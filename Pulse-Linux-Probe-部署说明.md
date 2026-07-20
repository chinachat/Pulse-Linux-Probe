# Pulse Linux Probe 部署说明

> 适用版本：main 分支（2026-07-20 之后，端口统一为 8080）
> 项目地址：https://github.com/chinachat/Pulse-Linux-Probe

---

## 目录

1. [架构概览](#1-架构概览)
2. [部署前准备](#2-部署前准备)
3. [方式一：Docker 部署（推荐）](#3-方式一docker-部署推荐)
4. [方式二：systemd 裸机部署](#4-方式二systemd-裸机部署)
5. [配置 HTTPS 反向代理（公网必做）](#5-配置-https-反向代理公网必做)
6. [客户端（被监控节点）安装](#6-客户端被监控节点安装)
7. [环境变量完整参考](#7-环境变量完整参考)
8. [老版本升级迁移指南](#8-老版本升级迁移指南)
9. [日常运维](#9-日常运维)
10. [安全自查清单](#10-安全自查清单)
11. [故障排查](#11-故障排查)

---

## 1. 架构概览

```
┌─────────────┐   每分钟 POST /api/report    ┌──────────────────┐
│  Linux 节点 A │ ──────────────────────────▶ │                  │
│  (cron+curl) │                              │   server.py      │
├─────────────┤   X-API-Key 鉴权              │   (端口 8080)     │
│  Linux 节点 B │ ──────────────────────────▶ │                  │
│  (cron+curl) │                              │   data.enc       │
└─────────────┘                              │   (加密落盘)      │
                                              └───────┬──────────┘
                                                      │ 浏览器访问
                                              ┌───────▼──────────┐
                                              │  仪表盘 / 管理后台 │
                                              └──────────────────┘
```

- **服务端**：单文件 `server.py`，Python 3 标准库实现，无任何第三方依赖
- **客户端**：`agent.sh` 生成的 Bash 脚本 + cron 每分钟上报，依赖 `curl`、`awk`、`free`、`df`
- **数据存储**：单文件 `data.enc`（SHA-256 密钥流加密 + HMAC-SHA256 完整性校验，原子写入）

## 2. 部署前准备

| 项目 | 要求 |
|---|---|
| 服务端主机 | 任意 Linux（或支持 Docker 的环境），Python ≥ 3.8 |
| 开放端口 | 8080（可改）；公网部署建议只暴露 443 由反代转发 |
| 必备决策 | 一个强管理员密码；一个独立的 `PROBE_DATA_KEY`（建议 32 位以上随机串） |
| 公网部署 | 域名 + HTTPS 证书（见第 5 节） |

生成随机密钥的参考命令：

```bash
openssl rand -base64 32        # 用作 PROBE_ADMIN_PASSWORD
openssl rand -base64 48        # 用作 PROBE_DATA_KEY
```

> ⚠️ `PROBE_DATA_KEY` 一旦设定不要更换——更换后旧的 `data.enc` 无法解密（等同于清空数据）。

## 3. 方式一：Docker 部署（推荐）

### 3.1 一键启动

```bash
git clone https://github.com/chinachat/Pulse-Linux-Probe.git
cd Pulse-Linux-Probe

PROBE_ADMIN_PASSWORD='你的强密码' \
PROBE_DATA_KEY='独立随机长密钥' \
docker compose up -d --build
```

- 服务监听 `8080`，数据持久化在名为 `probe-data` 的 Docker 卷中
- 容器内置健康检查（每 30 秒探测 `/api/health`）

### 3.2 使用 .env 文件（避免密码出现在 shell 历史）

```bash
cat > .env <<'EOF'
PROBE_ADMIN_PASSWORD=你的强密码
PROBE_DATA_KEY=独立随机长密钥
EOF
chmod 600 .env
docker compose up -d --build
```

> `.env` 已被 `.gitignore` 忽略，不会被误提交。

### 3.3 常用运维命令

```bash
docker compose logs -f          # 查看实时日志（登录、节点上报等事件）
docker compose restart          # 重启
docker compose down             # 停止（数据卷保留）
docker compose up -d --build    # 更新代码后重建
docker volume inspect probe-data # 查看数据卷位置（备份用）
```

## 4. 方式二：systemd 裸机部署

### 4.1 安装

```bash
# 1. 放置代码
sudo git clone https://github.com/chinachat/Pulse-Linux-Probe.git /opt/pulse-probe
cd /opt/pulse-probe

# 2. 执行安装脚本（两个环境变量均为必填）
sudo PROBE_ADMIN_PASSWORD='你的后台密码' \
     PROBE_DATA_KEY='独立且足够长的密钥' \
     ./install-server.sh
```

脚本会创建 `/etc/systemd/system/pulse-probe.service` 并设为开机自启，监听 8080。

### 4.2 自定义端口

```bash
sudo PORT=9000 PROBE_ADMIN_PASSWORD='xxx' PROBE_DATA_KEY='yyy' ./install-server.sh
```

### 4.3 常用运维命令

```bash
systemctl status pulse-probe     # 运行状态
journalctl -u pulse-probe -f     # 实时日志（登录成功/失败、节点首报等）
systemctl restart pulse-probe    # 重启
```

### 4.4 修改配置

编辑 `/etc/systemd/system/pulse-probe.service` 中的 `Environment=` 行，然后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart pulse-probe
```

## 5. 配置 HTTPS 反向代理（公网必做）

服务端本身只提供 HTTP。公网部署请用 Nginx 或 Caddy 终结 TLS，并设置 `PROBE_PUBLIC_URL` 使生成的客户端安装命令使用正确的 HTTPS 地址。

### 5.1 Caddy（最简，自动签证书）

```
# /etc/caddy/Caddyfile
probe.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

### 5.2 Nginx

```nginx
server {
    listen 443 ssl;
    server_name probe.example.com;

    ssl_certificate     /etc/letsencrypt/live/probe.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/probe.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;   # 关键：让服务端给 Cookie 加 Secure
    }
}
```

### 5.3 配套环境变量

在 systemd service 或 docker-compose 中增加：

```
PROBE_PUBLIC_URL=https://probe.example.com
```

同时建议防火墙只放行 443，8080 仅监听本地或由反代服务器访问。

## 6. 客户端（被监控节点）安装

1. 浏览器打开仪表盘 → **管理后台** → 登录（默认用户 `admin`）
2. 输入密钥名称 → **生成 API Key**
3. 点击该密钥的 **客户端安装** 按钮，复制生成的一行命令
4. 在目标 Linux 主机上以 **root** 执行该命令

安装脚本会：

- 写入 `/usr/local/bin/linux-probe-payload`（采集脚本）
- 立即上报一次验证连通性
- 向当前用户 crontab 添加每分钟上报任务

**客户端依赖**：`bash`、`curl`、`awk`、`free`、`df`、`cron`（ Debian/Ubuntu 默认齐全；极简容器需自行安装 cron 与 curl）。

**卸载客户端**：

```bash
(crontab -l 2>/dev/null | grep -v 'linux-probe-payload') | crontab -
rm -f /usr/local/bin/linux-probe-payload /var/lib/linux-probe-network
```

**删除节点**：后台 → 节点信息 → 删除节点。删除即封禁（blocked），该节点再次上报会被静默丢弃；吊销对应 API Key 同理。

## 7. 环境变量完整参考

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `PROBE_ADMIN_USER` | `admin` | 管理员用户名 |
| `PROBE_ADMIN_PASSWORD` | `change-me` | 管理员密码（**必须修改**） |
| `PROBE_DATA_KEY` | 由管理员密码派生 | `data.enc` 加密密钥，建议独立设置且不再变更 |
| `PROBE_DATA_DIR` | 项目目录 | 数据文件目录（Docker 中为 `/data`） |
| `PROBE_PUBLIC_URL` | 由请求推断 | 生成安装命令使用的外部地址 |
| `PROBE_SESSION_TTL` | `43200`（12h） | 后台会话有效期（秒） |
| `PROBE_OFFLINE_SECONDS` | `90` | 超过该秒数未上报判定离线 |
| `PROBE_REQUIRE_SET_PASSWORD` | 未设置 | 设任意值后，默认密码下拒绝启动（fail-closed） |

## 8. 老版本升级迁移指南

适用于 2026-07-20 之前部署的版本（默认端口 28080 的旧代码）。

### 8.1 变更点速览

| 变更 | 影响 |
|---|---|
| 默认端口 28080 → **8080** | 防火墙/反代/客户端上报地址需同步 |
| 静态文件白名单 | `install-server.sh`、`agent.sh` 不再能通过 HTTP 直接下载（不影响功能） |
| 登录限流（5 次/5 分钟） | 自动化脚本若频繁试错密码会被锁 5 分钟 |
| 会话 12 小时过期 | 后台需重新登录，属预期行为 |
| `data.enc` 格式不变 | **数据完全兼容，无需迁移** |

### 8.2 升级步骤（systemd）

```bash
cd /opt/pulse-probe
sudo git pull                      # 或重新拷贝新代码
# 端口若沿用 28080：编辑 /etc/systemd/system/pulse-probe.service
# 加一行 Environment=PORT=28080；否则调整防火墙放行 8080
sudo systemctl daemon-reload
sudo systemctl restart pulse-probe
journalctl -u pulse-probe -n 20    # 确认监听端口
```

### 8.3 升级步骤（Docker）

```bash
cd Pulse-Linux-Probe
git pull
docker compose up -d --build       # 数据卷自动保留
```

### 8.4 客户端侧

- 若**端口变了**：每个节点需更新 crontab 中的上报地址。最省事的方式是在后台重新生成安装命令到节点上再跑一遍（脚本自带去重，不会产生重复 cron 行）。
- 若端口不变：客户端**无需任何操作**，新版服务端完全兼容旧上报格式。

## 9. 日常运维

### 9.1 备份

只需备份一个文件：

```bash
# Docker
docker run --rm -v probe-data:/data -v $(pwd):/backup alpine \
    cp /data/data.enc /backup/data.enc.$(date +%F)

# 裸机
cp /opt/pulse-probe/data.enc ~/backup/data.enc.$(date +%F)
```

恢复：停服务 → 放回 `data.enc`（确保 `PROBE_DATA_KEY` 与备份时一致）→ 启动。

### 9.2 监控服务端本身

```bash
curl -fsS http://127.0.0.1:8080/api/health
# {"ok":true,"nodes":3,"time":...}
```

可接入 Uptime Kuma、Prometheus blackbox_exporter 等做存活监控。

### 9.3 日志含义

| 日志 | 含义 |
|---|---|
| `login ok for 'admin' from x.x.x.x` | 后台登录成功 |
| `login failed for user ... from ...` | 密码错误（留意暴力破解来源 IP） |
| `login rate-limited for ...` | 该 IP 触发限流 |
| `node xxx (hostname) first reported from ...` | 新节点首次上报 |
| `api key xxx created / revoked` | 密钥创建/吊销 |
| `node xxx deleted and blocked` | 节点被删除并封禁 |

## 10. 安全自查清单

部署完成后逐项核对：

- [ ] `PROBE_ADMIN_PASSWORD` 为强密码，非默认值
- [ ] `PROBE_DATA_KEY` 独立设置，并安全存档（丢失=数据不可解密）
- [ ] 公网访问走 HTTPS 反代，且已设置 `PROBE_PUBLIC_URL`
- [ ] 8080 端口未直接暴露公网（仅反代可达）
- [ ] 已设置 `PROBE_REQUIRE_SET_PASSWORD=1`（可选，更保险）
- [ ] `data.enc` 所在目录权限合理（非 root 不可读）
- [ ] 定期备份 `data.enc`
- [ ] 验证静态白名单：`curl http://IP:8080/server.py` 应返回 404

## 11. 故障排查

| 现象 | 排查方向 |
|---|---|
| 打不开仪表盘 | `systemctl status pulse-probe` / `docker compose ps`；防火墙是否放行端口 |
| 节点一直离线 | 节点上手动执行 `/usr/local/bin/linux-probe-payload` 看输出；`crontab -l` 确认任务存在；`curl` 手动 POST 测试连通性 |
| 后台登录一直 401 | 确认密码；连续失败 5 次会被锁 5 分钟（429），稍后再试 |
| 安装命令里地址不对 | 设置 `PROBE_PUBLIC_URL` 为外部完整地址后重启 |
| 启动报 integrity check failed | `PROBE_DATA_KEY` 与数据文件不匹配；恢复正确的 key 或（确认无重要数据时）删除 `data.enc` 重来 |
| CPU 一直显示很高 | 旧版客户端算法问题——用后台重新生成的安装命令升级节点客户端 |
| 国家旗帜不显示 | 节点出网无法访问 `ipapi.co`；可在后台手动填写两位国家代码覆盖 |

---

*文档生成时间：2026-07-20，与仓库 main 分支同步。*
