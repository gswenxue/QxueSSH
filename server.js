/**
 * QxueSSH 服务端
 * Express + socket.io + ssh2
 * 功能：用户认证、主机收藏存储、SSH 终端、SFTP 文件管理、系统监控
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('ssh2');
const { Server } = require('socket.io');
const pty = require('node-pty');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const KEY_FILE = path.join(DATA_DIR, '.key');
const MONITOR_INTERVAL = 2000;

/* ---------------- 数据库加密（AES-256-GCM，透明加解密） ---------------- */
function getDBKey() {
  // 密钥文件不存在则生成（32字节随机密钥，base64存储，权限600）
  if (!fs.existsSync(KEY_FILE)) {
    const key = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    return Buffer.from(key, 'base64');
  }
  const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
  return Buffer.from(key, 'base64');
}

function encryptDB(jsonStr) {
  const key = getDBKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 加密文件格式：JSON 包装，含版本号便于后续升级
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') });
}

function decryptDB(encStr) {
  try {
    const obj = JSON.parse(encStr);
    if (!obj.v || !obj.iv || !obj.tag || !obj.data) return null;
    const key = getDBKey();
    const iv = Buffer.from(obj.iv, 'base64');
    const tag = Buffer.from(obj.tag, 'base64');
    const data = Buffer.from(obj.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null;
  }
}

/* ---------------- 安全策略常量 ---------------- */
const TOKEN_TTL = 3 * 24 * 60 * 60 * 1000;        // token 有效期 3 天
const TOKEN_RENEW_THRESHOLD = 24 * 60 * 60 * 1000; // 剩余不足 1 天时自动续期
const CAPTCHA_TTL = 5 * 60 * 1000;                 // 验证码 5 分钟有效
const IP_FAIL_LIMIT = 5;        // 同一 IP 连续失败 5 次
const IP_LOCK_MS = 15 * 60 * 1000;   // 锁定 15 分钟
const USER_FAIL_LIMIT = 5;      // 同一账号连续失败 5 次
const USER_LOCK_MS = 30 * 60 * 1000; // 锁定 30 分钟
const FAIL_DECAY_MS = 15 * 60 * 1000; // 超过 15 分钟无失败则计数重置

/* ---------------- 数据存储（JSON 文件） ---------------- */
function defaultBackupCfg() {
  return {
    enabled: false,        // 是否启用自动备份
    webdavUrl: '',         // WebDAV 地址（如 https://dav.jianguoyun.com/dav/QxueSSH/）
    username: '',          // WebDAV 账号
    password: '',          // WebDAV 密码 / 应用密码
    intervalHours: 24,     // 备份间隔（小时）
    retention: 5,          // 本地保留份数
    lastBackup: null,      // 上次成功备份时间
    lastError: null,       // 上次错误信息
    log: []                // 最近备份记录
  };
}

let db = {
  users: [], hosts: [], tokens: {}, keys: [],
  loginLogs: {},          // userId -> [{time, ip, ua}]
  regEnabled: false,      // 站点注册开关（默认关闭）
  localTerminalEnabled: false, // 本机终端开关（仅管理员可见可用）
  meta: { lastSync: 0 },  // 云端数据最新同步时间
  backup: defaultBackupCfg()
};

function loadDB() {
  let isPlaintext = false;
  try {
    if (fs.existsSync(DB_FILE)) {
      let raw = fs.readFileSync(DB_FILE, 'utf8');
      // 尝试解密（加密文件以 { 开头但包含 v/iv/tag/data 字段）
      const decrypted = decryptDB(raw);
      if (decrypted !== null) {
        raw = decrypted;
      } else {
        // 明文文件：首次加载后自动加密保存
        isPlaintext = true;
        console.log('[信息] 检测到明文数据库，将自动加密存储');
      }
      db = Object.assign({
        users: [], hosts: [], tokens: {}, keys: [],
        loginLogs: {}, regEnabled: false, localTerminalEnabled: false, meta: { lastSync: 0 }
      }, JSON.parse(raw));
      db.backup = Object.assign(defaultBackupCfg(), db.backup || {});
    }
  } catch (e) {
    console.error('加载数据库失败，使用空数据库:', e.message);
  }
  // 迁移旧格式 token（token -> userId 字符串）为带过期时间的对象
  for (const t of Object.keys(db.tokens)) {
    if (typeof db.tokens[t] === 'string') {
      db.tokens[t] = { userId: db.tokens[t], expire: Date.now() + TOKEN_TTL };
    }
  }
  // 管理员账户治理：保证有且仅有一个 Qxue 管理员
  const qxueIdx = db.users.findIndex(u => u.username === 'Qxue');
  const hasAdmin = db.users.some(u => u.role === 'admin');
  if (!hasAdmin) {
    // 存在同名非管理员账户属于异常数据（或抢占保留名），移除后重建标准管理员
    if (qxueIdx >= 0) {
      const bad = db.users[qxueIdx];
      db.users.splice(qxueIdx, 1);
      db.hosts = db.hosts.filter(h => h.userId !== bad.id);
      db.keys = db.keys.filter(k => k.userId !== bad.id);
      delete db.loginLogs[bad.id];
      for (const t of Object.keys(db.tokens)) if (db.tokens[t].userId === bad.id) delete db.tokens[t];
      console.log('已清理异常的 Qxue 账户数据');
    }
    db.users.push({
      id: crypto.randomUUID(),
      username: 'Qxue',
      passHash: bcrypt.hashSync('Qxue2026', 10),
      role: 'admin',
      createdAt: Date.now()
    });
    saveDB();
    console.log('已创建默认管理员账户: Qxue / Qxue2026');
  }
  // 明文数据库自动加密保存
  if (isPlaintext) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, encryptDB(JSON.stringify(db, null, 2)));
      console.log('[信息] 数据库已加密存储');
    } catch (e) {
      console.error('加密数据库失败:', e.message);
    }
  }
}

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, encryptDB(JSON.stringify(db, null, 2)));
    } catch (e) {
      console.error('保存数据库失败:', e.message);
    }
  }, 100);
}
loadDB();

/* ---------------- HTTP API ---------------- */
const app = express();
app.use(express.json({ limit: '2mb' }));

// 预压缩静态资源：若存在 <file>.gz 且浏览器支持 gzip，直接发送（零运行时压缩开销）
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use((req, res, next) => {
  if (req.method !== 'GET' || !/(gzip|deflate|br)/i.test(req.headers['accept-encoding'] || '')) return next();
  const rel = req.path === '/' ? '/index.html' : req.path; // 首页映射到 index.html
  const gzPath = path.join(PUBLIC_DIR, rel + '.gz');
  // 防路径穿越：归一化后必须仍在 public 目录内
  if (!gzPath.startsWith(PUBLIC_DIR + path.sep)) return next();
  fs.stat(gzPath, (err, st) => {
    if (err || !st.isFile()) return next();
    const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.set({
      'Content-Encoding': 'gzip',
      'Content-Type': types[path.extname(rel)] || 'application/octet-stream',
      'Vary': 'Accept-Encoding',
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(gzPath).pipe(res);
  });
});
app.use(express.static(path.join(__dirname, 'public')));

const app_ = express.Router();
app.use('/api', app_);

/* --------- token 签发与校验（3 天有效期 + 活动自动续期） --------- */
function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens[token] = { userId, expire: Date.now() + TOKEN_TTL };
  return token;
}

function lookupToken(token) {
  const t = db.tokens[token];
  if (!t || !t.userId) return null;
  if (t.expire && t.expire < Date.now()) {
    delete db.tokens[token]; // 已过期
    saveDB();
    return null;
  }
  const user = db.users.find(u => u.id === t.userId);
  if (!user) return null;
  // 滑动续期：剩余有效期不足 1 天时，自动续期到 3 天
  if (!t.expire || t.expire - Date.now() < TOKEN_RENEW_THRESHOLD) {
    t.expire = Date.now() + TOKEN_TTL;
    saveDB();
  }
  return { user, token };
}

function getUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const ctx = lookupToken(token);
  return ctx ? { user: ctx.user, token: ctx.token } : null;
}

function requireAuth(req, res, next) {
  const ctx = getUser(req);
  if (!ctx) return res.status(401).json({ error: '未登录' });
  req.user = ctx.user;
  req.token = ctx.token;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
  });
}

function recordLogin(userId, req) {
  const ip = getClientIp(req);
  const ua = (req.headers['user-agent'] || '未知').slice(0, 100);
  if (!db.loginLogs[userId]) db.loginLogs[userId] = [];
  db.loginLogs[userId].unshift({ time: Date.now(), ip, ua });
  db.loginLogs[userId] = db.loginLogs[userId].slice(0, 20); // 最近 20 条
  saveDB();
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '未知';
}

/* --------- 图形验证码（自绘 SVG） --------- */
const captchaStore = new Map(); // captchaId -> { text, expire }

function generateCaptchaSVG(text) {
  const w = 120, h = 44;
  const colors = ['#4f8cff', '#e5534b', '#3fb950', '#bd93f9', '#ff8c42', '#0aa1a1'];
  const fonts = ['Arial', 'Verdana', 'Georgia', 'Courier New', 'Trebuchet MS'];
  let chars = '';
  [...text].forEach((ch, i) => {
    const x = 16 + i * 25 + (Math.random() * 6 - 3);
    const y = 29 + (Math.random() * 8 - 4);
    const rot = (Math.random() * 40 - 20).toFixed(1);
    const color = colors[Math.floor(Math.random() * colors.length)];
    const font = fonts[Math.floor(Math.random() * fonts.length)];
    const size = 22 + Math.floor(Math.random() * 8);
    chars += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${font}, sans-serif" font-size="${size}" fill="${color}" font-weight="bold" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`;
  });
  let lines = '';
  for (let i = 0; i < 4; i++) {
    lines += `<line x1="${(Math.random() * w).toFixed(1)}" y1="${(Math.random() * h).toFixed(1)}" x2="${(Math.random() * w).toFixed(1)}" y2="${(Math.random() * h).toFixed(1)}" stroke="hsl(${Math.floor(Math.random() * 360)},60%,55%)" stroke-width="1" opacity="0.45"/>`;
  }
  let dots = '';
  for (let i = 0; i < 30; i++) {
    dots += `<circle cx="${(Math.random() * w).toFixed(1)}" cy="${(Math.random() * h).toFixed(1)}" r="${(Math.random() * 1.5 + 0.5).toFixed(1)}" fill="hsl(${Math.floor(Math.random() * 360)},60%,50%)" opacity="0.4"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="6" fill="#f2f4f8"/>${dots}${lines}${chars}</svg>`;
}

app_.get('/captcha', (req, res) => {
  // 去掉易混淆字符（0/O/1/I/l）
  const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let text = '';
  for (let i = 0; i < 4; i++) text += pool[Math.floor(Math.random() * pool.length)];
  const captchaId = crypto.randomUUID();
  captchaStore.set(captchaId, { text, expire: Date.now() + CAPTCHA_TTL });
  // 顺带清理过期验证码
  const now = Date.now();
  for (const [k, v] of captchaStore) if (v.expire < now) captchaStore.delete(k);
  res.json({ captchaId, svg: generateCaptchaSVG(text) });
});

// 校验并消耗验证码（一次性使用）
function verifyCaptcha(captchaId, input) {
  const c = captchaStore.get(captchaId);
  captchaStore.delete(captchaId);
  if (!c || c.expire < Date.now()) return false;
  return String(input || '').toUpperCase() === c.text;
}

/* --------- 登录失败锁定 --------- */
const loginFail = { ip: new Map(), user: new Map() }; // key -> { count, lockUntil, last }

// 读取失败记录（锁定过期或长时间无失败则重置计数）
function getFailRec(map, key) {
  const rec = map.get(key);
  if (!rec) return null;
  const now = Date.now();
  if (rec.lockUntil) {
    if (rec.lockUntil <= now) { map.delete(key); return null; } // 锁定已解除，计数重置
  } else if (now - rec.last > FAIL_DECAY_MS) {
    map.delete(key); return null; // 超过 15 分钟无失败，计数重置
  }
  return rec;
}

function recordFail(map, key, limit, lockMs) {
  const rec = map.get(key) || { count: 0, lockUntil: 0, last: 0 };
  rec.count += 1;
  rec.last = Date.now();
  if (rec.count >= limit) {
    rec.lockUntil = Date.now() + lockMs;
    rec.count = 0; // 锁定后清零，解除锁定时重新计数
  }
  map.set(key, rec);
}

// 定期清理过期记录，防止内存缓慢增长
setInterval(() => {
  const now = Date.now();
  for (const m of [loginFail.ip, loginFail.user]) {
    for (const [k, v] of m) {
      if ((v.lockUntil && v.lockUntil < now) || (!v.lockUntil && now - v.last > FAIL_DECAY_MS)) m.delete(k);
    }
  }
}, 10 * 60 * 1000);

function lockRemainingMin(lockUntil) {
  return Math.max(1, Math.ceil((lockUntil - Date.now()) / 60000));
}

/* --------- 注册 / 登录 --------- */
app_.post('/register', (req, res) => {
  if (!db.regEnabled) return res.status(403).json({ error: '站点已关闭注册功能' });
  const { username, password, captchaId, captcha } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_\-\u4e00-\u9fa5]{2,20}$/.test(username))
    return res.status(400).json({ error: '用户名需为 2-20 位字母数字下划线或中文' });
  // 敏感词过滤（不区分大小写，包含即禁止）
  const reservedNames = ['admin', 'root', 'administrator', 'system', 'sysop', 'moderator', 'qxue', '管理员', '系统'];
  const unameLower = String(username).toLowerCase();
  if (reservedNames.some(n => unameLower.includes(n.toLowerCase())))
    return res.status(400).json({ error: '该用户名包含保留词，不可注册' });
  if (typeof password !== 'string' || password.length < 8)
    return res.status(400).json({ error: '密码至少 8 位' });
  if (db.users.some(u => u.username === username))
    return res.status(400).json({ error: '用户名已存在' });
  if (!verifyCaptcha(captchaId, captcha))
    return res.status(400).json({ error: '验证码错误或已过期，请刷新后重试' });
  const user = {
    id: crypto.randomUUID(),
    username,
    passHash: bcrypt.hashSync(password, 10),
    role: 'user',
    createdAt: Date.now()
  };
  db.users.push(user);
  const token = issueToken(user.id);
  recordLogin(user.id, req);
  saveDB();
  res.json({ token, username: user.username, role: user.role });
});

app_.post('/login', (req, res) => {
  const { username, password, captchaId, captcha } = req.body || {};
  const ip = getClientIp(req);

  // 检查 IP 锁定（同一 IP 连续失败 5 次 → 锁定 15 分钟）
  const ipRec = getFailRec(loginFail.ip, ip);
  if (ipRec && ipRec.lockUntil > Date.now())
    return res.status(403).json({ error: `该 IP 因连续登录失败已被锁定，请 ${lockRemainingMin(ipRec.lockUntil)} 分钟后再试` });

  // 检查账号锁定（同一账号连续失败 5 次 → 锁定 30 分钟）
  const userKey = String(username || '').toLowerCase();
  const userRec = getFailRec(loginFail.user, userKey);
  if (userRec && userRec.lockUntil > Date.now())
    return res.status(403).json({ error: `该账号因连续登录失败已被锁定，请 ${lockRemainingMin(userRec.lockUntil)} 分钟后再试` });

  // 验证码校验（一次性使用）
  if (!verifyCaptcha(captchaId, captcha))
    return res.status(400).json({ error: '验证码错误或已过期，请刷新后重试' });

  const user = db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(String(password || ''), user.passHash)) {
    recordFail(loginFail.ip, ip, IP_FAIL_LIMIT, IP_LOCK_MS);
    recordFail(loginFail.user, userKey, USER_FAIL_LIMIT, USER_LOCK_MS);
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  // 登录成功，清除失败计数
  loginFail.ip.delete(ip);
  loginFail.user.delete(userKey);

  const token = issueToken(user.id);
  recordLogin(user.id, req);
  saveDB();
  res.json({ token, username: user.username, role: user.role || 'user' });
});

app_.post('/logout', requireAuth, (req, res) => {
  const token = req.token;
  delete db.tokens[token];
  saveDB();
  // 强制断开该 token 的所有 WebSocket 连接（关闭所有 SSH 会话）
  if (tokenSockets.has(token)) {
    for (const sock of tokenSockets.get(token)) {
      try { sock.disconnect(true); } catch (e) { /* ignore */ }
    }
    tokenSockets.delete(token);
  }
  res.json({ ok: true });
});

app_.get('/me', (req, res) => {
  const ctx = getUser(req);
  if (!ctx) return res.json({ user: null });
  res.json({ user: { username: ctx.user.username, id: ctx.user.id, role: ctx.user.role || 'user' } });
});

/* --------- 主机收藏 CRUD（需登录） --------- */
function hostPublic(h) {
  return {
    id: h.id, label: h.label, remark: h.remark, host: h.host, port: h.port,
    username: h.username, authType: h.authType, createdAt: h.createdAt
  };
}

app_.get('/hosts', requireAuth, (req, res) => {
  const hosts = db.hosts.filter(h => h.userId === req.user.id);
  res.json({ hosts: hosts.map(hostPublic) });
});

app_.post('/hosts', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.host || !b.username) return res.status(400).json({ error: '主机地址和用户名不能为空' });
  const host = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    label: (b.label || '').trim() || `${b.username}@${b.host}`,
    remark: (b.remark || '').trim(),
    host: b.host.trim(),
    port: parseInt(b.port) || 22,
    username: b.username.trim(),
    authType: b.authType === 'key' ? 'key' : 'password',
    password: b.password || '',
    privateKey: b.privateKey || '',
    createdAt: Date.now()
  };
  db.hosts.push(host);
  saveDB();
  res.json({ host: hostPublic(host) });
});

app_.put('/hosts/:id', requireAuth, (req, res) => {
  const host = db.hosts.find(h => h.id === req.params.id && h.userId === req.user.id);
  if (!host) return res.status(404).json({ error: '主机不存在' });
  const b = req.body || {};
  if (b.host) host.host = b.host.trim();
  if (b.port) host.port = parseInt(b.port) || 22;
  if (b.username) host.username = b.username.trim();
  if (b.label !== undefined) host.label = (b.label || '').trim() || `${host.username}@${host.host}`;
  if (b.remark !== undefined) host.remark = (b.remark || '').trim();
  if (b.authType) host.authType = b.authType === 'key' ? 'key' : 'password';
  if (b.password !== undefined) host.password = b.password;
  if (b.privateKey !== undefined) host.privateKey = b.privateKey;
  saveDB();
  res.json({ host: hostPublic(host) });
});

app_.delete('/hosts/:id', requireAuth, (req, res) => {
  const idx = db.hosts.findIndex(h => h.id === req.params.id && h.userId === req.user.id);
  if (idx < 0) return res.status(404).json({ error: '主机不存在' });
  db.hosts.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 主机排序：在当前用户的主机列表内上移/下移一位
app_.put('/hosts/:id/move', requireAuth, (req, res) => {
  const dir = (req.body || {}).dir;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: '参数错误' });
  // 该用户的主机在 db.hosts 中的索引（保持相对顺序）
  const mine = db.hosts.map((h, i) => ({ h, i })).filter(x => x.h.userId === req.user.id);
  const pos = mine.findIndex(x => x.h.id === req.params.id);
  if (pos < 0) return res.status(404).json({ error: '主机不存在' });
  const target = dir === 'up' ? pos - 1 : pos + 1;
  if (target < 0 || target >= mine.length) return res.status(400).json({ error: '已在边缘位置' });
  const a = mine[pos].i, b = mine[target].i;
  [db.hosts[a], db.hosts[b]] = [db.hosts[b], db.hosts[a]];
  saveDB();
  res.json({ ok: true });
});

/* --------- 自定义快捷键 CRUD（需登录） --------- */
function keyPublic(k) {
  return { id: k.id, label: k.label, keys: k.keys, data: k.data, createdAt: k.createdAt };
}

app_.get('/keys', requireAuth, (req, res) => {
  const keys = (db.keys || []).filter(k => k.userId === req.user.id);
  res.json({ keys: keys.map(keyPublic) });
});

app_.post('/keys', requireAuth, (req, res) => {
  const b = req.body || {};
  const keysArr = Array.isArray(b.keys) ? b.keys.filter(Boolean) : [];
  if (keysArr.length < 2 || keysArr.length > 3)
    return res.status(400).json({ error: '组合需为 2-3 个按键' });
  if (!b.data) return res.status(400).json({ error: '无法识别的按键组合' });
  const item = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    label: (b.label || '').trim(),
    keys: keysArr,
    data: String(b.data),
    createdAt: Date.now()
  };
  db.keys.push(item);
  saveDB();
  res.json({ key: keyPublic(item) });
});

app_.put('/keys/:id', requireAuth, (req, res) => {
  const item = (db.keys || []).find(k => k.id === req.params.id && k.userId === req.user.id);
  if (!item) return res.status(404).json({ error: '快捷键不存在' });
  const b = req.body || {};
  const keysArr = Array.isArray(b.keys) ? b.keys.filter(Boolean) : null;
  if (keysArr) {
    if (keysArr.length < 2 || keysArr.length > 3)
      return res.status(400).json({ error: '组合需为 2-3 个按键' });
    item.keys = keysArr;
  }
  if (b.label !== undefined) item.label = (b.label || '').trim();
  if (b.data) item.data = String(b.data);
  saveDB();
  res.json({ key: keyPublic(item) });
});

app_.delete('/keys/:id', requireAuth, (req, res) => {
  const idx = (db.keys || []).findIndex(k => k.id === req.params.id && k.userId === req.user.id);
  if (idx < 0) return res.status(404).json({ error: '快捷键不存在' });
  db.keys.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

/* --------- 个人设置：账号 --------- */
app_.get('/profile', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role || 'user',
    createdAt: req.user.createdAt,
    logins: db.loginLogs[req.user.id] || []
  });
});

app_.post('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!bcrypt.compareSync(String(oldPassword || ''), req.user.passHash))
    return res.status(400).json({ error: '原密码错误' });
  if (typeof newPassword !== 'string' || newPassword.length < 8)
    return res.status(400).json({ error: '新密码至少 8 位' });
  req.user.passHash = bcrypt.hashSync(newPassword, 10);
  saveDB();
  res.json({ ok: true });
});

app_.post('/account/delete', requireAuth, (req, res) => {
  const userId = req.user.id;
  db.users = db.users.filter(u => u.id !== userId);
  db.hosts = db.hosts.filter(h => h.userId !== userId);
  db.keys = db.keys.filter(k => k.userId !== userId);
  delete db.loginLogs[userId];
  for (const t of Object.keys(db.tokens)) if (db.tokens[t].userId === userId) delete db.tokens[t];
  saveDB();
  res.json({ ok: true });
});

/* --------- 个人设置：云数据 --------- */
app_.get('/sync', requireAuth, (req, res) => {
  res.json({ lastSync: db.meta.lastSync || 0, hosts: db.hosts.filter(h => h.userId === req.user.id).length, keys: db.keys.filter(k => k.userId === req.user.id).length });
});

app_.post('/sync/push', requireAuth, (req, res) => {
  db.meta.lastSync = Date.now();
  saveDB();
  // 强制立即写盘（saveDB 是延迟的）
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, encryptDB(JSON.stringify(db, null, 2))); } catch (e) { /* ignore */ }
  res.json({ lastSync: db.meta.lastSync });
});

app_.post('/sync/pull', requireAuth, (req, res) => {
  loadDB(); // 重新从文件读取（放弃内存中的旧状态）
  const ctx = getUser({ headers: { authorization: 'Bearer ' + req.token } });
  if (!ctx) return res.status(401).json({ error: '登录状态失效，请重新登录' });
  res.json({
    lastSync: db.meta.lastSync || 0,
    hosts: db.hosts.filter(h => h.userId === req.user.id).map(hostPublic),
    keys: db.keys.filter(k => k.userId === req.user.id).map(keyPublic)
  });
});

app_.post('/sync/clear', requireAuth, (req, res) => {
  const userId = req.user.id;
  db.hosts = db.hosts.filter(h => h.userId !== userId);
  db.keys = db.keys.filter(k => k.userId !== userId);
  db.meta.lastSync = Date.now();
  saveDB();
  res.json({ ok: true });
});

/* --------- 管理员：站点详情 --------- */
app_.get('/admin/stats', requireAdmin, (req, res) => {
  const users = db.users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role || 'user',
    createdAt: u.createdAt,
    hosts: db.hosts.filter(h => h.userId === u.id).length,
    keys: db.keys.filter(k => k.userId === u.id).length,
    lastLogin: (db.loginLogs[u.id] || [])[0] || null
  })).sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1) || a.createdAt - b.createdAt);
  res.json({ count: db.users.length, regEnabled: db.regEnabled, localTerminalEnabled: db.localTerminalEnabled, users });
});

app_.post('/admin/registration', requireAdmin, (req, res) => {
  db.regEnabled = !!(req.body || {}).enabled;
  saveDB();
  res.json({ regEnabled: db.regEnabled });
});

/* --- 本机终端开关（启用需验证本机 SSH 凭据） --- */
app_.post('/admin/local-terminal', requireAdmin, (req, res) => {
  const { enabled, password, privateKey, passphrase, port } = req.body || {};
  if (!enabled) {
    db.localTerminalEnabled = false;
    saveDB();
    return res.json({ localTerminalEnabled: false });
  }
  // 启用：验证本机 SSH 凭据（连接 localhost:指定端口，默认22）
  const sshPort = parseInt(port) || 22;
  const cfg = { host: '127.0.0.1', port: sshPort, username: 'root' };
  if (privateKey) {
    cfg.privateKey = privateKey;
    if (passphrase) cfg.passphrase = passphrase;
  } else if (password) {
    cfg.password = password;
  } else {
    return res.status(400).json({ error: '请提供本机 SSH 密码或私钥' });
  }
  const client = new Client();
  let verified = false;
  client.on('ready', () => {
    verified = true;
    client.end();
    db.localTerminalEnabled = true;
    saveDB();
    res.json({ localTerminalEnabled: true });
  });
  client.on('error', (err) => {
    if (!verified) res.status(401).json({ error: '本机 SSH 凭据验证失败：' + err.message });
  });
  try { client.connect(cfg); } catch (e) { res.status(400).json({ error: e.message }); }
});

app_.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  const userId = req.params.id;
  if (userId === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'admin') return res.status(400).json({ error: '不能删除管理员账户' });
  db.users = db.users.filter(u => u.id !== userId);
  db.hosts = db.hosts.filter(h => h.userId !== userId);
  db.keys = db.keys.filter(k => k.userId !== userId);
  delete db.loginLogs[userId];
  for (const t of Object.keys(db.tokens)) if (db.tokens[t].userId === userId) delete db.tokens[t];
  saveDB();
  res.json({ ok: true });
});

/* --------- 管理员：站点备份（WebDAV 网盘） --------- */
const { execFile } = require('child_process');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function webdavAuth() {
  return 'Basic ' + Buffer.from(db.backup.username + ':' + db.backup.password).toString('base64');
}

/* WebDAV 连接测试：OPTIONS 请求，2xx / 207 视为可达 */
function webdavTest() {
  return new Promise((resolve, reject) => {
    const cfg = db.backup;
    if (!cfg.webdavUrl) return reject(new Error('未配置 WebDAV 地址'));
    let u;
    try { u = new URL(cfg.webdavUrl); } catch (e) { return reject(new Error('WebDAV 地址格式错误')); }
    const mod = u.protocol === 'http:' ? http : require('https');
    const req = mod.request(u, { method: 'OPTIONS', headers: { Authorization: webdavAuth() } }, (r) => {
      r.resume();
      if ((r.statusCode >= 200 && r.statusCode < 300) || r.statusCode === 207) resolve(r.statusCode);
      else reject(new Error('WebDAV 响应 HTTP ' + r.statusCode + (r.statusCode === 401 ? '（账号或密码错误）' : '')));
    });
    req.on('error', e => reject(new Error('连接失败: ' + e.message)));
    req.setTimeout(15000, () => req.destroy(new Error('连接超时')));
    req.end();
  });
}

/* 打包备份：仅 data/db.json（明文导出，便于跨机器迁移） */
function buildBackupArchive() {
  return new Promise((resolve, reject) => {
    try {
      // 先同步落盘数据库，确保内存数据最新
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, encryptDB(JSON.stringify(db, null, 2)));
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const file = path.join(BACKUP_DIR, `qxuessh-backup-${stamp}.tar.gz`);
      // 创建临时目录，导出明文 db.json（备份文件由用户保管，明文便于跨机器导入）
      const os = require('os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qxue-backup-'));
      const tmpDataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(tmpDataDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDataDir, 'db.json'), JSON.stringify(db, null, 2));
      execFile('tar', ['czf', file, 'data/db.json'],
        { cwd: tmpDir }, (err) => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          if (err) return reject(new Error('打包失败: ' + err.message));
          resolve(file);
        });
    } catch (e) { reject(e); }
  });
}

/* 上传备份文件到 WebDAV */
function webdavPut(file) {
  return new Promise((resolve, reject) => {
    const cfg = db.backup;
    if (!cfg.webdavUrl) return reject(new Error('未配置 WebDAV 地址'));
    let u;
    try { u = new URL(cfg.webdavUrl.replace(/\/+$/, '') + '/' + path.basename(file)); }
    catch (e) { return reject(new Error('WebDAV 地址格式错误')); }
    const mod = u.protocol === 'http:' ? http : require('https');
    const stat = fs.statSync(file);
    const req = mod.request(u, {
      method: 'PUT',
      headers: { Authorization: webdavAuth(), 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size }
    }, (r) => {
      r.resume();
      if (r.statusCode >= 200 && r.statusCode < 300) resolve({ status: r.statusCode, size: stat.size });
      else reject(new Error('上传失败 HTTP ' + r.statusCode + (r.statusCode === 401 ? '（账号或密码错误）' : '')));
    });
    req.on('error', e => reject(new Error('上传失败: ' + e.message)));
    req.setTimeout(60000, () => req.destroy(new Error('上传超时')));
    fs.createReadStream(file).pipe(req);
  });
}

/* 清理本地备份，只保留最近 retention 份 */
function cleanupLocalBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('qxuessh-backup-')).sort();
    while (files.length > db.backup.retention) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { /* ignore */ }
}

/* 执行一次完整备份：打包 -> 上传 -> 记录日志 */
async function runBackup(trigger) {
  const cfg = db.backup;
  let entry;
  try {
    const file = await buildBackupArchive();
    await webdavPut(file);
    cfg.lastBackup = Date.now();
    cfg.lastError = null;
    entry = { time: Date.now(), ok: true, trigger, file: path.basename(file), size: fs.statSync(file).size };
  } catch (e) {
    cfg.lastError = e.message;
    entry = { time: Date.now(), ok: false, trigger, error: e.message };
  }
  cfg.log.unshift(entry);
  cfg.log = cfg.log.slice(0, 20);
  cleanupLocalBackups();
  saveDB();
  return entry;
}

/* 定时备份调度：配置变化 / 启动时调用 */
let backupTimer = null;
function scheduleBackup() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  const cfg = db.backup;
  if (!cfg.enabled || !cfg.webdavUrl) return;
  const ms = Math.max(1, cfg.intervalHours || 24) * 3600 * 1000;
  backupTimer = setInterval(() => { runBackup('auto').catch(() => {}); }, ms);
  if (backupTimer.unref) backupTimer.unref();
  console.log(`自动备份已开启：每 ${cfg.intervalHours} 小时一次`);
}

app_.get('/admin/backup', requireAdmin, (req, res) => {
  const c = db.backup;
  res.json({
    enabled: c.enabled, webdavUrl: c.webdavUrl, username: c.username,
    hasPassword: !!c.password, intervalHours: c.intervalHours, retention: c.retention,
    lastBackup: c.lastBackup, lastError: c.lastError, log: c.log
  });
});

app_.post('/admin/backup', requireAdmin, (req, res) => {
  const b = req.body || {};
  const c = db.backup;
  c.enabled = !!b.enabled;
  c.webdavUrl = String(b.webdavUrl || '').trim();
  c.username = String(b.username || '').trim();
  // 密码留空 = 沿用旧密码
  if (typeof b.password === 'string' && b.password !== '') c.password = b.password;
  if (b.clearPassword) c.password = '';
  c.intervalHours = Math.min(720, Math.max(1, +b.intervalHours || 24));
  c.retention = Math.min(30, Math.max(1, +b.retention || 5));
  saveDB();
  scheduleBackup();
  res.json({ ok: true });
});

app_.post('/admin/backup/test', requireAdmin, async (req, res) => {
  try { await webdavTest(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app_.post('/admin/backup/run', requireAdmin, async (req, res) => {
  const entry = await runBackup('manual');
  if (!entry.ok) return res.status(400).json({ error: entry.error });
  res.json({ ok: true, entry });
});

// 下载最新备份
app_.get('/admin/backup/download', requireAdmin, async (req, res) => {
  try {
    const file = await buildBackupArchive();
    res.download(file, path.basename(file));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 导入尝试记录（token -> {count, lockUntil}）
const importAttempts = new Map();

// 解析备份文件内容，返回 db 对象
function parseBackupFile(buffer) {
  const parseJson = (raw) => {
    // 检测是否为加密格式（含 v/iv/tag/data 字段）
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.v && obj.iv && obj.tag && obj.data) {
        // 是加密格式，尝试解密
        const dec = decryptDB(raw);
        if (dec === null) throw new Error('备份文件已加密，无法在本机解密（请在原机器上导出，或使用明文备份）');
        raw = dec;
      }
    } catch (e) {
      if (e.message.includes('加密')) throw e;
      // 不是 JSON 或不是加密格式，继续
    }
    const result = JSON.parse(raw);
    if (!result || !Array.isArray(result.users)) {
      throw new Error('备份文件格式错误，未找到有效的用户数据');
    }
    return result;
  };

  // 尝试作为 tar.gz 解压
  try {
    const { execFileSync } = require('child_process');
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'qxue-import-'));
    const tmpFile = path.join(tmpDir, 'backup.tar.gz');
    fs.writeFileSync(tmpFile, buffer);
    execFileSync('tar', ['xzf', tmpFile, '-C', tmpDir]);
    // 查找 db.json（可能在 data/ 下或根目录）
    const candidates = [
      path.join(tmpDir, 'data', 'db.json'),
      path.join(tmpDir, 'db.json')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return parseJson(raw);
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    if (e.message && (e.message.includes('加密') || e.message.includes('格式错误'))) throw e;
    // 不是 tar.gz，继续尝试纯 JSON
  }
  // 尝试作为纯 JSON
  try {
    return parseJson(buffer.toString('utf8'));
  } catch (e) {
    if (e.message && (e.message.includes('加密') || e.message.includes('格式错误'))) throw e;
    throw new Error('无法解析备份文件格式');
  }
}

// 数据导入
app_.post('/admin/import', requireAdmin, express.json({ limit: '20mb' }), (req, res) => {
  const token = req.token;
  const { fileB64, adminPassword } = req.body || {};

  // 检查锁定
  const att = importAttempts.get(token);
  if (att && att.lockUntil && Date.now() < att.lockUntil) {
    return res.status(403).json({ error: '当前环境可能存在风险，为保护数据安全，本机禁止该数据导入' });
  }

  if (!fileB64 || !adminPassword) {
    return res.status(400).json({ error: '缺少备份文件或管理员密码' });
  }

  let backupData;
  try {
    const buffer = Buffer.from(fileB64, 'base64');
    backupData = parseBackupFile(buffer);
  } catch (e) {
    return res.status(400).json({ error: '备份文件解析失败: ' + e.message });
  }

  // 找到备份中的管理员
  const backupAdmin = (backupData.users || []).find(u => u.role === 'admin');
  if (!backupAdmin) {
    return res.status(400).json({ error: '备份文件中未找到管理员账户' });
  }

  // 验证旧管理员密码
  if (!bcrypt.compareSync(adminPassword, backupAdmin.passHash)) {
    const cur = importAttempts.get(token) || { count: 0 };
    cur.count++;
    if (cur.count >= 3) {
      cur.lockUntil = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000; // 永久锁定（100年）
      importAttempts.set(token, cur);
      return res.status(403).json({ error: '当前环境可能存在风险，为保护数据安全，本机禁止该数据导入' });
    }
    importAttempts.set(token, cur);
    return res.status(401).json({ error: `旧管理员密码错误（还可尝试 ${3 - cur.count} 次）` });
  }

  // 验证成功，清除尝试记录
  importAttempts.delete(token);

  // 合并数据：保留当前站点管理员，导入其他数据
  const currentAdmin = db.users.find(u => u.role === 'admin');
  const currentAdminId = currentAdmin ? currentAdmin.id : null;

  // 导入用户（跳过当前管理员，其他用户如果用户名冲突则跳过）
  const existingUsernames = new Set(db.users.map(u => u.username));
  let importedUsers = 0;
  for (const u of (backupData.users || [])) {
    if (u.role === 'admin') continue; // 不导入旧管理员
    if (existingUsernames.has(u.username)) continue; // 用户名冲突跳过
    db.users.push(u);
    existingUsernames.add(u.username);
    importedUsers++;
  }

  // 导入主机（关联到对应用户，如果用户不存在则关联到当前管理员）
  const oldToNewUserMap = {};
  for (const u of (backupData.users || [])) {
    if (u.role === 'admin') {
      oldToNewUserMap[u.id] = currentAdminId; // 旧管理员的主机归当前管理员
    } else {
      const found = db.users.find(x => x.username === u.username);
      if (found) oldToNewUserMap[u.id] = found.id;
    }
  }
  let importedHosts = 0;
  for (const h of (backupData.hosts || [])) {
    const newUserId = oldToNewUserMap[h.userId] || currentAdminId;
    if (!newUserId) continue;
    db.hosts.push({ ...h, userId: newUserId });
    importedHosts++;
  }

  // 导入密钥
  let importedKeys = 0;
  for (const k of (backupData.keys || [])) {
    const newUserId = oldToNewUserMap[k.userId] || currentAdminId;
    if (!newUserId) continue;
    db.keys.push({ ...k, userId: newUserId });
    importedKeys++;
  }

  // tokens 和 loginLogs 不导入（新站点需要重新登录）
  // 站点配置保留当前设置（regEnabled, localTerminalEnabled, backup）

  saveDB();
  res.json({
    ok: true,
    importedUsers,
    importedHosts,
    importedKeys,
    message: `导入完成：用户 ${importedUsers}、主机 ${importedHosts}、密钥 ${importedKeys}`
  });
});

/* ---------------- socket.io（SSH 会话） ---------------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

// token -> Set<socket>：退出登录时强制断开该用户的所有 WebSocket 连接
const tokenSockets = new Map();

const MONITOR_CMD = [
  // 系统版本（兼容 Alpine / Debian / Ubuntu 等，均有 /etc/os-release）
  'echo "OS=`cat /etc/os-release 2>/dev/null | grep \'^PRETTY_NAME=\' | cut -d= -f2 | tr -d \'"\'`"',
  'echo "CPU=`grep \'^cpu \' /proc/stat`"',
  'echo "MEMT=`grep \'^MemTotal:\' /proc/meminfo`"',
  'echo "MEMA=`grep \'^MemAvailable:\' /proc/meminfo`"',
  'echo "SWAPT=`grep \'^SwapTotal:\' /proc/meminfo`"',
  'echo "SWAPF=`grep \'^SwapFree:\' /proc/meminfo`"',
  // 磁盘：用 df -k -P（POSIX 格式、KB 单位），兼容 Alpine BusyBox df（不支持 -B1/-x）
  'df -k -P 2>/dev/null | tail -n +2 | sed "s/^/DISK=/"',
  'echo "LOAD=`cat /proc/loadavg 2>/dev/null`"',
  'echo "UP=`cat /proc/uptime 2>/dev/null`"',
  'echo "NET=`cat /proc/net/dev 2>/dev/null`"',
  'echo "PS=`ps axo pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -6 | tail -5`"'
].join('; ');

io.on('connection', (socket) => {
  // connId -> { client, stream, sftp, sftpLoading, monitorTimer, monitorPrev, closed }
  const conns = new Map();

  // 注册 token -> socket 映射（用于退出登录时强制断开所有连接）
  const sockToken = (socket.handshake.auth && socket.handshake.auth.token) || null;
  if (sockToken) {
    if (!tokenSockets.has(sockToken)) tokenSockets.set(sockToken, new Set());
    tokenSockets.get(sockToken).add(socket);
  }

  function getSession(connId) {
    return conns.get(connId);
  }

  function closeSession(connId) {
    const s = conns.get(connId);
    if (!s) return;
    conns.delete(connId);
    clearInterval(s.monitorTimer);
    try { s.client.end(); } catch (e) { /* ignore */ }
  }

  function startMonitor(connId, s) {
    clearInterval(s.monitorTimer);
    const runCmd = (cmd, cb) => {
      if (s.isLocal) {
        exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => cb(err, stdout));
      } else {
        s.client.exec(cmd, (err, stream) => {
          if (err) return cb(err);
          let out = '';
          stream.on('data', d => out += d.toString());
          stream.on('close', () => cb(null, out));
          stream.stderr.on('data', () => {});
        });
      }
    };
    const tick = () => {
      if (s.closed) return;
      runCmd(MONITOR_CMD, (err, out) => {
        if (err || s.closed) return;
        try {
          const data = parseMonitor(out, s.monitorPrev);
          s.monitorPrev = data.raw;
          socket.emit('s:monitor', { connId, data });
        } catch (e) { /* ignore */ }
      });
    };
    tick();
    s.monitorTimer = setInterval(tick, MONITOR_INTERVAL);
  }

  /* --- 连接 --- */
  socket.on('c:ssh:connect', (msg = {}) => {
    const { connId, cols = 80, rows = 24 } = msg;
    if (!connId) return;

    // SSH 功能必须登录，防止站点被滥用
    const ctx = getUserByToken(msg.token);
    if (!ctx) {
      return socket.emit('s:ssh:status', { connId, status: 'error', message: '请先登录后再使用 SSH 功能' });
    }

    // ===== 本地终端（直接访问部署机器本身，无需 SSH） =====
    if (msg.isLocal) {
      // 权限校验：仅管理员可用，且站点已开启本机终端
      if (ctx.user.role !== 'admin') {
        return socket.emit('s:ssh:status', { connId, status: 'error', message: '仅管理员可使用本机终端' });
      }
      if (!db.localTerminalEnabled) {
        return socket.emit('s:ssh:status', { connId, status: 'error', message: '本机终端未开启，请在站点管理中开启' });
      }
      const shell = process.env.SHELL || '/bin/bash';
      // 统一终端环境，确保字体/颜色/提示符与 SSH 登录体验一致
      const ptyEnv = Object.assign({}, process.env, {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'C.UTF-8'
      });
      const ptyProc = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols, rows,
        cwd: process.env.HOME || '/root',
        env: ptyEnv
      });
      const session = {
        client: { end: () => { try { ptyProc.kill(); } catch (e) { /* ignore */ } } },
        stream: ptyProc,
        sftp: null, sftpLoading: false,
        monitorTimer: null, monitorPrev: null, closed: false,
        isLocal: true
      };
      conns.set(connId, session);
      socket.emit('s:ssh:status', { connId, status: 'connecting', message: '正在连接…' });

      ptyProc.onData(d => socket.emit('s:ssh:data', { connId, data: d.toString('utf8') }));
      ptyProc.onExit(() => {
        session.closed = true;
        socket.emit('s:ssh:status', { connId, status: 'closed', message: '连接已关闭' });
        closeSession(connId);
      });

      socket.emit('s:ssh:status', { connId, status: 'connected', message: '已连接' });
      startMonitor(connId, session);
      return;
    }

    let cfg;
    if (msg.hostId) {
      const host = db.hosts.find(h => h.id === msg.hostId && h.userId === ctx.user.id);
      if (!host) return socket.emit('s:ssh:status', { connId, status: 'error', message: '主机不存在或无权限' });
      cfg = buildSSHConfig(host);
    } else {
      // 快速连接（不保存，需登录）
      if (!msg.host || !msg.username)
        return socket.emit('s:ssh:status', { connId, status: 'error', message: '缺少连接信息' });
      cfg = buildSSHConfig(msg);
    }

    const client = new Client();
    const session = {
      client, stream: null, sftp: null, sftpLoading: false,
      monitorTimer: null, monitorPrev: null, closed: false
    };
    conns.set(connId, session);

    socket.emit('s:ssh:status', { connId, status: 'connecting', message: '正在连接…' });

    client.on('ready', () => {
      session.closed = false;
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          socket.emit('s:ssh:status', { connId, status: 'error', message: err.message });
          return;
        }
        session.stream = stream;
        stream.on('data', d => socket.emit('s:ssh:data', { connId, data: d.toString('utf8') }));
        stream.stderr.on('data', d => socket.emit('s:ssh:data', { connId, data: d.toString('utf8') }));
        stream.on('close', () => {
          session.closed = true;
          socket.emit('s:ssh:status', { connId, status: 'closed', message: '连接已关闭' });
          closeSession(connId);
        });
        socket.emit('s:ssh:status', { connId, status: 'connected', message: '已连接' });
        startMonitor(connId, session);
      });
    });

    client.on('error', (err) => {
      socket.emit('s:ssh:status', {
        connId, status: 'error',
        message: err.message === 'All configured authentication methods failed' ? '认证失败：请检查用户名/密码/密钥' : err.message
      });
      session.closed = true;
      closeSession(connId);
    });

    client.on('close', () => {
      if (!session.closed) {
        session.closed = true;
        socket.emit('s:ssh:status', { connId, status: 'closed', message: '连接已断开' });
      }
      closeSession(connId);
    });

    client.connect(cfg);
  });

  socket.on('c:ssh:input', ({ connId, data } = {}) => {
    const s = getSession(connId);
    if (s && s.stream) s.stream.write(data);
  });

  socket.on('c:ssh:resize', ({ connId, cols, rows } = {}) => {
    const s = getSession(connId);
    if (s && s.stream) {
      try {
        if (s.isLocal) s.stream.resize(cols, rows);
        else s.stream.setWindow(rows, cols, 480, 640);
      } catch (e) { /* ignore */ }
    }
  });

  socket.on('c:ssh:close', ({ connId } = {}) => closeSession(connId));

  /* --- SFTP 文件管理 --- */
  // 本地 SFTP 模拟对象（用于本机终端，用 fs 模块代替 ssh2 sftp）
  function createLocalSftp() {
    const toStats = (st) => ({
      size: st.size,
      mtime: Math.floor(st.mtimeMs / 1000),
      mode: st.mode,
      isDirectory: () => st.isDirectory(),
      isSymbolicLink: () => st.isSymbolicLink(),
      isFile: () => st.isFile()
    });
    return {
      readdir(p, cb) {
        fs.readdir(p, { withFileTypes: true }, (err, entries) => {
          if (err) return cb(err);
          const items = entries.map(e => {
            try {
              const st = fs.statSync(path.join(p, e.name));
              return { filename: e.name, attrs: toStats(st) };
            } catch {
              return { filename: e.name, attrs: toStats({ size: 0, mtimeMs: 0, mode: 0, isDirectory: () => e.isDirectory(), isSymbolicLink: () => e.isSymbolicLink(), isFile: () => e.isFile() }) };
            }
          });
          cb(null, items);
        });
      },
      stat(p, cb) {
        fs.stat(p, (err, st) => { if (err) return cb(err); cb(null, toStats(st)); });
      },
      createReadStream(p) { return fs.createReadStream(p); },
      createWriteStream(p) { return fs.createWriteStream(p); },
      mkdir(p, cb) { fs.mkdir(p, { recursive: false }, cb); },
      rmdir(p, cb) { fs.rmdir(p, cb); },
      unlink(p, cb) { fs.unlink(p, cb); },
      rename(a, b, cb) { fs.rename(a, b, cb); },
      on() { return this; }
    };
  }

  function withSftp(connId, cb) {
    const s = getSession(connId);
    if (!s) return cb(new Error('连接不存在'));
    if (s.isLocal) {
      if (!s.sftp) s.sftp = createLocalSftp();
      return cb(null, s.sftp, s);
    }
    if (s.sftp) return cb(null, s.sftp, s);
    if (s.sftpLoading) return cb(new Error('SFTP 初始化中，请稍候'));
    s.sftpLoading = true;
    s.client.sftp((err, sftp) => {
      s.sftpLoading = false;
      if (err) return cb(err);
      s.sftp = sftp;
      sftp.on('close', () => { s.sftp = null; });
      cb(null, sftp, s);
    });
  }

  socket.on('c:sftp:list', ({ connId, path: p } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.readdir(p, (err2, items) => {
        if (err2) return ack && ack({ error: err2.message });
        const list = items.map(it => ({
          name: it.filename,
          type: it.attrs.isDirectory() ? 'dir' : (it.attrs.isSymbolicLink() ? 'link' : 'file'),
          size: it.attrs.size,
          mtime: it.attrs.mtime * 1000,
          mode: it.attrs.mode
        })).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
        ack && ack({ list });
      });
    });
  });

  socket.on('c:sftp:readfile', ({ connId, path: p } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.stat(p, (err2, st) => {
        if (err2) return ack && ack({ error: err2.message });
        if (st.size > 1024 * 512) return ack && ack({ error: '文件超过 512KB，不支持在线打开' });
        const chunks = [];
        const rs = sftp.createReadStream(p);
        rs.on('data', c => chunks.push(c));
        rs.on('error', e => ack && ack({ error: e.message }));
        rs.on('end', () => ack && ack({
          content: Buffer.concat(chunks).toString('utf8'),
          size: st.size, mtime: st.mtime * 1000
        }));
      });
    });
  });

  socket.on('c:sftp:writefile', ({ connId, path: p, content } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      const ws = sftp.createWriteStream(p);
      ws.on('error', e => ack && ack({ error: e.message }));
      ws.on('close', () => ack && ack({ ok: true }));
      ws.end(content);
    });
  });

  socket.on('c:sftp:mkdir', ({ connId, path: p } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.mkdir(p, e => ack && ack(e ? { error: e.message } : { ok: true }));
    });
  });

  socket.on('c:sftp:delete', ({ connId, path: p } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.stat(p, (err2, st) => {
        if (err2) return ack && ack({ error: err2.message });
        const done = e => ack && ack(e ? { error: e.message } : { ok: true });
        if (st.isDirectory()) {
          sftp.readdir(p, (e3, items) => {
            if (e3) return done(e3);
            if (items.length > 0) return ack && ack({ error: '目录非空，请先清空内容' });
            sftp.rmdir(p, done);
          });
        } else {
          sftp.unlink(p, done);
        }
      });
    });
  });

  socket.on('c:sftp:rename', ({ connId, path: p, newPath } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.rename(p, newPath, e => ack && ack(e ? { error: e.message } : { ok: true }));
    });
  });

  // 剪切（移动）：SFTP rename 即同文件系统移动，支持文件和目录
  socket.on('c:sftp:move', ({ connId, path: src, newPath: dst } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.rename(src, dst, e => ack && ack(e ? { error: e.message } : { ok: true }));
    });
  });

  // 远程路径拼接
  function joinRemote(a, b) { return (a.endsWith('/') ? a : a + '/') + b; }

  // 复制：文件用流复制，目录递归（先建目录再逐项复制）
  function copyEntry(sftp, src, dst, cb) {
    sftp.stat(src, (err, st) => {
      if (err) return cb(err);
      if (st.isDirectory()) {
        sftp.mkdir(dst, err2 => {
          if (err2) return cb(err2);
          sftp.readdir(src, (e3, items) => {
            if (e3) return cb(e3);
            let i = 0;
            (function next() {
              if (i >= items.length) return cb(null);
              const name = items[i++].filename;
              copyEntry(sftp, joinRemote(src, name), joinRemote(dst, name), e => e ? cb(e) : next());
            })();
          });
        });
      } else {
        const rs = sftp.createReadStream(src);
        const ws = sftp.createWriteStream(dst);
        let done = false;
        const fin = e => { if (!done) { done = true; cb(e); } };
        rs.on('error', fin);
        ws.on('error', fin);
        ws.on('close', () => fin(null));
        rs.pipe(ws);
      }
    });
  }

  socket.on('c:sftp:copy', ({ connId, path: src, newPath: dst } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      copyEntry(sftp, src, dst, e => ack && ack(e ? { error: e.message } : { ok: true }));
    });
  });

  socket.on('c:sftp:download', ({ connId, path: p } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      sftp.stat(p, (err2, st) => {
        if (err2) return ack && ack({ error: err2.message });
        if (st.size > 64 * 1024 * 1024) return ack && ack({ error: '文件超过 64MB，不支持下载' });
        const chunks = [];
        const rs = sftp.createReadStream(p);
        rs.on('data', c => chunks.push(c));
        rs.on('error', e => ack && ack({ error: e.message }));
        rs.on('end', () => ack && ack({
          b64: Buffer.concat(chunks).toString('base64'),
          size: st.size
        }));
      });
    });
  });

  socket.on('c:sftp:upload', ({ connId, path: p, b64 } = {}, ack) => {
    withSftp(connId, (err, sftp) => {
      if (err) return ack && ack({ error: err.message });
      const ws = sftp.createWriteStream(p);
      ws.on('error', e => ack && ack({ error: e.message }));
      ws.on('close', () => ack && ack({ ok: true }));
      ws.end(Buffer.from(b64, 'base64'));
    });
  });

  socket.on('c:sftp:home', ({ connId } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    if (s.isLocal) {
      return ack && ack({ path: process.env.HOME || require('os').homedir() || '/root' });
    }
    s.client.exec('echo $HOME', (err, stream) => {
      if (err) return ack && ack({ error: err.message });
      let out = '';
      stream.on('data', d => out += d.toString());
      stream.on('close', () => ack && ack({ path: out.trim() || '/' }));
    });
  });

  /* --- Docker 容器管理 --- */
  // 在 SSH 会话上执行命令并收集输出（cb: err, stdout, stderr, exitCode）
  function sshExec(s, cmd, cb) {
    // 本机终端：用 child_process 执行命令
    if (s.isLocal) {
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) return cb(err.message);
        cb(null, stdout || '', stderr || '', err ? (err.code || 1) : 0);
      });
      return;
    }
    s.client.exec(cmd, (err, stream) => {
      if (err) return cb(err.message);
      let out = '', errOut = '', code = 0;
      stream.on('data', d => out += d.toString());
      stream.stderr.on('data', d => errOut += d.toString());
      stream.on('exit', c => { code = c; });
      stream.on('close', () => cb(null, out, errOut, code));
    });
  }

  // 压缩：将 dir 下选中的多个文件/目录打包为 tar.gz
  socket.on('c:sftp:compress', ({ connId, dir, names, out } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    if (!Array.isArray(names) || !names.length || !dir || !out) return ack && ack({ error: '参数错误' });
    // shell 单引号转义，防止路径/文件名中特殊字符注入
    const esc = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
    const cmd = `cd ${esc(dir)} && tar -czf ${esc(out)} -- ${names.map(esc).join(' ')}`;
    sshExec(s, cmd, (err, stdout, stderr, code) => {
      if (err) return ack && ack({ error: err });
      if (code !== 0) return ack && ack({ error: (stderr || '').trim().split('\n')[0] || '压缩失败' });
      ack && ack({ ok: true });
    });
  });

  // 防命令注入：容器名/ID 只允许安全字符
  function safeName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
  }

  // Docker 版本 + 存储位置
  socket.on('c:docker:info', ({ connId } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    sshExec(s, 'docker version --format "{{.Server.Version}}" 2>&1; echo "__ROOT__"; docker info --format "{{.DockerRootDir}}" 2>/dev/null', (err, out) => {
      if (err) return ack && ack({ error: err });
      const [verPart, rootPart] = out.split('__ROOT__');
      const version = (verPart || '').trim();
      if (!version || !/^[0-9]/.test(version))
        return ack && ack({ error: '未检测到 Docker（未安装或当前用户无权限）' });
      ack && ack({ version, rootDir: (rootPart || '').trim() || null });
    });
  });

  // 容器列表（详情 + 重启策略 + 实时资源占用，一次取回）
  socket.on('c:docker:list', ({ connId } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    const cmd = [
      'echo "__PS__"',
      'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}|{{.CreatedAt}}" 2>&1',
      'echo "__POLICY__"',
      'docker inspect --format "{{.Name}}|{{.HostConfig.RestartPolicy.Name}}" $(docker ps -aq) 2>/dev/null',
      'echo "__STATS__"',
      'docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null'
    ].join('; ');
    sshExec(s, cmd, (err, out) => {
      if (err) return ack && ack({ error: err });
      try {
        ack && ack({ containers: parseDockerList(out) });
      } catch (e) {
        ack && ack({ error: e.message });
      }
    });
  });

  // 镜像列表
  socket.on('c:docker:images', ({ connId } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    sshExec(s, 'docker images --format "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}" 2>&1', (err, out) => {
      if (err) return ack && ack({ error: err });
      if (out.includes('command not found')) return ack && ack({ error: '未检测到 Docker' });
      const images = out.split('\n').filter(Boolean).map(l => {
        const p = l.split('|');
        if (p.length < 4) return null;
        return { repo: p[0], id: p[1], size: p[2], createdAt: p.slice(3).join('|') };
      }).filter(Boolean);
      ack && ack({ images });
    });
  });

  // 容器操作：启动/停止/重启
  socket.on('c:docker:action', ({ connId, name, action } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    if (!safeName(name)) return ack && ack({ error: '容器名不合法' });
    if (!['start', 'stop', 'restart'].includes(action)) return ack && ack({ error: '不支持的操作' });
    sshExec(s, `docker ${action} ${name} 2>&1 && echo OK`, (err, out) => {
      if (err) return ack && ack({ error: err });
      out = out.trim();
      if (out.endsWith('OK')) ack && ack({ ok: true });
      else ack && ack({ error: out || '操作失败' });
    });
  });

  // 修改重启策略
  socket.on('c:docker:policy', ({ connId, name, policy } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    if (!safeName(name)) return ack && ack({ error: '容器名不合法' });
    if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(policy)) return ack && ack({ error: '不支持的重启策略' });
    sshExec(s, `docker update --restart=${policy} ${name} 2>&1 && echo OK`, (err, out) => {
      if (err) return ack && ack({ error: err });
      out = out.trim();
      if (out.endsWith('OK')) ack && ack({ ok: true });
      else ack && ack({ error: out || '设置失败' });
    });
  });

  // 查看容器日志（最近 300 行）
  socket.on('c:docker:logs', ({ connId, name } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    if (!safeName(name)) return ack && ack({ error: '容器名不合法' });
    sshExec(s, `docker logs --tail 300 ${name} 2>&1`, (err, out) => {
      if (err) return ack && ack({ error: err });
      ack && ack({ logs: out || '（无日志输出）' });
    });
  });

  // 删除镜像（支持 id 或 repo:tag）
  socket.on('c:docker:rmi', ({ connId, image } = {}, ack) => {
    const s = getSession(connId);
    if (!s) return ack && ack({ error: '连接不存在' });
    if (!safeName(image) && !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(image || ''))
      return ack && ack({ error: '镜像标识不合法' });
    sshExec(s, `docker rmi ${image} 2>&1 && echo OK`, (err, out) => {
      if (err) return ack && ack({ error: err });
      out = out.trim();
      if (out.endsWith('OK')) ack && ack({ ok: true, output: out.replace(/OK$/, '').trim() });
      else ack && ack({ error: out || '删除失败' });
    });
  });

  socket.on('disconnect', () => {
    for (const connId of conns.keys()) closeSession(connId);
    // 从 token-socket 映射中移除
    if (sockToken && tokenSockets.has(sockToken)) {
      tokenSockets.get(sockToken).delete(socket);
      if (tokenSockets.get(sockToken).size === 0) tokenSockets.delete(sockToken);
    }
  });
});

function getUserByToken(token) {
  if (!token) return null;
  const ctx = lookupToken(token);
  return ctx ? { user: ctx.user } : null;
}

// 解析 docker ps / inspect / stats 组合输出为容器列表
function parseDockerList(out) {
  const sec = (tag) => {
    const m = out.split('__' + tag + '__');
    return (m[1] || '').trim();
  };
  const ps = sec('PS'), policy = sec('POLICY'), stats = sec('STATS');
  if (ps.includes('command not found') || ps.includes('Cannot connect'))
    throw new Error('未检测到 Docker（未安装或当前用户无权限）');

  // 重启策略：/name -> policy
  const policies = {};
  for (const l of policy.split('\n')) {
    const p = l.trim().split('|');
    if (p.length === 2) policies[p[0].replace(/^\//, '')] = p[1];
  }
  // 资源占用：name -> {cpu, memUsage, memPerc}
  const statMap = {};
  for (const l of stats.split('\n')) {
    const p = l.trim().split('|');
    if (p.length === 4) statMap[p[0]] = { cpu: p[1], memUsage: p[2], memPerc: p[3] };
  }

  return ps.split('\n').filter(Boolean).map(l => {
    const p = l.split('|');
    if (p.length < 8) return null;
    return {
      id: p[0], name: p[1], image: p[2], state: p[3], status: p[4],
      ports: p[5] || '', runningFor: p[6], createdAt: p.slice(7).join('|'),
      restartPolicy: policies[p[1]] || 'no',
      stats: statMap[p[1]] || null
    };
  }).filter(Boolean);
}

function buildSSHConfig(c) {
  const cfg = {
    host: c.host,
    port: parseInt(c.port) || 22,
    username: c.username,
    readyTimeout: 15000,
    keepaliveInterval: 10000
  };
  if (c.authType === 'key' && c.privateKey) {
    cfg.privateKey = c.privateKey;
    if (c.password) cfg.passphrase = c.password;
  } else if (c.password) {
    cfg.password = c.password;
  }
  return cfg;
}

/* ---------------- 监控数据解析 ---------------- */
function parseMonitor(out, prev) {
  const lines = out.split('\n');
  const get = (prefix) => {
    const l = lines.find(x => x.startsWith(prefix));
    return l ? l.slice(prefix.length) : '';
  };

  // 系统版本（/etc/os-release 的 PRETTY_NAME，如 "Alpine Linux v3.20"、"Debian GNU/Linux 12 (bookworm)"）
  const os = get('OS=').trim() || null;

  // CPU（"cpu  user nice system idle iowait irq softirq steal ..."，去掉首个 "cpu" 标记）
  let cpuPercent = null;
  const cpuTokens = get('CPU=').trim().split(/\s+/);
  const cpuParts = cpuTokens.slice(1).map(Number);
  if (cpuParts.length > 3 && !cpuParts.some(isNaN)) {
    const total = cpuParts.reduce((a, b) => a + b, 0);
    const idle = (cpuParts[3] || 0) + (cpuParts[4] || 0); // idle + iowait
    if (prev && prev.cpuTotal != null) {
      const dTotal = total - prev.cpuTotal;
      const dIdle = idle - prev.cpuIdle;
      if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    }
    prev = Object.assign({}, prev, { cpuTotal: total, cpuIdle: idle });
  }

  // 内存
  const memTotalKB = parseInt((get('MEMT=').match(/(\d+)/) || [0, 0])[1]);
  const memAvailKB = parseInt((get('MEMA=').match(/(\d+)/) || [0, 0])[1]);
  let memPercent = null;
  if (memTotalKB > 0 && memAvailKB > 0) {
    memPercent = (memTotalKB - memAvailKB) / memTotalKB * 100;
  }

  // Swap（SwapTotal 为 0 视为未启用）
  const swapTotalKB = parseInt((get('SWAPT=').match(/(\d+)/) || [0, 0])[1]);
  const swapFreeKB = parseInt((get('SWAPF=').match(/(\d+)/) || [0, 0])[1]);
  let swap = null;
  if (swapTotalKB > 0) {
    const usedKB = swapTotalKB - swapFreeKB;
    swap = { percent: usedKB / swapTotalKB * 100, totalKB: swapTotalKB, usedKB, freeKB: swapFreeKB };
  }

  // 磁盘（df -k -P 输出，KB 单位；过滤虚拟文件系统，兼容 Alpine BusyBox df）
  const VIRTUAL_FS = ['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'debugfs', 'configfs', 'fusectl', 'cgroup', 'cgroup2', 'pstore', 'bpf', 'mqueue', 'hugetlbfs', 'tracefs', 'binfmt_misc', 'autofs', 'rpc_pipefs', 'nsfs'];
  const disks = [];
  for (const l of lines) {
    if (!l.startsWith('DISK=')) continue;
    const parts = l.slice(5).trim().split(/\s+/);
    if (parts.length >= 6) {
      const fsName = parts[0];
      // 过滤虚拟文件系统（按设备名前缀 / 类型判断，Alpine df 不输出类型列）
      if (VIRTUAL_FS.some(v => fsName === v || fsName.startsWith(v + '/'))) continue;
      if (fsName.startsWith('none') || fsName === 'udev' || fsName === 'devfs') continue;
      const totalKB = +parts[1], usedKB = +parts[2], availKB = +parts[3];
      if (totalKB <= 0) continue;
      disks.push({
        fs: fsName,
        total: totalKB * 1024, used: usedKB * 1024, avail: availKB * 1024,
        percent: parseFloat(parts[4]) || 0,
        mount: parts.slice(5).join(' ')
      });
    }
  }
  const rootDisk = disks.find(d => d.mount === '/') || disks[0] || null;
  const disk = rootDisk
    ? { percent: rootDisk.percent, total: rootDisk.total, used: rootDisk.used, avail: rootDisk.avail, mount: rootDisk.mount }
    : null;

  // 负载 & 运行时间
  const loadParts = get('LOAD=').trim().split(/\s+/).map(parseFloat);
  const load = loadParts.length >= 3 ? loadParts.slice(0, 3) : null;
  const upSec = parseFloat(get('UP=').split(/\s+/)[0]) || null;

  // 网络（排除 lo）
  let rx = 0, tx = 0;
  for (const l of lines) {
    if (!l.startsWith('NET=') && !/^\s*\w+.*:/.test(l)) continue;
    const m = l.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const iface = m[1].trim().replace(/^NET=/, '');
    if (iface === 'lo') continue;
    const nums = m[2].trim().split(/\s+/).map(Number);
    if (nums.length >= 16 && !nums.some(isNaN)) {
      rx += nums[0];
      tx += nums[8];
    }
  }
  let netRx = 0, netTx = 0;
  if (prev && prev.rx != null) {
    netRx = Math.max(0, rx - prev.rx);
    netTx = Math.max(0, tx - prev.tx);
  }
  prev = Object.assign({}, prev, { rx, tx });

  // 进程 TOP5
  const procs = [];
  for (const l of lines) {
    const m = l.match(/^PS=(.*)$/) || (l.match(/^\s*([\d.]+)\s+([\d.]+)\s+(\S+)\s*$/) && [null, l]);
    if (m) {
      const parts = (m[1] || l).trim().split(/\s+/);
      if (parts.length >= 3 && !isNaN(parseFloat(parts[0]))) {
        procs.push({ cpu: +parts[0], mem: +parts[1], name: parts.slice(2).join(' ') });
      }
    }
    if (procs.length >= 5) break;
  }

  return {
    os,
    cpuPercent,
    mem: memPercent != null ? { percent: memPercent, totalKB: memTotalKB, availKB: memAvailKB } : null,
    swap,
    disk, disks, load, upSec,
    net: { rxTotal: rx, txTotal: tx, rxBps: netRx / (MONITOR_INTERVAL / 1000), txBps: netTx / (MONITOR_INTERVAL / 1000) },
    procs,
    raw: prev
  };
}

server.listen(PORT, () => {
  console.log(`QxueSSH 已启动: http://localhost:${PORT}`);
  scheduleBackup(); // 启动时恢复自动备份定时器
});
