# Pulse Linux Probe

**English | [简体中文](README.zh-CN.md)**

Multi-node Linux monitoring dashboard: a dependency-free Python 3 server, a
one-line Bash agent installer, and a live web dashboard with masked IPs,
country flags, resource gauges, hardware specs, and network-rate charts.

## Features

- **Resource monitoring** — CPU / memory / disk gauges with percentage + total capacity in center
- **Hardware specs** — CPU cores, total memory, and total disk capacity per node
- **Network rate charts** — 120-sample history with responsive-width canvas and left-axis Mbps labels
- **Group display** — nodes auto-grouped by country with collapse/expand; offline nodes in separate group
- **Floating nav panel** — right-side panel with group links, scroll-spy highlighting, one-click back-to-top
- **Encrypted data file** — SHA-256 keystream + HMAC-SHA256 integrity with atomic writes and debounced saves
- **API-key reporting** with revoke and node blocking (blocked nodes can be listed and unblocked)
- **Admin console** — key management with editable labels, node rename/country override, admin username change, one-line client installer with copy button
- **Hardened by default** — static-file whitelist, constant-time credential checks, login rate limiting, expiring sessions, security headers, thread-safe data access

## Quick start

```bash
PROBE_ADMIN_PASSWORD='strong-password' python3 server.py
```

Open `http://server-ip:8080`, sign in as `admin`, create an API Key, click
**Client install** to generate the one-line installer, and run it on each
Linux node.

## Docker deployment (recommended)

### 1. Prepare environment

```bash
git clone https://github.com/chinachat/Pulse-Linux-Probe.git
cd Pulse-Linux-Probe
echo 'PROBE_ADMIN_PASSWORD=your-strong-password' > .env
echo 'PROBE_DATA_KEY=your-random-data-key' >> .env
echo 'PROBE_PUBLIC_URL=https://probe.yourdomain.com' >> .env  # optional
```

### 2. Start

```bash
docker compose up -d --build
```

### 3. Reverse proxy (nginx example)

To get real client IPs (instead of Docker internal `172.x.x.x`), put a reverse proxy in front:

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

Then set `PROBE_TRUST_PROXY=true` and `PROBE_PUBLIC_URL=https://probe.yourdomain.com` in `.env`.

> With Caddy: `caddy reverse-proxy --from probe.yourdomain.com --to localhost:8080`

### 4. Update

```bash
git pull
docker compose down
docker compose up -d --build
```

## Server installer (systemd)

Copy project files to `/opt/pulse-probe`, then run:

```bash
cd /opt/pulse-probe
PROBE_ADMIN_PASSWORD='your-password' PROBE_DATA_KEY='random-key' ./install-server.sh
```

Creates and starts `pulse-probe.service` on port 8080. Requires Python 3.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PROBE_ADMIN_USER` | `admin` | Initial admin username (UI-saved name takes precedence) |
| `PROBE_ADMIN_PASSWORD` | `change-me` | Admin password (**change this!**) |
| `PROBE_DATA_KEY` | derived from password | Encryption key for `data.enc` |
| `PROBE_DATA_DIR` | project directory | Where `data.enc` is stored |
| `PROBE_PUBLIC_URL` | derived from request | Public base URL for generated install scripts |
| `PROBE_SESSION_TTL` | `43200` (12h) | Admin session lifetime in seconds |
| `PROBE_OFFLINE_SECONDS` | `90` | Node shown offline after this many seconds without report |
| `PROBE_REQUIRE_SET_PASSWORD` | unset | Refuse to start with default password if set |
| `PROBE_TRUST_PROXY` | unset | Trust `X-Forwarded-For`/`X-Real-IP` for real client IPs |

## Client agent

Reports every minute via cron:

- **CPU** — 1-second delta sampling from `/proc/stat`
- **Memory** — usage percentage + total capacity from `/proc/meminfo`
- **Disk** — root partition usage + total capacity from `df`
- **Network** — rx/tx throughput in bytes/sec (loopback excluded)
- **Uptime**, **OS name**, **country code**, **CPU cores**

Country lookup caches result for 24 hours. OS info is cached permanently.

## API overview

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | none | Health check |
| `GET /api/nodes` | none | Public node list (masked IPs) |
| `POST /api/report` | `X-API-Key` | Agent report |
| `POST /api/login` / `POST /api/logout` | none | Admin session |
| `GET /api/admin/keys` | session | List API keys |
| `POST /api/admin/keys` | session | Create API key |
| `POST /api/admin/keys/{id}` | session | Update key label |
| `DELETE /api/admin/keys/{id}` | session | Revoke key |
| `GET /api/admin/nodes` | session | Node list (real IPs) |
| `POST /api/admin/nodes` | session | Edit node name/country |
| `DELETE /api/admin/nodes/{id}` | session | Delete + block node |
| `GET /api/admin/blocked` | session | List blocked nodes |
| `POST /api/admin/unblock` | session | Unblock node |
| `GET /api/admin/settings` | session | View settings |
| `POST /api/admin/settings` | session | Change admin username |
| `GET /api/install.sh?key=...` | session | Generate client installer |

## Development

```bash
python -m pytest tests/ -v
```

CI (GitHub Actions) runs `py_compile`, test suite on Python 3.10/3.12, and
ShellCheck. See `.github/workflows/ci.yml`.

## Security notes

- **Always** set a strong `PROBE_ADMIN_PASSWORD` and `PROBE_DATA_KEY` before exposing the server.
- Put the server behind HTTPS (reverse proxy) for production.
- Enable `PROBE_TRUST_PROXY=true` only when a reverse proxy correctly sets `X-Forwarded-For`.
- Static files are whitelisted; `data.enc` and source files are not served over HTTP.
- Login is rate-limited per IP (5 failures / 5 minutes).
- API keys are stored in plaintext in client crontabs — protect host accounts accordingly.

## License

MIT — see [LICENSE](LICENSE).
