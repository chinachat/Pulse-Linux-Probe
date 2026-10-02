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
ENV_DATA_KEY = os.getenv("PROBE_DATA_KEY") or ADMIN_PASSWORD
PUBLIC_URL = os.getenv("PROBE_PUBLIC_URL", "").rstrip("/")
SESSION_TTL = int(os.getenv("PROBE_SESSION_TTL", str(12 * 3600)))
OFFLINE_SECONDS = int(os.getenv("PROBE_OFFLINE_SECONDS", "90"))
# 只有显式的真值才算开启。不能写成 bool(os.getenv(...))：docker-compose.yml
# 会注入同名变量，`PROBE_TRUST_PROXY=false` 是非空字符串，bool() 得到 True，
# 等于把"关闭"读成"开启"（后果见 README 的「反向代理」一节）。
TRUST_PROXY = os.getenv("PROBE_TRUST_PROXY", "").strip().lower() in ("1", "true", "yes", "on")
LOAD_HISTORY_LIMIT = int(os.getenv("PROBE_LOAD_HISTORY", "1440"))  # 负载/网络样本：1 天（1 分钟粒度）
PING_HISTORY_LIMIT = int(os.getenv("PROBE_PING_HISTORY", "1440"))  # 延迟样本：1 天（1 分钟粒度）
LOGIN_WINDOW = 300
LOGIN_MAX_FAILURES = 5
LOGIN_MAX_TRACKED_IPS = 10000  # 登录失败计数表上限，防伪造 IP 无限增长
LOGIN_PRUNE_INTERVAL = 60      # 全表清理的最小间隔（秒），避免每次登录都做 O(n) 扫描
MAX_NODES = int(os.getenv("PROBE_MAX_NODES", "200"))
MAX_BODY = 64 * 1024  # 64KB 请求体上限，防未认证端点内存/线程 DoS
STATIC_FILES = {"index.html", "app.js", "style.css"}
HOST_RE = re.compile(r"[A-Za-z0-9.-]+(:\d{1,5})?")
# 仅接受 host:port（域名/IPv4），端口 1-65535。该值会原样嵌入 agent 脚本的
# shell 调用点（单引号包裹），格式校验是防止命令注入的关键防线（agent.sh 侧另有防御）。
PING_TARGET_RE = re.compile(r"^[A-Za-z0-9.-]+:\d{1,5}$")
# data.enc 容器版本：v1 = nonce||tag||cipher（密钥是裸 SHA-256），
# v2 = MAGIC||salt||nonce||tag||cipher（密钥是 PBKDF2-HMAC-SHA256）。
FILE_MAGIC_V2 = b"PULSEv2\n"
KDF_ITERATIONS = 600_000
# 上报字段白名单：(最小值, 最大值)。持钥者只能写这些字段，且值被强制为有限数值，
# 否则可以把任意 JSON 灌进节点记录，再靠 history 放大 120 倍（见 README「安全」）。
REPORT_FIELDS = {
    "cpu": (0.0, 100.0), "memory": (0.0, 100.0), "disk": (0.0, 100.0),
    "uptime": (0.0, 1e15), "cpu_cores": (0.0, 1e9),
    "mem_total": (0.0, 1e15), "disk_total": (0.0, 1e15),
    "network_rx": (0.0, 1e15), "network_tx": (0.0, 1e15),
    "net_total_rx": (0.0, 1e15), "net_total_tx": (0.0, 1e15),
    "tcp_ping_ct": (-1.0, 1e6), "tcp_ping_cu": (-1.0, 1e6), "tcp_ping_cm": (-1.0, 1e6),
    # 规格/负载（新增；老客户端不上报时缺失，前端按"没有"处理）
    "cpu_mhz": (0.0, 1e6), "iowait": (0.0, 100.0),
    "mem_cached": (0.0, 1e15), "mem_buffers": (0.0, 1e15), "mem_available": (0.0, 1e15),
    "swap_total": (0.0, 1e15), "swap_used": (0.0, 1e15),
    "load1": (0.0, 1e6), "load5": (0.0, 1e6), "load15": (0.0, 1e6),
    "procs": (0.0, 1e9), "threads": (0.0, 1e9), "running": (0.0, 1e9),
    "tcp_conn": (0.0, 1e9), "net_err": (0.0, 1e15), "net_drop": (0.0, 1e15),
}
REPORT_STRINGS = (("hostname", 100, "unknown"), ("name", 60, ""), ("os", 120, ""),
                  # 规格类字符串；取不到的留空，前端整行不显示
                  ("os_version_id", 40, ""), ("os_codename", 40, ""), ("os_id", 40, ""),
                  ("kernel", 120, ""), ("kernel_full", 160, ""), ("arch", 20, ""),
                  ("cpu_model", 120, ""), ("cpu_cache", 40, ""), ("virt", 40, ""))
# 单条负载样本包含哪些字段：(上报字段, 样本里的短键)。
# 改这里就会同时影响存储、下发和曲线。
HISTORY_SAMPLE_FIELDS = (("network_rx", "rx"), ("network_tx", "tx"), ("cpu", "cpu"),
                         ("memory", "memory"), ("disk", "disk"), ("load1", "load1"),
                         ("mem_cached", "mem_cached"), ("swap_used", "swap_used"))
# 详情接口：一次最多下发多少个点、可查询的时间窗范围
DETAIL_POINTS = 300
DETAIL_KEEP_RECENT = 60
DETAIL_MIN_RANGE = 300      # 最小 5 分钟窗口（时间轴缩放下限）
DETAIL_MAX_RANGE = 86400    # 最大 24 小时
NODE_ID_RE = re.compile(r"^[0-9a-f]{6,64}$")
# 事件派生阈值（可在后台改，存在 DATA["settings"]["thresholds"]）。
# (键, 默认值, 最小, 最大, 单位/说明)
EVENT_THRESHOLDS = (
    ("cpu", 90, 10, 100, "CPU 使用率"),
    ("memory", 90, 10, 100, "内存使用率"),
    ("disk", 90, 10, 100, "磁盘使用率"),
    ("iowait", 60, 1, 100, "iowait 占比"),
    ("loss", 50, 5, 100, "单点丢包率"),
    ("ping_ms", 500, 50, 60000, "延迟"),
)
THRESHOLD_KEYS = {k: (lo, hi) for k, _d, lo, hi, _u in EVENT_THRESHOLDS}
EVENT_CONSECUTIVE = 3        # 连续多少个采样点越线才算一次事件
EVENT_OFFLINE_GAP = 150      # 相邻采样间隔超过这个秒数即视为一段离线
EVENT_MAX = 200              # 事件列表上限
# 按接口快照：最多几个网卡（只存当前值，不进历史）
IFACE_LIMIT = 8
# 多盘快照：最多几个挂载点（同样只存当前值，不进历史）
DISK_LIMIT = 8
# 挂载点允许的字符。这里只做一次粗过滤；前端用 textContent 赋值（不拼 HTML）作为第二道防线
DISK_MOUNT_RE = re.compile(r"[^A-Za-z0-9._:/@ +-]")
# 块设备树（lsblk）快照：最多几条。分区、LVM、RAID 都各算一条，所以要比磁盘数宽松。
# 注意不能按 name 去重 —— lsblk 会把多父设备（如 RAID 阵列）在每个成员下各列一次，
# 那个重复正是"这块盘属于某阵列"的唯一线索。
HDISK_LIMIT = 64
HDISK_NAME_RE = re.compile(r"[^A-Za-z0-9._:-]")
HDISK_TYPE_RE = re.compile(r"[^A-Za-z0-9]")
HDISK_MODEL_RE = re.compile(r"[^A-Za-z0-9 ._+()/-]")
CARRIER_NAMES = {"ct": "电信", "cu": "联通", "cm": "移动"}

def default_thresholds():
    return {k: d for k, d, _lo, _hi, _u in EVENT_THRESHOLDS}

def threshold_meta():
    """给后台界面用的阈值元信息，避免前端再抄一份取值范围。"""
    return [{"key": k, "label": u, "default": d, "min": lo, "max": hi}
            for k, d, lo, hi, u in EVENT_THRESHOLDS]

def clean_thresholds(raw):
    """把前端传来的阈值字典校验成合法数值；非法项回落默认值。"""
    out = default_thresholds()
    if not isinstance(raw, dict):
        return out
    for key, (lo, hi) in THRESHOLD_KEYS.items():
        if key not in raw:
            continue
        try:
            v = float(raw[key])
        except (TypeError, ValueError):
            continue
        if v != v:      # NaN
            continue
        out[key] = int(min(max(v, lo), hi))
    return out

def sanitize_ifaces(raw):
    """按接口快照：只重建已知字段，绝不把客户端给的 dict 原样收下。

    和 sanitize_report 同一套思路——网卡名过白名单、数值钳制、条数封顶。
    """
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:IFACE_LIMIT]:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"[^A-Za-z0-9._:@-]", "", str(item.get("name", "")))[:16]
        if not name:
            continue
        out.append({"name": name,
                    "rx": clamp_num(item.get("rx"), 0.0, 1e15),
                    "tx": clamp_num(item.get("tx"), 0.0, 1e15),
                    "err": clamp_num(item.get("err"), 0.0, 1e9),
                    "drop": clamp_num(item.get("drop"), 0.0, 1e9)})
    return out

def sanitize_disks(raw):
    """多盘用量快照：和 sanitize_ifaces 同一套思路——按白名单重建，绝不原样收下客户端的 dict。

    只存当前值，不进历史（曲线与"磁盘使用率"告警阈值仍只针对根盘 /）。
    """
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:DISK_LIMIT]:
        if not isinstance(item, dict):
            continue
        mount = DISK_MOUNT_RE.sub("", str(item.get("mount", "")))[:64]
        if not mount:
            continue
        out.append({"mount": mount,
                    "total": clamp_num(item.get("total"), 0.0, 1e15),
                    "used": clamp_num(item.get("used"), 0.0, 1e15),
                    "pct": clamp_num(item.get("pct"), 0.0, 100.0)})
    return out

def aggregate_disk_pct(clean):
    """总负载率 = 所有已上报磁盘的「已用合计 / 容量合计」。

    agent 已按设备去重，所以同一个物理盘重复挂载不会重复计入。
    老客户端不上报 disks 时退回根盘的 disk 值，行为与旧版一致。
    """
    disks = clean.get("disks") or []
    total = sum(d.get("total", 0.0) for d in disks)
    used = sum(d.get("used", 0.0) for d in disks)
    if total > 0:
        return round(min(max(used / total * 100.0, 0.0), 100.0), 2)
    return clamp_num(clean.get("disk"), 0.0, 100.0)

def sanitize_hdisks(raw):
    """块设备树快照（lsblk）：和 ifaces / disks 一样按白名单重建。

    name 故意不去重：lsblk 会把多父设备的子节点（RAID 阵列）在每个成员下各列一次，
    这个重复是判断"这块盘属于某个阵列"的唯一线索。
    """
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:HDISK_LIMIT]:
        if not isinstance(item, dict):
            continue
        name = HDISK_NAME_RE.sub("", str(item.get("name", "")))[:32]
        if not name:
            continue
        out.append({
            "name": name,
            "type": HDISK_TYPE_RE.sub("", str(item.get("type", "")))[:16],
            "size": clamp_num(item.get("size"), 0.0, 1e18),
            "mount": DISK_MOUNT_RE.sub("", str(item.get("mount", "")))[:64],
            "parent": HDISK_NAME_RE.sub("", str(item.get("parent", "")))[:32],
            "model": HDISK_MODEL_RE.sub("", str(item.get("model", "")))[:40].strip(),
            "rota": 1.0 if clamp_num(item.get("rota"), 0.0, 1.0) >= 0.5 else 0.0,
        })
    return out

def build_hardware_disks(hdisks, disks):
    """把块设备树整理成「硬件磁盘」列表，并把已挂载的文件系统归回所属物理盘。

    为什么要这么绕：df（也就是 disks）只知道"哪个挂载点用了多少"，**不知道它落在哪块盘上**。
    一块盘可能被拆成多个分区，也可能被 LVM / RAID / dm-crypt 盖住，df 里只看得到
    逻辑卷或阵列。这里靠 lsblk 的 parent 关系从挂载点往上走：

      · 中途只经过 partition 的  → 该文件系统的用量直接计入这块盘（可以相加）；
      · 中途跨过 lvm/raid/crypt 的 → 这块盘是逻辑卷或阵列的承载盘，**单盘的"已用"
        没有唯一答案**（RAID1 同一份数据算哪块盘的？），所以不编造数字，
        只标注角色、把用量留空。
    """
    by_name = {}
    for d in hdisks:
        by_name.setdefault(d["name"], d)   # 父设备（分区）名字唯一，首次为准
    usage = {d["mount"]: d for d in disks if d.get("mount")}

    agg = {}
    for dev in hdisks:
        mount = dev.get("mount") or ""
        if not mount:
            continue
        node, crossed, seen = dev, [], set()
        if node.get("type") not in ("part", "disk"):
            crossed.append(node.get("type") or "")
        while node.get("parent") and node["parent"] in by_name and node["name"] not in seen:
            seen.add(node["name"])
            parent = by_name[node["parent"]]
            if parent.get("type") == "disk":
                node = parent
                break
            if parent.get("type") != "part":
                crossed.append(parent.get("type") or "")
            node = parent
        if node.get("type") != "disk":
            continue                      # 找不到归属的物理盘（异常 / 虚拟设备）
        entry = agg.setdefault(node["name"], {"used": 0.0, "total": 0.0, "roles": [], "mounts": 0})
        entry["mounts"] += 1
        for role in crossed:
            if role and role not in entry["roles"]:
                entry["roles"].append(role)
        u = usage.get(mount)
        if u and not crossed:             # 直接挂载才计量；跨了逻辑层就不猜
            entry["used"] += float(u.get("used") or 0)
            entry["total"] += float(u.get("total") or 0)

    out, seen_disk = [], set()
    for d in hdisks:
        if d.get("type") != "disk" or d["name"] in seen_disk:
            continue
        seen_disk.add(d["name"])
        e = agg.get(d["name"])
        used = total = pct = None
        if e and e["total"] > 0:
            used, total = e["used"], e["total"]
            pct = round(min(max(used / total * 100.0, 0.0), 100.0), 1)
        out.append({
            "name": d["name"],
            "size": d["size"],
            "model": d["model"],
            "media": "HDD" if d["rota"] >= 0.5 else "SSD",
            "role": "/".join(e["roles"]) if e else "",
            "mounts": e["mounts"] if e else 0,
            "used": used,
            "total": total,
            "pct": pct,
        })
    return out                          # 保持 lsblk 的顺序（内核设备序），编号才稳定

def valid_ping_target(value):
    if not value:
        return True  # 空值 = 清空该运营商目标
    if not PING_TARGET_RE.fullmatch(value):
        return False
    port = int(value.rsplit(":", 1)[1])
    return 1 <= port <= 65535

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pulse-probe")

if ADMIN_PASSWORD == "change-me":
    log.error("PROBE_ADMIN_PASSWORD is not set; refusing to start.")
    log.error("Set PROBE_ADMIN_PASSWORD and PROBE_DATA_KEY in environment.")
    sys.exit(1)
if not os.getenv("PROBE_DATA_KEY") or os.getenv("PROBE_DATA_KEY") == ADMIN_PASSWORD:
    log.error("PROBE_DATA_KEY must be set independently from PROBE_ADMIN_PASSWORD.")
    sys.exit(1)

SESSIONS = {}        # token -> {"expiry": timestamp, "csrf": str}
LOGIN_FAILURES = {}  # client ip -> [failure timestamps]
LOCK = threading.RLock()
_AGENT_SCRIPT = None
_LAST_SAVE = 0.0
_LAST_LOGIN_PRUNE = 0.0
SAVE_DEBOUNCE_MIN = 5      # 两次自动落盘的最小间隔（秒）
SAVE_DEBOUNCE_MAX = 120    # 上限：节点多 / 历史长时允许放宽到 2 分钟
_SAVE_DEBOUNCE = SAVE_DEBOUNCE_MIN
# /api/nodes 下发的采样点数上限。服务端保留完整历史，但全量下发没有意义：
# 图表宽度只有几百像素，而且 200 个节点 × 1440 个点会让响应体膨胀到十几 MB。
API_RATE_POINTS = 60       # 速率图只画最近 30 个点，60 个足够
API_PING_POINTS = 240      # 延迟图（含丢包）最多 240 个点
API_PING_KEEP_RECENT = 60  # 其中最近 60 个保持原始 1 分钟粒度，供"最近 1 小时"使用

# v2 salt，由 load_data() 决定；DATA_KEY 是实际用于加解密的派生密钥。
SALT = None
DATA_KEY = hashlib.sha256(ENV_DATA_KEY.encode()).digest()  # v1 密钥，仅在读取旧文件时使用

def csrf_token(session_token):
    return SESSIONS.get(session_token, {}).get("csrf", "")

def derive_key(salt):
    """把口令拉伸成数据密钥。裸 SHA-256 单次迭代挡不住对 data.enc 的离线爆破；
    PBKDF2 只在启动时算一次，后续加解密复用内存中的结果。"""
    return hashlib.pbkdf2_hmac("sha256", ENV_DATA_KEY.encode(), salt, KDF_ITERATIONS)

def crypt(data, nonce, key):
    """SHA-256 计数器流异或。密钥流逐块生成，但异或用大整数一次完成：
    逐字节的 Python 循环在 17MB 上要花 1.6 秒，而 int 异或走 C 实现，
    输出与逐字节版本逐位相同（不影响已有文件）。"""
    n = len(data)
    if not n:
        return b""
    stream = b"".join(hashlib.sha256(key + nonce + (offset // 32).to_bytes(8, "big")).digest()
                      for offset in range(0, n, 32))
    return (int.from_bytes(data, "big") ^ int.from_bytes(stream[:n], "big")).to_bytes(n, "big")

def parse_container(raw):
    """拆开磁盘容器，返回 (salt, nonce, tag, cipher)；v1 布局的 salt 为 None。"""
    if raw.startswith(FILE_MAGIC_V2):
        body = raw[len(FILE_MAGIC_V2):]
        return body[:16], body[16:32], body[32:64], body[64:]
    return None, raw[:16], raw[16:48], raw[48:]

def load_data():
    global DATA_KEY, SALT
    if DATA_FILE.exists():
        raw = base64.b64decode(DATA_FILE.read_bytes())
        salt, nonce, tag, cipher = parse_container(raw)
        key = derive_key(salt) if salt is not None else DATA_KEY
        if not hmac.compare_digest(tag, hmac.new(key, nonce + cipher, hashlib.sha256).digest()):
            log.error("data file integrity check failed: %s", DATA_FILE)
            log.error("Refusing to start. Restore a backup of data.enc, or remove it to start fresh.")
            sys.exit(1)
        if salt is None:
            # 旧文件已经用 v1 密钥读出来了：换新 salt，下次保存自动升级成 v2。
            SALT = secrets.token_bytes(16)
            DATA_KEY = derive_key(SALT)
            log.info("legacy data file detected; it will be re-encrypted with PBKDF2 on the next save")
        else:
            SALT, DATA_KEY = salt, key
        return json.loads(crypt(cipher, nonce, key))
    SALT = secrets.token_bytes(16)
    DATA_KEY = derive_key(SALT)
    if LEGACY_DATA_FILE.exists():
        return json.loads(LEGACY_DATA_FILE.read_text())
    return {"keys": [], "nodes": {}}

try:
    DATA = load_data()
except SystemExit:
    raise
except Exception as exc:  # 磁盘损坏 / base64 或 JSON 解析失败
    log.error("failed to read %s: %s", DATA_FILE, exc)
    log.error("Refusing to start. Restore a backup of data.enc, or remove it to start fresh.")
    sys.exit(1)

DATA.setdefault("keys", [])
DATA.setdefault("blocked_nodes", [])
DATA.setdefault("settings", {})
DATA["revoked_keys"] = set(DATA.get("revoked_keys", []))
# migrate legacy entries (plain id strings) to dicts with metadata
DATA["blocked_nodes"] = [b if isinstance(b, dict) else {"id": str(b)} for b in DATA["blocked_nodes"]]

def blocked_ids():
    return {b.get("id") for b in DATA["blocked_nodes"]}

def admin_user():
    # UI-changed username (persisted) wins; the env var is the initial default
    return DATA["settings"].get("admin_user") or ADMIN_USER

def get_agent_script():
    global _AGENT_SCRIPT
    if _AGENT_SCRIPT is None:
        _AGENT_SCRIPT = (ROOT / "agent.sh").read_text(encoding="utf-8")
    return _AGENT_SCRIPT

def save_data(force=False):
    global _LAST_SAVE, _SAVE_DEBOUNCE
    now = time.time()
    if not force and now - _LAST_SAVE < _SAVE_DEBOUNCE:
        return
    _LAST_SAVE = now
    started = time.perf_counter()
    nonce = secrets.token_bytes(16)
    serializable = dict(DATA)
    serializable["revoked_keys"] = list(DATA["revoked_keys"])
    cipher = crypt(json.dumps(serializable, separators=(",", ":")).encode(), nonce, DATA_KEY)
    tag = hmac.new(DATA_KEY, nonce + cipher, hashlib.sha256).digest()
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_bytes(base64.b64encode(FILE_MAGIC_V2 + SALT + nonce + tag + cipher))
    os.chmod(tmp, 0o600)
    os.replace(tmp, DATA_FILE)  # atomic rename; a crash cannot corrupt data.enc
    # 自调节去抖：写盘全程持 LOCK，节点多/历史长时单次写盘可达秒级。
    # 让间隔跟随实测耗时，把写盘占用压到约 10% 时间以内。
    # 代价是崩溃时可能丢失更长的窗口（最多 SAVE_DEBOUNCE_MAX 秒），
    # 而节点每分钟就会重新上报一次，可以接受。
    _SAVE_DEBOUNCE = min(SAVE_DEBOUNCE_MAX,
                         max(SAVE_DEBOUNCE_MIN, (time.perf_counter() - started) * 10))

def flush_data():
    """收到 SIGTERM / 进程退出时，把去抖窗口内还没落盘的上报补写一次。"""
    try:
        save_data(force=True)
    except Exception:
        log.exception("failed to flush data on shutdown")

def prune_login_failures(now):
    """清理过期的登录失败记录并给表大小封顶（调用方需持有 LOCK）。
    只挂在登录请求上且全表扫描限频；否则伪造 X-Forwarded-For 的攻击者
    能给每个 IP 留一条记录，让这个字典无限增长。"""
    global _LAST_LOGIN_PRUNE
    if now - _LAST_LOGIN_PRUNE < LOGIN_PRUNE_INTERVAL:
        return
    _LAST_LOGIN_PRUNE = now
    for ip in [i for i, ts in LOGIN_FAILURES.items() if not ts or now - ts[-1] >= LOGIN_WINDOW]:
        LOGIN_FAILURES.pop(ip, None)
    overflow = len(LOGIN_FAILURES) - LOGIN_MAX_TRACKED_IPS
    if overflow > 0:
        for ip in list(LOGIN_FAILURES)[:overflow]:
            LOGIN_FAILURES.pop(ip, None)

def key_matches(candidate, keys):
    """常量时间比较 API Key，避免逐字节比较带来的时序泄漏。"""
    matched = False
    for k in keys:
        matched |= hmac.compare_digest(str(k.get("key", "")), str(candidate))
    return matched

def clamp_num(value, lo, hi):
    """把上报值强制成 [lo, hi] 内的有限浮点数，非法输入归零。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if v != v or v in (float("inf"), float("-inf")):  # NaN / ±inf
        return 0.0
    return min(max(v, lo), hi)

def sanitize_report(body):
    """按白名单重建上报内容。

    不能写成 {**old, **body}：持钥者可以塞任意键和任意大小的值，它们会留在
    节点记录里并被 history 复制 120 份，把内存和 data.enc 一起撑爆。
    """
    clean = {}
    for field, (lo, hi) in REPORT_FIELDS.items():
        if field in body:
            clean[field] = clamp_num(body[field], lo, hi)
    for field, limit, default in REPORT_STRINGS:
        raw = body.get(field, default)
        clean[field] = (default if raw is None else str(raw))[:limit]
    clean["hostname"] = clean["hostname"] or "unknown"
    # 国家码只保留字母，前端还有一次正则校验（双保险，避免拼进 innerHTML）
    clean["country"] = re.sub(r"[^A-Za-z]", "", str(body.get("country", "")))[:2].upper()
    # 列表型字段（按接口 / 多盘 / 块设备树）单独按白名单重建，不参与上面的字段循环
    clean["ifaces"] = sanitize_ifaces(body.get("ifaces"))
    clean["disks"] = sanitize_disks(body.get("disks"))
    clean["hdisks"] = sanitize_hdisks(body.get("hdisks"))
    return clean

def prune_sessions():
    now = time.time()
    with LOCK:
        for token in [t for t, s in SESSIONS.items() if s["expiry"] < now]:
            SESSIONS.pop(token, None)

def is_lossy(sample):
    """该采样点是否有运营商连接超时（-1）。0 表示未配置目标，不算丢包。"""
    return any(clamp_num(sample.get(k), -1.0, 1e6) < 0 for k in ("ct", "cu", "cm"))

def compact_ping_history(series, limit, keep_recent):
    """把全天 1 分钟粒度的序列压到 limit 个点。

    最近 keep_recent 个点原样保留（"最近 1 小时"要看细节），更早的部分等距抽样，
    但**优先保留出现超时的采样点** —— 否则一个 1 分钟的抖动会被抽样直接抹掉，
    而"什么时候抖过"恰恰是这张图存在的意义。
    """
    if limit <= 0 or len(series) <= limit:
        return series
    keep_recent = min(keep_recent, limit)
    cut = len(series) - keep_recent
    older, recent = series[:cut], series[cut:]
    budget = limit - keep_recent
    if budget <= 0:
        return recent
    lossy = [i for i, s in enumerate(older) if is_lossy(s)]
    clean = [i for i, s in enumerate(older) if not is_lossy(s)]
    picked = set()
    if len(lossy) > budget:
        # 超时点本身就超过预算，只能等距取
        picked.update(lossy[int(i * len(lossy) / budget)] for i in range(budget))
    else:
        picked.update(lossy)
        room = budget - len(lossy)
        if room > 0 and clean:
            picked.update(clean[int(i * len(clean) / room)] for i in range(room))
    return [older[i] for i in sorted(picked)] + recent

def compact_series(series, limit):
    """速率序列只需保留最近若干点（前端只画最近 30 个）。"""
    return series[-limit:] if limit > 0 else series

def slim_rate(sample):
    """列表页只画速率双曲线，别把 cpu/memory/disk/负载等字段一起下发。
    既省流量，也让列表接口的体积不随采样字段增加而增长。"""
    return {"time": sample.get("time", 0), "rx": sample.get("rx", 0),
            "tx": sample.get("tx", 0)}

def downsample_even(series, limit):
    """等距抽样到 limit 个点（详情页的负载曲线用）。"""
    n = len(series)
    if limit <= 0 or n <= limit:
        return series
    return [series[int(i * n / limit)] for i in range(limit)]

def trim_window(series, since, until=None):
    """取 [since, until) 内的样本；窗口内一个都没有时至少回退到窗口前的最后一个点，
    免得刚改区间就白屏。"""
    if not series:
        return []
    win = [s for s in series
           if (s.get("time") or 0) >= since and (until is None or (s.get("time") or 0) <= until)]
    return win if win else series[-1:]

def _sustained_events(samples, key, threshold, kind, label, events):
    """连续 EVENT_CONSECUTIVE 个采样越线才算一次事件。

    只在"刚越线"的那一刻报一条，恢复前不再重复，否则一天能刷出上千条。
    传入的必须是 1 分钟粒度的原始序列，否则"连续 N 分钟"会算错。
    """
    run, peak, start = 0, 0.0, 0
    for s in samples:
        v = clamp_num(s.get(key), -1e15, 1e15)
        if v >= threshold:
            if run == 0:
                start, peak = s.get("time", 0), v
            run += 1
            peak = max(peak, v)
            continue
        if run >= EVENT_CONSECUTIVE:
            events.append({"time": start, "level": "error" if peak >= 97 else "warn",
                           "kind": kind,
                           "text": f"{label}持续 {round(peak)}%"
                                   f"（≥{round(threshold)}%，连续 {run} 分钟）"})
        run = 0
    if run >= EVENT_CONSECUTIVE:
        events.append({"time": start, "level": "error" if peak >= 97 else "warn",
                       "kind": kind,
                       "text": f"{label}持续 {round(peak)}%"
                               f"（≥{round(threshold)}%，连续 {run} 分钟）"})
    return events

def derive_events(load_series, ping_series, thresholds):
    """从已存的时间序列按需派生事件日志——不落盘、不额外占存储。"""
    th = clean_thresholds(thresholds)
    events = []
    for key, kind, label in (("cpu", "cpu", "CPU 使用率"),
                             ("memory", "memory", "内存使用率"),
                             ("disk", "disk", "磁盘使用率"),
                             ("iowait", "iowait", "iowait")):
        _sustained_events(load_series, key, th[key], kind, label, events)

    # 上报缺口 = 这段时间节点没上报（离线/重启/网络中断）
    for prev, cur in zip(load_series, load_series[1:]):
        gap = (cur.get("time") or 0) - (prev.get("time") or 0)
        if gap > EVENT_OFFLINE_GAP:
            events.append({"time": prev.get("time", 0), "level": "info", "kind": "offline",
                           "text": f"节点离线约 {round(gap / 60)} 分钟"
                                   f"（{clock(prev.get('time'))} → {clock(cur.get('time'))}）"})

    for s in ping_series:
        t = s.get("time", 0)
        metrics = [(k, clamp_num(s.get(k), -1.0, 1e6)) for k in ("ct", "cu", "cm")]
        configured = [(k, v) for k, v in metrics if v != 0]
        if not configured:
            continue
        lost = [k for k, v in configured if v < 0]
        ratio = len(lost) / len(configured) * 100
        if lost:
            events.append({"time": t, "level": "warn", "kind": "ping_timeout",
                           "text": "/".join(CARRIER_NAMES.get(k, k) for k in lost) + " 连接超时"})
        if ratio >= th["loss"] and len(configured) > 1:
            events.append({"time": t, "level": "warn", "kind": "ping_loss",
                           "text": f"丢包率 {round(ratio)}%（≥{th['loss']}%）"})
        slow = [(k, v) for k, v in configured if v > th["ping_ms"]]
        if slow:
            worst = max(slow, key=lambda kv: kv[1])
            events.append({"time": t, "level": "warn", "kind": "ping_slow",
                           "text": f"{CARRIER_NAMES.get(worst[0], worst[0])} 延迟 {round(worst[1])}ms"
                                   f"（≥{th['ping_ms']}ms）"})

    events.sort(key=lambda e: e.get("time", 0), reverse=True)
    return events[:EVENT_MAX]

def clock(ts):
    return time.strftime("%m-%d %H:%M", time.localtime(clamp_num(ts, 0, 4e9)))

class App(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # 静态文件必须相对脚本目录解析：SimpleHTTPRequestHandler 默认用进程 CWD，
        # 而 DATA_DIR 默认用脚本目录；两者不一致时从别处启动服务会整站 404。
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass  # structured events go through the logger instead

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https://flagcdn.com https://cdn.jsdelivr.net data:; connect-src 'self'; frame-ancestors 'none'")
        if self.headers.get("X-Forwarded-Proto") == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        super().end_headers()

    def send_json(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    def send_empty(self, status=204):
        self.send_response(status); self.end_headers()

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length > MAX_BODY:
            return False  # sentinel: body too large (caller replies 413)
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            return None
        # 只接受 JSON 对象：数组/字符串/数字/布尔的 .get() 会抛未捕获的
        # AttributeError，未认证端点也能触发（连接被直接断开，且没有任何响应）。
        return body if isinstance(body, dict) else None

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
            if xff: return self._clean_forwarded(xff)
            xri = self.headers.get("X-Real-IP", "").strip()
            if xri: return self._clean_forwarded(xri)
        return self.client_address[0]

    def _clean_forwarded(self, value):
        # 头内容由客户端控制：丢掉非 IP 字符并限长，免得它变成任意写入节点记录的串。
        cleaned = re.sub(r"[^0-9A-Fa-f:.]", "", value)[:45]
        return cleaned or self.client_address[0]

    def is_admin(self):
        token = self.session_token()
        if not token: return False
        if len(SESSIONS) > 64:
            prune_sessions()  # 过期会话只在登录时清理的话会一直堆着
        with LOCK:
            s = SESSIONS.get(token)
            if not s: return False
            if s["expiry"] < time.time():
                SESSIONS.pop(token, None)
                return False
        return True

    def require_admin(self):
        if not self.is_admin(): self.send_json({"error": "login required"}, HTTPStatus.UNAUTHORIZED); return False
        # CSRF check for state-changing methods
        if self.command in ("POST", "DELETE"):
            csrf = self.headers.get("X-CSRF-Token", "")
            if not csrf or not hmac.compare_digest(csrf.encode(), csrf_token(self.session_token()).encode()):
                self.send_json({"error": "csrf token required"}, 403); return False
        return True

    def node_detail(self, node_id, query):
        """单节点详情：按时间窗裁剪 + 降采样。

        列表接口为了保持轻量只下发最近 60 个速率点 / 240 个延迟点；详情页要画
        一整天的曲线，所以单独开一个按节点按需拉取的接口，而不是把列表撑大。
        """
        if not NODE_ID_RE.fullmatch(node_id or ""):
            return self.send_json({"error": "not found"}, 404)
        try:
            window = int(query.get("range", ["3600"])[0])
        except (TypeError, ValueError):
            window = 3600
        window = min(max(window, DETAIL_MIN_RANGE), DETAIL_MAX_RANGE)
        # end = 窗口右端（unix 秒）。不传就是"贴着现在"，传了就能把时间轴往回拖。
        now = time.time()
        try:
            end = float(query.get("end", ["0"])[0]) or now
        except (TypeError, ValueError):
            end = now
        if end != end or end in (float("inf"), float("-inf")):   # NaN / ±inf
            end = now
        end = min(max(end, 0.0), now)                 # 不能看未来
        with LOCK:
            node = DATA["nodes"].get(node_id)
            if node is None:
                return self.send_json({"error": "node not found"}, 404)
            node = dict(node)
        since = end - window
        # 事件必须用**原始 1 分钟粒度**序列派生，"连续 N 分钟"才算得准；
        # 下发时再降采样。两者不要混，否则抽样后每个点代表好几分钟，措辞就错了。
        full_load = node.get("history", [])
        full_ping = node.get("ping_history", [])
        raw_load = trim_window(full_load, since, end)
        raw_ping = trim_window(full_ping, since, end)
        # 最早/最新样本，前端据此限制平移范围
        stamps = [s.get("time", 0) for s in full_load] + [s.get("time", 0) for s in full_ping]
        oldest = min(stamps) if stamps else 0
        newest = max(stamps) if stamps else end
        detail = {k: v for k, v in node.items() if k not in ("history", "ping_history", "ip", "hdisks")}
        # 硬件磁盘视图：由块设备树 + df 结果在读取时派生，不额外落盘
        detail["hardware_disks"] = build_hardware_disks(node.get("hdisks") or [], node.get("disks") or [])
        detail["online"] = now - node.get("updated", 0) < OFFLINE_SECONDS
        with LOCK:
            thresholds = clean_thresholds(DATA["settings"].get("thresholds"))
        return self.send_json({
            "node": detail,
            "range": window,
            "end": end,
            "oldest": oldest,
            "newest": newest,
            "thresholds": thresholds,
            "history": downsample_even(raw_load, DETAIL_POINTS),
            "ping_history": compact_ping_history(raw_ping, DETAIL_POINTS, DETAIL_KEEP_RECENT),
            "events": derive_events(raw_load, raw_ping, thresholds),
        })

    def do_GET(self):
        parsed, path = urlparse(self.path), urlparse(self.path).path
        if path == "/api/health":
            with LOCK:
                node_count = len(DATA["nodes"])
            return self.send_json({"ok": True, "nodes": node_count, "time": time.time()})
        if path == "/api/nodes":
            with LOCK:
                snapshot = list(DATA["nodes"].values())
            nodes = []
            for node in snapshot:
                n = dict(node)
                # 不对外下发 ip：服务端看到的对端地址不等于节点公网 IP（反代/NAT/多出口下
                # 都是错的），显示出去只会误导。原始值仍留在记录里，后台接口可见。
                n.pop("ip", None)
                # 多盘列表 / 块设备树只有详情页用得到，列表接口不下发（块设备树最多 64 条）
                n.pop("disks", None)
                n.pop("hdisks", None)
                n["online"] = time.time() - n.get("updated", 0) < OFFLINE_SECONDS
                # 只下发图表够用的点数：全量 1440 点 × 200 节点会把响应撑到十几 MB，
                # 而图表宽度只有几百像素。
                n["history"] = [slim_rate(s) for s in compact_series(n.get("history", []), API_RATE_POINTS)]
                n["ping_history"] = compact_ping_history(n.get("ping_history", []),
                                                         API_PING_POINTS, API_PING_KEEP_RECENT)
                nodes.append(n)
            return self.send_json({"nodes": sorted(nodes, key=lambda n: n.get("name", ""))})
        if path.startswith("/api/nodes/"):
            return self.node_detail(path[len("/api/nodes/"):], parse_qs(parsed.query))
        if path == "/api/admin/nodes":
            if self.require_admin():
                with LOCK:
                    # 管理列表只用于改名/改国家码，不画图表；带上历史只会白白撑大响应
                    nodes = [{k: v for k, v in node.items()
                              if k not in ("history", "ping_history")}
                             for node in DATA["nodes"].values()]
                self.send_json({"nodes": nodes})
            return
        if path == "/api/admin/keys":
            if self.require_admin():
                with LOCK:
                    keys = list(DATA["keys"])
                self.send_json({"keys": keys})
            return
        if path == "/api/admin/blocked":
            if self.require_admin():
                with LOCK:
                    blocked = list(DATA["blocked_nodes"])
                self.send_json({"blocked": blocked})
            return
        if path == "/api/admin/settings":
            if self.require_admin(): self.send_json({"admin_user": admin_user(),
                "csrf": csrf_token(self.session_token()),
                "thresholds": clean_thresholds(DATA["settings"].get("thresholds")),
                "threshold_meta": threshold_meta(),
                "ping_ct": DATA["settings"].get("ping_ct", ""), "ping_cu": DATA["settings"].get("ping_cu", ""), "ping_cm": DATA["settings"].get("ping_cm", "")})
            return
        if path == "/api/install.sh":
            if not self.require_admin(): return
            key = parse_qs(parsed.query).get("key", [""])[0]
            with LOCK:
                valid = key_matches(key, DATA["keys"])
            if not valid: return self.send_json({"error": "invalid key"}, 400)
            host = self.headers.get("Host", "")
            if not PUBLIC_URL and not HOST_RE.fullmatch(host):
                return self.send_json({"error": "invalid host header"}, 400)
            origin = PUBLIC_URL or f"http://{host}"
            s = DATA["settings"]
            def ph(k): return s.get(k, "")
            script = get_agent_script().replace("__SERVER__", origin).replace("__API_KEY__", key)\
                .replace("__PING_CT__", ph("ping_ct")).replace("__PING_CU__", ph("ping_cu")).replace("__PING_CM__", ph("ping_cm"))
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
            with LOCK:
                if token: SESSIONS.pop(token, None)
            self.send_response(200)
            self.send_header("Set-Cookie", "probe_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")
            self.end_headers()
            return self.wfile.write(b'{"ok":true}')
        body = self.read_json()
        if body is False:
            return self.send_json({"error": "request body too large"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        if body is None: return self.send_json({"error": "invalid request"}, 400)
        if path == "/api/login":
            ip = self.client_ip()
            now = time.time()
            with LOCK:
                prune_login_failures(now)
                fails = [t for t in LOGIN_FAILURES.get(ip, []) if now - t < LOGIN_WINDOW]
                if len(fails) >= LOGIN_MAX_FAILURES:
                    log.warning("login rate-limited for %s", ip)
                    return self.send_json({"error": "too many attempts, try again later"}, 429)
                username, password = str(body.get("username", "")), str(body.get("password", ""))
                # 两个比较都要算完（& 而不是 and），避免用户名错时整个跳过密码比较
                user_ok = hmac.compare_digest(username.encode(), admin_user().encode())
                pass_ok = hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode())
                if not (user_ok & pass_ok):
                    fails.append(now); LOGIN_FAILURES[ip] = fails
                    log.warning("login failed for user %r from %s", username, ip)
                    return self.send_json({"error": "invalid credentials"}, 401)
                LOGIN_FAILURES.pop(ip, None)
                prune_sessions()
                log.info("login ok for %r from %s", username, ip)
                token = secrets.token_urlsafe(32)
                csrf = secrets.token_urlsafe(32)
                SESSIONS[token] = {"expiry": now + SESSION_TTL, "csrf": csrf}
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            self.send_response(200)
            self.send_header("Set-Cookie", f"probe_session={token}; HttpOnly; SameSite=Strict; Path=/{secure}")
            self.end_headers()
            return self.wfile.write(json.dumps({"ok": True, "csrf": csrf}).encode())
        if path == "/api/report":
            key = self.headers.get("X-API-Key", "")
            with LOCK:
                if key in DATA["revoked_keys"]:
                    log.warning("report dropped: revoked key %s... from %s", key[:8], self.client_ip())
                    return self.send_empty()
                valid = key_matches(key, DATA["keys"])
            if not valid: return self.send_json({"error": "invalid key"}, 401)
            clean = sanitize_report(body)
            hostname = clean["hostname"]
            node_id = hashlib.sha256((key + hostname).encode()).hexdigest()[:16]
            if node_id in blocked_ids():
                log.info("report dropped: blocked node %s (%s) from %s", node_id, hostname, self.client_ip())
                return self.send_empty()
            ip = self.client_ip()
            with LOCK:
                old = DATA["nodes"].get(node_id, {})
                if not old and len(DATA["nodes"]) >= MAX_NODES:
                    # 持钥者可伪造任意 hostname 刷节点，必须设上限防止内存/数据文件膨胀
                    log.warning("node limit reached (%d); dropping new node %s from %s",
                                MAX_NODES, hostname, ip)
                    return self.send_json({"error": "node limit reached"}, 429)
                now = time.time()
                sample = {"time": now}
                for field, key in HISTORY_SAMPLE_FIELDS:
                    sample[key] = clean.get(field, 0)
                # 多盘总负载率入历史，才能画成时间曲线。
                # 老样本没有这个键，前端按同一条样本里的 disk（根盘）兜底。
                sample["disk_agg"] = aggregate_disk_pct(clean)
                history = (old.get("history", []) + [sample])[-LOAD_HISTORY_LIMIT:]
                ping_sample = {"time": now, "ct": clean.get("tcp_ping_ct", 0), "cu": clean.get("tcp_ping_cu", 0), "cm": clean.get("tcp_ping_cm", 0)}
                ping_history = (old.get("ping_history", []) + [ping_sample])[-PING_HISTORY_LIMIT:]
                # 管理员改过的名称/国家码优先于客户端上报
                edited = {field: old[field] for field in ("name", "country") if old.get(field)}
                # 整体重建而不是合并 old：顺手清掉旧版本可能残留的越界字段
                record = dict(clean)
                record.update(edited)
                record.update({"history": history, "ping_history": ping_history, "id": node_id,
                               "hostname": hostname, "ip": ip, "updated": now})
                DATA["nodes"][node_id] = record
                save_data()  # debounced; safe to skip writes under high report volume
            if not old:
                log.info("node %s (%s) first reported from %s", node_id, hostname, ip)
            return self.send_json({"ok": True, "id": node_id})
        if not self.require_admin(): return
        if path == "/api/admin/keys":
            item = {"id": secrets.token_hex(6), "label": str(body.get("label", "New key"))[:60], "key": "lp_" + secrets.token_urlsafe(24), "created": time.time()}
            with LOCK:
                DATA["keys"].append(item); save_data(force=True)
            log.info("api key %s created (label %r)", item["id"], item["label"])
            return self.send_json(item, 201)
        if path.startswith("/api/admin/keys/"):
            key_id = path[len("/api/admin/keys/"):]
            label = str(body.get("label", "")).strip()[:60]
            if not label: return self.send_json({"error": "label required"}, 400)
            with LOCK:
                for k in DATA["keys"]:
                    if k["id"] == key_id:
                        k["label"] = label
                        save_data(force=True)
                        log.info("api key %s label updated to %r", key_id, label)
                        return self.send_json(k)
            return self.send_json({"error": "key not found"}, 404)
        if path == "/api/admin/nodes":
            node_id = str(body.get("id") or "")
            with LOCK:
                node = DATA["nodes"].get(node_id)
                if node:
                    node["name"] = str(body.get("name", node.get("name", "")))[:60]
                    node["country"] = str(body.get("country", node.get("country", "")))[:2].upper()
                    save_data(force=True)
            if not node: return self.send_json({"error": "node not found"}, 404)
            return self.send_json(node)
        if path == "/api/admin/unblock":
            node_id = str(body.get("id", ""))
            with LOCK:
                before = len(DATA["blocked_nodes"])
                DATA["blocked_nodes"] = [b for b in DATA["blocked_nodes"] if b.get("id") != node_id]
                if len(DATA["blocked_nodes"]) < before:
                    save_data(force=True)
            if len(DATA["blocked_nodes"]) == before:
                return self.send_json({"error": "node not blocked"}, 404)
            log.info("node %s unblocked", node_id)
            return self.send_json({"ok": True})
        if path == "/api/admin/settings":
            if "admin_user" in body:
                name = str(body.get("admin_user", "")).strip()
                # 显式传空/超长用户名必须拒绝；不传该字段则视为部分更新（如只改 Ping 目标）
                if not (1 <= len(name) <= 60):
                    return self.send_json({"error": "username must be 1-60 chars"}, 400)
            for k in ("ping_ct", "ping_cu", "ping_cm"):
                if k in body and not valid_ping_target(str(body.get(k, "")).strip()):
                    return self.send_json(
                        {"error": f"{k} must be host:port (e.g. 1.1.1.1:80) or empty"}, 400)
            with LOCK:
                if "admin_user" in body: DATA["settings"]["admin_user"] = name
                for k in ("ping_ct", "ping_cu", "ping_cm"):
                    if k in body: DATA["settings"][k] = str(body.get(k, "")).strip()[:120]
                if "thresholds" in body:
                    # 只接受已知键，逐项夹到合法区间；非法项回落默认值
                    DATA["settings"]["thresholds"] = clean_thresholds(body.get("thresholds"))
                save_data(force=True)
            log.info("admin settings updated")
            return self.send_json({"ok": True, "admin_user": admin_user(),
                "thresholds": clean_thresholds(DATA["settings"].get("thresholds")),
                "threshold_meta": threshold_meta(),
                "ping_ct": DATA["settings"].get("ping_ct", ""), "ping_cu": DATA["settings"].get("ping_cu", ""), "ping_cm": DATA["settings"].get("ping_cm", "")})
        return self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not self.require_admin(): return
        if path.startswith("/api/admin/nodes/"):
            node_id = path[len("/api/admin/nodes/"):]
            with LOCK:
                if node_id not in DATA["nodes"]:
                    node = None
                else:
                    node = DATA["nodes"].pop(node_id)
                    if node_id not in blocked_ids():
                        DATA["blocked_nodes"].append({"id": node_id, "hostname": node.get("hostname", ""),
                                                      "name": node.get("name", ""), "time": time.time()})
                    save_data(force=True)
            if not node: return self.send_json({"error": "node not found"}, 404)
            log.info("node %s deleted and blocked", node_id)
            return self.send_json({"ok": True})
        if path.startswith("/api/admin/keys/"):
            key_id = path[len("/api/admin/keys/"):]
            with LOCK:
                removed = [x for x in DATA["keys"] if x["id"] == key_id]
                if removed:
                    DATA["keys"] = [x for x in DATA["keys"] if x["id"] != key_id]
                    for item in removed:
                        DATA["revoked_keys"].add(item["key"])
                    save_data(force=True)
            if not removed: return self.send_json({"error": "key not found"}, 404)
            log.info("api key %s revoked", key_id)
            return self.send_json({"ok": True})
        self.send_json({"error": "not found"}, 404)

if __name__ == "__main__":
    import atexit, signal

    port = int(os.getenv("PORT", "8080"))
    # 上报写盘有 5 秒去抖窗口；收到 SIGTERM（docker stop / systemctl stop）时必须
    # 补写一次，否则窗口内的样本会丢。
    atexit.register(flush_data)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log.info("pulse-probe listening on 0.0.0.0:%d", port)
    ThreadingHTTPServer(("0.0.0.0", port), App).serve_forever()
