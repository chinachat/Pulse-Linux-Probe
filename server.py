#!/usr/bin/env python3
import base64, hashlib, hmac, json, os, secrets, time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DATA_FILE = ROOT / "data.enc"
LEGACY_DATA_FILE = ROOT / "data.json"
ADMIN_USER = os.getenv("PROBE_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("PROBE_ADMIN_PASSWORD", "change-me")
SESSIONS = set()
DATA_KEY = hashlib.sha256(os.getenv("PROBE_DATA_KEY", ADMIN_PASSWORD).encode()).digest()

def crypt(data, nonce):
    out=bytearray()
    for offset in range(0, len(data), 32):
        stream=hashlib.sha256(DATA_KEY+nonce+(offset//32).to_bytes(8,"big")).digest()
        out.extend(a^b for a,b in zip(data[offset:offset+32],stream))
    return bytes(out)

def load_data():
    if DATA_FILE.exists():
        raw=base64.b64decode(DATA_FILE.read_bytes())
        nonce, tag, cipher=raw[:16], raw[16:48], raw[48:]
        if not hmac.compare_digest(tag,hmac.new(DATA_KEY,nonce+cipher,hashlib.sha256).digest()):
            raise RuntimeError("data file integrity check failed")
        return json.loads(crypt(cipher,nonce))
    return json.loads(LEGACY_DATA_FILE.read_text()) if LEGACY_DATA_FILE.exists() else {"keys": [], "nodes": {}}

DATA = load_data()
DATA.setdefault("revoked_keys", [])
DATA.setdefault("blocked_nodes", [])

def save_data():
    nonce=secrets.token_bytes(16)
    cipher=crypt(json.dumps(DATA,separators=(",",":")).encode(),nonce)
    tag=hmac.new(DATA_KEY,nonce+cipher,hashlib.sha256).digest()
    DATA_FILE.write_bytes(base64.b64encode(nonce+tag+cipher))

def mask_ip(ip):
    if not ip: return "hidden"
    if ":" in ip: return ":".join(ip.split(":")[:2]) + "::****"
    pieces = ip.split(".")
    return ".".join(pieces[:2]) + ".*.*" if len(pieces) == 4 else "hidden"

class App(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
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
    def is_admin(self):
        c = SimpleCookie(self.headers.get("Cookie"))
        return c.get("probe_session") and c["probe_session"].value in SESSIONS
    def require_admin(self):
        if self.is_admin(): return True
        self.send_json({"error": "login required"}, HTTPStatus.UNAUTHORIZED); return False
    def do_GET(self):
        parsed, path = urlparse(self.path), urlparse(self.path).path
        if path == "/api/nodes":
            nodes=[]
            for node in DATA["nodes"].values():
                n=dict(node); n["ip"]=mask_ip(n.get("ip")); n["online"]=time.time()-n.get("updated",0)<90; nodes.append(n)
            return self.send_json({"nodes": sorted(nodes, key=lambda n:n.get("name", ""))})
        if path == "/api/admin/nodes":
            if self.require_admin(): self.send_json({"nodes": list(DATA["nodes"].values())})
            return
        if path == "/api/admin/keys":
            if self.require_admin(): self.send_json({"keys": DATA["keys"]})
            return
        if path == "/api/install.sh":
            if not self.require_admin(): return
            key=parse_qs(parsed.query).get("key",[""])[0]
            if key not in [x["key"] for x in DATA["keys"]]: return self.send_json({"error":"invalid key"},400)
            origin=f"http://{self.headers.get('Host')}"
            script=(ROOT/"agent.sh").read_text(encoding="utf-8").replace("__SERVER__",origin).replace("__API_KEY__",key)
            return self.send_json({"script":script})
        if path == "/install-server.sh": self.path="/install-server.sh"
        elif path in ("/", "/admin"): self.path="/index.html"
        return super().do_GET()
    def do_POST(self):
        path, body=urlparse(self.path).path, self.read_json()
        if body is None: return self.send_json({"error":"invalid request"},400)
        if path == "/api/login":
            if body.get("username")!=ADMIN_USER or body.get("password")!=ADMIN_PASSWORD: return self.send_json({"error":"invalid credentials"},401)
            token=secrets.token_urlsafe(32); SESSIONS.add(token); self.send_response(200)
            self.send_header("Set-Cookie",f"probe_session={token}; HttpOnly; SameSite=Strict; Path=/"); self.end_headers(); return self.wfile.write(b'{"ok":true}')
        if path == "/api/report":
            key=self.headers.get("X-API-Key","")
            if key in DATA["revoked_keys"]: return self.send_empty()
            if key not in [x["key"] for x in DATA["keys"]]: return self.send_json({"error":"invalid key"},401)
            hostname=str(body.get("hostname","unknown"))[:100]; node_id=hashlib.sha256((key+hostname).encode()).hexdigest()[:16]
            if node_id in DATA["blocked_nodes"]: return self.send_empty()
            body["country"]=str(body.get("country", ""))[:2].upper()
            body["os"]=str(body.get("os", ""))[:120]
            old=DATA["nodes"].get(node_id,{})
            now=time.time()
            history=(old.get("history",[])+[{"time":now,"rx":body.get("network_rx",0),"tx":body.get("network_tx",0)}])[-60:]
            edited={field:old[field] for field in ("name","country") if old.get(field)}
            DATA["nodes"][node_id]={**old, **body, **edited, "history":history, "id":node_id, "hostname":hostname, "ip":self.client_address[0], "updated":now}; save_data()
            return self.send_json({"ok":True,"id":node_id})
        if not self.require_admin(): return
        if path == "/api/admin/keys":
            item={"id":secrets.token_hex(6),"label":str(body.get("label","New key"))[:60],"key":"lp_"+secrets.token_urlsafe(24),"created":time.time()}
            DATA["keys"].append(item); save_data(); return self.send_json(item,201)
        if path == "/api/admin/nodes":
            node=DATA["nodes"].get(body.get("id"))
            if not node: return self.send_json({"error":"node not found"},404)
            node["name"]=str(body.get("name",node.get("name","")))[:60]; node["country"]=str(body.get("country",node.get("country","")))[:2].upper(); save_data(); return self.send_json(node)
        return self.send_json({"error":"not found"},404)
    def do_DELETE(self):
        if not self.require_admin(): return
        if self.path.startswith("/api/admin/nodes/"):
            node_id=self.path.rsplit("/",1)[-1]
            if node_id not in DATA["nodes"]: return self.send_json({"error":"node not found"},404)
            del DATA["nodes"][node_id]
            if node_id not in DATA["blocked_nodes"]: DATA["blocked_nodes"].append(node_id)
            save_data(); return self.send_json({"ok":True})
        if self.path.startswith("/api/admin/keys/"):
            key_id=self.path.rsplit("/",1)[-1]
            removed=[x for x in DATA["keys"] if x["id"]==key_id]
            if not removed: return self.send_json({"error":"key not found"},404)
            DATA["keys"]=[x for x in DATA["keys"] if x["id"]!=key_id]
            for item in removed:
                if item["key"] not in DATA["revoked_keys"]: DATA["revoked_keys"].append(item["key"])
            save_data(); return self.send_json({"ok":True})
        self.send_json({"error":"not found"},404)

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0",int(os.getenv("PORT","28080"))),App).serve_forever()
