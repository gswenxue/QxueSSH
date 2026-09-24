#!/usr/bin/env bash
# ============================================================
# QxueSSH 一键部署脚本
# 自动安装 Node.js 运行环境、下载项目、配置并启动服务
# 用法: bash install.sh
# ============================================================

set -e

# ---------- 颜色 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[信息]${NC} $1"; }
ok()    { echo -e "${GREEN}[成功]${NC} $1"; }
warn()  { echo -e "${YELLOW}[警告]${NC} $1"; }
err()   { echo -e "${RED}[错误]${NC} $1"; }

# ---------- 配置 ----------
INSTALL_DIR="/opt/QxueSSH"
SERVICE_NAME="qxuessh"
GIT_REPO="https://github.com/gswenxue/QxueSSH.git"
NODE_VERSION="v20.18.1"

# ---------- 检查 root ----------
if [ "$EUID" -ne 0 ]; then
  err "请使用 root 用户运行此脚本"
  exit 1
fi

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}    QxueSSH 一键部署脚本${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# ---------- 检测系统 ----------
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    OS_VER=$VERSION_ID
  else
    OS=$(uname -s)
  fi
  ARCH=$(uname -m)
  info "操作系统: $OS $OS_VER ($ARCH)"
}
detect_os

# ---------- 安装 Node.js ----------
install_node() {
  if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1 | tr -d 'v')
    if [ "$NODE_MAJOR" -ge 18 ]; then
      ok "Node.js $NODE_VER 已安装（满足 18+ 要求）"
      return
    else
      warn "Node.js $NODE_VER 版本过低，需要 18+，正在安装..."
    fi
  else
    info "未检测到 Node.js，正在安装..."
  fi

  # 用官方二进制包安装（不依赖系统源，避免 DNS/源问题）
  local NODE_TAR="node-${NODE_VERSION}-linux-x64.tar.xz"
  if [ "$ARCH" = "aarch64" ]; then
    NODE_TAR="node-${NODE_VERSION}-linux-arm64.tar.xz"
  fi
  local NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"

  info "下载 Node.js ${NODE_VERSION}..."
  cd /tmp
  if command -v wget &>/dev/null; then
    wget -q "$NODE_URL" -O "$NODE_TAR" || { err "下载失败，请检查网络"; exit 1; }
  else
    curl -sL "$NODE_URL" -o "$NODE_TAR" || { err "下载失败，请检查网络"; exit 1; }
  fi

  info "解压安装 Node.js..."
  tar -xJf "$NODE_TAR" -C /usr/local --strip-components=1
  rm -f "$NODE_TAR"
  ok "Node.js $(node -v) / npm $(npm -v) 安装完成"
}
install_node

# ---------- 下载项目 ----------
download_project() {
  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/server.js" ]; then
    warn "检测到已有安装目录 $INSTALL_DIR"
    read -rp "是否覆盖重新下载？(y/N): " REINSTALL
    if [ "$REINSTALL" != "y" ] && [ "$REINSTALL" != "Y" ]; then
      info "保留现有项目文件"
      return
    fi
    rm -rf "$INSTALL_DIR"
  fi

  info "下载 QxueSSH 项目..."
  mkdir -p "$(dirname "$INSTALL_DIR")"

  # 优先 git clone，失败则下载 zip
  if command -v git &>/dev/null; then
    git clone --depth 1 "$GIT_REPO" "$INSTALL_DIR" 2>/dev/null && ok "项目已克隆到 $INSTALL_DIR" && return
  fi

  # 降级：下载 zip
  local ZIP_URL="https://github.com/gswenxue/QxueSSH/archive/refs/heads/main.tar.gz"
  info "git 不可用，使用压缩包下载..."
  cd /tmp
  curl -sL "$ZIP_URL" -o qxuessh.tar.gz || { err "项目下载失败"; exit 1; }
  mkdir -p "$INSTALL_DIR"
  tar -xzf qxuessh.tar.gz -C "$INSTALL_DIR" --strip-components=1
  rm -f qxuessh.tar.gz
  ok "项目已下载到 $INSTALL_DIR"
}
download_project

# ---------- 安装依赖 ----------
cd "$INSTALL_DIR"
info "安装 npm 依赖..."
npm install --production --registry=https://registry.npmmirror.com 2>/dev/null || npm install --production
ok "依赖安装完成"

# ---------- 交互式配置 ----------
echo ""
echo -e "${CYAN}---------- 服务配置 ----------${NC}"

# 管理员账号
read -rp "管理员用户名 [默认 Qxue]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-Qxue}

# 管理员密码
read -rp "是否自定义管理员密码？(y/N): " CUSTOM_PASS
if [ "$CUSTOM_PASS" = "y" ] || [ "$CUSTOM_PASS" = "Y" ]; then
  while true; do
    read -rsp "请输入管理员密码（至少8位）: " ADMIN_PASS; echo
    read -rsp "请再次输入密码: " ADMIN_PASS2; echo
    if [ ${#ADMIN_PASS} -lt 8 ]; then
      err "密码至少 8 位"
    elif [ "$ADMIN_PASS" != "$ADMIN_PASS2" ]; then
      err "两次输入不一致"
    else
      break
    fi
  done
else
  ADMIN_PASS="Qxue2026"
  info "使用默认密码: Qxue2026"
fi

# 部署端口
while true; do
  read -rp "服务监听端口 [默认 3000]: " APP_PORT
  APP_PORT=${APP_PORT:-3000}
  if [[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ]; then
    break
  else
    err "请输入有效的端口号 (1-65535)"
  fi
done

# ---------- 创建管理员数据 ----------
info "创建管理员账号..."
mkdir -p "$INSTALL_DIR/data"
ADMIN_HASH=$(/usr/local/bin/node -e "
const b=require('bcryptjs');
const c=require('crypto');
console.log(JSON.stringify({
  id: c.randomUUID(),
  username: process.argv[1],
  passHash: b.hashSync(process.argv[2], 10),
  role: 'admin',
  createdAt: Date.now()
}));
" "$ADMIN_USER" "$ADMIN_PASS")

cat > "$INSTALL_DIR/data/db.json" <<DBEOF
{
  "users": [$ADMIN_HASH],
  "hosts": [],
  "tokens": {},
  "keys": [],
  "loginLogs": {},
  "regEnabled": true,
  "meta": { "lastSync": 0 },
  "backup": {
    "enabled": false, "webdavUrl": "", "username": "", "password": "",
    "intervalHours": 24, "retention": 5, "lastBackup": null, "lastError": null, "log": []
  }
}
DBEOF
ok "管理员账号已创建"

# ---------- 创建 systemd 服务 ----------
create_systemd() {
  if ! command -v systemctl &>/dev/null; then
    warn "未检测到 systemd，将使用 nohup 方式运行"
    return 1
  fi

  cat > /etc/systemd/system/${SERVICE_NAME}.service <<SVCEOF
[Unit]
Description=QxueSSH Web SSH Client
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/local/bin/node server.js
Environment=PORT=$APP_PORT
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME} &>/dev/null
  ok "systemd 服务已创建并设置自启动"
  return 0
}

# ---------- 创建 qxuessh 管理命令 ----------
create_cli() {
  if [ -f "$INSTALL_DIR/qxuessh" ]; then
    cp "$INSTALL_DIR/qxuessh" /usr/local/bin/qxuessh
    chmod +x /usr/local/bin/qxuessh
    ok "管理命令 qxuessh 已创建（输入 qxuessh help 查看用法）"
  else
    warn "未找到 qxuessh 脚本文件，跳过管理命令创建"
  fi
}
create_cli

# ---------- 启动服务 ----------
echo ""
info "启动 QxueSSH 服务..."
if create_systemd; then
  systemctl start $SERVICE_NAME
else
  cd "$INSTALL_DIR" && PORT=$APP_PORT nohup /usr/local/bin/node server.js > /tmp/qxuessh.log 2>&1 &
fi

sleep 2

# ---------- 验证 ----------
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$APP_PORT/" | grep -q 200; then
  ok "服务启动成功"
else
  warn "服务可能未正常启动，请检查日志: qxuessh logs"
fi

# ---------- 获取本机 IP ----------
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}    QxueSSH 部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  访问地址: ${CYAN}http://${SERVER_IP}:${APP_PORT}${NC}"
echo -e "  管理员账号: ${CYAN}${ADMIN_USER}${NC}"
echo -e "  管理员密码: ${CYAN}${ADMIN_PASS}${NC}"
echo ""
echo -e "  ${YELLOW}请妥善保存以上账号密码，登录后建议立即修改密码${NC}"
echo ""
echo -e "  管理命令: ${CYAN}qxuessh help${NC}（查看状态/改端口/自启动/重置密码）"
echo ""
