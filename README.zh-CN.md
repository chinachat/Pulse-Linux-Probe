# Pulse Linux Probe

**[English](README.md) | 简体中文**

多节点 Linux 监控仪表盘：零依赖 Python 3 服务端 + 一行命令的 Bash 客户端 + 实时 Web 仪表盘，支持 IP 脱敏、国旗展示、硬件规格、柱状进度条、网络速率、三网 TCP Ping 延迟监测。

## 功能特性

- **现代仪表盘 UI** — 深色为默认主题，支持浅色切换（选择记忆在 localStorage），响应式卡片栅格、毛玻璃吸顶导航
- **资源监控** — CPU / 内存 / 磁盘横向彩色进度条 + 总容量规格
- **硬件信息** — CPU 核心数、总内存、磁盘容量、累计上传/下载流量
- **网络指标** — 实时速率（Mbps）+ 累计流量（MB/GB/TB），每张节点卡内置 canvas 实时速率图
- **TCP Ping** — CT 电信 / CU 联通 / CM 移动三网延迟徽章（绿 ≤100ms / 黄 ≤300ms / 红 >300ms）+ 丢包率
- **Ping 历史图** — SVG 面积渐变图展示 CT/CU/CM 延迟，**下方附带共用时间轴的丢包条**；整页可在 **1 小时 / 6 小时 / 12 小时 / 24 小时** 之间一键切换，服务端完整保留 **24 小时（1 分钟粒度）**
- **OS 识别** — 发行版图标经 CSS mask + currentColor 与标签同色渲染，深浅主题下均清晰
- **地区筛选** — 卡片上方的地区标签栏按国家分组（国旗 + 数量），点击某个地区只显示该地区的卡片
- **单节点详情页** — 点任意卡片（或直接打开 `#/node/<id>`）进入整页详情：CPU 型号 / 核心数 / 主频 / L3 缓存、发行版 + 版本号 + 代号、内核版本、进程/线程数、虚拟化类型、交换分区与 buff-cache、负载均值，以及 **1/6/12/24 小时** 的负载（CPU/内存/磁盘）、内存构成（已用 + 缓存）、网络速率、延迟 + 丢包曲线。另有**事件日志**（读时派生）、**可翻页的采样明细表**、**按接口快照**，以及 **CSV 导出**和分享链接
- **浮动导航** — 节点锚点、滚动高亮、移动端滑出、回到顶部
- **数据加密** — SHA-256 密钥流 + HMAC 校验，原子写入，高频写入防抖
- **安全加固** — CSRF 保护、强制密码+密钥、非 root 容器、CSP/HSTS 头、登录限流、Ping 目标注入防护、节点/请求体上限
- **管理后台** — 密钥管理（可编辑备注）、节点网格卡片编辑（含在线状态）、实时刷新不打断编辑、管理员用户名修改、一键安装（含复制按钮）、三网 Ping 目标配置

## 快速开始（开发环境）

```bash
PROBE_ADMIN_PASSWORD='强密码' PROBE_DATA_KEY='独立密钥' python3 server.py
```

> `PROBE_ADMIN_PASSWORD` 和 `PROBE_DATA_KEY` **必须同时设置且不能相同**，否则服务拒绝启动。

## Docker 部署

预构建镜像发布在 [GHCR](https://github.com/chinachat/Pulse-Linux-Probe/pkgs/container/pulse-linux-probe)，支持 **amd64 / arm64 / armv7** 多架构，无需本地构建，直接拉取：

```bash
curl -O https://raw.githubusercontent.com/chinachat/Pulse-Linux-Probe/main/docker-compose.yml
echo 'PROBE_ADMIN_PASSWORD=你的强密码' > .env
echo 'PROBE_DATA_KEY=你的独立密钥' >> .env
echo 'PROBE_PUBLIC_URL=https://probe.你的域名.com' >> .env  # 可选
docker compose up -d
```

不用 compose 也可以直接运行：

```bash
docker run -d --name pulse-probe --restart unless-stopped \
  -p 8080:8080 --env-file .env -v probe-data:/data \
  ghcr.io/chinachat/pulse-linux-probe:latest
```

数据持久化：`probe-data` 卷（容器内 `/data`）。

> 本地构建（开发）：把 `docker-compose.yml` 里的 `image:` 改为 `build: .`。

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
| `PROBE_PUBLIC_URL` | 由请求推断 | 生成安装脚本的外部访问地址；留空则按请求的 Host 头推导 |
| `PROBE_SESSION_TTL` | `43200`（12h） | 管理员会话有效期（秒） |
| `PROBE_OFFLINE_SECONDS` | `90` | 超时未上报则显示离线 |
| `PROBE_MAX_NODES` | `200` | 节点数上限（防止持钥者刷 hostname 耗尽存储） |
| `PROBE_LOAD_HISTORY` | `1440` | 每节点保留的负载/网络采样数（1 分钟一个，1440 = 24 小时）。内存/存储紧张时可调小 |
| `PROBE_PING_HISTORY` | `1440` | 每节点保留的延迟采样数（1 分钟一个，1440 = 24 小时）。内存/存储紧张时可调小 |
| `PROBE_TRUST_PROXY` | 未设置 | 信任 X-Forwarded-For 获取真实 IP。**只有 `1`/`true`/`yes`/`on` 算开启**，`false`、`0`、空值一律视为关闭 |

## 客户端说明

每分钟通过 cron 上报一次：

- CPU（1 秒间隔增量采样）+ iowait、内存使用率+总量、根磁盘使用率+总量
- 网络收发速率（bytes/s，排除 lo）+ 累计总流量 + 网卡错误/丢包计数
- 运行时长、OS 名称+完整版本号+代号、内核版本、国家代码（缓存 24h）、CPU 核心数
- 规格：**CPU 型号**、当前主频、架构、L3 缓存、虚拟化类型
- 负载：**1/5/15 负载均值**、**进程数 / 线程数 / 运行中**、交换分区、buff-cache、可用内存
- 三个 TCP Ping 目标延迟（电信/联通/移动）

> 规格与负载字段是新增的。用旧版 agent 装过的节点照常工作——详情页只显示它上报过的内容，
> 并提示"客户端版本较旧"。**想让某个节点显示完整规格，重新执行一次客户端安装命令即可。**

国家代码缓存 24 小时；OS 信息、CPU 型号、内核版本永久缓存。

延迟历史在服务端保留 **1440 采样（24 小时，1 分钟粒度）**（`PROBE_PING_HISTORY`），负载/网络历史同样
保留 24 小时（`PROBE_LOAD_HISTORY`）。列表接口 `/api/nodes` 压缩到最多 60 个速率点 + 240 个延迟点，
速率样本只下发 `time/rx/tx`——**超时的采样点始终保留**——所以响应体不会随保留时长增长。
单节点的全量序列走 `/api/nodes/<id>`。

## 管理后台

1. **API 密钥** — 创建、编辑备注、吊销、生成客户端安装命令
2. **客户端安装** — 一键复制命令，自动嵌入 Ping 目标
3. **节点信息** — 网格卡片布局；改名、改归属地、实时在线状态 + 最后上报时间、删除（自动封禁）
4. **已封禁节点** — 查看和解封
5. **账号设置** — 修改管理员用户名
6. **三网 Ping 监测** — 配置三个运营商 TCP Ping 目标（host:port）
7. **告警阈值** — CPU / 内存 / 磁盘 / iowait / 丢包率 / 延迟，**连续 3 分钟**越线才记一条事件。
   超范围的值夹到边界，非数值回落默认

事件日志从已存序列**读时派生**，不额外占存储。类型有 `cpu`、`memory`、`disk`、`iowait`、
`offline`（上报缺口）、`ping_timeout`、`ping_loss`、`ping_slow`。一次越线只在**开始那一刻**报一条，
不会每个采样点刷一条。

详情页会缓存最近一次响应（内存 + `sessionStorage`，2 分钟），重开节点或切区间时秒出，随后仍在后台刷新。

> 后台每 10 秒自动刷新，但**焦点停留在输入框或按钮上时不会重绘** —— 正在编辑的内容绝不会被刷新冲掉。

## API 一览

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 无 | 健康检查 |
| `GET /api/nodes` | 无 | 公开节点列表（IP 脱敏）；每节点最多 60 个速率点 + 240 个延迟点 |
| `GET /api/nodes/{id}?range=86400` | 无 | 单节点详情（IP 脱敏）：完整规格字段 + 窗口内 ≤300 个负载点 / ≤300 个延迟点。`range` 夹在 [300, 86400] |
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
| `GET /api/admin/settings` | 会话 | 查看设置（含 CSRF token、阈值及元信息） |
| `POST /api/admin/settings` | 会话+CSRF | 修改用户名/Ping 目标/告警阈值 |
| `GET /api/install.sh?key=...` | 会话 | 生成安装脚本 |

## 安全特性

- `PROBE_ADMIN_PASSWORD` 和 `PROBE_DATA_KEY` 必填且不能相同
- 所有管理员写操作需 CSRF token（`X-CSRF-Token` 头）
- Docker 容器以非 root `pulse` 用户运行，根文件系统只读
- Session Cookie：`HttpOnly`、`SameSite=Strict`、HTTPS 下 `Secure`
- 登录限流：每 IP 5 次失败 / 5 分钟
- Ping 目标仅接受 `host:port` 格式，嵌入客户端脚本前强制校验（阻断命令注入）
- 节点数、请求体大小与**上报字段白名单**上限（`PROBE_MAX_NODES`、64KB），防资源耗尽
- Content-Security-Policy、X-Frame-Options、HSTS（HTTPS）、静态文件白名单
- 常量时间的密码与 API Key 比较（`hmac.compare_digest`）
- 默认不信任 `X-Forwarded-For`（`PROBE_TRUST_PROXY` 关闭时不可伪造 IP）
- `data.enc` 密钥经 PBKDF2（60 万次迭代）拉伸；旧的 v1 文件可读，并在下次保存时自动升级为 v2 容器

## 开发

```bash
python -m pytest tests/ -v
```

CI 见 `.github/workflows/ci.yml`。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
