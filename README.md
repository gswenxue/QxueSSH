# QxueSSH

现代化在线 SSH 终端 —— 在浏览器中安全地连接和管理你的服务器，手机电脑均可使用。

## 功能特性

### SSH 终端
- 多标签连接，同时管理多台服务器
- 临时快速连接（不保存）与主机收藏（云端记忆）
- 支持密码 / 私钥认证
- 移动端优化的快捷键条（方向键、Tab、Ctrl 组合键等），可自定义
- 多主题（亮色 / 暗色 / Dracula / Nord / Solarized）
- 会话空闲提醒：长时间未操作弹窗确认，防止误断与资源占用

### 文件管理（SFTP）
- 目录浏览、上传、下载、重命名、删除
- 在线文本编辑器，直接编辑远程文件
- 新建文件 / 目录

### 实时系统监控
- CPU、内存、**Swap**（未启用会明确显示）、磁盘、网络速率
- 负载、运行时长、进程 TOP
- 底部状态条实时展示，间隔可调

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
- 管理员可开关站点注册、查看登录日志
- WebDAV 自动备份（如坚果云）

## 部署

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

- 用 systemd 常驻运行：

```ini
# /etc/systemd/system/qxuessh.service
[Unit]
Description=QxueSSH Web SSH Client
After=network.target

[Service]
WorkingDirectory=/opt/QxueSSH
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now qxuessh
```

- 建议用 Nginx / Caddy 反向代理并配置 HTTPS（设置中可开启"信任代理头"获取真实 IP）

## 配置说明

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| PORT | 3000 | 监听端口 |

数据均存储在 `data/db.json`（JSON 文件存储，无外部数据库依赖）。

## 技术栈

- 后端：Node.js + Express + Socket.IO + ssh2
- 前端：原生 JavaScript + xterm.js
- 认证：bcryptjs + Token（3 天有效期，滑动续期）

## 安全提醒

- 本服务等同于把 SSH 入口暴露在网页上，**务必使用强密码**并保持登录锁定策略开启
- 默认管理员密码请第一时间修改
- 不要把 `data/` 目录提交到任何公开仓库

## License

MIT
