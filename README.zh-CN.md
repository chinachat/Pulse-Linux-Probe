# Pulse Linux Probe

**[English](README.md) | 简体中文**

多节点 Linux 监控仪表盘：零依赖 Python 3 服务端 + 一行命令的 Bash 客户端 + 实时 Web 仪表盘，支持 IP 脱敏、国旗展示、资源仪表图、硬件规格、网络速率折线图和分组折叠导航。

## 功能特性

- **资源监控** — CPU / 内存 / 磁盘环形仪表图，圆心同时显示百分比与总容量规格
- **硬件规格** — 每个节点展示 CPU 核心数、总内存容量、磁盘总容量
- **网络速率折线图** — 120 条历史采样，宽度自适应容器，左侧 Y 轴标注 Mbps 刻度
- **分组显示** — 节点按国家自动分组，支持折叠/展开；离线节点独立分组始终展开
- **浮动导航面板** — 右侧固定面板列出所有分组，滚动高亮当前分组，点击快速跳转，一键回到顶部
- **数据加密落盘** — SHA-256 密钥流加密 + HMAC-SHA256 完整性校验，原子写入防损坏，高频上报自动防抖
- **API Key 鉴权上报** — 支持吊销密钥和封禁节点（被封禁节点可查看、可解封）
- **管理后台** — 密钥管理（可编辑备注）、节点改名/归属地修改、管理员用户名修改、客户端一键安装（含复制按钮）
- **默认安全加固** — 静态文件白名单、常量时间密码比较、登录限流、会话过期、安全响应头、多线程数据读写加锁

## 快速开始

```bash
PROBE_ADMIN_PASSWORD='强密码' python3 server.py
```

打开 `http://服务器IP:8080`，用 `admin` 登录，创建 API Key，点击**客户端安装**生成一键安装命令，复制到目标 Linux 主机执行即可。

## Docker 部署（推荐）

### 1. 准备环境

```bash
git clone https://github.com/chinachat/Pulse-Linux-Probe.git
cd Pulse-Linux-Probe
echo 'PROBE_ADMIN_PASSWORD=你的强密码' > .env
echo 'PROBE_DATA_KEY=你的随机密钥' >> .env
echo 'PROBE_PUBLIC_URL=https://probe.你的域名.com' >> .env  # 可选
```

### 2. 启动

```bash
docker compose up -d --build
```

数据持久化在 `probe-data` 卷中（容器内路径 `/data`）。

### 3. 配置反向代理获取真实 IP

Docker 默认会隐藏客户端真实 IP（显示为 `172.x.x.x` 内网地址）。在前面加一层反向代理即可解决。

**nginx 配置示例：**

```nginx
server {
    listen 80;
    server_name probe.你的域名.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

然后在 `.env` 中设置：

```bash
PROBE_TRUST_PROXY=true
PROBE_PUBLIC_URL=https://probe.你的域名.com
```

> 使用 Caddy 更简单：`caddy reverse-proxy --from probe.你的域名.com --to localhost:8080`

### 4. 更新升级

```bash
git pull
docker compose down
docker compose up -d --build
```

## 服务端安装（systemd）

将项目文件复制到 `/opt/pulse-probe`，然后执行：

```bash
cd /opt/pulse-probe
PROBE_ADMIN_PASSWORD='你的后台密码' PROBE_DATA_KEY='独立且足够长的密钥' ./install-server.sh
```

安装脚本创建并启动 `pulse-probe.service`，监听 8080 端口。需要 Python 3。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `PROBE_ADMIN_USER` | `admin` | 初始管理员用户名（后台保存的用户名优先） |
| `PROBE_ADMIN_PASSWORD` | `change-me` | 管理员密码（**务必修改！**） |
| `PROBE_DATA_KEY` | 由密码派生 | `data.enc` 数据文件的加密密钥 |
| `PROBE_DATA_DIR` | 项目目录 | `data.enc` 存储位置 |
| `PROBE_PUBLIC_URL` | 由请求推断 | 生成安装脚本时使用的外部访问地址 |
| `PROBE_SESSION_TTL` | `43200`（12小时） | 管理员会话有效期（秒） |
| `PROBE_OFFLINE_SECONDS` | `90` | 超过该秒数未上报则节点显示离线 |
| `PROBE_REQUIRE_SET_PASSWORD` | 未设置 | 设置后，使用默认密码时拒绝启动 |
| `PROBE_TRUST_PROXY` | 未设置 | 信任 `X-Forwarded-For`/`X-Real-IP` 获取真实 IP（仅反代时开启） |

## 客户端说明

客户端每分钟通过 cron 上报一次：

- **CPU** — 1 秒间隔增量采样（`/proc/stat`），反映瞬时使用率
- **内存** — 使用百分比 + 总容量（`/proc/meminfo`）
- **磁盘** — 根分区使用百分比 + 总容量（`df`）
- **网络** — 收发吞吐速率（bytes/s），排除 lo 回环
- **运行时长**、**操作系统名称**、**国家代码**、**CPU 核心数**

国家代码查询结果缓存 24 小时，OS 信息永久缓存，避免每次上报都请求外部 API。

## API 一览

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 无 | 健康检查探活 |
| `GET /api/nodes` | 无 | 公开节点列表（IP 已脱敏） |
| `POST /api/report` | `X-API-Key` | 客户端上报 |
| `POST /api/login` / `POST /api/logout` | 无 | 管理员登录/登出 |
| `GET /api/admin/keys` | 会话 | 查看 API 密钥列表 |
| `POST /api/admin/keys` | 会话 | 创建 API 密钥 |
| `POST /api/admin/keys/{id}` | 会话 | 修改密钥备注 |
| `DELETE /api/admin/keys/{id}` | 会话 | 吊销密钥 |
| `GET /api/admin/nodes` | 会话 | 查看节点列表（真实 IP） |
| `POST /api/admin/nodes` | 会话 | 编辑节点名称/国家代码 |
| `DELETE /api/admin/nodes/{id}` | 会话 | 删除并封禁节点 |
| `GET /api/admin/blocked` | 会话 | 查看被封禁节点 |
| `POST /api/admin/unblock` | 会话 | 解封节点 |
| `GET /api/admin/settings` | 会话 | 查看设置 |
| `POST /api/admin/settings` | 会话 | 修改管理员用户名 |
| `GET /api/install.sh?key=...` | 会话 | 生成客户端安装脚本 |

## 开发

```bash
python -m pytest tests/ -v
```

测试为纯标准库实现，CI（GitHub Actions）执行 `py_compile`、Python 3.10/3.12 测试和 ShellCheck，工作流文件见 `.github/workflows/ci.yml`。

## 安全须知

- 公网部署前**务必**设置强 `PROBE_ADMIN_PASSWORD` 和独立的 `PROBE_DATA_KEY`。
- 生产环境请置于 HTTPS 反向代理之后。
- 仅在反代正确传递 `X-Forwarded-For` 时开启 `PROBE_TRUST_PROXY=true`。
- 静态文件服务已做白名单限制，`data.enc` 和服务端源码不会通过 HTTP 暴露。
- 登录接口按 IP 限流（5 次失败 / 5 分钟内锁定）。
- 客户端 API Key 会以明文存在于目标主机的 crontab 中，请妥善保护主机账户。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
