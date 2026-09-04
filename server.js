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

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MONITOR_INTERVAL = 2000;

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
  regEnabled: true,       // 站点注册开关
  meta: { lastSync: 0 },  // 云端数据最新同步时间
  backup: defaultBackupCfg()
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = Object.assign({
        users: [], hosts: [], tokens: {}, keys: [],
        loginLogs: {}, regEnabled: true, meta: { lastSync: 0 }
      }, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
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
}

let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error('保存数据库失败:', e.message);
    }
  }, 100);
}
loadDB();

/* ---------------- HTTP API ---------------- */
const app = express();
app.use(express.json({ limit: '2mb' }));
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
  if (String(username).toLowerCase() === 'qxue')
    return res.status(400).json({ error: '该用户名为管理员保留名，不可注册' });
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
  delete db.tokens[req.token];
  saveDB();
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
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { /* ignore */ }
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
  res.json({ count: db.users.length, regEnabled: db.regEnabled, users });
});

app_.post('/admin/registration', requireAdmin, (req, res) => {
  db.regEnabled = !!(req.body || {}).enabled;
  saveDB();
  res.json({ regEnabled: db.regEnabled });
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

/* 打包备份：data/db.json + server.js + public/ + package.json -> tar.gz */
function buildBackupArchive() {
  return new Promise((resolve, reject) => {
    try {
      // 先同步落盘数据库，确保备份里的数据是最新的
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const file = path.join(BACKUP_DIR, `qxuessh-backup-${stamp}.tar.gz`);
      execFile('tar', ['czf', file, 'server.js', 'package.json', 'public', 'data/db.json'],
        { cwd: __dirname }, (err) => {
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

/* ---------------- socket.io（SSH 会话） ---------------- */
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const MONITOR_CMD = [
  'echo "CPU=`grep \'^cpu \' /proc/stat`"',
  'echo "MEMT=`grep \'^MemTotal:\' /proc/meminfo`"',
  'echo "MEMA=`grep \'^MemAvailable:\' /proc/meminfo`"',
  'echo "SWAPT=`grep \'^SwapTotal:\' /proc/meminfo`"',
  'echo "SWAPF=`grep \'^SwapFree:\' /proc/meminfo`"',
  'df -B1 -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x proc -x sysfs 2>/dev/null | tail -n +2 | sed "s/^/DISK=/"',
  'echo "LOAD=`cat /proc/loadavg 2>/dev/null`"',
  'echo "UP=`cat /proc/uptime 2>/dev/null`"',
  'echo "NET=`cat /proc/net/dev 2>/dev/null`"',
  'echo "PS=`ps axo pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -6 | tail -5`"'
].join('; ');

io.on('connection', (socket) => {
  // connId -> { client, stream, sftp, sftpLoading, monitorTimer, monitorPrev, closed }
  const conns = new Map();

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
    const tick = () => {
      if (s.closed) return;
      s.client.exec(MONITOR_CMD, (err, stream) => {
        if (err || s.closed) return;
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.on('close', () => {
          try {
            const data = parseMonitor(out, s.monitorPrev);
            s.monitorPrev = data.raw;
            socket.emit('s:monitor', { connId, data });
          } catch (e) { /* ignore */ }
        });
        stream.stderr.on('data', () => {});
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
      try { s.stream.setWindow(rows, cols, 480, 640); } catch (e) { /* ignore */ }
    }
  });

  socket.on('c:ssh:close', ({ connId } = {}) => closeSession(connId));

  /* --- SFTP 文件管理 --- */
  function withSftp(connId, cb) {
    const s = getSession(connId);
    if (!s) return cb(new Error('连接不存在'));
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

  // 磁盘（所有实体分区，排除虚拟文件系统）
  const disks = [];
  for (const l of lines) {
    if (!l.startsWith('DISK=')) continue;
    const parts = l.slice(5).trim().split(/\s+/);
    if (parts.length >= 6) {
      const d = {
        fs: parts[0],
        total: +parts[1], used: +parts[2], avail: +parts[3],
        percent: parseFloat(parts[4]) || 0,
        mount: parts.slice(5).join(' ')
      };
      if (d.total > 0) disks.push(d);
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
