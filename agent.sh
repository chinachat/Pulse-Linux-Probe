#!/usr/bin/env bash
set -eu
SERVER="__SERVER__"
API_KEY="__API_KEY__"
# 安装脚本要写 /usr/local/bin、/var/lib 并改 root 的 crontab；非 root 会以一堆
# 难以理解的报错失败，这里提前给出明确提示。
if [ "$(id -u)" -ne 0 ]; then
  echo 'This installer must run as root (it writes /usr/local/bin, /var/lib and the root crontab).' >&2
  exit 1
fi
install -d /usr/local/bin
cat > /usr/local/bin/linux-probe-payload <<'EOF'
#!/usr/bin/env bash
# CPU: sample /proc/stat twice (1s apart) and compute the delta, so the value
# reflects current usage instead of the all-time average since boot.
# awk 默认 OFMT=%.6g：tick 累计值 ≥1e6 时会输出科学计数法（如 2.2179e+09），
# 直接进入 bash 算术会报 "invalid arithmetic operator"；而 %d 在 32 位 awk
# 上会把大数截断成错误值。%.0f 无整数强转、无科学计数法，2^53 内精确，全平台安全。
read -r total1 idle1 iow1 < <(awk '/^cpu / {printf "%.0f %.0f %.0f\n", $2+$3+$4+$5+$6+$7+$8, $5+$6, $6}' /proc/stat)
sleep 1
read -r total2 idle2 iow2 < <(awk '/^cpu / {printf "%.0f %.0f %.0f\n", $2+$3+$4+$5+$6+$7+$8, $5+$6, $6}' /proc/stat)
# 兜底：先校验数值再计算，避免 awk 异常值触发 bash 算术错误(它在 set -e 下会
# 直接终止脚本，`2>/dev/null || cpu=0` 抓不住解析期错误)。等距空值/非法值都归 0。
cpu=0; iowait=0
case "$total1$idle1$iow1$total2$idle2$iow2" in
  *[!0-9]*) ;;
  *)
    if test "$total2" -gt "$total1"; then
      cpu=$(( ((total2-total1)-(idle2-idle1))*100/(total2-total1) ))
      iowait=$(( (iow2-iow1)*100/(total2-total1) ))
      # 计数器回绕/热插拔时可能出现负数，夹回 0
      if test "$cpu" -lt 0; then cpu=0; fi
      if test "$iowait" -lt 0; then iowait=0; fi
    fi
    ;;
esac
mem=$(free | awk '/Mem:/ {print int($3*100/$2)}')
# 锚定 Capacity 列（形如 42%）而不是写死列号：设备名或挂载点里一旦有空格，列号会整体错位，
# 百分比会取到 Available 这类数字，容量也会算成 0。df -P 的列序固定为
# Filesystem / total / used / avail / Capacity / Mounted-on，所以 Capacity 往前数第 3 列是 total。
disk=$(df -P / 2>/dev/null | awk 'NR>1 {for(i=2;i<=NF;i++) if($i ~ /^[0-9]+%$/){sub(/%/,"",$i); print $i; exit}}')
now=$(date +%s)
state=/var/lib/linux-probe-network
install -d /var/lib
read -r net_rx net_tx total_rx total_tx <<EOF_NET
$(awk -v now="$now" -v state="$state" '
  BEGIN { if ((getline < state) == 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/) { old_rx=$1; old_tx=$2; old_now=$3 } }
  NR > 2 && $1 != "lo:" { rx += $2; tx += $10 }
  END {
    elapsed = now - old_now; if (elapsed < 1) elapsed = 1
    if (!old_now) { old_rx = rx; old_tx = tx }
    drx = rx - old_rx; if (drx < 0) drx = 0
    dtx = tx - old_tx; if (dtx < 0) dtx = 0
    printf "%.0f %.0f %.0f %.0f\n", drx/elapsed, dtx/elapsed, rx, tx
    printf "%.0f %.0f %s\n", rx, tx, now > state
  }
' /proc/net/dev)
EOF_NET
up=$(cut -d. -f1 /proc/uptime)
# Cache country lookup (daily refresh to avoid rate limiting)
country_cache=/var/lib/linux-probe-country
now=$(date +%s)
country=""
if test -f "$country_cache"; then
  mtime=$(stat -c %Y "$country_cache" 2>/dev/null || echo 0)
  if test "$(( now - mtime ))" -lt 86400; then
    country=$(cat "$country_cache")
  fi
fi
if test -z "$country"; then
  country=$(curl -fsS --connect-timeout 3 https://ipapi.co/country/ 2>/dev/null | tr -cd 'A-Za-z' | head -c 2 || true)
  echo "$country" > "$country_cache"
fi
# Cache OS info (never changes)。缓存里现在有 4 行（全名/版本号/代号/发行版 ID），
# 旧版本只写 1 行，所以用行数判断而不是"文件存在与否"，否则版本号会永远空着。
os_cache=/var/lib/linux-probe-os
os=""; os_version_id=""; os_codename=""; os_id=""
if test -f "$os_cache" && test "$(wc -l < "$os_cache" 2>/dev/null || echo 0)" -ge 4; then
  { read -r os; read -r os_version_id; read -r os_codename; read -r os_id; } < "$os_cache" || true
else
  # 只落一次 os-release，避免 4 次 subshell；%s 逐行输出，read 逐行取
  { read -r os; read -r os_version_id; read -r os_codename; read -r os_id; } <<EOF_OS
$( ( . /etc/os-release 2>/dev/null; printf '%s\n%s\n%s\n%s\n' \
      "${PRETTY_NAME:-}" "${VERSION_ID:-}" "${VERSION_CODENAME:-}" "${ID:-}" ) || true )
EOF_OS
  printf '%s\n%s\n%s\n%s\n' "$os" "$os_version_id" "$os_codename" "$os_id" > "$os_cache"
fi
cpu_cores=$(nproc 2>/dev/null || grep -c processor /proc/cpuinfo 2>/dev/null || echo 0)
mem_total=$(awk '/MemTotal/ {printf "%.0f\n", $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
disk_total=$(df -P / 2>/dev/null | awk 'NR>1 {for(i=2;i<=NF;i++) if($i ~ /^[0-9]+%$/){printf "%.0f\n", $(i-3)*1024; exit}}' 2>/dev/null || echo 0)

# ---------- 规格信息（型号/内核/架构/虚拟化等，均为可选字段） ----------
# 型号、内核、架构不会变：缓存到 /var/lib，避免每分钟重新解析 /proc/cpuinfo
cpu_cache_file=/var/lib/linux-probe-cpuinfo
cpu_model=""; cpu_cache=""; arch=""; kernel=""; kernel_full=""
if test -f "$cpu_cache_file" && test "$(wc -l < "$cpu_cache_file" 2>/dev/null || echo 0)" -ge 5; then
  { read -r cpu_model; read -r cpu_cache; read -r arch; read -r kernel; read -r kernel_full; } < "$cpu_cache_file" || true
else
  # 优先级 model name(x86) > Hardware(ARM SBC) > Model(树莓派) > Processor(通用 ARM)。
  # 必须按优先级挑，不能靠"文件里谁先出现"——ARM 的 Processor 行在最前面，会盖住更有用的 Hardware。
  cpu_model=$(awk '
    /^model name[ \t]*:/ { v=$0; sub(/^[^:]*:[ \t]*/, "", v); m=v }
    /^Hardware[ \t]*:/   { v=$0; sub(/^[^:]*:[ \t]*/, "", v); if (h=="") h=v }
    /^Model[ \t]*:/      { v=$0; sub(/^[^:]*:[ \t]*/, "", v); if (d=="") d=v }
    /^Processor[ \t]*:/  { v=$0; sub(/^[^:]*:[ \t]*/, "", v); if (p=="") p=v }
    END { x = (m!="" ? m : (h!="" ? h : (d!="" ? d : p))); gsub(/[ \t]+$/, "", x); print x }
  ' /proc/cpuinfo 2>/dev/null || true)
  # cache size 只有 x86 的 /proc/cpuinfo 有，ARM 一般取不到
  cpu_cache=$(awk '/^cache size[ \t]*:/ { v=$0; sub(/^[^:]*:[ \t]*/, "", v); print v; exit }' /proc/cpuinfo 2>/dev/null || true)
  arch=$(uname -m 2>/dev/null || true)
  kernel=$(uname -r 2>/dev/null || true)
  kernel_full=$(uname -srmo 2>/dev/null || true)
  printf '%s\n%s\n%s\n%s\n%s\n' "$cpu_model" "$cpu_cache" "$arch" "$kernel" "$kernel_full" > "$cpu_cache_file"
fi
# 当前主频是动态值，每次都重新取
cpu_mhz=$(awk '/^cpu MHz/ {s+=$4; n++} END { if (n) printf "%.0f", s/n }' /proc/cpuinfo 2>/dev/null || true)
if test -z "${cpu_mhz:-}"; then
  # ARM 等平台没有 cpu MHz：从 cpufreq 读，单位 kHz
  cpu_mhz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || true)
  case "${cpu_mhz:-}" in
    ''|*[!0-9]*) cpu_mhz=0 ;;
    *) cpu_mhz=$(( cpu_mhz / 1000 )) ;;
  esac
fi
case "${cpu_mhz:-}" in ''|*[!0-9]*) cpu_mhz=0 ;; esac

# 负载均值 / 运行实体数 / 线程总数 都来自 /proc/loadavg 的第 4 段 "running/total"
load1=0; load5=0; load15=0; running=0; threads=0
read -r load1 load5 load15 running threads < <(awk '{split($4,a,"/"); print $1, $2, $3, a[1]+0, a[2]+0}' /proc/loadavg 2>/dev/null) || true
# 注意：loadavg 分母是内核调度实体（≈线程）数，不是进程数，所以进程数单独数 /proc 数字目录
procs=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)

# 内存明细取自 /proc/meminfo（比 free 多出 buffers/cached/available）
mem_cached=0; mem_buffers=0; mem_available=0; swap_total=0; swap_used=0
read -r mem_cached mem_buffers mem_available swap_total swap_used < <(awk '
  /^MemAvailable:/ { ma=$2*1024 }
  /^Buffers:/      { mb=$2*1024 }
  /^Cached:/       { mc=$2*1024 }
  /^SwapTotal:/    { st=$2*1024 }
  /^SwapFree:/     { sf=$2*1024 }
  END { printf "%.0f %.0f %.0f %.0f %.0f\n", mc+mb, mb, ma, st, st-sf }
' /proc/meminfo 2>/dev/null) || true

# 网卡错误/丢包累计计数（排除 lo）
net_err=0; net_drop=0
read -r net_err net_drop < <(awk 'FNR>2 && $1!="lo:" { e+=$4+$12; d+=$5+$13 } END { printf "%.0f %.0f\n", e, d }' /proc/net/dev 2>/dev/null) || true

# 虚拟化类型：只有 CPU 暴露 hypervisor 标志时才判断，容器里通常也带该标志
virt=""
if grep -qw hypervisor /proc/cpuinfo 2>/dev/null; then
  if command -v systemd-detect-virt >/dev/null 2>&1; then
    virt=$(systemd-detect-virt 2>/dev/null || true)
    if test "$virt" = "none"; then virt=""; fi
  fi
  if test -z "$virt"; then virt="virtualized"; fi
fi

# 已建立的 TCP 连接数（/proc/net/tcp[6] 中状态 01 = ESTABLISHED）
tcp_conn=$(awk 'FNR>1 && $4=="01" {n++} END {print n+0}' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)
# TCP pings: 目标仅接受 host:port（字母/数字/点/冒号/连字符）。
# 双重防线：即使服务端下发的目标被篡改，这里也会拒绝执行任何其它字符。
do_ping() {
  local t="${1:-}" h p s t1
  case "$t" in
    ''|*[!A-Za-z0-9.:-]*|*::*) echo 0; return ;;
    *:*) ;;
    *) echo 0; return ;;
  esac
  h=${t%%:*}; p=${t##*:}
  case "$p" in ''|*[!0-9]*) echo 0; return ;; esac
  test "$p" -ge 1 && test "$p" -le 65535 || { echo 0; return; }
  # busybox 等非 GNU date 不支持 %N 时退化为秒级精度
  s=$(date +%s%N 2>/dev/null || true); case "$s" in *%N*) s=$(date +%s)000000000 ;; esac
  # 单引号 + 位置参数：h/p 经白名单校验后才展开，杜绝命令注入
  if timeout 3 bash -c 'exec 3<>/dev/tcp/"$1"/"$2" 2>/dev/null; exec 3>&-' _ "$h" "$p" 2>/dev/null; then
    t1=$(date +%s%N 2>/dev/null || true); case "$t1" in *%N*) t1=$(date +%s)000000000 ;; esac
    echo $(( (t1 - s) / 1000000 ))
  else
    echo -1
  fi
}
# 调用点必须用单引号包裹：单引号内 `"`/`$(...)` 均为字面，即使服务端下发的
# 目标被篡改（含引号闭合式注入），载荷也会整体成为 do_ping 的参数并被白名单拒绝。
tcp_ping_ct=$(do_ping '__PING_CT__')
tcp_ping_cu=$(do_ping '__PING_CU__')
tcp_ping_cm=$(do_ping '__PING_CM__')
# 上报 JSON 由字段驱动拼装：字段已经四十来个，位置参数写法一旦错位没人能发现。
# json_escape 转义反斜杠和双引号，并去掉控制字符（含换行）——hostname / PRETTY_NAME
# 里出现 `"` 或 `\` 会拼出非法 JSON，服务端回 400 而 cron 把错误吞掉，表现为节点静默不上线。
json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s" | tr -d '[:cntrl:]'
}
_fields=""
add_str() {
  if test -n "$_fields"; then _fields="$_fields,"; fi
  _fields="$_fields\"$1\":\"$(json_escape "${2:-}")\""
}
# 数值字段统一走这里：非数值（空串、取不到、含意外字符）一律写 0，
# 绝不让非法 token 进入 JSON。
add_num() {
  case "${2:-}" in
    ''|*[!0-9.-]*) _fields="${_fields:+$_fields,}\"$1\":0" ;;
    *) _fields="${_fields:+$_fields,}\"$1\":$2" ;;
  esac
}
add_str hostname "$(hostname)"
add_str name "$(hostname)"
add_str country "$country"
add_str os "$os"
add_str os_version_id "$os_version_id"
add_str os_codename "$os_codename"
add_str os_id "$os_id"
add_str kernel "$kernel"
add_str kernel_full "$kernel_full"
add_str arch "$arch"
add_str cpu_model "$cpu_model"
add_str cpu_cache "$cpu_cache"
add_str virt "$virt"
add_num uptime "$up"
add_num cpu "$cpu"
add_num iowait "$iowait"
add_num memory "$mem"
add_num disk "$disk"
add_num network_rx "$net_rx"
add_num network_tx "$net_tx"
add_num cpu_cores "$cpu_cores"
add_num cpu_mhz "$cpu_mhz"
add_num mem_total "$mem_total"
add_num mem_cached "$mem_cached"
add_num mem_buffers "$mem_buffers"
add_num mem_available "$mem_available"
add_num swap_total "$swap_total"
add_num swap_used "$swap_used"
add_num disk_total "$disk_total"
add_num load1 "$load1"
add_num load5 "$load5"
add_num load15 "$load15"
add_num procs "$procs"
add_num threads "$threads"
add_num running "$running"
add_num tcp_conn "$tcp_conn"
add_num net_err "$net_err"
add_num net_drop "$net_drop"
add_num tcp_ping_ct "$tcp_ping_ct"
add_num tcp_ping_cu "$tcp_ping_cu"
add_num tcp_ping_cm "$tcp_ping_cm"
add_num net_total_rx "$total_rx"
add_num net_total_tx "$total_tx"
# 按接口快照（当前值，不进历史）：只取非 lo、按累计收包降序的前 8 个。
# 用 while+进程替换而不是管道，否则子 shell 里累加的 _ifaces 会丢。
num_or_zero() {
  case "${1:-}" in ''|*[!0-9.-]*) echo 0 ;; *) echo "$1" ;; esac
}
_ifaces=""
add_iface() {
  local n rx tx er dr
  n=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._:@-')
  test -n "$n" || return 0
  rx=$(num_or_zero "$2"); tx=$(num_or_zero "$3")
  er=$(num_or_zero "$4"); dr=$(num_or_zero "$5")
  _ifaces="${_ifaces:+$_ifaces,}{\"name\":\"$n\",\"rx\":$rx,\"tx\":$tx,\"err\":$er,\"drop\":$dr}"
}
while read -r _ifn _ifrx _iftx _iferr _ifdrop; do
  add_iface "$_ifn" "$_ifrx" "$_iftx" "$_iferr" "$_ifdrop"
done < <(awk 'FNR>2 && $1!="lo:" { n=$1; sub(/:$/,"",n); printf "%s %.0f %.0f %.0f %.0f\n", n, $2, $10, $4+$12, $5+$13 }' /proc/net/dev 2>/dev/null | sort -k2 -nr | head -n 8) || true
_fields="${_fields:+$_fields,}\"ifaces\":[${_ifaces}]"
# 多盘用量快照（只存当前值，不进历史；曲线与"磁盘使用率"告警阈值仍只针对根盘 /）。
# -l 只列本地文件系统：NFS/CIFS 对端无响应时 df 会长时间阻塞，而这是每分钟一次的 cron，
# 卡住就会像没有 --max-time 的 curl 一样把进程堆起来；外面再套 timeout 双保险。
# 极简系统（busybox df 等）不支持 -l 时会拿到空结果，这里退回不带 -l 再试一次，仍然有 timeout 兜底，
# 并在 awk 里把网络文件系统（host:/export、//server/share）滤掉。
# 伪文件系统与快照设备排除；同一设备只留第一次（bind mount 会重复出现）；按容量取前 8。
disks_raw=$(timeout 5 df -P -l 2>/dev/null) || disks_raw=""
# 退回不带 -l 时，df 不会替我们排除网络文件系统，得自己滤（见下面的 netfilter）。
# 注意不能在 -l 生效时也按"设备名含冒号"过滤：那只在退回路径下才成立，
# 正常路径下误伤面更大。
netfilter=0
if test -z "$disks_raw"; then
  disks_raw=$(timeout 5 df -P 2>/dev/null) || disks_raw=""
  netfilter=1
fi
disks_parsed=$(printf '%s\n' "$disks_raw" | awk -v netfilter="$netfilter" '
  NR > 1 {
    cap = 0
    for (i = 2; i <= NF; i++) if ($i ~ /^[0-9]+%$/) { cap = i; break }
    if (cap < 4) next
    total = $(cap - 3); used = $(cap - 2)
    if (total !~ /^[0-9]+$/ || used !~ /^[0-9]+$/) next
    pct = $cap; gsub(/%/, "", pct)
    dev = $1; for (i = 2; i <= cap - 4; i++) dev = dev " " $i
    if (dev ~ /^(tmpfs|devtmpfs|overlay|squashfs|none|udev|ramfs|efivarfs|cgroup|proc|sysfs|autofs)$/) next
    if (dev ~ /^\/dev\/loop/) next
    if (netfilter && (dev ~ /:/ || dev ~ /^\/\//)) next     # host:/export、//server/share
    if (seen[dev]++) next
    mnt = $(cap + 1)
    for (i = cap + 2; i <= NF; i++) mnt = mnt " " $i
    if (mnt == "") next
    gsub(/\|/, "", mnt)                                     # | 是下面的字段分隔符，挂载点里不能留
    printf "%s|%.0f|%.0f|%s\n", mnt, total * 1024, used * 1024, pct
  }' 2>/dev/null | sort -t'|' -k2 -nr | head -n 8)
_disks=""
add_disk() {
  local m
  m=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._:/@ +-')
  test -n "$m" || return 0
  _disks="${_disks:+$_disks,}{\"mount\":\"$(json_escape "$m")\",\"total\":$(num_or_zero "$2"),\"used\":$(num_or_zero "$3"),\"pct\":$(num_or_zero "$4")}"
}
while IFS='|' read -r _dm _dt _du _dp; do
  add_disk "$_dm" "$_dt" "$_du" "$_dp"
done <<EOF_DISKS
$disks_parsed
EOF_DISKS
_fields="${_fields:+$_fields,}\"disks\":[${_disks}]"
# 硬件磁盘（块设备树）。df 只给"已挂载的文件系统"，看不出它落在哪块盘上 ——
# 一块盘可能被拆成多个分区，也可能被 LVM / RAID / dm-crypt 盖住，df 里只看得见逻辑卷或阵列。
# lsblk 能给出父子关系，服务端据此把文件系统归回物理盘。lsblk 缺失（极简系统）时留空，
# 前端会退回"只显示文件系统"的视图。
# -b 让 SIZE 直接是字节，省得再解析 K/M/G/T 单位；-P 输出 KEY="value" 形式，好解析。
# 不按 name 去重：lsblk 会把多父设备（RAID 阵列）在每个成员下各列一次，
# 这个重复正是"这块盘属于某个阵列"的唯一线索。
hdisks_raw=$(timeout 5 lsblk -b -P -o NAME,TYPE,SIZE,MOUNTPOINT,PKNAME,MODEL,ROTA 2>/dev/null) || hdisks_raw=""
_hdisks=""
add_hdisk() {
  local n t mo pn
  n=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._:-')
  t=$(printf '%s' "$2" | tr -cd 'A-Za-z0-9')
  test -n "$n" || return 0
  test -n "$t" || return 0
  mo=$(printf '%s' "$6" | tr -cd 'A-Za-z0-9 ._+()/-')
  pn=$(printf '%s' "$5" | tr -cd 'A-Za-z0-9._:-')
  _hdisks="${_hdisks:+$_hdisks,}{\"name\":\"$(json_escape "$n")\",\"type\":\"$(json_escape "$t")\""
  _hdisks="${_hdisks},\"size\":$(num_or_zero "$3"),\"mount\":\"$(json_escape "$4")\""
  _hdisks="${_hdisks},\"parent\":\"$(json_escape "$pn")\",\"model\":\"$(json_escape "$mo")\",\"rota\":$(num_or_zero "$7")}"
}
while IFS='|' read -r _hn _ht _hs _hm _hp _hmo _hr; do
  add_hdisk "$_hn" "$_ht" "$_hs" "$_hm" "$_hp" "$_hmo" "$_hr"
done <<EOF_HDISKS
$(printf '%s\n' "$hdisks_raw" | awk '
  {
    line = $0
    while (match(line, /[A-Z]+="[^"]*"/)) {
      kv = substr(line, RSTART, RLENGTH)
      line = substr(line, RSTART + RLENGTH)
      k = kv; sub(/=.*/, "", k)
      v = kv; sub(/^[^=]*="/, "", v); sub(/"$/, "", v)
      val[k] = v
    }
    if (val["NAME"] != "") {
      mnt = val["MOUNTPOINT"]; gsub(/\|/, "", mnt)      # | 是下面的字段分隔符
      printf "%s|%s|%s|%s|%s|%s|%s\n", val["NAME"], val["TYPE"], val["SIZE"], mnt, val["PKNAME"], val["MODEL"], val["ROTA"]
    }
    delete val
  }' 2>/dev/null | head -n 64)
EOF_HDISKS
_fields="${_fields:+$_fields,}\"hdisks\":[${_hdisks}]"
printf '{%s}' "$_fields"
EOF
chmod 755 /usr/local/bin/linux-probe-payload
report="$(/usr/local/bin/linux-probe-payload)"
curl -fsS --connect-timeout 10 --max-time 30 -X POST "$SERVER/api/report" -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d "$report" >/dev/null
# --max-time 必须加：没有它，服务端只接受连接却不返回时 curl 会一直挂着，
# 上一分钟的 cron 还没结束、下一分钟又起一个，进程会越堆越多。
line="* * * * * $(command -v curl) -fsS --max-time 30 -X POST $SERVER/api/report -H 'X-API-Key: $API_KEY' -H 'Content-Type: application/json' -d \"\$(/usr/local/bin/linux-probe-payload)\" >/dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v 'linux-probe-payload' || true; printf '%s\n' "$line") | crontab -
echo 'Linux Probe installed.'
