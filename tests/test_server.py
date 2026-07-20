"""End-to-end smoke tests for the Pulse Linux Probe server.

Boots server.py in a subprocess on a throwaway port and exercises the API
with stdlib urllib only. Runs under both unittest and pytest.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def http(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class ServerTest(unittest.TestCase):
    PORT = 38091

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="pulse-test-"))
        for name in ("server.py", "index.html", "agent.sh"):
            shutil.copy(ROOT / name, cls.tmp / name)
        env = dict(os.environ, PORT=str(cls.PORT),
                   PROBE_ADMIN_PASSWORD="test-pass", PROBE_DATA_KEY="test-data-key",
                   PROBE_TRUST_PROXY="1")
        cls.proc = subprocess.Popen([sys.executable, str(cls.tmp / "server.py")],
                                    cwd=cls.tmp, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.base = f"http://127.0.0.1:{cls.PORT}"
        for _ in range(60):
            try:
                status, _, _ = http(cls.base, "GET", "/api/health")
                if status == 200:
                    break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("server failed to start")
        cls.key = None
        cls.node_id = None

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def login(self, password="test-pass"):
        status, headers, _ = http(self.base, "POST", "/api/login",
                                  {"username": "admin", "password": password})
        return status, headers.get("Set-Cookie", "").split(";")[0]

    def test_01_health(self):
        status, _, raw = http(self.base, "GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["ok"])

    def test_02_static_whitelist(self):
        for path in ("/server.py", "/agent.sh", "/data.enc", "/data.json", "/install-server.sh"):
            status, _, _ = http(self.base, "GET", path)
            self.assertEqual(status, 404, path)
        status, _, raw = http(self.base, "GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<html", raw)

    def test_03_admin_requires_login(self):
        status, _, _ = http(self.base, "GET", "/api/admin/keys")
        self.assertEqual(status, 401)

    def test_04_bad_login(self):
        status, _ = self.login("wrong-password")
        self.assertEqual(status, 401)

    def test_05_login_and_create_key(self):
        status, cookie = self.login()
        self.assertEqual(status, 200)
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "ci"}, {"Cookie": cookie})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        self.assertTrue(key.startswith("lp_"))
        type(self).key = key
        type(self).cookie = cookie

    def test_06_install_script(self):
        status, _, raw = http(self.base, "GET",
                              "/api/install.sh?key=" + self.key, headers={"Cookie": self.cookie})
        self.assertEqual(status, 200)
        script = json.loads(raw)["script"]
        self.assertIn(self.key, script)
        self.assertIn("http://127.0.0.1", script)

    def test_07_report_and_public_nodes(self):
        payload = {"hostname": "ci-node", "os": "TestOS", "country": "cn",
                   "uptime": 3600, "cpu": 12, "memory": 34, "disk": 56,
                   "network_rx": 1024, "network_tx": 2048}
        status, _, raw = http(self.base, "POST", "/api/report", payload,
                              {"X-API-Key": self.key})
        self.assertEqual(status, 200)
        type(self).node_id = json.loads(raw)["id"]
        status, _, raw = http(self.base, "GET", "/api/nodes")
        self.assertEqual(status, 200)
        nodes = json.loads(raw)["nodes"]
        self.assertEqual(len(nodes), 1)
        node = nodes[0]
        self.assertEqual(node["ip"], "127.0.*.*")  # masked
        self.assertTrue(node["online"])
        self.assertEqual(node["country"], "CN")  # upper-cased
        self.assertEqual(len(node["history"]), 1)
        self.assertIn("cpu", node["history"][0])

    def test_08_report_rejects_bad_key(self):
        status, _, _ = http(self.base, "POST", "/api/report",
                            {"hostname": "x"}, {"X-API-Key": "lp_nope"})
        self.assertEqual(status, 401)

    def test_09_rename_node(self):
        status, _, raw = http(self.base, "POST", "/api/admin/nodes",
                              {"id": self.node_id, "name": "renamed", "country": "JP"},
                              {"Cookie": self.cookie})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["name"], "renamed")

    def test_10_delete_node(self):
        status, _, _ = http(self.base, "DELETE",
                            "/api/admin/nodes/" + self.node_id, headers={"Cookie": self.cookie})
        self.assertEqual(status, 200)
        _, _, raw = http(self.base, "GET", "/api/nodes")
        self.assertEqual(json.loads(raw)["nodes"], [])

    def test_11_revoked_key_cannot_report(self):
        status, _, raw = http(self.base, "GET", "/api/admin/keys",
                              headers={"Cookie": self.cookie})
        key_id = json.loads(raw)["keys"][0]["id"]
        status, _, _ = http(self.base, "DELETE",
                            "/api/admin/keys/" + key_id, headers={"Cookie": self.cookie})
        self.assertEqual(status, 200)
        status, _, _ = http(self.base, "POST", "/api/report",
                            {"hostname": "x"}, {"X-API-Key": self.key})
        # revoked keys are silently dropped (204), not answered with 401
        self.assertEqual(status, 204)

    def test_12_logout(self):
        status, cookie = self.login()
        self.assertEqual(status, 200)
        http(self.base, "POST", "/api/logout", {}, {"Cookie": cookie})
        status, _, _ = http(self.base, "GET", "/api/admin/keys",
                            headers={"Cookie": cookie})
        self.assertEqual(status, 401)

    def test_13_x_forwarded_for(self):
        # PROBE_TRUST_PROXY=1 is set in setUpClass: the node IP must come
        # from the first X-Forwarded-For entry, not the TCP peer.
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "xff"}, {"Cookie": self.cookie})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        payload = {"hostname": "xff-node", "cpu": 1, "memory": 1, "disk": 1}
        status, _, _ = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key, "X-Forwarded-For": "203.0.113.7, 10.0.0.1"})
        self.assertEqual(status, 200)
        _, _, raw = http(self.base, "GET", "/api/nodes")
        node = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "xff-node"][0]
        self.assertEqual(node["ip"], "203.0.*.*")

    def test_14_block_and_unblock(self):
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "blk"}, {"Cookie": self.cookie})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        payload = {"hostname": "block-node", "cpu": 1, "memory": 1, "disk": 1}
        status, _, raw = http(self.base, "POST", "/api/report", payload,
                              {"X-API-Key": key})
        self.assertEqual(status, 200)
        node_id = json.loads(raw)["id"]
        # deleting the node blocks it, with metadata kept for the admin list
        status, _, _ = http(self.base, "DELETE",
                            "/api/admin/nodes/" + node_id, headers={"Cookie": self.cookie})
        self.assertEqual(status, 200)
        status, _, raw = http(self.base, "GET", "/api/admin/blocked",
                              headers={"Cookie": self.cookie})
        self.assertEqual(status, 200)
        blocked = {b["id"]: b for b in json.loads(raw)["blocked"]}
        self.assertIn(node_id, blocked)
        self.assertEqual(blocked[node_id]["hostname"], "block-node")
        # reports from a blocked node are dropped silently
        status, _, _ = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key})
        self.assertEqual(status, 204)
        # after unblocking, the node can report again
        status, _, _ = http(self.base, "POST", "/api/admin/unblock",
                            {"id": node_id}, {"Cookie": self.cookie})
        self.assertEqual(status, 200)
        status, _, _ = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key})
        self.assertEqual(status, 200)

    def test_99_login_rate_limit(self):
        for _ in range(5):
            status, _ = self.login("nope")
            self.assertEqual(status, 401)
        status, _ = self.login()  # even correct credentials are blocked now
        self.assertEqual(status, 429)


if __name__ == "__main__":
    unittest.main(verbosity=2)
