# Pulse Linux Probe

**[English](README.md) | 简体中文**

多节点 Linux 监控仪表盘：零依赖 Python 3 服务端 + 一行命令的 Bash 客户端 + 实时 Web 仪表盘，支持 IP 脱敏、国旗展示、硬件规格、柱状进度条、网络速率、三网 TCP Ping 延迟监测。

## 功能特性

- **资源监控** — CPU / 内存 / 磁盘横向彩色进度条 + 总容量规格
- **硬件信息** — CPU 核心数、总内存、磁盘容量、累计上传/下载流量
- **网络指标** — 实时速率（Mbps）+ 累计流量（MB/GB/TB）
- **TCP Ping** — CT 电信 / CU 联通 / CM 移动三网延迟徽章（绿 ≤100ms / 黄 ≤300ms / 红 >300ms）
- **Ping 历史图** — SVG 折线图，60 采样点，Y 轴分离标签
- **分组显示** — 节点按国家自动分组，折叠/展开状态持久化
- **浮动导航** — 分组 + 节点锚点、滚动高亮、移动端滑出、回到顶部
- **数据加密** — SHA-256 密钥流 + HMAC 校验，原子写入，高频写入防抖
- **安全加固** — CSRF 保护、强制密码+密钥、非 root 容器、CSP/HSTS 头、登录限流
- **管理后台** — 密钥管理（可编辑备注）、节点改名、管理员用户名修改、一键安装（含复制按钮）、三网 Ping 目标配置

## 快速开始（开发环境）

```bash
PROBE_ADMIN_PASSWORD='强密码' PROBE_DATA_KEY='独立密钥' python3 server.py
```

> `PROBE_ADMIN_PASSWORD` 和 `PROBE_DATA_KEY` **必须同时设置且不能相同**，否则服务拒绝启动。

## Docker 部署

完整部署与维护文档见 [DEPLOY.md](DEPLOY.md)。

### 最小步骤

```bash
git clone https://github.com/chinachat/Pulse-Linux-Probe.git
cd Pulse-Linux-Probe
echo 'PROBE_ADMIN_PASSWORD=你的强密码' > .env
echo 'PROBE_DATA_KEY=你的独立密钥' >> .env
echo 'PROBE_PUBLIC_URL=https://probe.你的域名.com' >> .env
docker compose up -d --build
```

数据持久化：`probe-data` 卷（容器内 `/data`）。

### 反向代理 (nginx)

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

在 `.env` 中设置 `PROBE_TRUST_PROXY=true` 和 `PROBE_PUBLIC_URL`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `PROBE_ADMIN_USER` | `admin` | 初始管理员用户名（后台保存优先） |
| `PROBE_ADMIN_PASSWORD` | **必填** | 管理员密码 |
| `PROBE_DATA_KEY` | **必填** | 数据加密密钥（须与密码不同） |
| `PROBE_DATA_DIR` | 项目目录 | `data.enc` 存储位置 |
| `PROBE_PUBLIC_URL` | 由请求推断 | 生成安装脚本的外部访问地址 |
| `PROBE_SESSION_TTL` | `43200`（12h） | 管理员会话有效期（秒） |
| `PROBE_OFFLINE_SECONDS` | `90` | 超时未上报则显示离线 |
| `PROBE_MAX_NODES` | `200` | 节点数上限（防止持钥者刷 hostname 耗尽存储） |
| `PROBE_TRUST_PROXY` | 未设置 | 信任 X-Forwarded-For 获取真实 IP |

## 客户端说明

每分钟通过 cron 上报一次：

- CPU（1 秒间隔增量采样）、内存使用率+总量、根磁盘使用率+总量
- 网络收发速率（bytes/s，排除 lo）+ 累计总流量
- 运行时长、OS 名称+版本（SVG 矢量图标）、国家代码（缓存 24h）、CPU 核心数
- 三个 TCP Ping 目标延迟（电信/联通/移动）

国家代码缓存 24 小时，OS 信息永久缓存。

## 管理后台

1. **API 密钥** — 创建、编辑备注、吊销、生成客户端安装命令
2. **客户端安装** — 一键复制命令，自动嵌入 Ping 目标
3. **节点信息** — 改名、改归属地、删除（自动封禁）
4. **已封禁节点** — 查看和解封
5. **账号设置** — 修改管理员用户名
6. **三网 Ping 监测** — 配置三个运营商 TCP Ping 目标（host:port）

## API 一览

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 无 | 健康检查 |
| `GET /api/nodes` | 无 | 公开节点列表（IP 脱敏） |
| `POST /api/report` | `X-API-Key` | 客户端上报 |
| `POST /api/login` | 无 | 登录（返回 CSRF token） |
| `POST /api/logout` | 无 | 登出 |
| `GET /api/admin/keys` | 会话 | 查看密钥 |
| `POST /api/admin/keys` | 会话+CSRF | 创建密钥 |
| `POST /api/admin/keys/{id}` | 会话+CSRF | 修改备注 |
| `DELETE /api/admin/keys/{id}` | 会话+CSRF | 吊销密钥 |
| `GET /api/admin/nodes` | 会话 | 查看节点（真实 IP） |
| `POST /api/admin/nodes` | 会话+CSRF | 编辑节点 |
| `DELETE /api/admin/nodes/{id}` | 会话+CSRF | 删除并封禁 |
| `GET /api/admin/blocked` | 会话 | 查看封禁列表 |
| `POST /api/admin/unblock` | 会话+CSRF | 解封 |
| `GET /api/admin/settings` | 会话 | 查看设置（含 CSRF token） |
| `POST /api/admin/settings` | 会话+CSRF | 修改用户名/Ping 目标 |
| `GET /api/install.sh?key=...` | 会话 | 生成安装脚本 |

## 安全特性

- `PROBE_ADMIN_PASSWORD` 和 `PROBE_DATA_KEY` 必填且不能相同
- 所有管理员写操作需 CSRF token（`X-CSRF-Token` 头）
- Docker 容器以非 root `pulse` 用户运行，根文件系统只读
- Session Cookie：`HttpOnly`、`SameSite=Strict`、HTTPS 下 `Secure`
- 登录限流：每 IP 5 次失败 / 5 分钟
- Ping 目标仅接受 `host:port` 格式，嵌入客户端脚本前强制校验（阻断命令注入）
- 节点数与请求体大小上限（`PROBE_MAX_NODES`、64KB），防资源耗尽
- Content-Security-Policy、X-Frame-Options、HSTS（HTTPS）、静态文件白名单
- 常量时间密码比较（`hmac.compare_digest`）
- 默认不信任 `X-Forwarded-For`（`PROBE_TRUST_PROXY` 关闭时不可伪造 IP）

## 开发

```bash
python -m pytest tests/ -v
```

CI 见 `.github/workflows/ci.yml`。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
