"""End-to-end smoke tests for the Pulse Linux Probe server.

Boots server.py in a subprocess on a throwaway port and exercises the API
with stdlib urllib only. Runs under both unittest and pytest.
"""
import base64
import hashlib
import hmac
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


def http(base, method, path, body=None, headers=None, raw=None):
    if raw is not None:
        data = raw
    else:
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


def wait_for_health(base, proc, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with code {proc.returncode}")
        try:
            if http(base, "GET", "/api/health")[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError("server failed to start")


def start_server(app_dir, cwd, data_dir, port, **env_overrides):
    """Start a server subprocess; the caller owns termination."""
    env = dict(os.environ, PORT=str(port),
               PROBE_ADMIN_PASSWORD="test-pass", PROBE_DATA_KEY="test-data-key",
               PROBE_DATA_DIR=str(data_dir), PROBE_PUBLIC_URL="",
               PROBE_MAX_NODES="50")
    env.update(env_overrides)
    proc = subprocess.Popen([sys.executable, str(Path(app_dir) / "server.py")],
                            cwd=str(cwd), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        wait_for_health(base, proc)
    except RuntimeError:
        proc.kill()
        raise
    return proc, base


def copy_app(dst):
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("server.py", "index.html", "app.js", "style.css", "agent.sh"):
        shutil.copy(ROOT / name, dst / name)
    return dst


def admin_session(base):
    """Log in and return headers carrying the session cookie and CSRF token."""
    status, hdrs, raw = http(base, "POST", "/api/login",
                             {"username": "admin", "password": "test-pass"})
    assert status == 200, (status, raw)
    cookie = hdrs["Set-Cookie"].split(";")[0]
    return {"Cookie": cookie, "X-CSRF-Token": json.loads(raw)["csrf"]}


def make_key(base, headers, label="k"):
    status, _, raw = http(base, "POST", "/api/admin/keys", {"label": label}, headers)
    assert status == 201, (status, raw)
    return json.loads(raw)


def shutdown(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


class ServerTest(unittest.TestCase):
    PORT = 38091

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="pulse-test-"))
        for name in ("server.py", "index.html", "agent.sh"):
            shutil.copy(ROOT / name, cls.tmp / name)
        env = dict(os.environ, PORT=str(cls.PORT),
                   PROBE_ADMIN_PASSWORD="test-pass", PROBE_DATA_KEY="test-data-key",
                   PROBE_TRUST_PROXY="1", PROBE_MAX_NODES="50")
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
        status, headers, raw = http(self.base, "POST", "/api/login",
                                    {"username": "admin", "password": password})
        csrf = ""
        if status == 200:
            csrf = json.loads(raw).get("csrf", "")
        return status, headers.get("Set-Cookie", "").split(";")[0], csrf

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
        status, _, _ = self.login("wrong-password")
        self.assertEqual(status, 401)

    def test_05_login_and_create_key(self):
        status, cookie, csrf = self.login()
        self.assertEqual(status, 200)
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "ci"}, {"Cookie": cookie, "X-CSRF-Token": csrf})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        self.assertTrue(key.startswith("lp_"))
        type(self).key = key
        type(self).cookie = cookie
        type(self).csrf = csrf

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
        # 公网列表不下发 ip：对端地址在多出口/NAT/反代下都不能代表节点公网 IP
        self.assertNotIn("ip", node)
        self.assertTrue(node["online"])
        self.assertEqual(node["country"], "CN")  # upper-cased
        self.assertEqual(len(node["history"]), 1)
        # 列表接口只下发画速率曲线要用的字段；完整样本在 /api/nodes/<id>
        self.assertEqual(set(node["history"][0]), {"time", "rx", "tx"})

    def test_08_report_rejects_bad_key(self):
        status, _, _ = http(self.base, "POST", "/api/report",
                            {"hostname": "x"}, {"X-API-Key": "lp_nope"})
        self.assertEqual(status, 401)

    def test_09_rename_node(self):
        status, _, raw = http(self.base, "POST", "/api/admin/nodes",
                              {"id": self.node_id, "name": "renamed", "country": "JP"},
                              {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["name"], "renamed")

    def test_10_delete_node(self):
        status, _, _ = http(self.base, "DELETE",
                            "/api/admin/nodes/" + self.node_id,
                            headers={"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 200)
        _, _, raw = http(self.base, "GET", "/api/nodes")
        self.assertEqual(json.loads(raw)["nodes"], [])

    def test_11_revoked_key_cannot_report(self):
        status, _, raw = http(self.base, "GET", "/api/admin/keys",
                              headers={"Cookie": self.cookie})
        key_id = json.loads(raw)["keys"][0]["id"]
        status, _, _ = http(self.base, "DELETE",
                            "/api/admin/keys/" + key_id,
                            headers={"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 200)
        status, _, _ = http(self.base, "POST", "/api/report",
                            {"hostname": "x"}, {"X-API-Key": self.key})
        # revoked keys are silently dropped (204), not answered with 401
        self.assertEqual(status, 204)

    def test_12_logout(self):
        status, cookie, _ = self.login()
        self.assertEqual(status, 200)
        http(self.base, "POST", "/api/logout", {}, {"Cookie": cookie})
        status, _, _ = http(self.base, "GET", "/api/admin/keys",
                            headers={"Cookie": cookie})
        self.assertEqual(status, 401)

    def test_13_x_forwarded_for(self):
        # PROBE_TRUST_PROXY=1 is set in setUpClass: the recorded peer address must
        # come from the first X-Forwarded-For entry, not the TCP peer.
        # 公网接口不再下发 ip（对端地址≠节点公网 IP），所以改从后台接口验证。
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "xff"},
                              {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        payload = {"hostname": "xff-node", "cpu": 1, "memory": 1, "disk": 1}
        status, _, _ = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key, "X-Forwarded-For": "203.0.113.7, 10.0.0.1"})
        self.assertEqual(status, 200)
        _, _, raw = http(self.base, "GET", "/api/admin/nodes",
                         headers={"Cookie": self.cookie})
        node = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "xff-node"][0]
        self.assertEqual(node["ip"], "203.0.113.7")     # 取 XFF 第一段，不带掩码
        # 公网接口无论如何都不该带 ip
        _, _, raw = http(self.base, "GET", "/api/nodes")
        pub = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "xff-node"][0]
        self.assertNotIn("ip", pub)

    def test_14_block_and_unblock(self):
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "blk"},
                              {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        payload = {"hostname": "block-node", "cpu": 1, "memory": 1, "disk": 1}
        status, _, raw = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key})
        self.assertEqual(status, 200)
        node_id = json.loads(raw)["id"]
        # deleting the node blocks it, with metadata kept for the admin list
        status, _, _ = http(self.base, "DELETE",
                            "/api/admin/nodes/" + node_id,
                            headers={"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
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
                            {"id": node_id},
                            {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 200)
        status, _, _ = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key})
        self.assertEqual(status, 200)

    def test_15_change_admin_username(self):
        status, cookie, csrf = self.login()
        self.assertEqual(status, 200)
        # settings endpoint reports the current admin username
        status, _, raw = http(self.base, "GET", "/api/admin/settings",
                              headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["admin_user"], "admin")
        # empty / overlong names are rejected
        for bad in ("", "x" * 61):
            status, _, _ = http(self.base, "POST", "/api/admin/settings",
                                {"admin_user": bad},
                                {"Cookie": cookie, "X-CSRF-Token": csrf})
            self.assertEqual(status, 400, repr(bad))
        # change to a new username
        status, _, raw = http(self.base, "POST", "/api/admin/settings",
                              {"admin_user": "root-admin"},
                              {"Cookie": cookie, "X-CSRF-Token": csrf})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["admin_user"], "root-admin")
        # the old username no longer works
        status, _, _ = self.login()
        self.assertEqual(status, 401)
        # the new username works (a success also clears the rate-limit counter)
        status, _, _ = http(self.base, "POST", "/api/login",
                            {"username": "root-admin", "password": "test-pass"})
        self.assertEqual(status, 200)
        # restore the default for the remaining tests
        status, _, _ = http(self.base, "POST", "/api/admin/settings",
                            {"admin_user": "admin"},
                            {"Cookie": cookie, "X-CSRF-Token": csrf})
        self.assertEqual(status, 200)

    def test_16_ping_target_validation(self):
        # 注入载荷/非法格式必须被拒绝（这是命令注入的第一道防线）
        for bad in ('8.8.8.8:53"; touch /tmp/PULSE_PWNED; echo "',
                    "1.1.1.1:99999", "no-port", "127.0.0.1", "1.1.1.1:80:90"):
            status, _, raw = http(self.base, "POST", "/api/admin/settings",
                                  {"ping_ct": bad},
                                  {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
            self.assertEqual(status, 400, (bad, raw))
        # 合法 host:port 与空值（清空）允许
        for good in ("1.1.1.1:80", "ping.example.com:443"):
            status, _, _ = http(self.base, "POST", "/api/admin/settings",
                                {"ping_ct": good},
                                {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
            self.assertEqual(status, 200, good)
        status, _, _ = http(self.base, "POST", "/api/admin/settings",
                            {"ping_ct": ""},
                            {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 200)

    def test_17_node_limit(self):
        # PROBE_MAX_NODES=50 在 setUpClass 中设置：第 51 个新节点必须被拒绝
        status, _, raw = http(self.base, "POST", "/api/admin/keys",
                              {"label": "flood"},
                              {"Cookie": self.cookie, "X-CSRF-Token": self.csrf})
        self.assertEqual(status, 201)
        key = json.loads(raw)["key"]
        last = None
        for i in range(51):
            status, _, raw = http(self.base, "POST", "/api/report",
                                  {"hostname": f"flood-{i:03d}", "cpu": 1},
                                  {"X-API-Key": key})
            last = status
        self.assertEqual(last, 429)  # 超出上限的新节点被拒
        # 已存在的节点仍可继续上报
        status, _, _ = http(self.base, "POST", "/api/report",
                            {"hostname": "flood-000", "cpu": 2},
                            {"X-API-Key": key})
        self.assertEqual(status, 200)

    def test_18_body_too_large(self):
        status, _, _ = http(self.base, "POST", "/api/login",
                            {"username": "a", "password": "b", "pad": "x" * 70000})
        self.assertEqual(status, 413)

    def test_99_login_rate_limit(self):
        for _ in range(5):
            status, _, _ = self.login("nope")
            self.assertEqual(status, 401)
        status, _, _ = self.login()  # even correct credentials are blocked now
        self.assertEqual(status, 429)


class RegressionTest(unittest.TestCase):
    """回归测试：每个用例对应一次代码审查中发现并修复的缺陷。

    使用独立的服务器实例：故意让进程 CWD 与脚本目录不同，并显式设置
    PROBE_TRUST_PROXY=false（而不是依赖"变量不存在"）。
    """
    PORT = 38093

    @classmethod
    def setUpClass(cls):
        cls.app = copy_app(Path(tempfile.mkdtemp(prefix="pulse-app-")))
        cls.cwd = Path(tempfile.mkdtemp(prefix="pulse-cwd-"))
        cls.data = Path(tempfile.mkdtemp(prefix="pulse-data-"))
        cls.proc, cls.base = start_server(cls.app, cls.cwd, cls.data, cls.PORT,
                                         PROBE_TRUST_PROXY="false")
        cls.admin = admin_session(cls.base)

    @classmethod
    def tearDownClass(cls):
        shutdown(cls.proc)
        for d in (cls.app, cls.cwd, cls.data):
            shutil.rmtree(d, ignore_errors=True)

    def test_01_static_files_resolve_from_script_dir(self):
        # 服务器进程的 CWD 是另一个目录；静态文件仍必须从 server.py 所在目录取。
        status, _, raw = http(self.base, "GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<html", raw)
        self.assertEqual(http(self.base, "GET", "/app.js")[0], 200)
        self.assertEqual(http(self.base, "GET", "/style.css")[0], 200)
        # 白名单仍然生效
        for path in ("/server.py", "/agent.sh", "/data.enc"):
            self.assertEqual(http(self.base, "GET", path)[0], 404, path)

    def test_02_non_dict_body_rejected_not_crashed(self):
        # 数组/字符串/数字/布尔都曾被当成合法 body，随后 .get() 抛
        # AttributeError，连接被直接断开且没有任何响应。
        for raw in (b"[]", b'"abc"', b"1", b"true", b"[1,2]"):
            status, _, _ = http(self.base, "POST", "/api/login", raw=raw)
            self.assertEqual(status, 400, raw)
        # 服务器还活着
        self.assertEqual(http(self.base, "GET", "/api/health")[0], 200)

    def test_03_explicit_false_disables_trust_proxy(self):
        # PROBE_TRUST_PROXY="false" 曾被 bool() 读成 True，等于默认开启反代信任，
        # 任何人都能伪造 X-Forwarded-For 绕过登录限流。
        key = make_key(self.base, self.admin, "xff")["key"]
        payload = {"hostname": "xff-node", "cpu": 1, "memory": 1, "disk": 1}
        status, _, _ = http(self.base, "POST", "/api/report", payload,
                            {"X-API-Key": key, "X-Forwarded-For": "203.0.113.7"})
        self.assertEqual(status, 200)
        # 公网接口不带 ip，改从后台接口查真实记录的对端地址
        _, _, raw = http(self.base, "GET", "/api/nodes")
        pub = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "xff-node"][0]
        self.assertNotIn("ip", pub, "公网接口不应下发 ip")
        _, _, raw = http(self.base, "GET", "/api/admin/nodes", headers=self.admin)
        node = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "xff-node"][0]
        self.assertEqual(node["ip"], "127.0.0.1")  # TCP 对端；伪造的 XFF 必须被忽略
        self.assertEqual(node["hostname"], "xff-node")

    def test_04_report_fields_are_whitelisted_and_clamped(self):
        key = make_key(self.base, self.admin, "clean")["key"]
        junk = "J" * 20000
        payload = {"hostname": "clean-node", "cpu": 999, "memory": -5, "disk": 42,
                   "network_rx": {"nested": junk}, "evil_extra_field": junk,
                   "admin_user": "pwned"}
        for _ in range(3):
            status, _, _ = http(self.base, "POST", "/api/report", payload,
                                {"X-API-Key": key})
            self.assertEqual(status, 200)
        _, _, raw = http(self.base, "GET", "/api/nodes")
        self.assertLess(len(raw), 4096)  # 3×20KB 的上报不能撑大响应
        node = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "clean-node"][0]
        self.assertNotIn("evil_extra_field", node)
        self.assertNotIn("admin_user", node)
        self.assertEqual(node["cpu"], 100)       # 百分比被夹到 [0,100]
        self.assertEqual(node["memory"], 0)
        self.assertEqual(node["disk"], 42)
        self.assertEqual(node["network_rx"], 0)  # 嵌套 dict 归零
        for sample in node["history"]:
            self.assertIsInstance(sample["rx"], float)

    def test_05_admin_node_edit_with_unhashable_id(self):
        # {"id": []} 曾让 DATA["nodes"].get() 抛 TypeError，连接被断开。
        status, _, raw = http(self.base, "POST", "/api/admin/nodes", {"id": []}, self.admin)
        self.assertEqual(status, 404, raw)
        status, _, raw = http(self.base, "POST", "/api/admin/nodes", {"id": {"a": 1}}, self.admin)
        self.assertEqual(status, 404, raw)

    def test_06_resource_id_with_query_string(self):
        # 路径参数取自原始 self.path 时，"?x=1" 会被当成 id 的一部分而误报 404。
        item = make_key(self.base, self.admin, "before")
        status, _, raw = http(self.base, "POST", f"/api/admin/keys/{item['id']}?x=1",
                              {"label": "after"}, self.admin)
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)["label"], "after")
        status, _, raw = http(self.base, "GET", "/api/admin/keys", headers=self.admin)
        self.assertEqual([k["label"] for k in json.loads(raw)["keys"] if k["id"] == item["id"]],
                         ["after"])

    def test_07_ping_history_is_compacted_but_keeps_loss_events(self):
        # 服务端保留 1 天 1 分钟粒度，但 /api/nodes 必须压到图表够用的点数，
        # 同时**不能把偶发超时的采样点抽掉**——那正是这张图存在的意义。
        key = make_key(self.base, self.admin, "ping")["key"]
        total = 260
        for i in range(total):
            loss = -1 if i == 100 else 0
            payload = {"hostname": "ping-node", "cpu": 1, "memory": 1, "disk": 1,
                       "tcp_ping_ct": loss or 20, "tcp_ping_cu": loss or 30,
                       "tcp_ping_cm": loss or 40}
            status, _, _ = http(self.base, "POST", "/api/report", payload, {"X-API-Key": key})
            self.assertEqual(status, 200, i)

        status, _, raw = http(self.base, "GET", "/api/nodes")
        node = [n for n in json.loads(raw)["nodes"] if n["hostname"] == "ping-node"][0]
        self.assertLess(len(node["ping_history"]), total, "全天序列必须被压缩")
        self.assertLessEqual(len(node["ping_history"]), 240)
        self.assertLessEqual(len(node["history"]), 60)
        self.assertTrue(any(s["cm"] < 0 for s in node["ping_history"]),
                        "抽样不能把超时采样点抹掉")

    def test_08_admin_node_list_omits_chart_history(self):
        # 管理列表只用来改名/改国家码；带上历史会白白撑大响应。
        status, _, raw = http(self.base, "GET", "/api/admin/nodes", headers=self.admin)
        self.assertEqual(status, 200)
        nodes = json.loads(raw)["nodes"]
        self.assertTrue(nodes)
        for n in nodes:
            self.assertNotIn("history", n)
            self.assertNotIn("ping_history", n)
            self.assertIn("hostname", n)   # 管理界面需要的字段仍在

    def test_09_detail_endpoint_serves_full_samples(self):
        # 列表页只给 time/rx/tx，详情页才给完整样本（CPU/内存/负载/缓存都在）
        key = make_key(self.base, self.admin, "detail")["key"]
        payload = {"hostname": "detail-node", "cpu": 42, "memory": 61, "disk": 55,
                   "network_rx": 1234567, "network_tx": 654321,
                   "load1": 0.42, "mem_cached": 123456789, "swap_used": 1024,
                   "cpu_model": "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz",
                   "kernel": "6.1.0-18-amd64", "os_version_id": "12",
                   "os_codename": "bookworm", "procs": 234, "iowait": 3}
        status, _, raw = http(self.base, "POST", "/api/report", payload, {"X-API-Key": key})
        self.assertEqual(status, 200)
        node_id = json.loads(raw)["id"]

        status, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=86400")
        self.assertEqual(status, 200)
        body = json.loads(raw)
        node = body["node"]
        self.assertEqual(body["range"], 86400)
        # 规格字段原样带出
        self.assertEqual(node["kernel"], "6.1.0-18-amd64")
        self.assertEqual(node["os_codename"], "bookworm")
        self.assertEqual(node["procs"], 234)
        self.assertEqual(node["iowait"], 3)
        self.assertTrue(node["cpu_model"].startswith("Intel(R) Xeon(R)"))
        # 详情接口同样不下发 ip
        self.assertNotIn("ip", node)
        # 完整样本
        sample = body["history"][0]
        for key_name in ("time", "rx", "tx", "cpu", "memory", "disk", "load1",
                         "mem_cached", "swap_used"):
            self.assertIn(key_name, sample)
        self.assertEqual(sample["cpu"], 42)
        self.assertEqual(sample["load1"], 0.42)

    def test_10_detail_endpoint_input_validation(self):
        # 非法 id / 不存在的 id / 越界 range 都不能 500，也不能回落到别的节点
        for bad in ("", "not-an-id", "../etc", "ZZZZZZZZ", "a" * 100):
            status, _, _ = http(self.base, "GET", "/api/nodes/" + bad)
            self.assertEqual(status, 404, bad)
        status, _, _ = http(self.base, "GET", "/api/nodes/0123456789abcdef")
        self.assertEqual(status, 404)   # 格式合法但不存在
        # range 越界被夹到 [300, 86400]，非法值退回默认 3600
        key = make_key(self.base, self.admin, "range")["key"]
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "range-node", "cpu": 1}, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        for query, expect in (("?range=99999999", 86400), ("?range=1", 300),
                              ("?range=abc", 3600), ("", 3600), ("?range=-5", 300)):
            status, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}{query}")
            self.assertEqual(status, 200, query)
            self.assertEqual(json.loads(raw)["range"], expect, query)

    def test_11_detail_history_respects_retention_and_point_cap(self):
        # 详情页也要压到 DETAIL_POINTS 以内，并且窗口裁剪不会裁空
        key = make_key(self.base, self.admin, "cap")["key"]
        for i in range(320):
            http(self.base, "POST", "/api/report",
                 {"hostname": "cap-node", "cpu": i % 100, "memory": 50, "disk": 50},
                 {"X-API-Key": key})
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "cap-node", "cpu": 1}, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=86400")
        body = json.loads(raw)
        self.assertLessEqual(len(body["history"]), 300)
        self.assertGreater(len(body["history"]), 1)
        # 窗口比数据还短时至少回退到一个点，而不是空数组
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=300")
        self.assertGreaterEqual(len(json.loads(raw)["history"]), 1)

    def test_12_detail_derives_events_and_exposes_thresholds(self):
        key = make_key(self.base, self.admin, "ev")["key"]
        # 连续 5 个采样 CPU ≥90 → 派生一条 CPU 事件
        for _ in range(5):
            http(self.base, "POST", "/api/report",
                 {"hostname": "ev-node", "cpu": 95, "memory": 20, "disk": 20}, {"X-API-Key": key})
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "ev-node", "cpu": 95, "memory": 20, "disk": 20},
                         {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=86400")
        body = json.loads(raw)
        self.assertIn("events", body)
        self.assertIn("thresholds", body)
        self.assertEqual(body["thresholds"]["cpu"], 90)
        kinds = {e["kind"] for e in body["events"]}
        self.assertIn("cpu", kinds)
        cpu_ev = [e for e in body["events"] if e["kind"] == "cpu"][0]
        self.assertIn("连续", cpu_ev["text"])
        self.assertIn(cpu_ev["level"], ("warn", "error"))

    def test_13_thresholds_are_clamped_and_applied(self):
        # 超范围夹到边界，非数值回落默认，未知键忽略
        status, _, raw = http(self.base, "POST", "/api/admin/settings",
                              {"thresholds": {"cpu": 999, "loss": "abc", "bogus": 1}},
                              self.admin)
        self.assertEqual(status, 200, raw)
        th = json.loads(raw)["thresholds"]
        self.assertEqual(th["cpu"], 100)      # 夹到 max
        self.assertEqual(th["loss"], 50)      # 非数值 → 默认
        self.assertNotIn("bogus", th)
        self.assertEqual(th["memory"], 90)    # 未提交的保持默认

        # 阈值调低后，原本不触发的事件应该出现
        key = make_key(self.base, self.admin, "th")["key"]
        for _ in range(4):
            http(self.base, "POST", "/api/report",
                 {"hostname": "th-node", "cpu": 25, "memory": 10, "disk": 10}, {"X-API-Key": key})
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "th-node", "cpu": 25, "memory": 10, "disk": 10},
                         {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=86400")
        self.assertNotIn("cpu", {e["kind"] for e in json.loads(raw)["events"]})

        http(self.base, "POST", "/api/admin/settings", {"thresholds": {"cpu": 10}}, self.admin)
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=86400")
        self.assertIn("cpu", {e["kind"] for e in json.loads(raw)["events"]},
                      "阈值调低后应命中")
        # 恢复默认，免得影响后续用例
        http(self.base, "POST", "/api/admin/settings",
             {"thresholds": {"cpu": 90, "memory": 90, "disk": 90, "iowait": 60,
                             "loss": 50, "ping_ms": 500}}, self.admin)

    def test_15_detail_window_can_be_panned_with_end(self):
        # 时间轴缩放/平移：end 决定窗口右端，不传就是贴着现在
        key = make_key(self.base, self.admin, "pan")["key"]
        for i in range(30):
            http(self.base, "POST", "/api/report",
                 {"hostname": "pan-node", "cpu": i, "memory": 10, "disk": 10},
                 {"X-API-Key": key})
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "pan-node", "cpu": 1}, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]

        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        body = json.loads(raw)
        self.assertIn("end", body)
        self.assertIn("oldest", body)
        self.assertIn("newest", body)
        self.assertLessEqual(body["end"], time.time() + 1)
        self.assertLessEqual(body["oldest"], body["newest"])

        # 把 end 挪到过去：窗口右端必须跟着走
        past = body["newest"] - 600
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600&end={past}")
        moved = json.loads(raw)
        self.assertAlmostEqual(moved["end"], past, delta=2)
        # 这些上报都挤在几秒内，往回挪 10 分钟后窗口内其实没有样本；
        # trim_window 会回退到最后一个点（避免白屏），所以这里只断言非空。
        # 真正的窗口裁剪在端到端脚本里用 24 小时数据验证。
        self.assertGreaterEqual(len(moved["history"]), 1)

        # end 不能超过现在，也不能是垃圾值
        for bad, desc in ((time.time() + 99999, "未来"), ("abc", "非数值"), ("", "空")):
            _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600&end={bad}")
            self.assertLessEqual(json.loads(raw)["end"], time.time() + 1, desc)

        # range 下限 300 秒（时间轴放大到 5 分钟为止）
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=10")
        self.assertEqual(json.loads(raw)["range"], 300)
    def test_14_ifaces_are_whitelisted_and_capped(self):
        key = make_key(self.base, self.admin, "if")["key"]
        payload = {"hostname": "if-node", "cpu": 1,
                   "ifaces": [
                       {"name": "eth0", "rx": 1000, "tx": 2000, "err": 0, "drop": 0},
                       # 非法字符 / 负数 / 天文数字
                       {"name": 'eth1"; rm -rf /', "rx": -5, "tx": 1e99, "err": 1, "drop": 2},
                       "not-a-dict",                      # 直接丢弃
                       {"name": "", "rx": 1},             # 空名字丢弃
                       {"name": "e" * 40, "rx": 1},       # 名字截断到 16
                   ]}
        _, _, raw = http(self.base, "POST", "/api/report", payload, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        got = json.loads(raw)["node"]["ifaces"]
        self.assertEqual(len(got), 3, got)
        self.assertEqual(got[0], {"name": "eth0", "rx": 1000.0, "tx": 2000.0, "err": 0.0, "drop": 0.0})
        self.assertEqual(got[1]["name"], "eth1rm-rf")     # 非白名单字符被剥掉
        self.assertEqual(got[1]["rx"], 0)                 # 负数归零
        self.assertEqual(got[1]["tx"], 1e15)              # 夹到上限
        self.assertEqual(got[2]["name"], "e" * 16)        # 截断

        # 超过上限只保留前 8 个
        many = {"hostname": "if2-node", "cpu": 1,
                "ifaces": [{"name": f"eth{i}", "rx": i} for i in range(20)]}
        _, _, raw = http(self.base, "POST", "/api/report", many, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        self.assertEqual(len(json.loads(raw)["node"]["ifaces"]), 8)
        # 传个非列表也不该炸
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "if3-node", "cpu": 1, "ifaces": "nope"}, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        self.assertEqual(json.loads(raw)["node"]["ifaces"], [])

    def test_16_disks_are_whitelisted_and_capped(self):
        key = make_key(self.base, self.admin, "dk")["key"]
        payload = {"hostname": "dk-node", "cpu": 1, "disks": [
            {"mount": "/", "total": 1000, "used": 400, "pct": 40},
            # 非白名单字符 / 负数 / 天文数字 / 越界百分比
            {"mount": '/data"; rm -rf /', "total": -5, "used": 1e99, "pct": 999},
            "not-a-dict",                       # 直接丢弃
            {"mount": "", "total": 1},          # 空挂载点丢弃
            {"mount": "/m" * 40, "total": 1},   # 超长挂载点截断
        ]}
        _, _, raw = http(self.base, "POST", "/api/report", payload, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        got = json.loads(raw)["node"]["disks"]
        self.assertEqual(len(got), 3, got)
        self.assertEqual(got[0], {"mount": "/", "total": 1000.0, "used": 400.0, "pct": 40.0})
        self.assertEqual(got[1]["mount"], "/data rm -rf /")   # 非白名单字符被剥掉
        self.assertEqual(got[1]["total"], 0)                  # 负数归零
        self.assertEqual(got[1]["used"], 1e15)                # 夹到上限
        self.assertEqual(got[1]["pct"], 100)                  # 百分比夹到 100
        self.assertEqual(len(got[2]["mount"]), 64)            # 截断

        # 超过上限只保留前 8 个
        many = {"hostname": "dk2-node", "cpu": 1,
                "disks": [{"mount": f"/d{i}", "total": i} for i in range(20)]}
        _, _, raw = http(self.base, "POST", "/api/report", many, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        self.assertEqual(len(json.loads(raw)["node"]["disks"]), 8)

        # 传个非列表也不该炸
        _, _, raw = http(self.base, "POST", "/api/report",
                         {"hostname": "dk3-node", "cpu": 1, "disks": "nope"}, {"X-API-Key": key})
        node_id = json.loads(raw)["id"]
        _, _, raw = http(self.base, "GET", f"/api/nodes/{node_id}?range=3600")
        self.assertEqual(json.loads(raw)["node"]["disks"], [])

        # 公开列表接口不下发 disks（只有详情页用得到），避免节点多时白撑响应
        _, _, raw = http(self.base, "GET", "/api/nodes")
        for node in json.loads(raw)["nodes"]:
            self.assertNotIn("disks", node)


class DataFileMigrationTest(unittest.TestCase):
    """v1 容器（裸 SHA-256 密钥）必须能读，并在下一次保存时自动升级成 v2（PBKDF2）。"""
    PORT = 38094
    MAGIC = b"PULSEv2\n"

    @staticmethod
    def write_legacy_file(path, password, payload):
        key = hashlib.sha256(password.encode()).digest()
        nonce = b"\x01" * 16
        data = json.dumps(payload, separators=(",", ":")).encode()
        cipher = bytearray()
        for offset in range(0, len(data), 32):
            stream = hashlib.sha256(key + nonce + (offset // 32).to_bytes(8, "big")).digest()
            cipher.extend(a ^ b for a, b in zip(data[offset:offset + 32], stream))
        cipher = bytes(cipher)
        tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
        path.write_bytes(base64.b64encode(nonce + tag + cipher))

    def test_legacy_file_is_read_then_upgraded(self):
        app = copy_app(Path(tempfile.mkdtemp(prefix="pulse-app-")))
        cwd = Path(tempfile.mkdtemp(prefix="pulse-cwd-"))
        data = Path(tempfile.mkdtemp(prefix="pulse-data-"))
        self.addCleanup(shutil.rmtree, app, True)
        self.addCleanup(shutil.rmtree, cwd, True)
        self.addCleanup(shutil.rmtree, data, True)

        node = {"id": "legacy01", "hostname": "legacy-node", "name": "legacy",
                "country": "CN", "cpu": 7, "memory": 8, "disk": 9, "ip": "10.0.0.1",
                "updated": time.time(), "history": [], "ping_history": []}
        payload = {"keys": [], "nodes": {"legacy01": node},
                   "blocked_nodes": [], "settings": {}, "revoked_keys": []}
        data_file = data / "data.enc"
        self.write_legacy_file(data_file, "test-data-key", payload)
        self.assertFalse(base64.b64decode(data_file.read_bytes()).startswith(self.MAGIC),
                         "precondition: the seeded file must be in the v1 layout")

        proc, base = start_server(app, cwd, data, self.PORT)
        try:
            _, _, raw = http(base, "GET", "/api/nodes")
            nodes = json.loads(raw)["nodes"]
            self.assertEqual([n["hostname"] for n in nodes], ["legacy-node"])
            # 任何管理员写操作都会走 save_data(force=True)
            make_key(base, admin_session(base), "upgrade")
        finally:
            shutdown(proc)  # SIGTERM 触发 flush

        self.assertTrue(base64.b64decode(data_file.read_bytes()).startswith(self.MAGIC),
                        "saving must rewrite the file in the v2 container")

        # 重启后仍能读回同一份数据（证明 v2 容器自洽）
        proc, base = start_server(app, cwd, data, self.PORT)
        try:
            _, _, raw = http(base, "GET", "/api/nodes")
            self.assertEqual([n["hostname"] for n in json.loads(raw)["nodes"]], ["legacy-node"])
            _, _, raw = http(base, "GET", "/api/admin/keys", headers=admin_session(base))
            self.assertEqual([k["label"] for k in json.loads(raw)["keys"]], ["upgrade"])
        finally:
            shutdown(proc)


if __name__ == "__main__":
    unittest.main(verbosity=2)
