# Pulse Linux Probe

Multi-node Linux monitoring dashboard with API-key reporting, masked IPs, country flags, and uptime.

## Quick start

```bash
PROBE_ADMIN_PASSWORD='strong-password' python3 server.py
```

Open `http://server-ip:8080`, sign in as `admin`, create an API Key, and select **Client install** to generate the one-line installer for a Linux node.

## Server installer

Copy this project to `/opt/pulse-probe`, then run:

```bash
cd /opt/pulse-probe
PROBE_ADMIN_PASSWORD='strong-password' ./install-server.sh
```

It creates and starts a `systemd` service on port 8080. Python 3 is required.

The client reports CPU, memory, root disk, network counters, Linux uptime, and a country code every minute. Country code lookup uses `https://ipapi.co/country/`; a manually saved country code in Admin takes precedence. Use HTTPS and a strong `PROBE_ADMIN_PASSWORD` before public deployment.
