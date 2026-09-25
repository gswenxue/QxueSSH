# QxueSSH

现代化在线 SSH 终端 —— 在浏览器中安全地连接和管理你的服务器，手机电脑均可使用。

## 功能特性

### SSH 终端
- 多标签连接，同时管理多台服务器
- 临时快速连接（不保存）与主机收藏（云端记忆）
- 主机列表支持手动排序（上移 / 下移）
- 支持密码 / 私钥认证
- 移动端优化的快捷键条（方向键、Tab、Ctrl 组合键等），可自定义
- 多主题（亮色 / 暗色 / Dracula / Nord / Solarized）
- 会话空闲提醒：长时间未操作弹窗确认，防止误断与资源占用

### 文件管理（SFTP）
- 目录浏览、上传、下载、重命名、删除
- 复制 / 剪切 / 粘贴（单个或批量）
- 多选模式：勾选多个文件后批量复制 / 剪切 / 压缩（tar.gz）
- 拖拽上传：弹窗内拖入即传，支持多文件队列
- 在线文本编辑器，直接编辑远程文件
- 新建文件 / 目录

### 实时系统监控
- CPU、内存、**Swap**（未启用会明确显示）、磁盘、网络速率
- **系统版本**（如 Debian 11、Ubuntu 22.04 等，顶部展示）
- 负载、运行时长、进程 TOP
- 底部状态条实时展示，间隔可调
- 兼容 Alpine 等 BusyBox 系统（磁盘检测自动适配）

### 本机终端
- 管理员可在站点管理中开启「本机终端」，开启需验证本机 SSH 密码或私钥（支持自定义 SSH 端口）
- 开启后仅管理员主页可见，直接访问部署机器本身的 shell，无需 SSH 连接
- 支持完整交互式终端（vim、top、htop 等），监控面板同步展示本机信息
- 支持完整文件管理（目录浏览、上传下载、编辑、压缩等，基于本地文件系统）
- 支持 Docker 容器管理（容器列表、日志、启停、重启策略、镜像管理）
- 统一终端环境（TERM/COLORTERM/LANG），字体颜色与 SSH 登录体验一致

### Docker 容器管理
- 服务器 Docker 版本、镜像存储位置
- 容器列表：运行状态、端口映射（折叠展示）、实时 CPU / 内存占用
- 容器操作：启动 / 停止 / 重启 / 查看日志（最近 300 行）
- 重启策略查看与快捷切换（`no` / `always` / `unless-stopped` / `on-failure`）
- 镜像列表与删除

### 账户与安全
- 用户注册 / 登录，SVG 图形验证码（登录注册必填）
- 登录失败锁定：同一 IP 连续失败 5 次锁 15 分钟，同一账号连续失败 5 次锁 30 分钟
- 密码最低 8 位（bcrypt 哈希存储）
- Token 3 天有效期 + 活跃自动续期
- 未登录禁止使用 SSH 功能，防止被滥用
- 前端资源**完全自托管**（xterm.js、图标等内置，无外部 CDN 请求），杜绝第三方脚本窃取 SSH 凭据的供应链风险
- 管理员可开关站点注册、查看登录日志
- 管理员可开关「本机终端」（开启需验证本机 SSH 凭据，开启后仅管理员可见可用）
- 管理员账号无注销按键，避免异常操作
- 退出登录时自动关闭所有已打开的终端会话，防止残留
- WebDAV 自动备份（如坚果云）

### 界面与偏好设置
右上角「设置」弹窗中可配置（存储在浏览器本地，个人偏好）：
- 主题切换（浅色 / 深色 / Dracula / Nord / Solarized / 午夜蓝）
- 终端字体大小调节（10-24px）
- 终端快捷键条显示开关（移动端默认开启，PC 默认关闭，支持鼠标拖拽和滚轮横向滚动）
- 底部长条监控显示开关
- **隐藏主机IP及端口**：开启后主机列表不显示地址和端口，鼠标悬停主机项时显示

## 部署

### 一键部署（推荐）

在服务器上执行以下命令，脚本会自动安装 Node.js 环境、下载项目、配置管理员账号和端口，并注册为 systemd 服务：

- **Debian/Ubuntu/CentOS（glibc）**：下载固定版本 Node.js v20.18.1，独立安装到 `/opt/qxue-node/`，不依赖系统预装
- **Alpine（musl）**：通过 `apk` 安装仓库版 Node.js（v20.x），官方二进制不兼容 musl

```bash
curl -O https://raw.githubusercontent.com/gswenxue/QxueSSH/main/install.sh && bash install.sh
```

**预编译加速**：Debian/Ubuntu/CentOS（glibc）和 Alpine（musl）的 **x86_64** 系统自动下载预编译的 `node_modules`（含 node-pty 原生二进制），跳过本地编译，安装仅需 20-40 秒。arm64 及其他架构自动回退到本地编译（需安装编译工具）。

> **Alpine 注意**：Alpine 使用 musl libc，官方 Node.js 二进制不兼容，脚本会自动通过 `apk` 安装仓库版 Node.js（v20.x），并下载 musl 版本的预编译 node_modules。

部署过程中会交互式询问：
- 管理员用户名（默认 `Qxue`）
- 是否自定义管理员密码（选 `y` 后需两次输入确认，至少 8 位；否则使用默认密码）
- 服务监听端口（默认 `3000`）

部署完成后会输出访问地址、管理员账号和密码，请妥善保存。

### 服务管理命令

部署完成后，可使用 `qxuessh` 命令进行交互式管理：

```bash
qxuessh
```

唤起数字菜单，顶部实时显示运行状态、端口、自启状态，通过序号选择操作：

| 序号 | 功能 |
|------|------|
| 1 | 重启服务 |
| 2 | 停止服务 |
| 3 | 启动服务 |
| 4 | 修改运行端口 |
| 5 | 开机自启动管理 |
| 6 | 重置管理员密码 |
| 7 | 查看运行日志 |
| 8 | 查看服务详情 |
| 9 | 卸载服务 |
| 0 | 退出 |

**卸载服务**：停止并删除服务，询问是否保留 Node.js 运行环境（glibc 系统为 `/opt/qxue-node/`）。选 `y` 仅删除项目文件，保留环境便于下次快速重装；选 `n` 彻底删除项目、Node.js 环境和管理命令。

也支持直接命令模式：`qxuessh status`、`qxuessh restart`、`qxuessh port 8080`、`qxuessh autostart on` 等。

### 手动部署

要求：Node.js 18+

```bash
# 1. 克隆
git clone https://github.com/gswenxue/QxueSSH.git
cd QxueSSH

# 2. 安装依赖
npm install

# 3. 启动（默认端口 3000，可用 PORT 环境变量修改）
npm start
# 或
PORT=8080 node server.js
```

启动后访问 `http://你的IP:端口`。

首次启动会自动创建数据文件 `data/db.json`和默认管理员账户：

| 用户名 | 密码 |
|--------|------|
| Qxue | Qxue2026 |

**登录后请立即在设置中修改默认密码。**

### 生产环境建议

- 一键部署脚本已自动配置服务常驻运行与开机自启动
  - Debian/Ubuntu/CentOS：systemd 服务
  - Alpine/Gentoo：OpenRC 服务（`/etc/init.d/qxuessh`）
  - 无 init 系统的环境：nohup 后台运行
- 建议用 Nginx / Caddy 反向代理并配置 HTTPS（设置中可开启"信任代理头"获取真实 IP）

### 更新到最新版本

```bash
# 进入项目目录（默认 /opt/QxueSSH，旧版部署可能在 /opt/qxuessh）
cd /opt/QxueSSH

# 拉取最新代码
git pull

# 重新安装依赖（如有依赖变更）
npm install --production

# 重启服务
qxuessh restart
# 或
systemctl restart qxuessh
```

> **预编译模式**：如果安装时使用了预编译 node_modules，更新代码后无需重新编译，直接重启即可。仅当 `package.json` 依赖变更时才需要重新下载对应平台的预编译包。

## 配置说明

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| PORT | 3000 | 监听端口 |

数据均存储在 `data/db.json`（JSON 文件存储，无外部数据库依赖）。

## 技术栈

- 后端：Node.js + Express + Socket.IO + ssh2 + node-pty（本机终端）
- 前端：原生 JavaScript + xterm.js（自托管于 `public/vendor/`）
- 认证：bcryptjs + Token（3 天有效期，滑动续期）
- 静态资源：预压缩传输（`.gz` 预生成，零运行时压缩开销）

## 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|---------|---------|
| CPU | 1 核 | 2 核+ |
| 内存 | 512MB（预编译模式） | 1GB+ |
| 磁盘 | 200MB | 500MB+ |
| 系统 | Debian 10+ / Ubuntu 18.04+ / CentOS 7+ / Alpine | Debian/Ubuntu LTS |

> 预编译模式下无需编译工具，低内存机器也可流畅安装；glibc 和 musl(Alpine) 均已提供预编译包。其他架构需本地编译，建议 1GB+ 内存。

## 二次开发注意

前端静态资源采用**预压缩**机制：浏览器请求 JS / CSS / HTML 时，服务端优先返回对应的 `.gz` 文件。

因此修改 `public/` 下的源文件后，必须重新生成压缩版本，否则浏览器拿到的仍是旧内容：

```bash
# 重新生成所有 .gz（在项目根目录执行）
for f in public/app.js public/style.css public/index.html \
         public/vendor/xterm.min.js public/vendor/xterm.min.css \
         public/vendor/xterm-addon-fit.min.js; do
  gzip -9 -c "$f" > "$f.gz"
done
```

## 安全提醒

- 本服务等同于把 SSH 入口暴露在网页上，**务必使用强密码**并保持登录锁定策略开启
- 默认管理员密码请第一时间修改
- 不要把 `data/` 目录提交到任何公开仓库

## License

MIT
