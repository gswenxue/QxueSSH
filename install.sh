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

# ---------- 预编译包检测 ----------
# 预编译 node_modules 适用于 linux + x86_64/aarch64，支持 glibc 和 musl(Alpine)
PREBUILT_AVAILABLE=0
PREBUILT_ARCH=""
PREBUILT_LIBC=""
detect_prebuilt() {
  if [ "$(uname -s)" != "Linux" ]; then return; fi
  local ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ]; then PREBUILT_ARCH="x64"; elif [ "$ARCH" = "aarch64" ]; then PREBUILT_ARCH="arm64"; else return; fi
  # 检测 libc 类型：glibc (Debian/Ubuntu/CentOS) 或 musl (Alpine)
  if ldd --version 2>&1 | head -1 | grep -qi "glibc\|GNU C Library"; then
    PREBUILT_LIBC="glibc"
    PREBUILT_AVAILABLE=1
  elif ldd --version 2>&1 | head -1 | grep -qi "musl"; then
    PREBUILT_LIBC="musl"
    PREBUILT_AVAILABLE=1
  fi
}
detect_prebuilt

# ---------- 安装基础依赖 ----------
install_deps() {
  if [ "$PREBUILT_AVAILABLE" = "1" ]; then
    info "检测到兼容平台（linux/$PREBUILT_ARCH/$PREBUILT_LIBC），将使用预编译 node_modules，无需编译工具"
    # 预编译模式只需 xz 解压 Node.js 和预编译包
    if command -v apt-get &>/dev/null; then
      apt-get update -qq 2>/dev/null || true
      apt-get install -y -qq xz-utils >/dev/null 2>&1 || true
    elif command -v yum &>/dev/null; then
      yum install -y -q xz >/dev/null 2>&1 || true
    elif command -v dnf &>/dev/null; then
      dnf install -y -q xz >/dev/null 2>&1 || true
    elif command -v apk &>/dev/null; then
      # Alpine 需要 libstdc++ 运行官方 Node.js 二进制
      apk add --no-cache xz libstdc++ gcompat >/dev/null 2>&1 || true
    fi
    if ! command -v xz &>/dev/null; then
      err "xz 解压工具安装失败，无法继续。请手动安装 xz-utils 后重试。"
      exit 1
    fi
    ok "基础依赖检查完成（预编译模式）"
    return
  fi

  # 非预编译模式：需要完整编译工具
  info "安装基础依赖（xz-utils g++ make python3）..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq xz-utils >/dev/null 2>&1 || true
    apt-get install -y -qq g++ make python3 >/dev/null 2>&1 || true
    if command -v xz &>/dev/null && command -v g++ &>/dev/null; then ok "基础依赖安装完成"; return; fi
    # fallback: Debian/Ubuntu EOL 源
    if [ -f /etc/apt/sources.list ] && grep -qE "deb\.debian\.org|archive\.ubuntu\.com" /etc/apt/sources.list; then
      warn "默认源安装失败，尝试归档源..."
      local CODENAME="$(grep -oP 'VERSION_CODENAME=\K\w+' /etc/os-release 2>/dev/null || echo bullseye)"
      cp /etc/apt/sources.list /etc/apt/sources.list.qxuebak 2>/dev/null
      cat > /etc/apt/sources.list <<APTEOF
deb http://archive.debian.org/debian ${CODENAME} main contrib
APTEOF
      apt-get update -o Acquire::Check-Valid-Until=false -qq 2>/dev/null || true
      apt-get install -y -qq xz-utils >/dev/null 2>&1 || true
      if ! apt-get install -y -qq g++ make python3 >/dev/null 2>&1; then
        warn "编译工具版本冲突，尝试降级 libc6-dev..."
        apt-get install -y -qq --allow-downgrades libc6-dev >/dev/null 2>&1 || true
        apt-get install -y -qq g++ make python3 >/dev/null 2>&1 || true
      fi
      [ -f /etc/apt/sources.list.qxuebak ] && mv /etc/apt/sources.list.qxuebak /etc/apt/sources.list
    fi
  elif command -v yum &>/dev/null; then
    yum install -y -q xz gcc-c++ make python3 >/dev/null 2>&1 || true
  elif command -v dnf &>/dev/null; then
    dnf install -y -q xz gcc-c++ make python3 >/dev/null 2>&1 || true
  elif command -v apk &>/dev/null; then
    apk add --no-cache xz build-base python3 >/dev/null 2>&1 || true
  else
    warn "未识别的包管理器，请确保已安装 xz、g++、make、python3"
  fi
  if ! command -v xz &>/dev/null; then
    err "xz 解压工具安装失败，无法继续。请手动安装 xz-utils 后重试。"
    exit 1
  fi
  if ! command -v g++ &>/dev/null; then
    warn "g++ 未安装，本机终端功能将不可用（SSH连接功能正常）"
  fi
  ok "基础依赖检查完成"
}
install_deps

# ---------- 安装 Node.js ----------
# glibc 系统：下载固定版本 v20.18.1 到 /opt/qxue-node/（独立目录，不依赖系统预装）
# musl(Alpine) 系统：官方二进制不兼容 musl，通过 apk 安装仓库版 nodejs
NODE_DIR="/opt/qxue-node"
NODE_BIN="$NODE_DIR/bin/node"

install_node() {
  # Alpine(musl) 通过 apk 安装原生 nodejs
  if [ "$PREBUILT_LIBC" = "musl" ]; then
    if command -v node &>/dev/null && [ "$(node -v | cut -d. -f1 | tr -d 'v')" -ge 18 ]; then
      ok "Node.js $(node -v) 已安装（apk 仓库版）"
    else
      info "Alpine 系统通过 apk 安装 Node.js..."
      apk add --no-cache nodejs npm >/dev/null 2>&1 || { err "Node.js 安装失败"; exit 1; }
      ok "Node.js $(node -v) / npm $(npm -v) 安装完成（apk 仓库版）"
    fi
    NODE_BIN=$(which node)
    return
  fi

  # glibc 系统：下载固定版本到独立目录
  if [ -x "$NODE_BIN" ] && "$NODE_BIN" -v 2>/dev/null | grep -q "$NODE_VERSION"; then
    ok "Node.js $NODE_VERSION 已安装（$NODE_DIR）"
    return
  fi

  local NODE_TAR="node-${NODE_VERSION}-linux-x64.tar.xz"
  if [ "$ARCH" = "aarch64" ]; then
    NODE_TAR="node-${NODE_VERSION}-linux-arm64.tar.xz"
  fi
  local NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"

  info "下载 Node.js ${NODE_VERSION}..."
  cd /tmp
  if command -v wget &>/dev/null; then
    wget -q "$NODE_URL" -o /dev/null -O "$NODE_TAR" || { err "下载失败，请检查网络"; exit 1; }
  else
    curl -sL "$NODE_URL" -o "$NODE_TAR" || { err "下载失败，请检查网络"; exit 1; }
  fi

  info "解压安装 Node.js 到 $NODE_DIR..."
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$NODE_TAR" -C "$NODE_DIR" --strip-components=1
  rm -f "$NODE_TAR"
  ok "Node.js $($NODE_BIN -v) / npm $($NODE_DIR/bin/npm -v) 安装完成"
}
install_node

info "Node.js 路径: $NODE_BIN"

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

# 优先使用预编译 node_modules（跳过本地编译，节省时间和内存）
PREBUILT_OK=0
if [ "$PREBUILT_AVAILABLE" = "1" ]; then
  PREBUILT_PKG="node_modules-linux-${PREBUILT_ARCH}.tar.gz"
  [ "$PREBUILT_LIBC" = "musl" ] && PREBUILT_PKG="node_modules-linux-${PREBUILT_ARCH}-musl.tar.gz"
  PREBUILT_URL="https://github.com/gswenxue/QxueSSH/releases/download/prebuilt-v1/${PREBUILT_PKG}"
  info "尝试下载预编译 node_modules（${PREBUILT_PKG}）..."
  if curl -sL --fail "$PREBUILT_URL" -o /tmp/qxue_node_modules.tar.gz 2>/dev/null && [ -s /tmp/qxue_node_modules.tar.gz ]; then
    tar -xzf /tmp/qxue_node_modules.tar.gz -C "$INSTALL_DIR"
    rm -f /tmp/qxue_node_modules.tar.gz
    if [ -d "$INSTALL_DIR/node_modules" ] && [ -f "$INSTALL_DIR/node_modules/node-pty/build/Release/pty.node" ]; then
      ok "预编译 node_modules 已就绪（跳过本地编译）"
      PREBUILT_OK=1
    fi
  fi
  if [ "$PREBUILT_OK" = "0" ]; then
    warn "预编译包下载失败，回退到本地编译..."
  fi
fi

# 预编译失败或不支持的平台，走 npm install
if [ "$PREBUILT_OK" = "0" ]; then
  # 低内存机器自动创建 swap，防止编译 node-pty 时 OOM
  MEM_TOTAL_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
  if [ -n "$MEM_TOTAL_KB" ] && [ "$MEM_TOTAL_KB" -lt 1048576 ]; then
    if [ ! -f /tmp/qxue_swap ]; then
      warn "内存不足 1GB，自动创建 1GB swap 以支持编译..."
      fallocate -l 1G /tmp/qxue_swap 2>/dev/null || dd if=/dev/zero of=/tmp/qxue_swap bs=1M count=1024 2>/dev/null
      chmod 600 /tmp/qxue_swap
      mkswap /tmp/qxue_swap >/dev/null 2>&1
      swapon /tmp/qxue_swap 2>/dev/null && info "swap 已启用" || warn "swap 创建失败，编译可能因内存不足失败"
    fi
  fi
  npm install --production --registry=https://registry.npmmirror.com 2>/dev/null || npm install --production
  ok "依赖安装完成"
fi

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
ADMIN_HASH=$($NODE_BIN -e "
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
  "localTerminalEnabled": false,
  "meta": { "lastSync": 0 },
  "backup": {
    "enabled": false, "webdavUrl": "", "username": "", "password": "",
    "intervalHours": 24, "retention": 5, "lastBackup": null, "lastError": null, "log": []
  }
}
DBEOF
ok "管理员账号已创建"

# ---------- 创建 systemd 服务 ----------
create_service() {
  SERVICE_TYPE="nohup"
  # systemd (Debian/Ubuntu/CentOS)
  if command -v systemctl &>/dev/null; then
    cat > /etc/systemd/system/${SERVICE_NAME}.service <<SVCEOF
[Unit]
Description=QxueSSH Web SSH Client
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN server.js
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
    SERVICE_TYPE="systemd"
    return 0
  fi

  # OpenRC (Alpine/Gentoo)
  if command -v rc-service &>/dev/null; then
    cat > /etc/init.d/${SERVICE_NAME} <<SVCEOF
#!/sbin/openrc-run

description="QxueSSH Web SSH Client"
pidfile="/run/qxuessh.pid"
logfile="/var/log/qxuessh.log"

depend() {
    need net
    after firewall
}

start() {
    ebegin "Starting QxueSSH"
    cd $INSTALL_DIR
    PORT=$APP_PORT nohup $NODE_BIN server.js > \$logfile 2>&1 &
    echo \$! > \$pidfile
    eend \$?
}

stop() {
    ebegin "Stopping QxueSSH"
    if [ -f \$pidfile ]; then
        kill \$(cat \$pidfile) 2>/dev/null
        rm -f \$pidfile
    else
        pkill -f "node server.js" 2>/dev/null
    fi
    eend \$?
}
SVCEOF
    chmod +x /etc/init.d/${SERVICE_NAME}
    rc-update add ${SERVICE_NAME} default &>/dev/null
    ok "OpenRC 服务已创建并设置自启动"
    SERVICE_TYPE="openrc"
    return 0
  fi

  warn "未检测到 systemd 或 OpenRC，将使用 nohup 方式运行"
  return 1
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
create_service
case "$SERVICE_TYPE" in
  systemd) systemctl start $SERVICE_NAME ;;
  openrc)  rc-service $SERVICE_NAME start ;;
  *)       cd "$INSTALL_DIR" && PORT=$APP_PORT nohup $NODE_BIN server.js > /tmp/qxuessh.log 2>&1 & ;;
esac

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
