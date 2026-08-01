# 部署与维护指南

## 环境要求

- Docker 20.10+ 和 Docker Compose v2
- 公网部署建议配置域名 + HTTPS 反向代理
- 客户端：任何 Linux 发行版（需 `bash`、`curl`、`cron`）

---

## 一、首次部署

### 1. 克隆项目

```bash
git clone https://github.com/chinachat/Pulse-Linux-Probe.git
cd Pulse-Linux-Probe
```

### 2. 创建环境文件

```bash
cat > .env <<EOF
PROBE_ADMIN_PASSWORD=$(openssl rand -base64 24)
PROBE_DATA_KEY=$(openssl rand -base64 32)
PROBE_PUBLIC_URL=https://probe.yourdomain.com
EOF
```

> **安全要求**：`PROBE_ADMIN_PASSWORD` 和 `PROBE_DATA_KEY` 均必填且不能相同，否则服务拒绝启动。

### 3. 配置反向代理（推荐）

**nginx：**

```nginx
server {
    listen 80;
    server_name probe.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Caddy：**

```bash
caddy reverse-proxy --from probe.yourdomain.com --to localhost:8080
```

配置完成后在 `.env` 中启用：

```bash
echo 'PROBE_TRUST_PROXY=true' >> .env
```

### 4. 启动服务

```bash
docker compose up -d --build
```

### 5. 验证

```bash
curl http://localhost:8080/api/health
# 预期: {"ok": true, "nodes": 0, "time": ...}
```

### 6. 访问后台

打开 `http://服务器IP:8080` 或 `https://yourdomain.com`，用 `.env` 中设置的用户名（默认 `admin`）和密码登录。

---

## 二、添加监控节点

### 1. 配置 Ping 目标（可选）

进入后台 → 三网 Ping 监测 → 填入各运营商的 `IP:端口`（如 `1.1.1.1:80`）→ 保存。

### 2. 创建 API Key

进入后台 → API 密钥 → 输入备注名称 → 生成 API Key。

### 3. 生成安装命令

点击 API Key 旁边的「客户端安装」→ 点击「复制」→ 在目标 Linux 主机上执行。

### 4. 验证

1-2 分钟后仪表盘出现新节点卡片。

---

## 三、日常维护

### 更新升级

```bash
cd Pulse-Linux-Probe
git pull
docker compose down
docker compose up -d --build
```

### 查看日志

```bash
# 实时日志
docker compose logs -f pulse-probe --tail 50

# 错误日志
docker compose logs pulse-probe | grep -i error
```

### 备份数据

```bash
# 数据卷位置
docker volume inspect pulse-linux-probe_probe-data

# 备份
docker run --rm -v pulse-linux-probe_probe-data:/data -v $(pwd):/backup alpine cp /data/data.enc /backup/data.enc.$(date +%Y%m%d)
```

### 恢复数据

```bash
docker run --rm -v pulse-linux-probe_probe-data:/data -v $(pwd):/backup alpine cp /backup/data.enc /data/data.enc
docker compose restart
```

### 磁盘清理

```bash
# 清理未使用的镜像和卷
docker system prune -a --volumes -f
```

---

## 四、监控面板功能

| 功能 | 说明 |
|------|------|
| 仪表盘 | 节点按国家分组，柱状图显示 CPU/内存/磁盘，实时速率 + 累计流量 |
| Ping 监测 | CT/CU/CM 三网延迟徽章（绿 ≤100 / 黄 ≤300 / 红 >300）+ SVG 折线图 |
| 分组折叠 | 点击分组标题展开/收起，状态记忆 |
| 右侧导航 | 分组 + 节点锚点，滚动高亮，移动端滑出面板 |
| 主题切换 | 浅色/深色 |
| 后台管理 | 密钥/节点/封禁/账号/Ping 目标 全管理 |

---

## 五、systemd 部署（非 Docker）

```bash
cp -r server.py index.html app.js style.css agent.sh /opt/pulse-probe/
cd /opt/pulse-probe
PROBE_ADMIN_PASSWORD='password' PROBE_DATA_KEY='key' ./install-server.sh
```

密码存入 `/etc/pulse-probe/env`（权限 `600`），服务单元不会直接暴露。

---

## 六、安全清单

| 检查项 | 要求 |
|--------|------|
| 密码强度 | 24 字符以上随机字符串 |
| 数据密钥 | 与密码不同，32 字符以上 |
| HTTPS | 生产环境必须使用 |
| 反代 | `PROBE_TRUST_PROXY=true` 仅在有可信反代时开启 |
| 防火墙 | 仅开放 443(HTTPS)，8080 仅本地回环 |
| 定期更新 | 关注 GitHub Release |
| 日志审计 | 定期检查 `docker compose logs` 异常登录 |

---

## 七、故障排查

| 症状 | 检查 |
|------|------|
| 服务启动失败 | 确认 `.env` 中 `PROBE_ADMIN_PASSWORD` 和 `PROBE_DATA_KEY` 均已设置且不同 |
| 节点不显示 | `curl localhost:8080/api/nodes` 检查是否有数据；检查客户端 crontab |
| 节点 IP 显示 172.x | 配置反向代理 + `PROBE_TRUST_PROXY=true` |
| Ping 不显示 | 客户端需重新生成安装命令（嵌入 Ping 目标），后台配置后重新安装 |
| 后台 403 错误 | 重新登录获取新 CSRF token |
| 容器权限错误 | `docker compose down -v && docker compose up -d --build` 重建卷 |
