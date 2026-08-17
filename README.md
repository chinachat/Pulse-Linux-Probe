# Pulse Linux Probe

**English | [简体中文](README.zh-CN.md)**

Multi-node Linux monitoring dashboard: a dependency-free Python 3 server, a
one-line Bash agent installer, and a live web dashboard with masked IPs,
country flags, hardware specs, bar charts, network-rate indicators, and
real-time TCP ping monitoring from three Chinese carriers (CT/CU/CM).

## Features

- **Modern dashboard UI** — dark theme by default with a light-mode toggle (choice remembered in `localStorage`), responsive card grid, glassmorphism sticky header
- **Resource monitoring** — CPU / memory / disk horizontal bar charts with percentage + total capacity
- **Hardware specs** — CPU cores, total memory, total disk capacity, cumulative traffic per node
- **Network metrics** — real-time throughput (Mbps) + total upload/download (MB/GB/TB), plus a live canvas rate chart on every node card
- **TCP ping** — CT (电信) / CU (联通) / CM (移动) latency badges with color coding (green ≤100ms / yellow ≤300ms / red >300ms) and packet-loss rate
- **Ping history chart** — SVG area-gradient chart; server keeps **120 samples (~2 h)**, dashboard shows the latest 60 (~1 h)
- **OS detection** — distro icon tinted with the same color as the label via CSS mask + `currentColor` (crisp in both themes)
- **Floating nav panel** — node anchors with scroll-spy highlighting, mobile slide-out, back-to-top
- **Encrypted data file** — SHA-256 keystream + HMAC-SHA256 integrity, atomic writes, debounced saves
- **Security** — CSRF protection, forced password + encryption key, non-root container, CSP/HSTS headers, rate-limited login, ping-target injection guard, node & body size caps
- **Admin console** — API key management (editable labels), node editing in a card grid with live online status, auto-refresh that never interrupts editing, admin username change, one-line client installer with copy button, three-carrier ping target configuration

## Quick start (development)

```bash
PROBE_ADMIN_PASSWORD='strong-password' PROBE_DATA_KEY='another-random-key' python3 server.py
```

> Both `PROBE_ADMIN_PASSWORD` and `PROBE_DATA_KEY` are **mandatory** — the server refuses
> to start without them or if they are identical.

## Docker deployment

Pre-built images are published to [GHCR](https://github.com/chinachat/Pulse-Linux-Probe/pkgs/container/pulse-linux-probe) for **amd64 / arm64 / armv7** — no local build needed. Pull and run:

```bash
curl -O https://raw.githubusercontent.com/chinachat/Pulse-Linux-Probe/main/docker-compose.yml
echo 'PROBE_ADMIN_PASSWORD=your-strong-password' > .env
echo 'PROBE_DATA_KEY=your-random-data-key' >> .env
echo 'PROBE_PUBLIC_URL=https://probe.yourdomain.com' >> .env  # optional
docker compose up -d
```

Or run directly without compose:

```bash
docker run -d --name pulse-probe --restart unless-stopped \
  -p 8080:8080 --env-file .env -v probe-data:/data \
  ghcr.io/chinachat/pulse-linux-probe:latest
```

Persistence: `probe-data` volume (mounted at `/data` in the container).

> Development builds: use `build: .` instead of `image:` in `docker-compose.yml`.

### Reverse proxy (nginx)

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

Set `PROBE_TRUST_PROXY=true` and `PROBE_PUBLIC_URL=https://probe.yourdomain.com` in `.env` for real client IPs.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PROBE_ADMIN_USER` | `admin` | Initial admin username (UI-saved name takes precedence) |
| `PROBE_ADMIN_PASSWORD` | **required** | Admin password |
| `PROBE_DATA_KEY` | **required** | Encryption key for `data.enc` (must differ from password) |
| `PROBE_DATA_DIR` | project dir | Where `data.enc` is stored |
| `PROBE_PUBLIC_URL` | from request | Public base URL for generated install scripts |
| `PROBE_SESSION_TTL` | `43200` (12h) | Admin session lifetime in seconds |
| `PROBE_OFFLINE_SECONDS` | `90` | Node shown offline after this many seconds without report |
| `PROBE_MAX_NODES` | `200` | Max node count; protects storage from hostname-flooding |
| `PROBE_TRUST_PROXY` | unset | Trust `X-Forwarded-For`/`X-Real-IP` for real client IPs |

## Client agent

Reports every minute via cron:

- CPU (1-second delta sampling), memory usage + total, root disk usage + total
- Network rx/tx throughput (bytes/sec, loopback excluded) + cumulative totals
- Uptime, OS name + version (distro icon), country code (cached 24h), CPU cores
- TCP ping to three configurable targets (CT/CU/CM)

Country lookup caches result for 24 hours. OS info cached permanently.
Ping latency history is kept for **120 samples (~2 hours)** server-side (`HISTORY_LIMIT`); the dashboard chart shows the latest 60 samples (~1 hour).

## Admin console

1. **API Keys** — create, edit labels, revoke, generate client installer
2. **Client Install** — one-liner copyable command, auto-embeds ping targets
3. **Nodes** — card-grid layout; rename, set country, live online status + last-report time, delete (auto-blocks)
4. **Blocked Nodes** — view and unblock
5. **Account** — change admin username
6. **Ping Targets** — configure three-carrier TCP ping endpoints (host:port)

> The admin panel auto-refreshes every 10 s, but **never re-renders while focus is on an input or button** — your in-progress edits are never wiped by a refresh.

## API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | none | Health check |
| `GET /api/nodes` | none | Public node list (masked IPs) |
| `POST /api/report` | `X-API-Key` | Agent report |
| `POST /api/login` | none | Admin login (returns CSRF token) |
| `POST /api/logout` | none | Admin logout |
| `GET /api/admin/keys` | session | List API keys |
| `POST /api/admin/keys` | session+CSRF | Create API key |
| `POST /api/admin/keys/{id}` | session+CSRF | Update key label |
| `DELETE /api/admin/keys/{id}` | session+CSRF | Revoke key |
| `GET /api/admin/nodes` | session | Node list (real IPs) |
| `POST /api/admin/nodes` | session+CSRF | Edit node name/country |
| `DELETE /api/admin/nodes/{id}` | session+CSRF | Delete + block node |
| `GET /api/admin/blocked` | session | List blocked nodes |
| `POST /api/admin/unblock` | session+CSRF | Unblock node |
| `GET /api/admin/settings` | session | View settings (includes CSRF token) |
| `POST /api/admin/settings` | session+CSRF | Change username / ping targets |
| `GET /api/install.sh?key=...` | session | Generate client installer |

## Security

- `PROBE_ADMIN_PASSWORD` and `PROBE_DATA_KEY` are mandatory and must differ
- CSRF protection on all admin state-changing endpoints (`X-CSRF-Token` header)
- Docker container runs as non-root `pulse` user with `read_only` rootfs
- Session cookies: `HttpOnly`, `SameSite=Strict`, `Secure` (when HTTPS)
- Login rate-limited: 5 failures / 5 minutes per IP
- Ping targets validated as `host:port` before being embedded in the agent script (blocks shell injection)
- Node count and request body size capped (`PROBE_MAX_NODES`, 64 KB) to prevent resource exhaustion
- Content-Security-Policy, X-Frame-Options, HSTS (on HTTPS), static file whitelist
- Constant-time password comparison (`hmac.compare_digest`)
- `X-Forwarded-For` spoofing blocked by default (`PROBE_TRUST_PROXY`)

## Development

```bash
python -m pytest tests/ -v
```

See `.github/workflows/ci.yml` for CI details.

## License

MIT — see [LICENSE](LICENSE).
