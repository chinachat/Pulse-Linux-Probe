# Pulse Linux Probe

**[English](README.md) | 简体中文**

多节点 Linux 监控仪表盘：零依赖的 Python 3 服务端 + 一行命令安装的 Bash 客户端 + 实时 Web 仪表盘，支持 IP 脱敏、国旗展示、资源仪表图和网络速率曲线。

## 功能特性

- CPU / 内存 / 磁盘仪表图，每个节点保留 120 条网络速率历史采样
- 数据加密落盘（SHA-256 密钥流加密 + HMAC-SHA256 完整性校验），原子写入防损坏
- API Key 上报机制，支持吊销密钥和封禁节点（被封禁节点可查看、可解封）
- 管理后台：密钥管理、节点改名/归属地修改、生成客户端一键安装命令
- 默认安全加固：静态文件白名单、常量时间密码比较、登录限流、会话过期、安全响应头、事件日志

## 快速开始

```bash
PROBE_ADMIN_PASSWORD='强密码' python3 server.py
```

打开 `http://服务器IP:8080`，使用 `admin` 登录，创建 API Key，然后点击**客户端安装**生成一键安装命令，到目标 Linux 主机上执行即可。

## Docker 部署

```bash
PROBE_ADMIN_PASSWORD='强密码' docker compose up -d --build
```

数据持久化在 `probe-data` 卷中（容器内路径 `/data`）。

## 服务端安装（systemd）

将本项目复制到 `/opt/pulse-probe`，然后执行：

```bash
cd /opt/pulse-probe
PROBE_ADMIN_PASSWORD='你的后台密码' PROBE_DATA_KEY='独立且足够长的密钥' ./install-server.sh
```

安装脚本会创建并启动 `pulse-probe.service`，监听 8080 端口。需要 Python 3。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `PROBE_ADMIN_USER` | `admin` | 管理员用户名 |
| `PROBE_ADMIN_PASSWORD` | `change-me` | 管理员密码（**务必修改！**） |
| `PROBE_DATA_KEY` | 由管理员密码派生 | `data.enc` 数据文件的加密密钥 |
| `PROBE_DATA_DIR` | 项目目录 | `data.enc` 存储位置 |
| `PROBE_PUBLIC_URL` | 由请求推断 | 生成安装脚本时使用的外部访问地址（如 `https://probe.example.com`） |
| `PROBE_SESSION_TTL` | `43200` | 管理员会话有效期（秒） |
| `PROBE_OFFLINE_SECONDS` | `90` | 超过该秒数未上报则节点显示离线 |
| `PROBE_REQUIRE_SET_PASSWORD` | 未设置 | 设置后，使用默认密码时拒绝启动 |
| `PROBE_TRUST_PROXY` | 未设置 | 信任 `X-Forwarded-For`/`X-Real-IP` 作为节点 IP（仅在反代正确传递真实 IP 时开启） |

## 客户端说明

客户端每分钟通过 cron 上报一次：CPU（1 秒间隔增量采样）、内存、根分区磁盘、网络吞吐（排除 lo 回环）、系统运行时长、OS 名称和国家代码。国家代码通过 `https://ipapi.co/country/` 查询；在后台手动设置的国家代码优先于自动查询结果。

## API 一览

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 无 | 健康检查探活 |
| `GET /api/nodes` | 无 | 公开节点列表（IP 已脱敏） |
| `POST /api/report` | `X-API-Key` | 客户端上报 |
| `POST /api/login` / `POST /api/logout` | 无 | 管理员登录/登出 |
| `GET/POST /api/admin/keys`、`DELETE /api/admin/keys/{id}` | 会话 | 密钥管理 |
| `GET/POST /api/admin/nodes`、`DELETE /api/admin/nodes/{id}` | 会话 | 节点管理（删除即封禁） |
| `GET /api/admin/blocked`、`POST /api/admin/unblock` | 会话 | 封禁节点查看/解封 |
| `GET /api/install.sh?key=...` | 会话 | 生成客户端安装脚本 |

## 开发

```bash
python -m pytest tests/ -v   # 或者：python tests/test_server.py
```

测试为纯标准库实现，共 15 个端到端用例（登录、限流、密钥、上报、节点管理、吊销、登出、静态白名单、XFF 解析、封禁/解封）。CI（GitHub Actions）执行 `py_compile`、Python 3.10/3.12 测试和 ShellCheck，工作流文件见 `.github/workflows/ci.yml`。

## 安全须知

- 公网部署前**务必**设置强 `PROBE_ADMIN_PASSWORD`（建议同时设置独立的 `PROBE_DATA_KEY`）；可设置 `PROBE_REQUIRE_SET_PASSWORD=1` 强制 fail-closed。
- 公网环境请置于 HTTPS 反向代理之后，并设置 `PROBE_PUBLIC_URL` 为外部访问地址，使生成的安装脚本引用正确的 URL。
- 使用反向代理时，请同时传递真实客户端 IP（nginx/openresty 配置 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`）并设置 `PROBE_TRUST_PROXY=1`，否则所有节点都会显示成反代自己的 IP。
- 静态文件服务已做白名单限制，`data.enc` 和服务端源码不会通过 HTTP 暴露。
- 登录接口按 IP 限流（5 次失败 / 5 分钟内锁定）。
- 客户端 API Key 会以明文存在于目标主机的 crontab 中，请妥善保护主机账户。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
