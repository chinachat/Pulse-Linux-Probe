#!/usr/bin/env bash
set -eu
SERVER="__SERVER__"
API_KEY="__API_KEY__"
install -d /usr/local/bin
cat > /usr/local/bin/linux-probe-payload <<'EOF'
#!/usr/bin/env bash
# CPU: sample /proc/stat twice (1s apart) and compute the delta, so the value
# reflects current usage instead of the all-time average since boot.
read -r total1 idle1 < <(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)
sleep 1
read -r total2 idle2 < <(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat)
cpu=$(( total2 > total1 ? ((total2-total1)-(idle2-idle1))*100/(total2-total1) : 0 ))
mem=$(free | awk '/Mem:/ {print int($3*100/$2)}')
disk=$(df -P / | awk 'NR==2 {gsub("%","",$5);print $5}')
now=$(date +%s)
state=/var/lib/linux-probe-network
install -d /var/lib
read -r net_rx net_tx <<EOF_NET
$(awk -v now="$now" -v state="$state" '
  BEGIN { if ((getline < state) == 1 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/) { old_rx=$1; old_tx=$2; old_now=$3 } }
  NR > 2 && $1 != "lo:" { rx += $2; tx += $10 }
  END {
    elapsed = now - old_now; if (elapsed < 1) elapsed = 1
    if (!old_now) { old_rx = rx; old_tx = tx }
    drx = rx - old_rx; if (drx < 0) drx = 0
    dtx = tx - old_tx; if (dtx < 0) dtx = 0
    printf "%.0f %.0f\n", drx/elapsed, dtx/elapsed
    printf "%.0f %.0f %s\n", rx, tx, now > state
  }
' /proc/net/dev)
EOF_NET
up=$(cut -d. -f1 /proc/uptime)
country=$(curl -fsS --connect-timeout 3 https://ipapi.co/country/ 2>/dev/null | tr -cd 'A-Za-z' | head -c 2 || true)
os=$( ( . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-}" ) || true )
os=${os//\"/}
printf '{"hostname":"%s","name":"%s","country":"%s","os":"%s","uptime":%s,"cpu":%s,"memory":%s,"disk":%s,"network_rx":%s,"network_tx":%s}' "$(hostname)" "$(hostname)" "$country" "$os" "$up" "$cpu" "$mem" "$disk" "$net_rx" "$net_tx"
EOF
chmod 755 /usr/local/bin/linux-probe-payload
report="$(/usr/local/bin/linux-probe-payload)"
curl -fsS --connect-timeout 10 -X POST "$SERVER/api/report" -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d "$report" >/dev/null
line="* * * * * $(command -v curl) -fsS -X POST $SERVER/api/report -H 'X-API-Key: $API_KEY' -H 'Content-Type: application/json' -d \"\$(/usr/local/bin/linux-probe-payload)\" >/dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v 'linux-probe-payload' || true; printf '%s\n' "$line") | crontab -
echo 'Linux Probe installed.'
