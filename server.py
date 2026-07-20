#!/usr/bin/env python3
"""Pulse Linux Probe server - multi-node Linux monitoring dashboard."""
import base64, hashlib, hmac, json, logging, os, re, secrets, sys, threading, time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DATA_DIR = Path(os.getenv("PROBE_DATA_DIR", str(ROOT)))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE = DATA_DIR / "data.enc"
LEGACY_DATA_FILE = DATA_DIR / "data.json"
ADMIN_USER = os.getenv("PROBE_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("PROBE_ADMIN_PASSWORD", "change-me")
DATA_KEY = hashlib.sha256((os.getenv("PROBE_DATA_KEY") or ADMIN_PASSWORD).encode()).digest()
PUBLIC_URL = os.getenv("PROBE_PUBLIC_URL", "").rstrip("/")
SESSION_TTL = int(os.getenv("PROBE_SESSION_TTL", str(12 * 3600)))
OFFLINE_SECONDS = int(os.getenv("PROBE_OFFLINE_SECONDS", "90"))
TRUST_PROXY = bool(os.getenv("PROBE_TRUST_PROXY"))
HISTORY_LIMIT = 120
LOGIN_WINDOW = 300
LOGIN_MAX_FAILURES = 5
STATIC_FILES = {"index.html", "app.js", "style.css"}
HOST_RE = re.compile(r"[A-Za-z0-9.-]+(:\d{1,5})?")

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pulse-probe")

if ADMIN_PASSWORD == "change-me":
    MSG = "PROBE_ADMIN_PASSWORD is not set; using the insecure default 'change-me'"
    if os.getenv("PROBE_REQUIRE_SET_PASSWORD"):
        log.error("%s; refusing to start because PROBE_REQUIRE_SET_PASSWORD is set", MSG)
        sys.exit(1)
    log.warning(MSG)

SESSIONS = {}        # token -> expiry timestamp
LOGIN_FAILURES = {}  # client ip -> [failure timestamps]
LOCK = threading.Lock()

def crypt(data, nonce):
    out = bytearray()
    for offset in range(0, len(data), 32):
        stream = hashlib.sha256(DATA_KEY + nonce + (offset // 32).to_bytes(8, "big")).digest()
        out.extend(a ^ b for a, b in zip(data[offset:offset + 32], stream))
    return bytes(out)

def load_data():
    if DATA_FILE.exists():
        raw = base64.b64decode(DATA_FILE.read_bytes())
        nonce, tag, cipher = raw[:16], raw[16:48], raw[48:]
        if not hmac.compare_digest(tag, hmac.new(DATA_KEY, nonce + cipher, hashlib.sha256).digest()):
            raise RuntimeError("data file integrity check failed")
        return json.loads(crypt(cipher, nonce))
    return json.loads(LEGACY_DATA_FILE.read_text()) if LEGACY_DATA_FILE.exists() else {"keys": [], "nodes": {}}

DATA = load_data()
DATA.setdefault("revoked_keys", [])
DATA.setdefault("blocked_nodes", [])
# migrate legacy entries (plain id strings) to dicts with metadata
DATA["blocked_nodes"] = [b if isinstance(b, dict) else {"id": str(b)} for b in DATA["blocked_nodes"]]

def blocked_ids():
    return {b.get("id") for b in DATA["blocked_nodes"]}

def save_data():
    nonce = secrets.token_bytes(16)
    cipher = crypt(json.dumps(DATA, separators=(",", ":")).encode(), nonce)
    tag = hmac.new(DATA_KEY, nonce + cipher, hashlib.sha256).digest()
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_bytes(base64.b64encode(nonce + tag + cipher))
    os.replace(tmp, DATA_FILE)  # atomic rename; a crash cannot corrupt data.enc

def mask_ip(ip):
    if not ip: return "hidden"
    if ":" in ip: return ":".join(ip.split(":")[:2]) + "::****"
    pieces = ip.split(".")
    return ".".join(pieces[:2]) + ".*.*" if len(pieces) == 4 else "hidden"

def prune_sessions():
    now = time.time()
    for token in [t for t, exp in SESSIONS.items() if exp < now]:
        SESSIONS.pop(token, None)

class App(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # structured events go through the logger instead

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def send_json(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    def send_empty(self, status=204):
        self.send_response(status); self.end_headers()

    def read_json(self):
        try: return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except (ValueError, json.JSONDecodeError): return None

    def session_token(self):
        c = SimpleCookie(self.headers.get("Cookie"))
        morsel = c.get("probe_session")
        return morsel.value if morsel else None

    def client_ip(self):
        # Behind a reverse proxy the TCP peer is the proxy itself; only trust
        # forwarded headers when PROBE_TRUST_PROXY is explicitly enabled,
        # otherwise anyone could spoof their displayed IP.
        if TRUST_PROXY:
            xff = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if xff: return xff
            xri = self.headers.get("X-Real-IP", "").strip()
            if xri: return xri
        return self.client_address[0]

    def is_admin(self):
        token = self.session_token()
        if not token: return False
        expiry = SESSIONS.get(token)
        if not expiry: return False
        if expiry < time.time():
            SESSIONS.pop(token, None)
            return False
        return True

    def require_admin(self):
        if self.is_admin(): return True
        self.send_json({"error": "login required"}, HTTPStatus.UNAUTHORIZED); return False

    def do_GET(self):
        parsed, path = urlparse(self.path), urlparse(self.path).path
        if path == "/api/health":
            return self.send_json({"ok": True, "nodes": len(DATA["nodes"]), "time": time.time()})
        if path == "/api/nodes":
            nodes = []
            for node in DATA["nodes"].values():
                n = dict(node); n["ip"] = mask_ip(n.get("ip")); n["online"] = time.time() - n.get("updated", 0) < OFFLINE_SECONDS
                nodes.append(n)
            return self.send_json({"nodes": sorted(nodes, key=lambda n: n.get("name", ""))})
        if path == "/api/admin/nodes":
            if self.require_admin(): self.send_json({"nodes": list(DATA["nodes"].values())})
            return
        if path == "/api/admin/keys":
            if self.require_admin(): self.send_json({"keys": DATA["keys"]})
            return
        if path == "/api/admin/blocked":
            if self.require_admin(): self.send_json({"blocked": DATA["blocked_nodes"]})
            return
        if path == "/api/install.sh":
            if not self.require_admin(): return
            key = parse_qs(parsed.query).get("key", [""])[0]
            if key not in [x["key"] for x in DATA["keys"]]: return self.send_json({"error": "invalid key"}, 400)
            host = self.headers.get("Host", "")
            if not PUBLIC_URL and not HOST_RE.fullmatch(host):
                return self.send_json({"error": "invalid host header"}, 400)
            origin = PUBLIC_URL or f"http://{host}"
            script = (ROOT / "agent.sh").read_text(encoding="utf-8").replace("__SERVER__", origin).replace("__API_KEY__", key)
            return self.send_json({"script": script})
        name = "index.html" if path in ("/", "/admin") else path.lstrip("/")
        if name not in STATIC_FILES:
            return self.send_json({"error": "not found"}, 404)
        self.path = "/" + name
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/logout":
            token = self.session_token()
            if token: SESSIONS.pop(token, None)
            self.send_response(200)
            self.send_header("Set-Cookie", "probe_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
            self.end_headers()
            return self.wfile.write(b'{"ok":true}')
        body = self.read_json()
        if body is None: return self.send_json({"error": "invalid request"}, 400)
        if path == "/api/login":
            ip = self.client_address[0]
            now = time.time()
            fails = [t for t in LOGIN_FAILURES.get(ip, []) if now - t < LOGIN_WINDOW]
            if len(fails) >= LOGIN_MAX_FAILURES:
                log.warning("login rate-limited for %s", ip)
                return self.send_json({"error": "too many attempts, try again later"}, 429)
            username, password = str(body.get("username", "")), str(body.get("password", ""))
            if not (hmac.compare_digest(username.encode(), ADMIN_USER.encode())
                    and hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode())):
                fails.append(now); LOGIN_FAILURES[ip] = fails
                log.warning("login failed for user %r from %s", username, ip)
                return self.send_json({"error": "invalid credentials"}, 401)
            LOGIN_FAILURES.pop(ip, None)
            prune_sessions()
            log.info("login ok for %r from %s", username, ip)
            token = secrets.token_urlsafe(32)
            SESSIONS[token] = now + SESSION_TTL
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            self.send_response(200)
            self.send_header("Set-Cookie", f"probe_session={token}; HttpOnly; SameSite=Strict; Path=/{secure}")
            self.end_headers()
            return self.wfile.write(b'{"ok":true}')
        if path == "/api/report":
            key = self.headers.get("X-API-Key", "")
            if key in DATA["revoked_keys"]:
                log.warning("report dropped: revoked key %s... from %s", key[:8], self.client_ip())
                return self.send_empty()
            if key not in [x["key"] for x in DATA["keys"]]: return self.send_json({"error": "invalid key"}, 401)
            hostname = str(body.get("hostname", "unknown"))[:100]
            node_id = hashlib.sha256((key + hostname).encode()).hexdigest()[:16]
            if node_id in blocked_ids():
                log.info("report dropped: blocked node %s (%s) from %s", node_id, hostname, self.client_ip())
                return self.send_empty()
            body["country"] = str(body.get("country", ""))[:2].upper()
            body["os"] = str(body.get("os", ""))[:120]
            ip = self.client_ip()
            with LOCK:
                old = DATA["nodes"].get(node_id, {})
                now = time.time()
                sample = {"time": now, "rx": body.get("network_rx", 0), "tx": body.get("network_tx", 0),
                          "cpu": body.get("cpu", 0), "memory": body.get("memory", 0), "disk": body.get("disk", 0)}
                history = (old.get("history", []) + [sample])[-HISTORY_LIMIT:]
                edited = {field: old[field] for field in ("name", "country") if old.get(field)}
                DATA["nodes"][node_id] = {**old, **body, **edited, "history": history, "id": node_id, "hostname": hostname, "ip": ip, "updated": now}
                save_data()
            if not old:
                log.info("node %s (%s) first reported from %s", node_id, hostname, ip)
            return self.send_json({"ok": True, "id": node_id})
        if not self.require_admin(): return
        if path == "/api/admin/keys":
            item = {"id": secrets.token_hex(6), "label": str(body.get("label", "New key"))[:60], "key": "lp_" + secrets.token_urlsafe(24), "created": time.time()}
            with LOCK:
                DATA["keys"].append(item); save_data()
            log.info("api key %s created (label %r)", item["id"], item["label"])
            return self.send_json(item, 201)
        if path == "/api/admin/nodes":
            with LOCK:
                node = DATA["nodes"].get(body.get("id"))
                if node:
                    node["name"] = str(body.get("name", node.get("name", "")))[:60]
                    node["country"] = str(body.get("country", node.get("country", "")))[:2].upper()
                    save_data()
            if not node: return self.send_json({"error": "node not found"}, 404)
            return self.send_json(node)
        if path == "/api/admin/unblock":
            node_id = str(body.get("id", ""))
            with LOCK:
                before = len(DATA["blocked_nodes"])
                DATA["blocked_nodes"] = [b for b in DATA["blocked_nodes"] if b.get("id") != node_id]
                if len(DATA["blocked_nodes"]) < before:
                    save_data()
            if len(DATA["blocked_nodes"]) == before:
                return self.send_json({"error": "node not blocked"}, 404)
            log.info("node %s unblocked", node_id)
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        if not self.require_admin(): return
        if self.path.startswith("/api/admin/nodes/"):
            node_id = self.path.rsplit("/", 1)[-1]
            with LOCK:
                if node_id not in DATA["nodes"]:
                    node = None
                else:
                    node = DATA["nodes"].pop(node_id)
                    if node_id not in blocked_ids():
                        DATA["blocked_nodes"].append({"id": node_id, "hostname": node.get("hostname", ""),
                                                      "name": node.get("name", ""), "time": time.time()})
                    save_data()
            if not node: return self.send_json({"error": "node not found"}, 404)
            log.info("node %s deleted and blocked", node_id)
            return self.send_json({"ok": True})
        if self.path.startswith("/api/admin/keys/"):
            key_id = self.path.rsplit("/", 1)[-1]
            with LOCK:
                removed = [x for x in DATA["keys"] if x["id"] == key_id]
                if removed:
                    DATA["keys"] = [x for x in DATA["keys"] if x["id"] != key_id]
                    for item in removed:
                        if item["key"] not in DATA["revoked_keys"]: DATA["revoked_keys"].append(item["key"])
                    save_data()
            if not removed: return self.send_json({"error": "key not found"}, 404)
            log.info("api key %s revoked", key_id)
            return self.send_json({"ok": True})
        self.send_json({"error": "not found"}, 404)

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    log.info("pulse-probe listening on 0.0.0.0:%d", port)
    ThreadingHTTPServer(("0.0.0.0", port), App).serve_forever()
