# Pulse Linux Probe

**English | [简体中文](README.zh-CN.md)**

Multi-node Linux monitoring dashboard: a dependency-free Python 3 server, a
one-line Bash agent installer, and a live web dashboard with masked IPs,
country flags, resource gauges, and network-rate sparklines.

## Features

- CPU / memory / disk gauges plus per-node network-rate history (120 samples)
- Encrypted-at-rest data file (SHA-256 keystream + HMAC-SHA256 integrity) with atomic writes
- API-key reporting with revoke and node blocking
- Admin console: key management, node rename/location override, one-line client installer
- Hardened by default: static-file whitelist, constant-time credential checks,
  login rate limiting, expiring sessions, security headers, event logging

## Quick start

```bash
PROBE_ADMIN_PASSWORD='strong-password' python3 server.py
```

Open `http://server-ip:8080`, sign in as `admin`, create an API Key, and use
**Client install** to generate the one-line installer for each Linux node.

## Docker

```bash
PROBE_ADMIN_PASSWORD='strong-password' docker compose up -d --build
```

Data persists in the `probe-data` volume (`/data` in the container).

## Server installer (systemd)

Copy this project to `/opt/pulse-probe`, then run:

```bash
cd /opt/pulse-probe
PROBE_ADMIN_PASSWORD='你的后台密码' PROBE_DATA_KEY='独立且足够长的密钥' ./install-server.sh
```

It creates and starts a `pulse-probe.service` on port 8080. Python 3 is required.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PROBE_ADMIN_USER` | `admin` | Admin username |
| `PROBE_ADMIN_PASSWORD` | `change-me` | Admin password (**set this!**) |
| `PROBE_DATA_KEY` | derived from admin password | Encryption key for `data.enc` |
| `PROBE_DATA_DIR` | project directory | Where `data.enc` is stored |
| `PROBE_PUBLIC_URL` | derived from request | Public base URL used in generated install scripts (e.g. `https://probe.example.com`) |
| `PROBE_SESSION_TTL` | `43200` | Admin session lifetime in seconds |
| `PROBE_OFFLINE_SECONDS` | `90` | Node is shown offline after this many seconds without a report |
| `PROBE_REQUIRE_SET_PASSWORD` | unset | If set, the server refuses to start with the default password |
| `PROBE_TRUST_PROXY` | unset | Trust `X-Forwarded-For`/`X-Real-IP` for node IPs (enable only behind a reverse proxy that sets them) |

## Client

The agent reports CPU (1s delta sampling), memory, root disk, network
throughput (loopback excluded), uptime, OS name, and a country code every
minute via cron. Country lookup uses `https://ipapi.co/country/`; a manually
saved country code in Admin takes precedence.

## API overview

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | none | Liveness probe |
| `GET /api/nodes` | none | Public node list (masked IPs) |
| `POST /api/report` | `X-API-Key` | Agent report |
| `POST /api/login` / `POST /api/logout` | none | Admin session |
| `GET/POST /api/admin/keys`, `DELETE /api/admin/keys/{id}` | session | Key management |
| `GET/POST /api/admin/nodes`, `DELETE /api/admin/nodes/{id}` | session | Node management |
| `GET /api/install.sh?key=...` | session | Generated agent installer |

## Development

```bash
python -m pytest tests/ -v   # or: python tests/test_server.py
```

CI (GitHub Actions) runs `py_compile`, the test suite on Python 3.10/3.12,
and ShellCheck over the shell scripts. The workflow file lives in
`.github/workflows/ci.yml`.

## Security notes

- Always set a strong `PROBE_ADMIN_PASSWORD` (and ideally `PROBE_DATA_KEY`)
  before exposing the server; set `PROBE_REQUIRE_SET_PASSWORD=1` to fail closed.
- Put the server behind HTTPS (reverse proxy) for public deployments and set
  `PROBE_PUBLIC_URL` to the external URL so install scripts reference it.
- Behind a reverse proxy, also forward the real client address
  (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` on
  nginx/openresty) and set `PROBE_TRUST_PROXY=1`, otherwise every node shows
  the proxy's own IP.
- Static file serving is whitelisted; `data.enc` and server sources are not
  served over HTTP.
- Login attempts are rate limited per IP (5 failures / 5 minutes).

## License

MIT — see [LICENSE](LICENSE).
