/* ============ QxueSSH 前端逻辑 ============ */
'use strict';

/* ---------------- 工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmtBytes(n, digits = 1) {
  if (n == null || isNaN(n)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : digits) + ' ' + units[i];
}
function fmtSpeed(n) { return n == null ? '--' : fmtBytes(n) + '/s'; }
function fmtPercent(n) { return n == null ? '--' : n.toFixed(1) + '%'; }
function fmtBytesC(n) { return n == null ? '--' : fmtBytes(n).replace(/\s/g, ''); }
function fmtDuration(sec) {
  if (sec == null) return '--';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分钟`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
  setTimeout(() => el.remove(), 2800);
}
function showEl(id) {
  $('#' + id).classList.remove('hidden');
  if (id === 'loginModal') loadCaptcha(); // 打开登录弹窗时加载验证码
}
function hideEl(id) { $('#' + id).classList.add('hidden'); }

/* 确认对话框 */
let confirmCb = null;
function confirmDlg(title, msg, cb) {
  $('#confirmTitle').textContent = title;
  $('#confirmMsg').textContent = msg;
  confirmCb = cb;
  showEl('confirmModal');
}
$('#btnConfirmOk').addEventListener('click', () => {
  hideEl('confirmModal');
  if (confirmCb) { const cb = confirmCb; confirmCb = null; cb(); }
});

/* 输入对话框 */
let inputCb = null;
function inputDlg(title, placeholder, value, cb) {
  $('#inputTitle').textContent = title;
  const inp = $('#inputValue');
  inp.value = value || '';
  inp.placeholder = placeholder || '';
  hideEl('inputError');
  inputCb = cb;
  showEl('inputModal');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}
$('#btnInputOk').addEventListener('click', () => {
  const v = $('#inputValue').value.trim();
  if (!v) { $('#inputError').textContent = '内容不能为空'; $('#inputError').classList.remove('hidden'); return; }
  hideEl('inputModal');
  if (inputCb) { const cb = inputCb; inputCb = null; cb(v); }
});
$('#inputValue').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnInputOk').click(); });

/* 关闭弹窗 */
document.addEventListener('click', e => {
  const closer = e.target.closest('[data-close]');
  if (closer) hideEl(closer.dataset.close);
  // idleModal 不可通过点击遮罩关闭（避免倒计时中误关导致意外断开）
  if (e.target.classList.contains('modal-mask') && e.target.id !== 'idleModal') e.target.classList.add('hidden');
});

/* ---------------- 全局状态 ---------------- */
const state = {
  token: localStorage.getItem('qxue_token') || null,
  user: null,
  hosts: [],
  conns: new Map(),      // connId -> {term, fit, box, tabEl, status, label, monitor, hostId}
  activeConnId: null,
  fileConnId: null,      // 文件面板绑定的连接
  filePath: '/',
  ctrlArmed: false,
  diskExpanded: false,
  settings: {
    theme: localStorage.getItem('qxue_theme') || 'qxue-light',
    fontSize: parseInt(localStorage.getItem('qxue_fontsize')) || 14,
    // 快捷键条：未手动设置过时，仅移动端（触屏 / 小屏）默认开启，PC 默认关闭
    quickKeys: localStorage.getItem('qxue_quickkeys') !== null
      ? localStorage.getItem('qxue_quickkeys') === '1'
      : (window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768),
    monitorBar: localStorage.getItem('qxue_monitorbar') !== '0'
  }
};

const socket = io({ auth: { token: state.token } });

/* ---------------- xterm 主题映射 ---------------- */
const TERM_THEMES = {
  'qxue-dark': {
    background: '#101216', foreground: '#e2e5ea', cursor: '#4f8cff', cursorAccent: '#101216',
    black: '#1a1d23', red: '#e5534b', green: '#3fb950', yellow: '#d29922',
    blue: '#4f8cff', magenta: '#b87ee8', cyan: '#39c5cf', white: '#d5d9e0',
    brightBlack: '#5c6472', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f2f5',
    selectionBackground: '#2d5a9e', selectionInactiveBackground: '#31415e'
  },
  'qxue-light': {
    background: '#ffffff', foreground: '#22262e', cursor: '#2f6fe4', cursorAccent: '#ffffff',
    black: '#22262e', red: '#d43b34', green: '#1a7f37', yellow: '#9a6700',
    blue: '#2f6fe4', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
    brightBlack: '#57606a', brightRed: '#cb2431', brightGreen: '#22863a', brightYellow: '#b08800',
    brightBlue: '#005cc5', brightMagenta: '#6f42c1', brightCyan: '#3192aa', brightWhite: '#22262e',
    selectionBackground: '#aad4ff', selectionInactiveBackground: '#d6e6f7'
  },
  'dracula': {
    background: '#21222c', foreground: '#f8f8f2', cursor: '#bd93f9', cursorAccent: '#21222c',
    black: '#000000', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#bfbfbf',
    brightBlack: '#4d4d4d', brightRed: '#ff6e67', brightGreen: '#5af78e', brightYellow: '#f4f99d',
    brightBlue: '#caa9fa', brightMagenta: '#ff92d0', brightCyan: '#9aedfe', brightWhite: '#e6e6e6',
    selectionBackground: '#44475a', selectionInactiveBackground: '#3b3d4e'
  },
  'nord': {
    background: '#272c36', foreground: '#e5e9f0', cursor: '#88c0d0', cursorAccent: '#272c36',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#d08770', brightGreen: '#97b67d', brightYellow: '#f0d69a',
    brightBlue: '#9fb8cf', brightMagenta: '#c3a3c9', brightCyan: '#a0d3e0', brightWhite: '#d8dee9',
    selectionBackground: '#434c5e', selectionInactiveBackground: '#3b4252'
  },
  'solarized-dark': {
    background: '#00212a', foreground: '#eee8d5', cursor: '#268bd2', cursorAccent: '#00212a',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#839900', brightYellow: '#657b83',
    brightBlue: '#005f87', brightMagenta: '#6c71c4', brightCyan: '#005f5f', brightWhite: '#fdf6e3',
    selectionBackground: '#0d4555', selectionInactiveBackground: '#073642'
  },
  'midnight': {
    background: '#0a1622', foreground: '#dce7f5', cursor: '#5eead4', cursorAccent: '#0a1622',
    black: '#12263a', red: '#ef6a5f', green: '#4ade80', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#5eead4', white: '#9db4cf',
    brightBlack: '#33506b', brightRed: '#f87171', brightGreen: '#86efac', brightYellow: '#fcd34d',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#99f6e4', brightWhite: '#e8f0fa',
    selectionBackground: '#1e4e79', selectionInactiveBackground: '#16324a'
  }
};

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  for (const c of state.conns.values()) {
    if (c.term) c.term.options.theme = TERM_THEMES[theme] || TERM_THEMES['qxue-dark'];
  }
}
function applyFontSize(size) {
  for (const c of state.conns.values()) {
    if (c.term) { c.term.options.fontSize = size; if (c.fit) setTimeout(() => c.fit.fit(), 30); }
  }
}
function applySettings() {
  applyTheme(state.settings.theme);
  $('#setTheme').value = state.settings.theme;
  $('#setFontSize').value = state.settings.fontSize;
  $('#fontSizeVal').textContent = state.settings.fontSize;
  $('#setQuickKeys').checked = state.settings.quickKeys;
  $('#setMonitorBar').checked = state.settings.monitorBar;
  $('#quickKeysBar').classList.toggle('hidden', !state.settings.quickKeys);
  $('#monitorBar').classList.toggle('hidden', !state.settings.monitorBar);
}

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ---------------- 认证 UI ---------------- */
let authMode = 'login';
let captchaId = null; // 当前验证码 ID

/* 图形验证码：获取 / 刷新 */
async function loadCaptcha() {
  try {
    const data = await api('/captcha');
    captchaId = data.captchaId;
    const img = $('#captchaImg');
    if (img) img.innerHTML = data.svg;
  } catch (e) { /* 验证码加载失败时不阻塞弹窗 */ }
}

function renderUserArea() {
  const area = $('#userArea');
  if (state.user) {
    const isAdmin = state.user.role === 'admin';
    area.innerHTML = `
      <span class="user-chip" id="btnProfile" title="个人设置" style="cursor:pointer">
        <span class="dot"></span>${escapeHtml(state.user.username)}${isAdmin ? ' 👑' : ''}
      </span>
      <span class="logout-link" id="btnLogout">退出</span>`;
    $('#btnProfile').addEventListener('click', openProfile);
    $('#btnLogout').addEventListener('click', async () => {
      try { await api('/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      state.token = null; state.user = null;
      localStorage.removeItem('qxue_token');
      state.hosts = [];
      customKeys = [];
      renderUserArea(); renderHosts(); renderQuickKeys();
      toast('已退出登录');
    });
  } else {
    area.innerHTML = '<button id="btnLogin" class="btn btn-ghost">登录</button>';
    $('#btnLogin').addEventListener('click', () => { showEl('loginModal'); setTimeout(() => $('#authUsername').focus(), 50); });
  }
}

$$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => {
  authMode = btn.dataset.authTab;
  $$('[data-auth-tab]').forEach(b => b.classList.toggle('active', b === btn));
  $('#loginTitle').textContent = authMode === 'login' ? '登录 QxueSSH' : '注册 QxueSSH';
  $('#btnAuthSubmit').textContent = authMode === 'login' ? '登录' : '注册';
  $('#authPassword').placeholder = authMode === 'login' ? '密码' : '密码（至少 8 位）';
  $('#authError').classList.add('hidden');
  loadCaptcha(); // 切换标签时刷新验证码
}));

// 点击验证码图片刷新
$('#captchaImg').addEventListener('click', loadCaptcha);

$('#btnAuthSubmit').addEventListener('click', async () => {
  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value;
  const captcha = $('#authCaptcha').value.trim();
  const authErr = m => { $('#authError').textContent = m; $('#authError').classList.remove('hidden'); };
  if (!username || !password) { authErr('请输入用户名和密码'); return; }
  if (authMode === 'register' && password.length < 8) { authErr('密码至少 8 位'); return; }
  if (!captcha) { authErr('请输入验证码'); return; }
  $('#btnAuthSubmit').disabled = true;
  try {
    const data = await api('/' + authMode, { method: 'POST', body: { username, password, captchaId, captcha } });
    state.token = data.token;
    state.user = { username: data.username, role: data.role || 'user' };
    localStorage.setItem('qxue_token', data.token);
    hideEl('loginModal');
    renderUserArea();
    await loadHosts();
    loadCustomKeys();
    toast(authMode === 'login' ? `欢迎回来，${data.username}` : `注册成功，欢迎 ${data.username}`, 'ok');
  } catch (e) {
    authErr(e.message);
    loadCaptcha(); // 失败后刷新验证码（验证码一次性使用）
    $('#authCaptcha').value = '';
  } finally {
    $('#btnAuthSubmit').disabled = false;
  }
});
$('#authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnAuthSubmit').click(); });
$('#authCaptcha').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnAuthSubmit').click(); });

/* ---------------- 主机列表 ---------------- */
async function loadHosts() {
  if (!state.user) { state.hosts = []; renderHosts(); return; }
  try {
    const data = await api('/hosts');
    state.hosts = data.hosts;
  } catch (e) {
    if (e.message.includes('未登录')) { state.user = null; state.token = null; localStorage.removeItem('qxue_token'); renderUserArea(); }
    state.hosts = [];
  }
  renderHosts();
}

function renderHosts() {
  const list = $('#hostList');
  const tip = $('#guestTip');
  if (!state.user) {
    tip.textContent = '当前未登录：SSH 功能需要登录后使用（防止站点被滥用）。登录后可保存多台主机并使用终端。';
    tip.classList.remove('hidden');
  } else {
    tip.classList.add('hidden');
  }
  if (!state.hosts.length) {
    list.innerHTML = '<div class="empty-hint">' + (state.user ? '还没有保存的主机，点击「+ 新增」添加一台吧' : '未登录，无保存数据') + '</div>';
    return;
  }
  list.innerHTML = state.hosts.map(h => `
    <div class="host-item" data-id="${h.id}">
      <div class="h-name">${escapeHtml(h.label)} <span class="h-badge">${h.port === 22 ? '22' : h.port}</span></div>
      <div class="h-addr">${escapeHtml(h.username)}@${escapeHtml(h.host)}</div>
      ${h.remark ? `<div class="h-remark" title="${escapeHtml(h.remark)}">📝 ${escapeHtml(h.remark)}</div>` : ''}
      <div class="h-actions">
        <button class="edit" title="编辑">✎</button>
        <button class="del" title="删除">🗑</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.host-item').forEach(item => {
    const id = item.dataset.id;
    item.addEventListener('click', e => {
      if (e.target.closest('.h-actions')) return;
      const host = state.hosts.find(h => h.id === id);
      if (host) connectHost(host);
    });
    item.querySelector('.edit').addEventListener('click', () => openHostModal(state.hosts.find(h => h.id === id)));
    item.querySelector('.del').addEventListener('click', () => {
      const host = state.hosts.find(h => h.id === id);
      confirmDlg('删除主机', `确定删除「${host.label}」吗？`, async () => {
        try {
          await api('/hosts/' + id, { method: 'DELETE' });
          state.hosts = state.hosts.filter(h => h.id !== id);
          renderHosts();
          toast('已删除', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  });
}

/* --- 主机编辑弹窗 --- */
let hostModalMode = 'add'; // add | edit
let hostEditId = null;
let hostAuthType = 'password';

function openHostModal(host) {
  hostModalMode = host ? 'edit' : 'add';
  hostEditId = host ? host.id : null;
  $('#hostModalTitle').textContent = host ? '编辑主机' : '新增主机';
  $('#hostLabel').value = host ? host.label : '';
  $('#hostRemark').value = host ? (host.remark || '') : '';
  $('#hostHost').value = host ? host.host : '';
  $('#hostPort').value = host ? host.port : 22;
  $('#hostUsername').value = host ? host.username : '';
  $('#hostPassword').value = '';
  $('#hostPrivateKey').value = '';
  $('#hostKeyPassphrase').value = '';
  $('#hostError').classList.add('hidden');
  setHostAuthType(host ? host.authType : 'password');
  showEl('hostModal');
}
function setHostAuthType(t) {
  hostAuthType = t;
  $$('#hostModal [data-authtype]').forEach(b => b.classList.toggle('active', b.dataset.authtype === t));
  $('#authPasswordWrap').classList.toggle('hidden', t === 'key');
  $('#authKeyWrap').classList.toggle('hidden', t !== 'key');
}
$$('#hostModal [data-authtype]').forEach(btn => btn.addEventListener('click', () => setHostAuthType(btn.dataset.authtype)));

$('#btnAddHost').addEventListener('click', () => {
  if (!state.user) { toast('请先登录后再保存主机', 'err'); showEl('loginModal'); return; }
  openHostModal(null);
});

$('#btnHostSave').addEventListener('click', async () => {
  const body = {
    label: $('#hostLabel').value,
    remark: $('#hostRemark').value,
    host: $('#hostHost').value.trim(),
    port: $('#hostPort').value || 22,
    username: $('#hostUsername').value.trim(),
    authType: hostAuthType,
    password: hostAuthType === 'key' ? $('#hostKeyPassphrase').value : $('#hostPassword').value,
    privateKey: hostAuthType === 'key' ? $('#hostPrivateKey').value : ''
  };
  if (!body.host || !body.username) { $('#hostError').textContent = '请填写主机地址和用户名'; $('#hostError').classList.remove('hidden'); return; }
  try {
    if (hostModalMode === 'edit') {
      const old = state.hosts.find(h => h.id === hostEditId);
      // 密码/密钥留空则沿用旧值
      if (!body.password && old && old.authType === body.authType) body.password = undefined;
      if (body.authType === 'key' && !body.privateKey) body.privateKey = undefined;
      const data = await api('/hosts/' + hostEditId, { method: 'PUT', body });
      const i = state.hosts.findIndex(h => h.id === hostEditId);
      state.hosts[i] = data.host;
    } else {
      const data = await api('/hosts', { method: 'POST', body });
      state.hosts.push(data.host);
    }
    hideEl('hostModal');
    renderHosts();
    toast('已保存', 'ok');
  } catch (e) {
    $('#hostError').textContent = e.message; $('#hostError').classList.remove('hidden');
  }
});

/* --- 快速连接（需登录） --- */
function requireLoginForSSH() {
  if (state.token) return true;
  toast('SSH 功能需要登录后使用，请先登录或注册', 'err');
  showEl('loginModal');
  return false;
}
$('#btnQuickConnect').addEventListener('click', () => {
  if (!requireLoginForSSH()) return;
  showEl('quickModal'); setTimeout(() => $('#qcHost').focus(), 50);
});
$('#btnNewTab').addEventListener('click', () => {
  if (!requireLoginForSSH()) return;
  showEl('quickModal'); setTimeout(() => $('#qcHost').focus(), 50);
});
$('#btnQcConnect').addEventListener('click', () => {
  const host = $('#qcHost').value.trim();
  const username = $('#qcUsername').value.trim();
  if (!host || !username) { $('#qcError').textContent = '请填写主机地址和用户名'; $('#qcError').classList.remove('hidden'); return; }
  hideEl('quickModal');
  collapsePanelOnMobile();
  createSession({
    label: `${username}@${host}`,
    creds: { host, port: +$('#qcPort').value || 22, username, password: $('#qcPassword').value, authType: 'password' }
  });
  $('#qcPassword').value = '';
});

function connectHost(host) {
  // 密码不回传前端：用 hostId 让服务端取库里的凭据
  collapsePanelOnMobile();
  createSession({ label: host.label, hostId: host.id, remark: host.remark });
}

/* ---------------- 终端会话 ---------------- */
function createSession({ label, hostId, creds }) {
  if (!state.token) { toast('SSH 功能需要登录后使用', 'err'); showEl('loginModal'); return; }
  // 移除欢迎页
  if (window._welcomeBox) { window._welcomeBox.remove(); window._welcomeBox = null; }
  const connId = uuid();
  const box = document.createElement('div');
  box.className = 'term-box';
  box.id = 'termbox-' + connId;
  $('#terminals').appendChild(box);

  const term = new Terminal({
    fontSize: state.settings.fontSize,
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "Courier New", monospace',
    theme: TERM_THEMES[state.settings.theme] || TERM_THEMES['qxue-dark'],
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  fit.fit();

  term.onData(data => {
    if (state.ctrlArmed && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        data = String.fromCharCode(code - 64);
        disarmCtrl();
      }
    }
    markActive(connId);
    socket.emit('c:ssh:input', { connId, data });
  });

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="tab-status connecting"></span><span class="tab-label">${escapeHtml(label)}</span><span class="tab-close">×</span>`;
  tabEl.addEventListener('click', e => {
    if (e.target.classList.contains('tab-close')) { closeSession(connId); return; }
    switchSession(connId);
  });
  $('#tabList').appendChild(tabEl);

  const conn = { connId, term, fit, box, tabEl, status: 'connecting', label, hostId, monitor: null, lastActive: Date.now(), busy: 0 };
  state.conns.set(connId, conn);

  // 尺寸自适应
  const ro = new ResizeObserver(() => {
    if (!box.classList.contains('active')) return;
    try {
      fit.fit();
      socket.emit('c:ssh:resize', { connId, cols: term.cols, rows: term.rows });
    } catch (e) { /* ignore */ }
  });
  ro.observe(box);
  conn.ro = ro;

  switchSession(connId);

  term.writeln('\x1b[90m正在连接 ' + (creds ? creds.username + '@' + creds.host : label) + ' …\x1b[0m');

  socket.emit('c:ssh:connect', {
    connId, hostId, token: state.token,
    cols: term.cols, rows: term.rows, ...(creds || {})
  });
}

function switchSession(connId) {
  state.activeConnId = connId;
  for (const c of state.conns.values()) {
    const active = c.connId === connId;
    c.box.classList.toggle('active', active);
    c.tabEl.classList.toggle('active', active);
    if (active && c.fit) setTimeout(() => {
      try { c.fit.fit(); socket.emit('c:ssh:resize', { connId: c.connId, cols: c.term.cols, rows: c.term.rows }); } catch (e) { /* ignore */ }
    }, 30);
  }
  updateMonitorDisplay();
  if ($('#panel-files').classList.contains('active') || !$('#fileList .empty-hint')) refreshFilesIfReady();
}

function closeSession(connId) {
  const c = state.conns.get(connId);
  if (!c) return;
  socket.emit('c:ssh:close', { connId });
  try { c.ro.disconnect(); } catch (e) { /* ignore */ }
  try { c.term.dispose(); } catch (e) { /* ignore */ }
  c.box.remove(); c.tabEl.remove();
  state.conns.delete(connId);
  if (state.activeConnId === connId) {
    const next = [...state.conns.keys()].pop();
    if (next) switchSession(next);
    else { state.activeConnId = null; updateMonitorDisplay(); }
  }
  if (state.fileConnId === connId) { state.fileConnId = null; renderFiles(); }
}

/* ---------------- socket 事件 ---------------- */
socket.on('s:ssh:data', ({ connId, data }) => {
  const c = state.conns.get(connId);
  if (c) { c.term.write(data); markActive(connId); }
});

socket.on('s:ssh:status', ({ connId, status, message }) => {
  const c = state.conns.get(connId);
  if (!c) return;
  c.status = status;
  const dot = c.tabEl.querySelector('.tab-status');
  dot.className = 'tab-status ' + (status === 'connected' ? 'connected' : status === 'error' ? 'error' : status === 'connecting' ? 'connecting' : '');
  if (status === 'connected') {
    if (state.fileConnId == null) { state.fileConnId = connId; refreshFilesIfReady(); }
    updateMonitorDisplay();
  } else if (status === 'error') {
    c.term.writeln('\r\n\x1b[31m✗ 连接失败：' + message + '\x1b[0m');
    toast('连接失败：' + message, 'err');
  } else if (status === 'closed') {
    c.term.writeln('\r\n\x1b[90m—— 连接已关闭 ——\x1b[0m');
  }
  updateMonitorDisplay();
});

socket.on('s:monitor', ({ connId, data }) => {
  const c = state.conns.get(connId);
  if (!c) return;
  c.monitor = data;
  if (connId === state.activeConnId) updateMonitorDisplay();
});

socket.on('disconnect', () => {
  for (const c of state.conns.values()) {
    if (c.status === 'connected') {
      c.status = 'closed';
      c.tabEl.querySelector('.tab-status').className = 'tab-status error';
      c.term.writeln('\r\n\x1b[31m—— 与 QxueSSH 服务器的连接中断，请刷新页面重试 ——\x1b[0m');
    }
  }
  updateMonitorDisplay();
});

/* ---------------- 会话空闲检测 ---------------- */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 连续 30 分钟无操作则提醒
const IDLE_COUNTDOWN_SEC = 15;          // 提醒后 15 秒无响应则断开
let idlePromptConnId = null;            // 当前正在提醒的会话
let idleCountdown = 0;
let idleTimer = null;

// 标记会话有活动（终端输入/输出等）；若正处于空闲倒计时则取消提醒
function markActive(connId) {
  const c = state.conns.get(connId);
  if (!c) return;
  c.lastActive = Date.now();
  if (idlePromptConnId === connId) cancelIdlePrompt();
}

// SFTP 等后台操作计数：操作进行中（如下载/上传/读取）不视为空闲
function sftpBusy(connId, delta) {
  const c = state.conns.get(connId);
  if (!c) return;
  c.busy = Math.max(0, (c.busy || 0) + delta);
  if (c.busy > 0) c.lastActive = Date.now();
}

function cancelIdlePrompt() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  idlePromptConnId = null;
  hideEl('idleModal');
}

function idleCheck() {
  if (idlePromptConnId) return; // 一次只处理一个提醒
  const now = Date.now();
  let target = null;
  for (const c of state.conns.values()) {
    if (c.status !== 'connected' || (c.busy || 0) > 0) continue;
    if (now - (c.lastActive || 0) >= IDLE_TIMEOUT_MS && (!target || c.lastActive < target.lastActive)) target = c;
  }
  if (target) showIdlePrompt(target);
}

function showIdlePrompt(c) {
  idlePromptConnId = c.connId;
  idleCountdown = IDLE_COUNTDOWN_SEC;
  $('#idleMsg').textContent = `会话「${c.label}」已长时间未操作，是否保持会话状态？${IDLE_COUNTDOWN_SEC} 秒内无响应将自动断开连接。`;
  $('#idleCount').textContent = idleCountdown;
  showEl('idleModal');
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    idleCountdown--;
    const conn = state.conns.get(idlePromptConnId);
    if (!conn || conn.status !== 'connected') { cancelIdlePrompt(); return; }
    if (idleCountdown <= 0) {
      cancelIdlePrompt();
      conn.term.writeln('\r\n\x1b[90m—— 长时间未操作，连接已自动断开 ——\x1b[0m');
      closeSession(conn.connId);
      toast(`会话「${conn.label}」因长时间未操作已断开`);
      return;
    }
    $('#idleCount').textContent = idleCountdown;
  }, 1000);
}

// 保持会话：重置空闲计时，下次到达空闲时长会再次提醒
$('#btnIdleKeep').addEventListener('click', () => {
  const id = idlePromptConnId;
  cancelIdlePrompt();
  const c = state.conns.get(id);
  if (c) c.lastActive = Date.now();
});
$('#idleCloseBtn').addEventListener('click', () => $('#btnIdleKeep').click());
$('#btnIdleDisconnect').addEventListener('click', () => {
  const id = idlePromptConnId;
  cancelIdlePrompt();
  const c = state.conns.get(id);
  if (c) closeSession(c.connId);
});
setInterval(idleCheck, 1000);

/* ---------------- 监控显示 ---------------- */
function setBar(el, percent) {
  el.style.width = (percent || 0) + '%';
  el.className = 'm-bar-fill' + (percent >= 90 ? ' crit' : percent >= 70 ? ' warn' : '');
}

function barCls(p) { return 'm-bar-fill' + (p >= 90 ? ' crit' : p >= 70 ? ' warn' : ''); }

function updateMonitorDisplay() {
  const c = state.conns.get(state.activeConnId);
  const m = c && c.monitor;

  // 底部长条
  $('#mConnVal').textContent = !c ? '未连接' :
    c.status === 'connected' ? '已连接' : c.status === 'connecting' ? '连接中' :
    c.status === 'error' ? '连接失败' : '已断开';
  $('#mCpuVal').textContent = m ? fmtPercent(m.cpuPercent) : '--';
  setBar($('#mCpuBar'), m ? m.cpuPercent : 0);
  $('#mMemVal').textContent = m && m.mem
    ? fmtBytesC((m.mem.totalKB - m.mem.availKB) * 1024) + '/' + fmtBytesC(m.mem.totalKB * 1024)
    : '--';
  setBar($('#mMemBar'), m && m.mem ? m.mem.percent : 0);
  $('#mDiskVal').textContent = m && m.disk
    ? fmtBytesC(m.disk.used) + '/' + fmtBytesC(m.disk.total)
    : '--';
  setBar($('#mDiskBar'), m && m.disk ? m.disk.percent : 0);
  $('#mRxVal').textContent = m ? fmtSpeed(m.net.rxBps) : '--';
  $('#mTxVal').textContent = m ? fmtSpeed(m.net.txBps) : '--';
  $('#mLoadVal').textContent = m && m.load ? m.load.map(x => x.toFixed(2)).join(' ') : '--';

  // 侧边监控面板
  const panel = $('#monitorPanel');
  if (!m) {
    panel.innerHTML = '<div class="empty-hint">连接主机后显示监控数据</div>';
    return;
  }
  const mon = (title, value, percent) => `
    <div class="mon-card">
      <div class="mc-title"><span>${title}</span><span>${percent != null ? fmtPercent(percent) : ''}</span></div>
      <div class="mc-value">${value}</div>
      ${percent != null ? `<div class="m-bar"><div class="${barCls(percent)}" style="width:${percent}%"></div></div>` : ''}
    </div>`;
  let html = mon('CPU 使用率', m.cpuPercent != null ? m.cpuPercent.toFixed(1) + '%' : '--', m.cpuPercent);
  if (m.mem) {
    const usedB = (m.mem.totalKB - m.mem.availKB) * 1024;
    const totalB = m.mem.totalKB * 1024;
    const availB = m.mem.availKB * 1024;
    html += `
    <div class="mon-card">
      <div class="mc-title"><span>内存</span><span>${fmtPercent(m.mem.percent)}</span></div>
      <div class="mc-value">${fmtBytes(usedB)} / ${fmtBytes(totalB)}</div>
      <div class="m-bar"><div class="${barCls(m.mem.percent)}" style="width:${m.mem.percent}%"></div></div>
      <div class="mon-kv"><span>总内存</span><span>${fmtBytes(totalB)}</span></div>
      <div class="mon-kv"><span>已用</span><span>${fmtBytes(usedB)}（${fmtPercent(m.mem.percent)}）</span></div>
      <div class="mon-kv"><span>可用</span><span>${fmtBytes(availB)}</span></div>
      ${m.swap != null ? `
      <div class="mon-kv"><span>Swap 已用</span><span>${fmtBytes(m.swap.usedKB * 1024)} / ${fmtBytes(m.swap.totalKB * 1024)}（${fmtPercent(m.swap.percent)}）</span></div>
      <div class="m-bar"><div class="${barCls(m.swap.percent)}" style="width:${m.swap.percent}%"></div></div>`
        : '<div class="mon-kv"><span>Swap</span><span>未启用</span></div>'}
    </div>`;
  }
  if (m.disk) {
    const multi = m.disks && m.disks.length > 1;
    html += `
    <div class="mon-card disk-card" title="${multi ? '点击查看全部分区' : ''}">
      <div class="mc-title">
        <span>磁盘（${escapeHtml(m.disk.mount || '/')}）</span>
        ${multi ? `<span class="disk-expand-hint">${state.diskExpanded ? '收起分区 ▴' : '全部分区 ▾'}</span>` : ''}
      </div>
      <div class="mc-value">${fmtBytes(m.disk.used)} / ${fmtBytes(m.disk.total)}</div>
      <div class="m-bar"><div class="${barCls(m.disk.percent)}" style="width:${m.disk.percent}%"></div></div>
      <div class="mon-kv"><span>已用</span><span>${fmtBytes(m.disk.used)}（${fmtPercent(m.disk.percent)}）</span></div>
      <div class="mon-kv"><span>剩余</span><span>${fmtBytes(m.disk.avail)}</span></div>
      ${state.diskExpanded && m.disks && m.disks.length ? `
      <div class="disk-sub">
        ${m.disks.map(d => `
        <div class="ds-row">
          <div class="ds-head">
            <span class="ds-mount" title="${escapeHtml(d.fs)}">📀 ${escapeHtml(d.mount)}</span>
            <span>${fmtBytes(d.used)} / ${fmtBytes(d.total)}</span>
          </div>
          <div class="m-bar"><div class="${barCls(d.percent)}" style="width:${d.percent}%"></div></div>
          <div class="ds-avail">已用 ${fmtBytes(d.used)} · 剩余 ${fmtBytes(d.avail)} · ${fmtPercent(d.percent)}</div>
        </div>`).join('')}
      </div>` : ''}
    </div>`;
  }
  html += `
    <div class="mon-card">
      <div class="mc-title"><span>网络</span></div>
      <div class="mon-kv"><span>↓ 下载速度</span><span>${fmtSpeed(m.net.rxBps)}</span></div>
      <div class="mon-kv"><span>↑ 上传速度</span><span>${fmtSpeed(m.net.txBps)}</span></div>
      <div class="mon-kv"><span>累计下载</span><span>${fmtBytes(m.net.rxTotal)}</span></div>
      <div class="mon-kv"><span>累计上传</span><span>${fmtBytes(m.net.txTotal)}</span></div>
    </div>
    <div class="mon-card">
      <div class="mc-title"><span>负载与运行</span></div>
      ${m.load ? m.load.map((l, i) => `<div class="mon-kv"><span>${['1 分钟', '5 分钟', '15 分钟'][i]}负载</span><span>${l.toFixed(2)}</span></div>`).join('') : ''}
      <div class="mon-kv"><span>运行时长</span><span>${fmtDuration(m.upSec)}</span></div>
    </div>`;
  if (m.procs && m.procs.length) {
    html += `
    <div class="mon-card">
      <div class="mc-title"><span>进程 TOP5（CPU）</span></div>
      ${m.procs.map(p => `<div class="proc-row"><span class="p-name">${escapeHtml(p.name)}</span><span>CPU ${p.cpu}%</span><span>MEM ${p.mem}%</span></div>`).join('')}
    </div>`;
  }
  panel.innerHTML = html;

  // 磁盘卡片点击展开/收起分区
  const diskCard = panel.querySelector('.disk-card');
  if (diskCard) {
    diskCard.addEventListener('click', () => {
      state.diskExpanded = !state.diskExpanded;
      updateMonitorDisplay();
    });
  }
}

/* ---------------- Docker 容器管理 ---------------- */
const DOCKER_REFRESH_MS = 10000; // 面板激活时自动刷新间隔
const RESTART_POLICY_LABELS = {
  'no': '不自动重启',
  'always': '总是重启',
  'unless-stopped': '退出后自动重启（手动停止除外）',
  'on-failure': '异常退出时重启'
};
// 下拉框短标签（完整含义放 title 提示）
const RESTART_POLICY_SHORT = {
  'no': '不重启',
  'always': '总是重启',
  'unless-stopped': '自动重启',
  'on-failure': '异常时重启'
};

// 端口映射简化：去掉 0.0.0.0:/[::]: 前缀并合并 IPv4/IPv6 重复项
// 例：0.0.0.0:6180-6200->6180-6200/tcp, [::]:6180-6200->6180-6200/tcp → 6180-6200->6180-6200/tcp
function simplifyPorts(portsStr) {
  const seen = new Set();
  const list = [];
  for (const raw of (portsStr || '').split(', ')) {
    if (!raw) continue;
    // 去掉通配绑定前缀（保留特定 IP 绑定）
    let p = raw.replace(/^(0\.0\.0\.0|\[::\]):/, '');
    if (seen.has(p)) continue;
    seen.add(p);
    list.push(p);
  }
  return list;
}

// 端口折叠状态：容器名 -> 是否展开
state.dockerPortsOpen = {};
state.docker = { info: null, containers: [], images: [], loading: false, error: null, imagesError: null };

function dockerCall(event, payload, cb, silent) {
  const c = currentFileConn();
  if (!c) { if (!silent) toast('请先连接主机', 'err'); return; }
  socket.emit(event, { connId: c.connId, ...payload }, res => {
    if (res && res.error) { if (!silent) toast(res.error, 'err'); if (cb) cb(null, res.error); }
    else if (cb) cb(res);
  });
}

async function refreshDocker() {
  const panel = $('#panel-docker');
  if (!panel.classList.contains('active')) return; // 仅面板可见时刷新
  const c = currentFileConn();
  if (!c) {
    state.docker = { info: null, containers: [], images: [], loading: false, error: null, imagesError: null };
    renderDocker();
    return;
  }
  if (state.docker.loading) return;
  state.docker.loading = true;
  renderDocker();
  const done = () => { state.docker.loading = false; renderDocker(); };
  dockerCall('c:docker:info', {}, res => {
    state.docker.info = res ? { version: res.version, rootDir: res.rootDir } : null;
    state.docker.error = res ? null : '未检测到 Docker（未安装或当前用户无权限）';
    if (!res) { state.docker.containers = []; state.docker.images = []; done(); return; }
    dockerCall('c:docker:list', {}, r => {
      state.docker.containers = r ? r.containers : [];
      done();
    }, true);
    dockerCall('c:docker:images', {}, r => {
      state.docker.images = r ? r.images : [];
      state.docker.imagesError = r ? null : '镜像列表读取失败';
      renderDocker();
    }, true);
  });
}

function dockerAction(action, ctr) {
  const run = () => {
    toast(`正在${{ start: '启动', stop: '停止', restart: '重启' }[action]}容器 ${ctr.name} …`);
    dockerCall('c:docker:action', { name: ctr.name, action }, () => setTimeout(refreshDocker, 800));
  };
  if (action === 'start') run();
  else confirmDlg(`${{ stop: '停止', restart: '重启' }[action]}容器`, `确定${{ stop: '停止', restart: '重启' }[action]}容器「${ctr.name}」吗？`, run);
}

function renderDocker() {
  const panel = $('#dockerPanel');
  const d = state.docker;
  if (!currentFileConn()) {
    panel.innerHTML = '<div class="empty-hint">连接主机后显示容器信息</div>';
    return;
  }
  if (d.error) {
    panel.innerHTML = `<div class="empty-hint">${escapeHtml(d.error)}</div>`;
    return;
  }
  if (d.loading && !d.info) {
    panel.innerHTML = '<div class="empty-hint">正在读取 Docker 信息…</div>';
    return;
  }

  let html = '';
  // Docker 信息卡片
  if (d.info) {
    const running = d.containers.filter(x => x.state === 'running').length;
    html += `
    <div class="mon-card">
      <div class="mc-title"><span>Docker</span><span>v${escapeHtml(d.info.version)}</span></div>
      <div class="mon-kv"><span>容器</span><span>${running} 运行 / ${d.containers.length} 总计</span></div>
      <div class="mon-kv"><span>镜像数</span><span>${d.images.length || '--'}${d.loading ? ' …' : ''}</span></div>
      ${d.info.rootDir ? `<div class="mon-kv"><span>存储位置</span><span title="${escapeHtml(d.info.rootDir)}">${escapeHtml(d.info.rootDir)}</span></div>` : ''}
    </div>`;
  }

  // 容器列表
  if (d.containers.length) {
    html += `
    <div class="mon-card dk-list-card">
      <div class="mc-title"><span>容器（${d.containers.length}）</span>${d.loading ? '<span class="dk-loading">刷新中…</span>' : ''}</div>
      ${d.containers.map(ctr => {
        const running = ctr.state === 'running';
        const ports = simplifyPorts(ctr.ports);
        const portsOpen = !!state.dockerPortsOpen[ctr.name];
        return `
        <div class="dk-ctr" data-name="${escapeHtml(ctr.name)}">
          <div class="dk-ctr-head">
            <span class="tab-status ${running ? 'connected' : 'error'}"></span>
            <span class="dk-name" title="${escapeHtml(ctr.name)}（${escapeHtml(ctr.id)}）">${escapeHtml(ctr.name)}</span>
            <span class="dk-actions">
              <button class="dk-btn" data-dk-act="start" ${running ? 'disabled' : ''} title="启动">▶</button>
              <button class="dk-btn" data-dk-act="stop" ${running ? '' : 'disabled'} title="停止">■</button>
              <button class="dk-btn" data-dk-act="restart" ${running ? '' : 'disabled'} title="重启">↻</button>
              <button class="dk-btn" data-dk-act="logs" title="查看日志">▤</button>
            </span>
          </div>
          <div class="dk-ctr-body">
            <div class="mon-kv"><span>状态</span><span>${escapeHtml(ctr.status)}</span></div>
            <div class="mon-kv"><span>镜像</span><span>${escapeHtml(ctr.image)}</span></div>
            ${ports.length ? `
            <div class="dk-ports-toggle${portsOpen ? ' open' : ''}" data-dk-ports="${escapeHtml(ctr.name)}">
              <span class="dk-ports-arrow">${portsOpen ? '▾' : '▸'}</span>端口映射（${ports.length}）
            </div>
            ${portsOpen ? `<div class="dk-ports-list">${ports.map(p => `<div class="dk-port" title="${escapeHtml(p)}">${escapeHtml(p)}</div>`).join('')}</div>` : ''}` : ''}
            ${ctr.stats ? `<div class="mon-kv"><span>资源占用</span><span>CPU ${escapeHtml(ctr.stats.cpu)} · 内存 ${escapeHtml(ctr.stats.memUsage)}（${escapeHtml(ctr.stats.memPerc)}）</span></div>` : ''}
            <div class="mon-kv dk-policy-row"><span>重启策略</span>
              <select class="dk-policy" data-name="${escapeHtml(ctr.name)}" title="当前：${RESTART_POLICY_LABELS[ctr.restartPolicy] || ctr.restartPolicy}">
                ${Object.keys(RESTART_POLICY_SHORT).map(p => `<option value="${p}" ${p === ctr.restartPolicy ? 'selected' : ''}>${RESTART_POLICY_SHORT[p]}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  } else if (d.info && !d.loading) {
    html += '<div class="mon-card"><div class="mc-title"><span>容器</span></div><div class="empty-hint">暂无容器</div></div>';
  }

  // 镜像列表
  if (d.images.length) {
    html += `
    <div class="mon-card dk-list-card">
      <div class="mc-title"><span>镜像（${d.images.length}）</span></div>
      ${d.images.map(img => {
        const dangling = img.repo === '<none>:<none>';
        return `
        <div class="dk-img">
          <div class="dk-img-head">
            <span class="dk-name" title="${escapeHtml(img.id)}">${dangling ? '📦 &lt;悬空镜像&gt;' : '📦 ' + escapeHtml(img.repo)}</span>
            <button class="dk-btn dk-del" data-dk-img="${escapeHtml(img.id)}" title="删除镜像">🗑</button>
          </div>
          <div class="dk-ctr-body">
            <div class="mon-kv"><span>大小</span><span>${escapeHtml(img.size)}</span></div>
            <div class="mon-kv"><span>创建时间</span><span>${escapeHtml(img.createdAt)}</span></div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  } else if (d.info && !d.loading && !d.imagesError) {
    html += '<div class="mon-card"><div class="mc-title"><span>镜像</span></div><div class="empty-hint">暂无镜像</div></div>';
  }
  panel.innerHTML = html;
}

// 容器操作 / 日志 / 端口展开 / 重启策略切换（事件委托）
$('#dockerPanel').addEventListener('click', e => {
  // 端口映射展开/收起
  const pt = e.target.closest('[data-dk-ports]');
  if (pt) {
    const name = pt.dataset.dkPorts;
    state.dockerPortsOpen[name] = !state.dockerPortsOpen[name];
    renderDocker();
    return;
  }
  const btn = e.target.closest('[data-dk-act]');
  if (btn) {
    const ctr = state.docker.containers.find(x => x.name === btn.closest('.dk-ctr').dataset.name);
    if (!ctr) return;
    const act = btn.dataset.dkAct;
    if (act === 'logs') {
      $('#dockerLogTitle').textContent = `容器日志 - ${ctr.name}`;
      $('#dockerLogContent').textContent = '加载中…';
      showEl('dockerLogModal');
      dockerCall('c:docker:logs', { name: ctr.name }, res => {
        $('#dockerLogContent').textContent = res ? res.logs : '日志读取失败';
        $('#dockerLogContent').scrollTop = 0;
      });
    } else {
      dockerAction(act, ctr);
    }
    return;
  }
  const del = e.target.closest('[data-dk-img]');
  if (del) {
    const id = del.dataset.dkImg;
    const img = state.docker.images.find(x => x.id === id);
    const label = img && img.repo !== '<none>:<none>' ? img.repo : id.slice(0, 12);
    confirmDlg('删除镜像', `确定删除镜像「${label}」吗？${img && state.docker.containers.some(c => c.image === img.repo) ? '注意：仍有容器在使用该镜像，可能删除失败。' : ''}`, () => {
      dockerCall('c:docker:rmi', { image: id }, () => setTimeout(refreshDocker, 500));
    });
  }
});

// 重启策略快捷切换
$('#dockerPanel').addEventListener('change', e => {
  const sel = e.target.closest('.dk-policy');
  if (!sel) return;
  const name = sel.dataset.name;
  const policy = sel.value;
  dockerCall('c:docker:policy', { name, policy }, () => {
    toast(`已将「${name}」重启策略切换为：${RESTART_POLICY_LABELS[policy]}`, 'ok');
    const ctr = state.docker.containers.find(x => x.name === name);
    if (ctr) ctr.restartPolicy = policy;
  });
});

$('#btnDockerRefresh').addEventListener('click', refreshDocker);
setInterval(refreshDocker, DOCKER_REFRESH_MS); // 面板激活时自动刷新（含 docker stats 资源占用）

/* ---------------- 文件管理 ---------------- */
function currentFileConn() {
  let c = state.conns.get(state.fileConnId);
  if (!c || c.status !== 'connected') {
    c = state.conns.get(state.activeConnId);
    if (c && c.status === 'connected') state.fileConnId = c.connId;
    else c = null;
  }
  return c;
}

function refreshFilesIfReady() {
  const c = currentFileConn();
  if (c) listFiles(state.filePath || null);
  else renderFiles();
}

async function listFiles(p) {
  const c = currentFileConn();
  if (!c) { renderFiles(); return; }
  if (p == null) {
    // 首次：取 HOME
    sftpBusy(c.connId, +1);
    socket.emit('c:sftp:home', { connId: c.connId }, res => {
      sftpBusy(c.connId, -1);
      if (res && res.path) listFiles(res.path);
      else listFiles('/');
    });
    return;
  }
  sftpBusy(c.connId, +1);
  socket.emit('c:sftp:list', { connId: c.connId, path: p }, res => {
    sftpBusy(c.connId, -1);
    if (res && res.error) {
      $('#fileList').innerHTML = `<div class="empty-hint">读取失败：${escapeHtml(res.error)}</div>`;
      return;
    }
    state.filePath = p;
    renderBreadcrumb(p);
    renderFiles(res.list || []);
  });
}

function renderBreadcrumb(p) {
  const parts = p.split('/').filter(Boolean);
  let html = '<span class="crumb" data-path="/">/</span>';
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    html += `<span class="crumb-sep">›</span><span class="crumb" data-path="${escapeHtml(cur)}">${escapeHtml(part)}</span>`;
  }
  const bc = $('#fileBreadcrumb');
  bc.innerHTML = html;
  bc.querySelectorAll('.crumb').forEach(el => el.addEventListener('click', () => listFiles(el.dataset.path)));
}

function renderFiles(list) {
  const el = $('#fileList');
  updatePasteBtn();
  if (!list) {
    const c = currentFileConn();
    el.innerHTML = `<div class="empty-hint">${c ? '加载中…' : '请先连接主机（左侧「连接」面板）'}</div>`;
    return;
  }
  state.fileList = list;
  if (!list.length) { el.innerHTML = '<div class="empty-hint">空目录</div>'; return; }
  el.innerHTML = list.map(f => {
    const full = joinPath(state.filePath, f.name);
    const isCut = state.clipboard && state.clipboard.mode === 'cut' && state.clipboard.path === full;
    return `
    <div class="file-row${isCut ? ' is-cut' : ''}" data-name="${escapeHtml(f.name)}" data-type="${f.type}">
      <span class="f-icon">${f.type === 'dir' ? '📁' : f.type === 'link' ? '🔗' : '📄'}</span>
      <span class="f-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="f-size">${f.type === 'file' ? fmtBytes(f.size) : ''}</span>
      <span class="f-act">
        <button class="cp" title="复制">⧉</button>
        <button class="mv" title="剪切">✂</button>
        <button class="rn" title="重命名">✎</button>
        <button class="dl" title="下载">⭳</button>
        <button class="del" title="删除">🗑</button>
      </span>
    </div>`;
  }).join('');
  el.querySelectorAll('.file-row').forEach(row => {
    const name = row.dataset.name;
    const type = row.dataset.type;
    const full = joinPath(state.filePath, name);
    row.addEventListener('click', e => {
      if (e.target.closest('.f-act')) return;
      if (type === 'dir') listFiles(full);
      else if (type === 'file') openFile(full, name);
      else toast('暂不支持打开符号链接');
    });
    row.querySelector('.cp').addEventListener('click', () => setClipboard('copy', full, name, type));
    row.querySelector('.mv').addEventListener('click', () => setClipboard('cut', full, name, type));
    row.querySelector('.rn').addEventListener('click', () => {
      inputDlg('重命名', '新名称', name, v => {
        if (v === name) return;
        sftpCall('c:sftp:rename', { path: full, newPath: joinPath(state.filePath, v) }, () => listFiles(state.filePath));
      });
    });
    row.querySelector('.dl').addEventListener('click', () => downloadFile(full, name));
    row.querySelector('.del').addEventListener('click', () => {
      confirmDlg('删除', `确定删除「${name}」${type === 'dir' ? '（目录需为空）' : ''}吗？`, () => {
        sftpCall('c:sftp:delete', { path: full }, () => { toast('已删除', 'ok'); listFiles(state.filePath); });
      });
    });
  });
}

/* --- 复制 / 剪切 / 粘贴 --- */
state.clipboard = null; // { mode: 'copy'|'cut', path, name, type, connId }

function setClipboard(mode, path, name, type) {
  const c = currentFileConn();
  if (!c) return;
  state.clipboard = { mode, path, name, type, connId: c.connId };
  updatePasteBtn();
  renderFiles(state.fileList); // 刷新剪切高亮
  toast(`${mode === 'copy' ? '已复制' : '已剪切'}「${name}」，进入目标目录后点击顶部「粘贴」`, 'ok');
}

function updatePasteBtn() {
  const btn = $('#btnPaste'), clr = $('#btnPasteClear');
  const cb = state.clipboard;
  const c = currentFileConn();
  if (!cb || !c || cb.connId !== c.connId) {
    btn.classList.add('hidden');
    clr.classList.add('hidden');
    return;
  }
  btn.textContent = `${cb.mode === 'copy' ? '⧉' : '✂'} 粘贴「${cb.name}」`;
  btn.title = `${cb.mode === 'copy' ? '复制' : '剪切'}自 ${cb.path}，点击粘贴到当前目录`;
  btn.classList.remove('hidden');
  clr.classList.remove('hidden');
}

function doPaste() {
  const cb = state.clipboard;
  const c = currentFileConn();
  if (!cb || !c) return;
  const dst = joinPath(state.filePath, cb.name);
  if (dst === cb.path) { toast('已在原位置，无需粘贴', 'err'); return; }
  if (dst.startsWith(cb.path + '/')) { toast('不能粘贴到自身内部', 'err'); return; }
  const perform = (preDelete) => {
    const run = () => {
      toast(cb.mode === 'copy' ? '正在复制…' : '正在移动…');
      sftpCall(cb.mode === 'cut' ? 'c:sftp:move' : 'c:sftp:copy', { path: cb.path, newPath: dst }, (res, err) => {
        if (err) return;
        toast(cb.mode === 'cut' ? '已移动' : '已复制', 'ok');
        if (cb.mode === 'cut') { state.clipboard = null; updatePasteBtn(); }
        listFiles(state.filePath);
      });
    };
    if (preDelete) sftpCall('c:sftp:delete', { path: dst }, () => run());
    else run();
  };
  // 同名冲突检查
  const exists = (state.fileList || []).some(f => f.name === cb.name);
  if (exists) {
    confirmDlg('覆盖确认', `当前目录已存在同名「${cb.name}」，覆盖后将删除原有${cb.type === 'dir' ? '目录（仅空目录可删）' : '文件'}，继续吗？`, () => perform(true));
  } else {
    perform(false);
  }
}

$('#btnPaste').addEventListener('click', doPaste);
$('#btnPasteClear').addEventListener('click', () => {
  state.clipboard = null;
  updatePasteBtn();
  renderFiles(state.fileList);
});

function joinPath(dir, name) {
  if (dir.endsWith('/')) return dir + name;
  return dir + '/' + name;
}

function sftpCall(event, payload, cb) {
  const c = currentFileConn();
  if (!c) { toast('请先连接主机', 'err'); return; }
  sftpBusy(c.connId, +1);
  socket.emit(event, { connId: c.connId, ...payload }, res => {
    sftpBusy(c.connId, -1);
    if (res && res.error) { toast(res.error, 'err'); if (cb) cb(null, res.error); }
    else if (cb) cb(res);
  });
}

/* --- 文件查看/编辑 --- */
let fileModalPath = null;
function openFile(path, name) {
  fileModalPath = path;
  $('#fileModalTitle').textContent = name;
  $('#fileEditor').value = '加载中…';
  $('#fileMeta').textContent = '';
  showEl('fileModal');
  sftpCall('c:sftp:readfile', { path }, res => {
    if (!res) return;
    $('#fileEditor').value = res.content;
    $('#fileMeta').textContent = `${name} · ${fmtBytes(res.size)} · ${new Date(res.mtime).toLocaleString()}`;
  });
}
$('#btnFileSave').addEventListener('click', () => {
  if (!fileModalPath) return;
  sftpCall('c:sftp:writefile', { path: fileModalPath, content: $('#fileEditor').value }, () => {
    toast('已保存', 'ok');
    listFiles(state.filePath);
  });
});
// 编辑文件期间视为正在使用会话，不判空闲
$('#fileEditor').addEventListener('input', () => {
  const c = currentFileConn();
  if (c) markActive(c.connId);
});
$('#btnFileDownload').addEventListener('click', () => {
  if (fileModalPath) downloadFile(fileModalPath, $('#fileModalTitle').textContent);
});

function downloadFile(path, name) {
  const c = currentFileConn();
  if (!c) return;
  toast('正在准备下载…');
  sftpBusy(c.connId, +1);
  socket.emit('c:sftp:download', { connId: c.connId, path }, res => {
    sftpBusy(c.connId, -1);
    if (res && res.error) { toast(res.error, 'err'); return; }
    const bin = atob(res.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  });
}

/* --- 新建 / 上传 --- */
$('#btnNewFile').addEventListener('click', () => {
  if (!currentFileConn()) { toast('请先连接主机', 'err'); return; }
  inputDlg('新建文件', '文件名，如 notes.txt', '', v => {
    sftpCall('c:sftp:writefile', { path: joinPath(state.filePath, v), content: '' }, () => { toast('已创建', 'ok'); listFiles(state.filePath); });
  });
});
$('#btnNewFolder').addEventListener('click', () => {
  if (!currentFileConn()) { toast('请先连接主机', 'err'); return; }
  inputDlg('新建目录', '目录名', '', v => {
    sftpCall('c:sftp:mkdir', { path: joinPath(state.filePath, v) }, () => { toast('已创建', 'ok'); listFiles(state.filePath); });
  });
});
$('#btnRefreshFiles').addEventListener('click', () => listFiles(state.filePath));

/* --- 上传（弹窗 + 拖拽 + 多文件队列） --- */
let uploading = false;
$('#btnUpload').addEventListener('click', () => {
  if (!currentFileConn()) { toast('请先连接主机', 'err'); return; }
  $('#uploadTargetPath').textContent = state.filePath;
  $('#uploadQueue').innerHTML = '';
  showEl('uploadModal');
});
// 点击拖拽区 → 选择文件
$('#uploadDrop').addEventListener('click', () => $('#uploadInput').click());
// 拖拽高亮
['dragenter', 'dragover'].forEach(ev => $('#uploadDrop').addEventListener(ev, e => {
  e.preventDefault();
  e.stopPropagation();
  $('#uploadDrop').classList.add('drag');
}));
['dragleave', 'drop'].forEach(ev => $('#uploadDrop').addEventListener(ev, e => {
  e.preventDefault();
  e.stopPropagation();
  $('#uploadDrop').classList.remove('drag');
}));
// 弹窗内其他区域阻止浏览器默认打开文件
$('#uploadModal').addEventListener('dragover', e => e.preventDefault());
$('#uploadModal').addEventListener('drop', e => e.preventDefault());
// 放下文件
$('#uploadDrop').addEventListener('drop', e => {
  const items = Array.from(e.dataTransfer.items || []);
  const entries = items.filter(it => it.kind === 'file').map(it => it.webkitGetAsEntry && it.webkitGetAsEntry());
  if (entries.some(en => en && en.isDirectory)) {
    toast('暂不支持拖拽上传文件夹，请拖拽文件', 'err');
    return;
  }
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) uploadFiles(files);
});
// 点击选择（已改为 multiple 多选）
$('#uploadInput').addEventListener('change', e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) uploadFiles(files);
});

function uploadOne(file) {
  return new Promise((resolve, reject) => {
    file.arrayBuffer().then(buf => {
      const u8 = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      sftpCall('c:sftp:upload', { path: joinPath(state.filePath, file.name), b64: btoa(bin) }, (res, err) => {
        if (err) reject(new Error(err));
        else resolve();
      });
    }).catch(reject);
  });
}

async function uploadFiles(files) {
  if (!currentFileConn()) { toast('请先连接主机', 'err'); return; }
  if (uploading) { toast('正在上传中，请稍候', 'err'); return; }
  uploading = true;
  const queue = $('#uploadQueue');
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'up-item';
    row.innerHTML = `<span class="up-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>` +
      `<span class="up-size">${fmtBytes(file.size)}</span><span class="up-status">上传中…</span>`;
    queue.appendChild(row);
    try {
      await uploadOne(file);
      row.classList.add('ok');
      row.querySelector('.up-status').textContent = '✓ 完成';
    } catch (err) {
      row.classList.add('fail');
      row.querySelector('.up-status').textContent = '✗ ' + (err.message || '失败');
    }
  }
  uploading = false;
  toast('上传处理完成', 'ok');
  listFiles(state.filePath);
}

/* ---------------- 终端复制 / 粘贴 ---------------- */
function activeTerm() {
  const c = state.conns.get(state.activeConnId);
  return (c && c.term) ? c : null;
}

// HTTP 环境兼容的剪贴板写入
function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    ok ? resolve() : reject(new Error('复制失败，请手动选择复制'));
  });
}

// 智能获取选中文本：优先 xterm 内部选区，其次浏览器原生选区（选择模式）
function getSelectedText() {
  const c = activeTerm();
  let sel = '';
  if (c && c.term) {
    try { sel = c.term.getSelection(); } catch (e) { /* ignore */ }
  }
  if (!sel) sel = String(window.getSelection ? window.getSelection() : '');
  return sel.trim();
}

function copySelection() {
  const c = activeTerm();
  if (!c || c.status !== 'connected') return toast('终端未连接', 'err');
  const sel = getSelectedText();
  if (!sel) return toast('请先选中文字：电脑拖动选择，手机点「选择」后长按选择', 'err');
  copyTextToClipboard(sel)
    .then(() => toast('已复制 ' + sel.split('\n').length + ' 行', 'ok'))
    .catch(e => toast(e.message, 'err'));
}

/* 选择：把终端当前屏幕内容转成普通文本，在弹窗里展示（可长按/拖动选中复制） */
function showScreenText() {
  const c = activeTerm();
  if (!c || !c.term) return toast('终端未连接', 'err');
  const b = c.term.buffer.active;
  const lines = [];
  const start = Math.max(0, b.viewportY);
  const end = Math.min(b.length, start + c.term.rows);
  for (let i = start; i < end; i++) {
    const line = b.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  // 去掉每行行尾空格与整体末尾的空行
  const text = lines.map(s => s.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  if (!text) return toast('当前屏幕没有内容', 'err');
  $('#screenArea').value = text;
  showEl('screenModal');
}

function pasteClipboard() {
  const c = activeTerm();
  if (!c || c.status !== 'connected') return toast('终端未连接', 'err');
  // 优先尝试直接读剪贴板（HTTPS / 已授权），失败则弹粘贴框（兼容 HTTP 与手机）
  if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
    navigator.clipboard.readText()
      .then(text => { if (text) c.term.paste(text); else openPasteModal(); })
      .catch(() => openPasteModal());
  } else {
    openPasteModal();
  }
}

function openPasteModal() {
  const ta = $('#pasteArea');
  ta.value = '';
  showEl('pasteModal');
  setTimeout(() => ta.focus(), 80);
}

$('#btnPasteOk').addEventListener('click', () => {
  const c = activeTerm();
  const text = $('#pasteArea').value;
  hideEl('pasteModal');
  if (c && c.status === 'connected' && text) c.term.paste(text);
});

// 终端右键：有选中则复制，无选中则粘贴
$('#terminals').addEventListener('contextmenu', e => {
  e.preventDefault();
  const c = activeTerm();
  if (!c || c.status !== 'connected') return;
  if (c.term.hasSelection()) {
    copySelection();
  } else {
    pasteClipboard();
  }
});

// 桌面快捷键：Ctrl+Shift+C 复制 / Ctrl+Shift+V 粘贴；Mac 上 Cmd+C 有选中时复制
document.addEventListener('keydown', e => {
  const c = activeTerm();
  if (!c || c.status !== 'connected') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault(); copySelection();
  } else if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    e.preventDefault(); pasteClipboard();
  } else if (e.metaKey && !e.shiftKey && (e.key === 'c' || e.key === 'C') && c.term.hasSelection()) {
    e.preventDefault(); copySelection();
  }
});

/* ---------------- 快捷键 ---------------- */
const QUICK_KEYS_MAIN = [
  { label: '粘贴', action: 'paste' },
  { label: '选择', action: 'select' },
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', sticky: true },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: 'Ctrl+Z', data: '\x1a' },
  { label: 'Ctrl+U', data: '\x15' },
  { label: 'Ctrl+W', data: '\x17' },
  { label: 'Ctrl+L', data: '\x0c' },
  { label: '/', data: '/' },
  { label: '-', data: '-' },
  { label: '~', data: '~' },
  { label: '|', data: '|' },
  { label: ':', data: ':' },
  { label: ';', data: ';' },
  { label: '$', data: '$' },
  { label: '#', data: '#' },
  { label: '"', data: '"' },
  { label: "'", data: "'" },
  { label: '`', data: '`' },
  { label: 'Enter', data: '\r' }
];
const QUICK_KEYS_ARROWS = [
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Home', data: '\x1b[H' },
  { label: 'End', data: '\x1b[F' },
  { label: 'PgUp', data: '\x1b[5~' },
  { label: 'PgDn', data: '\x1b[6~' }
];

function disarmCtrl() {
  state.ctrlArmed = false;
  $$('.qkey.sticky-on').forEach(b => { if (b.textContent === 'Ctrl') b.classList.remove('sticky-on'); });
}

function makeKeyBtn(key) {
  const btn = document.createElement('button');
  btn.className = 'qkey';
  btn.textContent = key.label;
  btn.addEventListener('click', () => {
    if (key.action === 'paste') return pasteClipboard();
    if (key.action === 'select') return showScreenText();
    if (key.sticky) {
      state.ctrlArmed = !state.ctrlArmed;
      btn.classList.toggle('sticky-on', state.ctrlArmed);
      return;
    }
    let data = key.data;
    if (state.ctrlArmed && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) { data = String.fromCharCode(code - 64); disarmCtrl(); }
    }
    const c = state.conns.get(state.activeConnId);
    if (c && c.status === 'connected') {
      socket.emit('c:ssh:input', { connId: c.connId, data });
    } else {
      toast('终端未连接', 'err');
    }
  });
  return btn;
}

function renderQuickKeys() {
  const main = $('#qkMain'), arrows = $('#qkArrows'), grid = $('#keysPanelGrid');
  main.innerHTML = ''; arrows.innerHTML = ''; grid.innerHTML = '';
  QUICK_KEYS_MAIN.forEach(k => main.appendChild(makeKeyBtn(k)));
  QUICK_KEYS_ARROWS.forEach(k => arrows.appendChild(makeKeyBtn(k)));
  [...QUICK_KEYS_MAIN, ...QUICK_KEYS_ARROWS].forEach(k => grid.appendChild(makeKeyBtn(k)));

  // 底部快捷键条追加自定义键
  customKeys.forEach(k => main.appendChild(makeKeyBtn({ label: k.label || k.keys.join('+'), data: k.data })));

  // 侧栏自定义区域
  const wrap = $('#customKeysWrap');
  if (!state.user) {
    wrap.innerHTML = `
      <div class="ck-section-title"><span>自定义快捷键</span></div>
      <div class="empty-hint">登录后可添加 2-3 键组合的自定义快捷键，云端记忆，手机端也能用</div>`;
    return;
  }
  let html = '<div class="ck-section-title"><span>自定义快捷键</span></div>';
  if (!customKeys.length) {
    html += '<div class="empty-hint">暂无自定义快捷键，点击右上角「+ 自定义」添加</div>';
  } else {
    html += '<div class="ck-list">' + customKeys.map(k => `
      <div class="ck-item" data-id="${k.id}">
        <button class="qkey">${escapeHtml(k.label || k.keys.join('+'))}</button>
        ${k.label ? `<span class="ck-label-remark" title="${escapeHtml(k.keys.join('+'))}">${escapeHtml(k.keys.join('+'))}</span>` : ''}
        <span class="ck-actions">
          <button class="ck-edit" title="编辑">✎</button>
          <button class="ck-del" title="删除">🗑</button>
        </span>
      </div>`).join('') + '</div>';
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('.ck-item').forEach(item => {
    const k = customKeys.find(x => x.id === item.dataset.id);
    if (!k) return;
    item.querySelector('.qkey').addEventListener('click', () => {
      const c = state.conns.get(state.activeConnId);
      if (c && c.status === 'connected') socket.emit('c:ssh:input', { connId: c.connId, data: k.data });
      else toast('终端未连接', 'err');
    });
    item.querySelector('.ck-edit').addEventListener('click', () => openKeyModal(k));
    item.querySelector('.ck-del').addEventListener('click', () => {
      confirmDlg('删除快捷键', `确定删除「${k.label || k.keys.join('+')}」吗？`, async () => {
        try {
          await api('/keys/' + k.id, { method: 'DELETE' });
          customKeys = customKeys.filter(x => x.id !== k.id);
          renderQuickKeys();
          toast('已删除', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  });
}

/* ---------------- 自定义快捷键（登录记忆） ---------------- */
let customKeys = [];

const KEY_MODS = ['Ctrl', 'Alt', 'Shift'];
const KEY_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const KEY_DIGITS = '0123456789'.split('');
const KEY_SYMBOLS = ['/', '-', '=', ',', '.', ';', "'", '\\', '[', ']', '`', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '|', ':', '"', '<', '>', '?', '~'];
const KEY_FUNCS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
const KEY_SPECIALS = ['Enter', 'Space', 'Tab', 'Esc', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PgUp', 'PgDn', 'Ins', 'Del', 'Backspace'];
const KEY_ALL = [...KEY_MODS, ...KEY_LETTERS, ...KEY_DIGITS, ...KEY_SYMBOLS, ...KEY_FUNCS, ...KEY_SPECIALS];

// 终端转义序列表
const FKEYS = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S', F5: '15~', F6: '17~', F7: '18~', F8: '19~', F9: '20~', F10: '21~', F11: '23~', F12: '24~' };
const ARROWKEYS = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' };

function modParam(ctrl, alt, shift) { return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0); }

// 编码单个按键（可带修饰键）
function encodeSingle(key, ctrl, alt, shift) {
  const hasMod = ctrl || alt || shift;
  const esc = alt ? '\x1b' : '';
  // 字母
  if (/^[A-Z]$/.test(key)) {
    if (ctrl) return esc + String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96);
    return esc + (shift ? key : key.toLowerCase());
  }
  // 数字（Ctrl+数字无标准序列，按原样发送）
  if (/^[0-9]$/.test(key)) return esc + key;
  // 符号
  if (key.length === 1) {
    if (ctrl) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) return esc + String.fromCharCode(code - 64);
    }
    return esc + key;
  }
  switch (key) {
    case 'Enter': return esc + '\r';
    case 'Space': return esc + (ctrl ? '\x00' : ' ');
    case 'Tab': return shift ? '\x1b[Z' : (alt ? '\x1b\t' : '\t');
    case 'Esc': return (alt || ctrl) ? '\x1b\x1b' : '\x1b';
    case 'Backspace': return alt ? '\x1b\x7f' : '\x7f';
    case 'PgUp': return hasMod ? `\x1b[5;${modParam(ctrl, alt, shift)}~` : '\x1b[5~';
    case 'PgDn': return hasMod ? `\x1b[6;${modParam(ctrl, alt, shift)}~` : '\x1b[6~';
    case 'Ins': return hasMod ? `\x1b[2;${modParam(ctrl, alt, shift)}~` : '\x1b[2~';
    case 'Del': return hasMod ? `\x1b[3;${modParam(ctrl, alt, shift)}~` : '\x1b[3~';
  }
  if (ARROWKEYS[key]) {
    return hasMod ? `\x1b[1;${modParam(ctrl, alt, shift)}${ARROWKEYS[key]}` : `\x1b[${ARROWKEYS[key]}`;
  }
  if (FKEYS[key]) {
    const v = FKEYS[key];
    if (v.endsWith('~')) {
      const n = v.slice(0, -1);
      return hasMod ? `\x1b[${n};${modParam(ctrl, alt, shift)}~` : `\x1b[${n}~`;
    }
    return hasMod ? `\x1b[1;${modParam(ctrl, alt, shift)}${v}` : `\x1bO${v}`;
  }
  return null;
}

// 编码组合键：修饰键 + 单个普通键；若多个普通键则按顺序发送（序列）
function encodeCombo(keys) {
  const mods = keys.filter(k => KEY_MODS.includes(k));
  const bases = keys.filter(k => !KEY_MODS.includes(k));
  if (!bases.length) return { error: '组合中需要至少一个普通按键（不能全为修饰键）' };
  if (bases.length === 1) {
    const data = encodeSingle(bases[0], mods.includes('Ctrl'), mods.includes('Alt'), mods.includes('Shift'));
    if (data == null) return { error: '无法识别按键：' + bases[0] };
    return { data };
  }
  let data = '';
  for (const b of bases) {
    const d = encodeSingle(b, false, false, false);
    if (d == null) return { error: '无法识别按键：' + b };
    data += d;
  }
  return { data };
}

async function loadCustomKeys() {
  if (!state.user) { customKeys = []; renderQuickKeys(); return; }
  try {
    customKeys = (await api('/keys')).keys;
  } catch (e) { customKeys = []; }
  renderQuickKeys();
}

/* --- 自定义快捷键弹窗 --- */
let keyModalMode = 'add';
let keyEditId = null;

function populateKeySelect(sel, includeNone) {
  sel.innerHTML = (includeNone ? '<option value="">无</option>' : '') +
    KEY_ALL.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
}

function readKeySlots() {
  return [$('#keySlot1').value, $('#keySlot2').value, $('#keySlot3').value].filter(Boolean);
}

function updateKeyPreview() {
  const el = $('#keyPreview');
  const keys = readKeySlots();
  if (keys.length < 2) {
    el.textContent = '请至少选择 2 个按键（如 Ctrl + C，或 Ctrl + Alt + T）';
    el.classList.add('invalid');
    return;
  }
  const enc = encodeCombo(keys);
  if (enc.error) {
    el.textContent = enc.error;
    el.classList.add('invalid');
  } else {
    el.textContent = '组合：' + keys.join(' + ');
    el.classList.remove('invalid');
  }
}

function openKeyModal(key) {
  keyModalMode = key ? 'edit' : 'add';
  keyEditId = key ? key.id : null;
  $('#keyModalTitle').textContent = key ? '编辑快捷键' : '自定义快捷键';
  if (!$('#keySlot1').options.length) {
    populateKeySelect($('#keySlot1'), false);
    populateKeySelect($('#keySlot2'), false);
    populateKeySelect($('#keySlot3'), true);
  }
  const ks = key ? key.keys : [];
  $('#keySlot1').value = ks[0] || 'Ctrl';
  $('#keySlot2').value = ks[1] || 'C';
  $('#keySlot3').value = ks[2] || '';
  $('#keyLabel').value = key ? (key.label || '') : '';
  $('#keyError').classList.add('hidden');
  updateKeyPreview();
  showEl('keyModal');
}

$('#btnAddKey').addEventListener('click', () => {
  if (!state.user) { toast('自定义快捷键需要登录后使用', 'err'); showEl('loginModal'); return; }
  openKeyModal(null);
});

['keySlot1', 'keySlot2', 'keySlot3'].forEach(id =>
  $('#' + id).addEventListener('change', updateKeyPreview)
);

$('#btnKeySave').addEventListener('click', async () => {
  const keys = readKeySlots();
  const err = m => { $('#keyError').textContent = m; $('#keyError').classList.remove('hidden'); };
  if (keys.length < 2) return err('请至少选择 2 个按键');
  if (keys.length > 3) return err('最多 3 个按键');
  const enc = encodeCombo(keys);
  if (enc.error) return err(enc.error);
  const body = { keys, label: $('#keyLabel').value.trim(), data: enc.data };
  try {
    if (keyModalMode === 'edit') {
      const d = await api('/keys/' + keyEditId, { method: 'PUT', body });
      const i = customKeys.findIndex(k => k.id === keyEditId);
      if (i >= 0) customKeys[i] = d.key;
    } else {
      const d = await api('/keys', { method: 'POST', body });
      customKeys.push(d.key);
    }
    hideEl('keyModal');
    renderQuickKeys();
    toast('已保存', 'ok');
  } catch (e) { err(e.message); }
});

/* ---------------- 个人设置 ---------------- */
function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function uaSummary(ua) {
  if (!ua || ua === '未知') return '未知设备';
  let os = '未知系统';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Mac/i.test(ua)) os = 'Mac';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let br = '浏览器';
  if (/Edg\//i.test(ua)) br = 'Edge';
  else if (/Chrome\//i.test(ua)) br = 'Chrome';
  else if (/Firefox\//i.test(ua)) br = 'Firefox';
  else if (/Safari\//i.test(ua)) br = 'Safari';
  return `${os} · ${br}`;
}

function switchPTab(tab) {
  $$('[data-ptab]').forEach(b => b.classList.toggle('active', b.dataset.ptab === tab));
  $$('.ptab-page').forEach(p => p.classList.toggle('hidden', p.id !== 'ptab-' + tab));
  if (tab === 'cloud') loadSyncInfo();
  if (tab === 'admin') loadAdminStats();
}
$$('[data-ptab]').forEach(btn => btn.addEventListener('click', () => switchPTab(btn.dataset.ptab)));

function openProfile() {
  $('#ptabAdminBtn').classList.toggle('hidden', state.user.role !== 'admin');
  switchPTab('account');
  showEl('profileModal');
  loadProfile();
}

let logExpanded = false;
let lastLogins = [];

function renderLoginLog(logins, expanded) {
  lastLogins = logins;
  logExpanded = expanded;
  const log = $('#pfLoginLog');
  const shown = expanded ? logins : logins.slice(0, 2);
  let html = shown.map((l, i) => `
    <div class="log-row">
      <span class="log-dot"></span>
      <span class="log-time">${fmtTime(l.time)}</span>
      <span class="log-ip">${escapeHtml(l.ip)}</span>
      <span class="log-ua" title="${escapeHtml(l.ua)}">${escapeHtml(uaSummary(l.ua))}</span>
      ${!expanded && i === 0 && logins.length > 1 ? '<span class="log-cur">本次</span>' : (!expanded && i === 1 ? '<span class="log-cur prev">上次</span>' : '')}
    </div>`).join('');
  if (logins.length > 2) {
    html += `<button class="log-more">${expanded ? '收起' : `更多（共 ${logins.length} 条记录） ▾`}</button>`;
  }
  log.innerHTML = html;
  const more = log.querySelector('.log-more');
  if (more) more.addEventListener('click', () => renderLoginLog(lastLogins, !logExpanded));
}

async function loadProfile() {
  try {
    const p = await api('/profile');
    $('#pfAvatar').textContent = (p.username || 'Q')[0].toUpperCase();
    $('#pfName').innerHTML = escapeHtml(p.username) +
      (p.role === 'admin' ? ' <span class="role-badge">管理员</span>' : '');
    $('#pfSub').textContent = `注册于 ${fmtTime(p.createdAt)}`;
    const log = $('#pfLoginLog');
    if (!p.logins.length) {
      log.innerHTML = '<div class="empty-hint">暂无登录记录</div>';
    } else {
      renderLoginLog(p.logins, false);
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* --- 修改密码 --- */
$('#btnChangePass').addEventListener('click', async () => {
  const oldPassword = $('#pfOldPass').value;
  const newPassword = $('#pfNewPass').value;
  const err = m => { $('#pfPassErr').textContent = m; $('#pfPassErr').classList.remove('hidden'); };
  if (!oldPassword || !newPassword) return err('请填写原密码和新密码');
  if (newPassword.length < 8) return err('新密码至少 8 位');
  try {
    await api('/password', { method: 'POST', body: { oldPassword, newPassword } });
    $('#pfPassErr').classList.add('hidden');
    $('#pfOldPass').value = ''; $('#pfNewPass').value = '';
    toast('密码修改成功', 'ok');
  } catch (e) { err(e.message); }
});

/* --- 注销账号 --- */
$('#btnDeleteAccount').addEventListener('click', () => {
  confirmDlg('注销账号', `确定注销「${state.user.username}」吗？所有云端数据（主机、快捷键、登录记录）将被永久删除，不可恢复。`, async () => {
    try {
      await api('/account/delete', { method: 'POST' });
      hideEl('profileModal');
      state.token = null; state.user = null;
      localStorage.removeItem('qxue_token');
      state.hosts = []; customKeys = [];
      for (const connId of [...state.conns.keys()]) closeSession(connId);
      renderUserArea(); renderHosts(); renderQuickKeys();
      toast('账号已注销', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
});

/* --- 云数据 --- */
async function loadSyncInfo() {
  try {
    const s = await api('/sync');
    $('#pfSyncInfo').innerHTML =
      `最新同步：${s.lastSync ? fmtTime(s.lastSync) : '尚未同步'} · 云端保存 ${s.hosts} 台主机、${s.keys} 个自定义快捷键`;
  } catch (e) {
    $('#pfSyncInfo').textContent = e.message;
  }
}

$('#btnSyncPush').addEventListener('click', async () => {
  try {
    const r = await api('/sync/push', { method: 'POST' });
    toast(`已同步到云端（${fmtTime(r.lastSync)}）`, 'ok');
    loadSyncInfo();
  } catch (e) { toast(e.message, 'err'); }
});

$('#btnSyncPull').addEventListener('click', async () => {
  try {
    const r = await api('/sync/pull', { method: 'POST' });
    state.hosts = r.hosts;
    customKeys = r.keys;
    renderHosts();
    renderQuickKeys();
    toast(`已从远端同步（${r.lastSync ? fmtTime(r.lastSync) : '云端为空'}）`, 'ok');
    loadSyncInfo();
  } catch (e) { toast(e.message, 'err'); }
});

$('#btnSyncClear').addEventListener('click', () => {
  confirmDlg('清除云端数据', '将删除云端保存的全部主机与自定义快捷键，确定继续吗？', async () => {
    try {
      await api('/sync/clear', { method: 'POST' });
      state.hosts = []; customKeys = [];
      renderHosts();
      renderQuickKeys();
      toast('云端数据已清除', 'ok');
      loadSyncInfo();
    } catch (e) { toast(e.message, 'err'); }
  });
});

/* --- 管理员：站点详情 --- */
let adminUsers = [];
let adminPage = 1;
const ADMIN_PAGE_SIZE = 10;

async function loadAdminStats() {
  try {
    const s = await api('/admin/stats');
    $('#adUserCount').textContent = s.count;
    $('#adHostCount').textContent = s.users.reduce((a, u) => a + u.hosts, 0);
    $('#adRegSwitch').checked = s.regEnabled;
    adminUsers = s.users;
    const totalPages = Math.max(1, Math.ceil(adminUsers.length / ADMIN_PAGE_SIZE));
    if (adminPage > totalPages) adminPage = totalPages;
    renderAdminPage();
  } catch (e) {
    $('#adUserList').innerHTML = `<div class="empty-hint">${escapeHtml(e.message)}</div>`;
    $('#adPager').classList.add('hidden');
  }
  loadBackupCfg();
}

/* --- 管理员：站点备份（WebDAV） --- */
let backupCfg = null;

async function loadBackupCfg() {
  try {
    backupCfg = await api('/admin/backup');
    $('#bkEnabled').checked = backupCfg.enabled;
    $('#bkUrl').value = backupCfg.webdavUrl || '';
    $('#bkUser').value = backupCfg.username || '';
    $('#bkPass').value = '';
    $('#bkPass').placeholder = backupCfg.hasPassword ? '已保存（留空表示不修改）' : '坚果云等请使用「应用密码」';
    $('#bkInterval').value = backupCfg.intervalHours || 24;
    $('#bkRetention').value = backupCfg.retention || 5;
    renderBackupStatus();
  } catch (e) { /* ignore */ }
}

function renderBackupStatus() {
  if (!backupCfg) return;
  const st = $('#bkStatus'), lg = $('#bkLog');
  if (backupCfg.lastError) {
    st.innerHTML = `<span class="bk-err">最近一次备份失败：${escapeHtml(backupCfg.lastError)}</span>`;
  } else if (backupCfg.lastBackup) {
    st.innerHTML = `<span class="bk-ok">上次成功备份：${fmtTime(backupCfg.lastBackup)}</span>`;
  } else {
    st.innerHTML = '<span class="bk-dim">尚未备份过</span>';
  }
  st.innerHTML += backupCfg.enabled
    ? ' · <span class="bk-ok">自动备份已开启（每 ' + backupCfg.intervalHours + ' 小时）</span>'
    : ' · <span class="bk-dim">自动备份未开启</span>';
  if (!backupCfg.log || !backupCfg.log.length) { lg.innerHTML = ''; return; }
  lg.innerHTML = '<div class="pf-section-title" style="margin:10px 0 6px">备份记录</div>' +
    backupCfg.log.slice(0, 10).map(e => `
      <div class="bk-log-row ${e.ok ? '' : 'bk-err'}">
        ${e.ok ? '✔' : '✘'} ${fmtTime(e.time)} · ${e.trigger === 'auto' ? '自动' : '手动'}
        ${e.ok ? ` · ${escapeHtml(e.file)}（${fmtBytes(e.size)}）` : ` · ${escapeHtml(e.error || '')}`}
      </div>`).join('');
}

function readBackupForm() {
  return {
    enabled: $('#bkEnabled').checked,
    webdavUrl: $('#bkUrl').value.trim(),
    username: $('#bkUser').value.trim(),
    password: $('#bkPass').value,
    intervalHours: +$('#bkInterval').value || 24,
    retention: +$('#bkRetention').value || 5
  };
}

$('#btnBkSave').addEventListener('click', async () => {
  const body = readBackupForm();
  if (body.enabled && (!body.webdavUrl || !body.username)) {
    return toast('启用备份需要填写 WebDAV 地址和账号', 'err');
  }
  try {
    await api('/admin/backup', { method: 'POST', body });
    toast('备份配置已保存', 'ok');
    await loadBackupCfg();
  } catch (e) { toast(e.message, 'err'); }
});

$('#btnBkTest').addEventListener('click', async () => {
  // 测试用表单里的最新配置：先保存再测试，密码留空时沿用已存的
  const body = readBackupForm();
  if (!body.webdavUrl || !body.username) return toast('请先填写 WebDAV 地址和账号', 'err');
  toast('正在测试连接…');
  try {
    await api('/admin/backup', { method: 'POST', body });
    await api('/admin/backup/test', { method: 'POST', body: {} });
    toast('WebDAV 连接成功', 'ok');
    await loadBackupCfg();
  } catch (e) { toast('连接失败：' + e.message, 'err'); }
});

$('#btnBkRun').addEventListener('click', async () => {
  const body = readBackupForm();
  if (!body.webdavUrl) return toast('请先配置 WebDAV 地址', 'err');
  toast('正在备份…');
  try {
    await api('/admin/backup', { method: 'POST', body });
    const r = await api('/admin/backup/run', { method: 'POST', body: {} });
    toast(`备份成功（${fmtBytes(r.entry.size)}），已上传到网盘`, 'ok');
    await loadBackupCfg();
  } catch (e) { toast('备份失败：' + e.message, 'err'); await loadBackupCfg(); }
});

function renderAdminPage() {
  const list = $('#adUserList');
  const total = adminUsers.length;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const start = (adminPage - 1) * ADMIN_PAGE_SIZE;
  const pageUsers = adminUsers.slice(start, start + ADMIN_PAGE_SIZE);

  list.innerHTML = pageUsers.map(u => `
    <div class="au-row" data-id="${u.id}">
      <div>
        <div class="au-name">${escapeHtml(u.username)}${u.role === 'admin' ? ' <span class="role-badge">管理员</span>' : ''}</div>
        <div class="au-sub">
          注册 ${fmtTime(u.createdAt)} · ${u.hosts} 主机 · ${u.keys} 快捷键 · 最近登录 ${u.lastLogin ? fmtTime(u.lastLogin.time) : '从未'}
        </div>
      </div>
      <span class="au-spacer"></span>
      ${u.role === 'admin' ? '' : '<button class="btn btn-sm btn-danger au-del">删除</button>'}
    </div>`).join('');

  list.querySelectorAll('.au-del').forEach(btn => btn.addEventListener('click', () => {
    const row = btn.closest('.au-row');
    const u = adminUsers.find(x => x.id === row.dataset.id);
    confirmDlg('删除用户', `确定删除用户「${u.username}」吗？其所有数据将被移除。`, async () => {
      try {
        await api('/admin/users/' + u.id + '/delete', { method: 'POST' });
        toast('已删除', 'ok');
        loadAdminStats();
      } catch (e) { toast(e.message, 'err'); }
    });
  }));

  const pager = $('#adPager');
  if (totalPages > 1) {
    pager.classList.remove('hidden');
    $('#adPageInfo').textContent = `第 ${adminPage} / ${totalPages} 页 · 共 ${total} 人`;
    $('#adPrev').disabled = adminPage <= 1;
    $('#adNext').disabled = adminPage >= totalPages;
  } else {
    pager.classList.add('hidden');
  }
}

$('#adPrev').addEventListener('click', () => {
  if (adminPage > 1) { adminPage--; renderAdminPage(); }
});
$('#adNext').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(adminUsers.length / ADMIN_PAGE_SIZE));
  if (adminPage < totalPages) { adminPage++; renderAdminPage(); }
});

$('#adRegSwitch').addEventListener('change', async (e) => {
  try {
    const r = await api('/admin/registration', { method: 'POST', body: { enabled: e.target.checked } });
    toast(r.regEnabled ? '已开启站点注册' : '已关闭站点注册', 'ok');
  } catch (err2) {
    e.target.checked = !e.target.checked;
    toast(err2.message, 'err');
  }
});

/* ---------------- 侧栏切换 ---------------- */
function isMobileView() { return window.innerWidth <= 768; }

function collapsePanelOnMobile() {
  if (!isMobileView()) return;
  const p = $('#panel');
  if (p.classList.contains('collapsed')) return;
  p.classList.add('collapsed');
  const c = state.conns.get(state.activeConnId);
  if (c && c.fit) setTimeout(() => c.fit.fit(), 60);
}

/* ---------------- 移动端软键盘适配 ----------------
   键盘弹起时 visualViewport.height 变小，把整体布局高度同步为可视高度，
   底部快捷键条 / 监控条随之顶到键盘上方（body 为 fixed 定位，无缝贴合）；键盘收起后自动还原 */
if (window.visualViewport && window.matchMedia('(pointer: coarse)').matches) {
  const vv = window.visualViewport;
  let _kbTimer = null;
  const applyVv = () => {
    const h = Math.round(vv.height - vv.offsetTop);
    document.body.style.height = h + 'px';
    document.body.style.top = vv.offsetTop + 'px';
    clearTimeout(_kbTimer);
    _kbTimer = setTimeout(() => {
      const c = state.conns.get(state.activeConnId);
      if (c && c.fit) { try { c.fit.fit(); } catch (e) { /* ignore */ } }
    }, 120);
  };
  vv.addEventListener('resize', applyVv);
  vv.addEventListener('scroll', applyVv);
}

$$('.menu-item').forEach(btn => btn.addEventListener('click', () => {
  const panel = btn.dataset.panel;
  // 移动端：再次点击当前菜单项 = 收起侧栏
  if (isMobileView() && btn.classList.contains('active') && !$('#panel').classList.contains('collapsed')) {
    $('#panel').classList.add('collapsed');
    const c0 = state.conns.get(state.activeConnId);
    if (c0 && c0.fit) setTimeout(() => c0.fit.fit(), 60);
    return;
  }
  $$('.menu-item').forEach(b => b.classList.toggle('active', b === btn));
  $$('.panel-page').forEach(p => p.classList.toggle('active', p.id === 'panel-' + panel));
  if (panel === 'files') refreshFilesIfReady();
  if (panel === 'monitor') updateMonitorDisplay();
  if (panel === 'docker') refreshDocker();
  if (isMobileView()) $('#panel').classList.remove('collapsed');
  const c = state.conns.get(state.activeConnId);
  if (c && c.fit) setTimeout(() => c.fit.fit(), 50);
}));

// 移动端：点击终端区域自动收起侧栏
$('#terminalArea').addEventListener('click', () => {
  if (isMobileView() && !$('#panel').classList.contains('collapsed')) {
    $('#panel').classList.add('collapsed');
    const c = state.conns.get(state.activeConnId);
    if (c && c.fit) setTimeout(() => c.fit.fit(), 60);
  }
});

/* ---------------- 滚动条：滚动时才显示 ---------------- */
const _scrollTimers = new WeakMap();
document.addEventListener('scroll', e => {
  const el = e.target;
  if (!(el instanceof Element)) return;
  el.classList.add('scrolling');
  clearTimeout(_scrollTimers.get(el));
  _scrollTimers.set(el, setTimeout(() => el.classList.remove('scrolling'), 900));
}, true);

$('#panelToggle').addEventListener('click', () => {
  const p = $('#panel');
  p.classList.toggle('collapsed');
  const c = state.conns.get(state.activeConnId);
  if (c && c.fit) setTimeout(() => c.fit.fit(), 60);
  $('#panelToggle').textContent = p.classList.contains('collapsed') ? '›' : '‹';
});

/* ---------------- 设置 ---------------- */
$('#btnSettings').addEventListener('click', () => showEl('settingsModal'));

$('#setTheme').addEventListener('change', e => {
  state.settings.theme = e.target.value;
  localStorage.setItem('qxue_theme', e.target.value);
  applyTheme(e.target.value);
});
$('#setFontSize').addEventListener('input', e => {
  const size = +e.target.value;
  state.settings.fontSize = size;
  localStorage.setItem('qxue_fontsize', size);
  $('#fontSizeVal').textContent = size;
  applyFontSize(size);
});
$('#setQuickKeys').addEventListener('change', e => {
  state.settings.quickKeys = e.target.checked;
  localStorage.setItem('qxue_quickkeys', e.target.checked ? '1' : '0');
  $('#quickKeysBar').classList.toggle('hidden', !e.target.checked);
  const c = state.conns.get(state.activeConnId);
  if (c && c.fit) setTimeout(() => c.fit.fit(), 50);
});
$('#setMonitorBar').addEventListener('change', e => {
  state.settings.monitorBar = e.target.checked;
  localStorage.setItem('qxue_monitorbar', e.target.checked ? '1' : '0');
  $('#monitorBar').classList.toggle('hidden', !e.target.checked);
});

/* ---------------- 初始化 ---------------- */
(async function init() {
  applySettings();
  renderQuickKeys();
  renderUserArea();

  // 移动端默认收起侧边栏，给终端留出全屏空间
  if (isMobileView()) $('#panel').classList.add('collapsed');

  // 检查登录态
  if (state.token) {
    try {
      const data = await api('/me');
      if (data.user) {
        state.user = data.user;
        renderUserArea();
        await loadHosts();
        loadCustomKeys();
      } else {
        state.token = null;
        localStorage.removeItem('qxue_token');
        renderUserArea(); renderHosts();
      }
    } catch (e) { renderHosts(); }
  } else {
    renderHosts();
  }

  // 点击磁盘卡片以外的区域时收起分区列表
  document.addEventListener('click', e => {
    if (state.diskExpanded && !e.target.closest('.disk-card')) {
      state.diskExpanded = false;
      updateMonitorDisplay();
    }
  });

  // 欢迎标签（未连接时的提示）
  if (state.conns.size === 0) {
    const box = document.createElement('div');
    box.className = 'term-box active';
    box.innerHTML = `
      <div class="term-overlay">
        <div class="big">⌨</div>
        <div><b>QxueSSH</b> — 在线 SSH 终端</div>
        <div>从左侧「连接」面板选择主机，或点击右上角「登录」保存你的主机</div>
        <div>SSH 功能需登录后使用，点击右上角「登录」开始</div>
      </div>`;
    $('#terminals').appendChild(box);
    window._welcomeBox = box;
  }
})();

// 窗口尺寸变化时自适应终端
window.addEventListener('resize', () => {
  const c = state.conns.get(state.activeConnId);
  if (c && c.fit) setTimeout(() => {
    try { c.fit.fit(); socket.emit('c:ssh:resize', { connId: c.connId, cols: c.term.cols, rows: c.term.rows }); } catch (e) { /* ignore */ }
  }, 60);
});
