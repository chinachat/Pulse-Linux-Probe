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
read -r total1 idle1 < <(awk '/^cpu / {printf "%.0f %.0f\n", $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)
sleep 1
read -r total2 idle2 < <(awk '/^cpu / {printf "%.0f %.0f\n", $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)
# 兜底：先校验数值再计算，避免 awk 异常值触发 bash 算术错误(它在 set -e 下会
# 直接终止脚本，`2>/dev/null || cpu=0` 抓不住解析期错误)。等距空值/非法值都归 0。
case "$total1$idle1$total2$idle2" in
  *[!0-9]*) cpu=0 ;;
  *) cpu=$(( total2 > total1 ? ((total2-total1)-(idle2-idle1))*100/(total2-total1) : 0 )) ;;
esac
mem=$(free | awk '/Mem:/ {print int($3*100/$2)}')
disk=$(df -P / | awk 'NR==2 {gsub("%","",$5);print $5}')
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
# Cache OS info (never changes)
os_cache=/var/lib/linux-probe-os
if test -f "$os_cache"; then
  os=$(cat "$os_cache")
else
  os=$( ( . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}" ) || true )
  os=${os//\"/}
  echo "$os" > "$os_cache"
fi
cpu_cores=$(nproc 2>/dev/null || grep -c processor /proc/cpuinfo 2>/dev/null || echo 0)
mem_total=$(awk '/MemTotal/ {printf "%.0f\n", $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
disk_total=$(df -P / | awk 'NR==2 {printf "%.0f\n", $2*1024}' 2>/dev/null || echo 0)
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
# 上报 JSON 由 printf 拼装：hostname / PRETTY_NAME 里若含 `"` 或 `\`，拼出来的
# JSON 就是非法的，服务端回 400，而 cron 把错误吞掉 —— 表现为节点静默不上线。
# 这里转义反斜杠和双引号，并去掉控制字符（含换行）。
json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s" | tr -d '[:cntrl:]'
}
printf '{"hostname":"%s","name":"%s","country":"%s","os":"%s","uptime":%s,"cpu":%s,"memory":%s,"disk":%s,"network_rx":%s,"network_tx":%s,"cpu_cores":%s,"mem_total":%s,"disk_total":%s,"tcp_ping_ct":%s,"tcp_ping_cu":%s,"tcp_ping_cm":%s,"net_total_rx":%s,"net_total_tx":%s}' "$(json_escape "$(hostname)")" "$(json_escape "$(hostname)")" "$country" "$(json_escape "$os")" "$up" "$cpu" "$mem" "$disk" "$net_rx" "$net_tx" "$cpu_cores" "$mem_total" "$disk_total" "$tcp_ping_ct" "$tcp_ping_cu" "$tcp_ping_cm" "$total_rx" "$total_tx"
EOF
chmod 755 /usr/local/bin/linux-probe-payload
report="$(/usr/local/bin/linux-probe-payload)"
curl -fsS --connect-timeout 10 --max-time 30 -X POST "$SERVER/api/report" -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d "$report" >/dev/null
# --max-time 必须加：没有它，服务端只接受连接却不返回时 curl 会一直挂着，
# 上一分钟的 cron 还没结束、下一分钟又起一个，进程会越堆越多。
line="* * * * * $(command -v curl) -fsS --max-time 30 -X POST $SERVER/api/report -H 'X-API-Key: $API_KEY' -H 'Content-Type: application/json' -d \"\$(/usr/local/bin/linux-probe-payload)\" >/dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v 'linux-probe-payload' || true; printf '%s\n' "$line") | crontab -
echo 'Linux Probe installed.'
