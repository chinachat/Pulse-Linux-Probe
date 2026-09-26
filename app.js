/* Pulse Linux Probe — 前端逻辑
   零依赖原生 JS；遵守 CSP：script-src 'self'（无内联脚本/事件处理器） */
const $ = s => document.querySelector(s);
let _csrf = '';

/* ---------- 视图状态：地区筛选 + 延迟图表区间 ---------- */
const REGION_ALL = '__all__';   // 表示"不筛选"的哨兵值，不会与真实国家码冲突
let _region = REGION_ALL;
let _pingRange = 3600;          // 秒；默认只看最近 1 小时
const PING_RANGE_LABELS = { 3600: '最近 1 小时', 21600: '最近 6 小时', 43200: '最近 12 小时', 86400: '最近 24 小时' };

/* ---------- 主题：localStorage 记忆，覆盖 HTML 初始深色 ---------- */
function syncThemeBtn() {
  const b = $('#theme');
  if (b) b.textContent = document.body.classList.contains('dark') ? '浅色' : '深色';
}
(function initTheme() {
  try {
    const saved = localStorage.getItem('probe-theme');
    if (saved === 'light') document.body.classList.remove('dark');
    else if (saved === 'dark') document.body.classList.add('dark');
  } catch (_) { /* localStorage 不可用则保持默认 */ }
  syncThemeBtn();
})();

/* ---------- API 封装 ---------- */
const api = (u, o = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(o.headers || {}) };
  if (_csrf) headers['X-CSRF-Token'] = _csrf;
  return fetch(u, { headers, ...o }).then(async r => {
    let b = {};
    try { b = await r.json(); } catch (_) { /* non-json body */ }
    if (!r.ok) throw Error(b.error || 'HTTP ' + r.status);
    return b;
  });
};

/* ---------- 格式化工具 ---------- */
function countryFlag(code) {
  const cc = (code || '').toUpperCase();
  return /^[A-Z]{2}$/.test(cc)
    ? `<img src="https://flagcdn.com/w40/${cc.toLowerCase()}.png" width="20" height="15" alt="${cc}" loading="lazy"> ${cc}`
    : '未知';
}
function mbpsNum(value) {
  const n = (Number(value) || 0) * 8 / 1e6; // bytes/s -> megabits/s
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}
function mbps(value) { return mbpsNum(value) + ' Mbps'; }
function duration(s) {
  s = Number(s) || 0;
  if (s >= 86400) return Math.floor(s / 86400) + '天 ' + Math.floor(s % 86400 / 3600) + '小时';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return `${h}小时 ${m}分`;
}
function bytesTotal(rx, tx) {
  if (!rx && !tx) return '';
  const f = v => { v = Number(v) || 0; return v >= 1e12 ? (v / 1e12).toFixed(1) + 'TB' : v >= 1e9 ? (v / 1e9).toFixed(1) + 'GB' : (v / 1e6).toFixed(1) + 'MB'; };
  return f(rx) + ' ↓ / ' + f(tx) + ' ↑';
}
/* 容量按 1024 进制显示，与 free -h / df -h 一致（16 GiB 内存显示 16.0 GB，
   而不是十进制的 17.2 GB）。流量累计走 decimal 的 bytesTotal()（网络惯例）。 */
function bytes(v) {
  v = Number(v) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(1) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  return (v / 1024).toFixed(0) + ' KB';
}
/* hex 颜色转 rgba（用于 canvas 渐变） */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------- OS 图标（span + CSS mask，颜色随 currentColor 与文字同步） ---------- */
function osIcon(os) {
  const s = (os || '').toLowerCase();
  let cls = 'other', label = 'Linux';
  if (s.includes('debian')) { cls = 'debian'; label = 'Debian'; }
  else if (s.includes('ubuntu')) { cls = 'ubuntu'; label = 'Ubuntu'; }
  else if (s.includes('centos')) { cls = 'centos'; label = 'CentOS'; }
  else if (s.includes('rocky')) { cls = 'rocky'; label = 'Rocky'; }
  else if (s.includes('alma')) { cls = 'alma'; label = 'Alma'; }
  else if (s.includes('rhel') || s.includes('redhat')) { cls = 'redhat'; label = 'RHEL'; }
  else if (s.includes('fedora')) { cls = 'fedora'; label = 'Fedora'; }
  else if (s.includes('arch')) { cls = 'arch'; label = 'Arch'; }
  else if (s.includes('alpine')) { cls = 'alpine'; label = 'Alpine'; }
  else if (s.includes('opensuse') || s.includes('suse')) { cls = 'suse'; label = 'openSUSE'; }
  const m = os.match(/\d+/);
  const ver = m ? ' ' + m[0] : '';
  return `<span class="os-tag ${cls}"><span class="os-svg" aria-hidden="true"></span><b>${label}</b>${ver}</span>`;
}

/* ---------- Ping 历史图（SVG 折线 + 面积渐变 + 端点） ---------- */
let _uid = 0;

/* 时间轴定位。服务端为兼顾"1 天"和"1 小时"两种尺度，下发的采样点疏密不均
   （最近 60 个是 1 分钟粒度，更早的是抽样点），所以横坐标必须按真实时间算，
   不能按序号等距——否则图上的"斜线"其实只是采样密度变化。 */
function xPositions(samples, w) {
  const n = samples.length;
  if (n < 2) return [w / 2];
  const t0 = Number(samples[0].time) || 0;
  const t1 = Number(samples[n - 1].time) || 0;
  if (t1 > t0) return samples.map(s => (Number(s.time) - t0) / (t1 - t0) * w);
  return samples.map((_, i) => i * w / (n - 1));
}

/* 单个采样点的丢包比例（0~1）。0 表示该运营商未配置目标，不计入分母。 */
function sampleLoss(sample) {
  let lost = 0, total = 0;
  ['ct', 'cu', 'cm'].forEach(k => {
    const v = Number(sample[k]) || 0;
    if (v < 0) { lost++; total++; } else if (v > 0) total++;
  });
  return total ? lost / total : 0;
}

/* 区间内的真实丢包率：失败探测数 / 总探测数 */
function lossStats(samples) {
  let lost = 0, total = 0;
  samples.forEach(s => ['ct', 'cu', 'cm'].forEach(k => {
    const v = Number(s[k]) || 0;
    if (v < 0) { lost++; total++; } else if (v > 0) total++;
  }));
  return { lost, total, pct: total ? lost / total * 100 : 0 };
}

function pingChart(svg, samples = [], height = 48) {
  const w = 600, h = height, pad = 4;
  if (!samples.length) { svg.innerHTML = ''; return; }
  const xs = xPositions(samples, w);
  const all = samples.flatMap(s => ['ct', 'cu', 'cm'].map(k => Number(s[k]) || 0)).filter(v => v > 0);
  if (!all.length) { svg.innerHTML = ''; return; }
  const peak = Math.max(1, ...all);
  const py = v => h - pad - (Number(v) || 0) / peak * (h - pad * 2);
  const cs = getComputedStyle(document.body);
  const colors = {
    ct: (cs.getPropertyValue('--ping-ct') || '#2979FF').trim(),
    cu: (cs.getPropertyValue('--ping-cu') || '#E64A19').trim(),
    cm: (cs.getPropertyValue('--ping-cm') || '#00C853').trim(),
  };
  const uid = 'pg' + (++_uid);
  const baseY = (h - pad).toFixed(1);
  let html = `<defs>${['ct', 'cu', 'cm'].map(k =>
    `<linearGradient id="${uid}-${k}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${colors[k]}" stop-opacity=".30"/>` +
    `<stop offset="1" stop-color="${colors[k]}" stop-opacity="0"/>` +
    `</linearGradient>`).join('')}</defs>`;
  // 网格线
  [[1, '3'], [0.5, '3,3']].forEach(([f, dash]) => {
    html += `<line x1="0" y1="${py(peak * f).toFixed(1)}" x2="${w}" y2="${py(peak * f).toFixed(1)}" stroke="var(--line)" stroke-dasharray="${dash}"/>`;
  });
  html += `<line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="var(--line)"/>`;
  // 三条曲线
  ['ct', 'cu', 'cm'].forEach(k => {
    const pts = [];
    samples.forEach((s, i) => {
      const v = Number(s[k]) || 0;
      if (v > 0) pts.push([xs[i], py(v)]);
    });
    if (!pts.length) return;
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    const area = line + `L${pts[pts.length - 1][0].toFixed(1)} ${baseY}L${pts[0][0].toFixed(1)} ${baseY}Z`;
    html += `<path d="${area}" fill="url(#${uid}-${k})" stroke="none"/>`;
    html += `<path d="${line}" fill="none" stroke="${colors[k]}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    const last = pts[pts.length - 1];
    html += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${colors[k]}"/>`;
  });
  svg.innerHTML = html;
  // Y 轴标签
  const axis = svg.parentElement.querySelector('.y-axis');
  if (axis) {
    const spans = axis.querySelectorAll('span');
    if (spans[0]) spans[0].textContent = Math.round(peak);
    if (spans[1]) spans[1].textContent = Math.round(peak / 2);
    if (spans[2]) spans[2].textContent = '0';
  }
}

/* ---------- 丢包图（与延迟图共用时间轴） ---------- */
function lossChart(svg, samples = [], height = 18) {
  const w = 600, h = height;
  if (!samples.length) { svg.innerHTML = ''; return; }
  const xs = xPositions(samples, w);
  let bars = '';
  for (let i = 0; i < samples.length; i++) {
    const ratio = sampleLoss(samples[i]);
    const x0 = xs[i];
    const x1 = i + 1 < samples.length ? xs[i + 1] : w;
    // 柱子宽度跟随实际时间间隔：抽样后的老数据格子更宽，图才没有说谎
    const bw = Math.max(1.2, x1 - x0);
    const bh = ratio > 0 ? Math.max(2.5, ratio * (h - 2)) : 1.2;
    const cls = ratio >= 1 ? 'bad' : ratio >= 0.34 ? 'warn' : ratio > 0 ? 'low' : 'none';
    bars += `<rect x="${x0.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" class="loss-bar ${cls}"/>`;
  }
  svg.innerHTML = `<line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="var(--line)"/>` + bars;
}

/* ---------- 实时网络速率图（canvas 面积渐变 + 双曲线） ---------- */
function networkChart(canvas, history = [], current = {}, opts = {}) {
  const count = opts.count || 30;
  const parentW = canvas.parentElement.clientWidth;
  const w = parentW || 270, h = opts.height || 64, ml = 36, d = devicePixelRatio || 1, c = canvas.getContext('2d');
  canvas.width = w * d; canvas.height = h * d; c.scale(d, d);
  const cs = getComputedStyle(document.body);
  const muted = cs.getPropertyValue('--muted').trim() || '#64766e';
  const grid = cs.getPropertyValue('--line').trim() || '#22302b';
  const rxColor = cs.getPropertyValue('--net-rx').trim() || '#38bdf8';
  const txColor = cs.getPropertyValue('--net-tx').trim() || '#10b981';
  const cardBg = cs.getPropertyValue('--card').trim() || '#121a17';
  let samples = (history || []).slice(-count).map(x => ({ rx: Number(x.rx) || 0, tx: Number(x.tx) || 0 }));
  if (!samples.length) samples = [{ rx: Number(current.network_rx) || 0, tx: Number(current.network_tx) || 0 }];
  const peak = Math.max(1, ...samples.flatMap(x => [x.rx, x.tx]));
  const pw = w - ml;
  const px = i => ml + (samples.length > 1 ? i * pw / (samples.length - 1) : pw / 2);
  const py = v => h - (Number(v) || 0) / peak * (h - 22) - 6;
  // 网格 + Y 轴刻度
  c.font = "9px 'DM Mono', monospace";
  [[1, []], [0.5, [3, 3]]].forEach(([f, dash]) => {
    c.strokeStyle = grid; c.setLineDash(dash);
    c.beginPath(); c.moveTo(ml, py(peak * f)); c.lineTo(w, py(peak * f)); c.stroke();
    c.setLineDash([]);
    c.fillStyle = muted; c.fillText(mbpsNum(peak * f), 0, py(peak * f) + 3);
  });
  c.strokeStyle = grid;
  c.beginPath(); c.moveTo(ml, h - 4); c.lineTo(w, h - 4); c.stroke();
  // 双曲线：面积渐变 + 折线 + 端点圆点
  [['rx', rxColor], ['tx', txColor]].forEach(([key, color]) => {
    const pts = samples.map((x, i) => [px(i), py(x[key])]);
    // 面积
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexA(color, .22));
    grad.addColorStop(1, hexA(color, 0));
    c.beginPath();
    pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.lineTo(pts[pts.length - 1][0], h - 4);
    c.lineTo(pts[0][0], h - 4);
    c.closePath();
    c.fillStyle = grad; c.fill();
    // 折线
    c.beginPath();
    pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
    // 端点
    const last = pts[pts.length - 1];
    c.fillStyle = color;
    c.beginPath(); c.arc(last[0], last[1], 3.2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = cardBg; c.lineWidth = 1.5;
    c.beginPath(); c.arc(last[0], last[1], 3.2, 0, Math.PI * 2); c.stroke();
  });
}

/* ---------- 数字滚动动画 ---------- */
function animateNumber(el, target, dur = 700) {
  if (!el) return;
  const from = Number(el.dataset.v || 0);
  if (from === target) { el.textContent = target; return; }
  el.dataset.v = target;
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- 地区分组 ---------- */
function regionKey(node) {
  return (node.country || '').toUpperCase() || '??';
}

function renderRegionTabs(nodes) {
  const box = $('#region-tabs');
  if (!box) return;
  const counts = new Map();
  nodes.forEach(n => {
    const k = regionKey(n);
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  // 选中的地区没有节点了（被删除或改了国家码）就退回"全部"
  if (_region !== REGION_ALL && !counts.has(_region)) _region = REGION_ALL;
  // 完全没有节点时把筛选栏收起，避免只剩一个"全部"
  box.hidden = !nodes.length;
  box.innerHTML = '';
  const tab = (key, label, count) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'region-tab' + (key === _region ? ' active' : '');
    b.innerHTML = label + '<em>' + count + '</em>';
    b.onclick = () => {
      if (_region === key) return;
      _region = key;
      if (_lastNodes) render(_lastNodes);
    };
    return b;
  };
  box.append(tab(REGION_ALL, '全部', nodes.length));
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([code, count]) => box.append(tab(code, countryFlag(code), count)));
}

/* ---------- 延迟图表区间：按时间截取采样点 ---------- */
// range 必须能显式传入：详情页有自己的区间选择器，用错全局的 _pingRange
// 会让详情页的延迟/丢包图永远停在列表页那一档。
function pingWindow(node, range = _pingRange) {
  const all = node.ping_history || [];
  if (!all.length) return all;
  // 以服务端时间戳为基准，避免浏览器时钟偏差把整段数据切掉
  const now = Number(node.updated) || Number(all[all.length - 1].time) || 0;
  const win = all.filter(s => (Number(s.time) || 0) >= now - range);
  // 刚上线 / 时钟异常时可能筛空，退回最后几个点，别让图凭空消失
  return win.length >= 2 ? win : all.slice(-Math.min(all.length, 30));
}

document.querySelectorAll('#ping-range button').forEach(btn => {
  btn.onclick = () => {
    const range = Number(btn.dataset.range) || 3600;
    if (range === _pingRange) return;
    _pingRange = range;
    document.querySelectorAll('#ping-range button')
      .forEach(x => x.classList.toggle('active', x === btn));
    if (_lastNodes) render(_lastNodes);
  };
});

/* ---------- 负载曲线（CPU / 内存 / 磁盘，全部是 0-100 的百分比） ---------- */
/* 注意：百分比里 0 是有效值（磁盘可能真的是 0%），不像延迟那样能把 0 当"没数据"过滤掉 */
const LOAD_SERIES = [
  { key: 'cpu', color: '#10b981' },
  { key: 'memory', color: '#38bdf8' },
  { key: 'disk', color: '#f59e0b' },
];

function pctLines(svg, samples, series, height = 96) {
  const w = 600, h = height, pad = 4;
  svg.innerHTML = '';
  if (!samples.length) return;
  const xs = xPositions(samples, w);
  const py = v => h - pad - Math.min(Math.max(Number(v) || 0, 0), 100) / 100 * (h - pad * 2);
  let html = '';
  [100, 50].forEach(v => {
    html += `<line x1="0" y1="${py(v).toFixed(1)}" x2="${w}" y2="${py(v).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3"/>`;
  });
  html += `<line x1="0" y1="${py(0).toFixed(1)}" x2="${w}" y2="${py(0).toFixed(1)}" stroke="var(--line)"/>`;
  series.forEach(({ key, color }) => {
    const pts = samples.map((s, i) => [xs[i], py(s[key])]);
    if (!pts.length) return;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    html += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  });
  svg.innerHTML = html;
  const axis = svg.parentElement.querySelector('.y-axis');
  if (axis) {
    const sp = axis.querySelectorAll('span');
    if (sp[0]) sp[0].textContent = '100%';
    if (sp[1]) sp[1].textContent = '50%';
    if (sp[2]) sp[2].textContent = '0';
  }
}

/* ---------- 内存构成（已用 + buff/cache 堆叠，同样按总量的百分比画） ---------- */
function memChart(svg, samples, total, height = 80) {
  const w = 600, h = height, pad = 4;
  svg.innerHTML = '';
  if (!samples.length) return;
  const xs = xPositions(samples, w);
  const py = v => h - pad - Math.min(Math.max(v, 0), 100) / 100 * (h - pad * 2);
  const cs = getComputedStyle(document.body);
  const usedColor = (cs.getPropertyValue('--mem-used') || '#38bdf8').trim();
  const cachedColor = (cs.getPropertyValue('--mem-cached') || '#a78bfa').trim();
  const totalBytes = Number(total) || 0;
  // 已用是服务端算好的百分比；缓存是字节数，要按总量换算
  const usedPct = s => Math.min(Math.max(Number(s.memory) || 0, 0), 100);
  const cachedPct = s => {
    if (totalBytes <= 0) return 0;
    const c = (Number(s.mem_cached) || 0) / totalBytes * 100;
    return Math.min(Math.max(c, 0), 100 - usedPct(s));
  };
  const bot = samples.map((s, i) => [xs[i], py(usedPct(s))]);
  const top = samples.map((s, i) => [xs[i], py(usedPct(s) + cachedPct(s))]);
  const line = (pts, first) => pts.map((p, i) => (i || first ? 'L' : 'M') +
    p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const baseY = py(0).toFixed(1);
  const last = arr => arr[arr.length - 1];
  // 缓存层：上边界正向 + 下边界反向闭合；已用层：下边界到 0 闭合
  const cachedArea = line(top, 1) +
    bot.slice().reverse().map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + 'Z';
  const usedArea = line(bot, 1) +
    `L${last(bot)[0].toFixed(1)} ${baseY}L${bot[0][0].toFixed(1)} ${baseY}Z`;
  svg.innerHTML =
    `<path d="${cachedArea}" fill="${cachedColor}" fill-opacity=".45" stroke="none"/>` +
    `<path d="${usedArea}" fill="${usedColor}" fill-opacity=".5" stroke="none"/>` +
    `<line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="var(--line)"/>`;
  const axis = svg.parentElement.querySelector('.y-axis');
  if (axis) {
    const sp = axis.querySelectorAll('span');
    if (sp[0]) sp[0].textContent = '100%';
    if (sp[1]) sp[1].textContent = '50%';
    if (sp[2]) sp[2].textContent = '0';
  }
}

/* ---------- 节点卡片 ---------- */
function createCard(n, container) {
  const e = $('#node-card').content.cloneNode(true);
  const ms = [n.cpu, n.memory, n.disk];
  // 标题行
  e.querySelector('strong').textContent = n.name || n.hostname || '未命名节点';
  e.querySelector('.loc').innerHTML = countryFlag(n.country);
  e.querySelector('i').className = n.online ? '' : 'offline';
  e.querySelector('.ip').textContent = n.ip;
  e.querySelector('.status').textContent = n.online ? '在线' : '离线';
  e.querySelector('.status').className = 'status ' + (n.online ? 'on' : 'off');
  // OS 标签（图标为 span，颜色由 CSS mask + currentColor 控制，与文字同步）
  e.querySelector('.os').innerHTML = osIcon(n.os);
  // 资源进度条（先归零再动画到目标值）
  e.querySelectorAll('.bar').forEach((x, i) => {
    const v = ms[i] || 0;
    const fill = x.querySelector('.bar-fill');
    fill.style.width = '0%';
    requestAnimationFrame(() => { fill.style.width = v + '%'; });
    fill.style.background = v > 80 ? 'linear-gradient(90deg,#ef4444,#f87171)'
      : v > 60 ? 'linear-gradient(90deg,#eab308,#facc15)'
      : 'linear-gradient(90deg,#10b981,#34d399)';
    x.querySelector('b').textContent = v + '%';
    x.querySelector('small').textContent = [n.cpu_cores ? n.cpu_cores + '核' : '', bytes(n.mem_total), bytes(n.disk_total)][i];
  });
  // 网络实时面板
  e.querySelector('.net').innerHTML = '<b>↓</b> ' + mbps(n.network_rx) + ' <b class="tx">↑</b> ' + mbps(n.network_tx);
  e.querySelector('.traffic').innerHTML = '<span class="tag">累计</span> ' + bytesTotal(n.net_total_rx, n.net_total_tx);
  // Ping 徽章 + 丢包率（丢包率跟随所选区间，与下面的图表一致）
  const win = pingWindow(n);
  const prow = e.querySelector('.ping-row');
  if (prow) {
    const icons = { ct: '电信', cu: '联通', cm: '移动' };
    const lr = {};
    ['ct', 'cu', 'cm'].forEach(k => {
      let lost = 0, total = 0;
      win.forEach(s => {
        const v = Number(s[k]) || 0;
        if (v < 0) { lost++; total++; } else if (v > 0) total++;
      });
      if (total) lr[k] = Math.round(lost / total * 100);
    });
    prow.innerHTML = ['ct', 'cu', 'cm'].map(k => {
      const v = n['tcp_ping_' + k];
      if (!v) return '';
      const msVal = Number(v);
      const cls = msVal < 0 ? 'timeout' : msVal <= 100 ? 'fast' : msVal <= 300 ? 'mid' : 'slow';
      const badge = `<span class="ping ${k} ${cls}"><i>${icons[k]}</i> ${msVal < 0 ? '超时' : msVal}ms</span>`;
      const loss = lr[k] !== undefined
        ? `<em class="loss loss-${lr[k] === 0 ? 'ok' : lr[k] < 5 ? 'warn' : 'bad'}">${lr[k]}%</em>`
        : '';
      return badge + loss;
    }).join('');
  }
  // 运行时长
  e.querySelector('.uptime').innerHTML = '<span class="tag">运行</span> ' + duration(n.uptime);
  container.append(e);
  const card = container.lastElementChild;
  // 整卡可点：进入单节点详情页。键盘也要能用，所以补 tabindex/role 和 Enter/Space。
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', '查看 ' + (n.name || n.hostname || '节点') + ' 的详情');
  const openDetail = () => { location.hash = '#/node/' + n.id; };
  card.onclick = openDetail;
  card.onkeydown = ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(); }
  };
  // Ping 延迟 + 丢包图（共用同一段区间）
  const ps = card.querySelector('.ping-svg');
  if (ps) pingChart(ps, win);
  const ls = card.querySelector('.loss-svg');
  if (ls) lossChart(ls, win);
  const lv = card.querySelector('.loss-val');
  if (lv) {
    const st = lossStats(win);
    lv.textContent = st.total ? st.pct.toFixed(st.pct < 10 ? 1 : 0) + '%' : '—';
    lv.className = 'loss-val ' + (st.pct === 0 ? 'ok' : st.pct < 5 ? 'warn' : 'bad');
  }
  const hint = card.querySelector('.chart-hint');
  if (hint) hint.textContent = PING_RANGE_LABELS[_pingRange] || '';
  // 网络速率图（等布局完成后绘制，保证 canvas 宽度正确）
  const netCanvas = card.querySelector('.net-canvas');
  if (netCanvas) requestAnimationFrame(() => networkChart(netCanvas, n.history, n));
}

/* ---------- 仪表盘渲染 ---------- */
function render(nodes) {
  _lastNodes = nodes;
  const shown = _region === REGION_ALL ? nodes : nodes.filter(n => regionKey(n) === _region);
  // 统计数字跟随筛选结果，避免"筛到一个地区却显示全网节点数"
  animateNumber($('#online'), shown.filter(n => n.online).length);
  animateNumber($('#total'), shown.length);
  const box = $('#nodes');
  box.innerHTML = '';
  // 空状态
  if (!nodes.length) {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.innerHTML = '<b>&#128225;</b><p>暂无节点上报</p><p>请在管理后台生成 API Key 并在目标主机安装客户端。</p>';
    box.appendChild(d);
    renderRegionTabs(nodes);
    updateGroupNav();
    return;
  }
  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.innerHTML = '<b>&#128269;</b><p>该地区暂无节点</p><p>切换到「全部」查看所有节点。</p>';
    box.appendChild(d);
    renderRegionTabs(nodes);
    updateGroupNav();
    return;
  }
  // 平铺网格：在线优先、离线置后（组内保持 API 的名称排序）
  const sorted = [...shown].sort((a, b) => a.online === b.online ? 0 : a.online ? -1 : 1);
  sorted.forEach(n => createCard(n, box));
  renderRegionTabs(nodes);
  updateGroupNav();
}

let _lastNodes = null;
let _lastNodesSig = '';
async function refresh() {
  if (_detailId) return;   // 详情页开着时暂停列表轮询，免得两套轮询互相干扰
  try {
    const data = (await api('/api/nodes')).nodes;
    const sig = JSON.stringify(data);
    if (sig === _lastNodesSig) return;
    _lastNodesSig = sig;
    render(data);
  } catch (e) { console.error(e); }
}

/* ---------- 顶部操作 ---------- */
$('#theme').onclick = () => {
  document.body.classList.toggle('dark');
  try { localStorage.setItem('probe-theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch (_) {}
  syncThemeBtn();
  if (_lastNodes) render(_lastNodes);
};
$('#admin').onclick = () => {
  if (location.hash) location.hash = '';   // 从详情页回列表（hashchange 异步触发路由）
  $('#dashboard').hidden = true; $('#admin-panel').hidden = false;
  updateGroupNav();  // 否则桌面端节点导航会继续悬浮在后台面板上
};
$('#back').onclick = () => {
  $('#dashboard').hidden = false; $('#admin-panel').hidden = true;
  updateGroupNav();
};

/* ---------- 单节点详情页 ---------- */
const DETAIL_POLL_MS = 5000;
const DETAIL_DEFAULT_RANGE = 86400;
let _detailId = null;
let _detailData = null;
let _detailRange = DETAIL_DEFAULT_RANGE;
let _detailTimer = null;

function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - (Number(ts) || 0));
  if (d < 60) return Math.round(d) + ' 秒前';
  if (d < 3600) return Math.round(d / 60) + ' 分钟前';
  if (d < 86400) return Math.round(d / 3600) + ' 小时前';
  return Math.round(d / 86400) + ' 天前';
}

function clock(ts) {
  const d = new Date((Number(ts) || 0) * 1000), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function detailTimer() { return _detailTimer; }   // 测试用：确认关闭后没有遗留定时器

function openDetail(id) {
  if (_detailId !== id) {
    _detailId = id;
    _detailData = null;
    $('#detail-head').innerHTML = '';
    $('#detail-spec').innerHTML = '';
    $('#detail-bars').innerHTML = '';
    $('#detail-net-stats').innerHTML = '';
    $('#detail-ping-row').innerHTML = '';
    $('#detail-title').textContent = '加载中…';
  }
  $('#dashboard').hidden = true;
  $('#admin-panel').hidden = true;
  $('#node-detail').hidden = false;
  updateGroupNav();
  window.scrollTo({ top: 0 });
  loadDetail();
  startDetailPolling();
}

function closeDetail() {
  _detailId = null;
  _detailData = null;
  stopDetailPolling();
  $('#node-detail').hidden = true;
  // 后台面板如果开着，就别把仪表盘也显示出来
  if ($('#admin-panel').hidden) $('#dashboard').hidden = false;
  updateGroupNav();
}

function startDetailPolling() {
  stopDetailPolling();
  _detailTimer = setInterval(() => { if (_detailId) loadDetail(); }, DETAIL_POLL_MS);
}

function stopDetailPolling() {
  if (_detailTimer) { clearInterval(_detailTimer); _detailTimer = null; }
}

async function loadDetail() {
  const id = _detailId;
  if (!id) return;
  try {
    const data = await api(`/api/nodes/${encodeURIComponent(id)}?range=${_detailRange}`);
    if (_detailId !== id) return;   // 期间已经切走/关闭，别用旧响应覆盖新页面
    _detailData = data;
    renderDetail(data);
  } catch (e) {
    if (_detailId !== id) return;
    $('#detail-title').textContent = '节点不存在或已删除';
    $('#detail-head').innerHTML =
      '<p class="hint">该节点可能已被删除或封禁。' +
      '<a href="#" id="detail-head-back">返回仪表盘</a></p>';
    const back = $('#detail-head-back');
    if (back) back.onclick = ev => { ev.preventDefault(); location.hash = ''; };
  }
}

function renderDetail(data) {
  const n = data.node || {};
  renderDetailHead(n);
  renderDetailSpec(n);
  renderDetailLoad(data);
  renderDetailNet(n, data.history || []);
  renderDetailPing(data.ping_history || [], n);
}

function renderDetailHead(n) {
  $('#detail-title').textContent = n.name || n.hostname || '未命名节点';
  const box = $('#detail-head');
  box.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'detail-head-row';
  const loc = document.createElement('span');
  loc.className = 'loc';
  loc.innerHTML = countryFlag(n.country);      // 只插入正则校验过的国家码
  const fields = [
    ['状态', n.online ? '在线' : '离线', 'status ' + (n.online ? 'on' : 'off')],
    ['IP', n.ip || '—', ''],
    ['主机名', n.hostname || '—', ''],
    ['最后上报', n.updated ? ago(n.updated) + '（' + clock(n.updated) + '）' : '—', ''],
    ['运行时长', n.uptime ? duration(n.uptime) : '—', ''],
  ];
  row.append(loc);
  fields.forEach(([label, value, cls]) => {
    const w = document.createElement('span');
    w.className = 'detail-field';
    const l = document.createElement('em');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    if (cls) v.className = cls;
    w.append(l, v);
    row.append(w);
  });
  box.append(row);
}

function renderDetailSpec(n) {
  const box = $('#detail-spec');
  box.innerHTML = '';
  const rows = [];
  const str = (label, value) => { const s = String(value == null ? '' : value).trim(); if (s) rows.push([label, s]); };
  const num = (label, value, fmt) => { const v = Number(value) || 0; if (v > 0) rows.push([label, fmt ? fmt(v) : String(v)]); };
  // 把若干片段拼成一行；没有片段就不出这一行
  const grouped = (label, ...parts) => { const s = parts.filter(Boolean).join(' · '); if (s) rows.push([label, s]); };
  const bitNum = (value, fmt) => { const v = Number(value) || 0; return v > 0 ? (fmt ? fmt(v) : String(v)) : ''; };
  const bitStr = value => String(value == null ? '' : value).trim();

  str('CPU 型号', n.cpu_model);
  grouped('CPU 规格',
    bitNum(n.cpu_cores, v => v + ' 核'), bitStr(n.arch),
    bitNum(n.cpu_mhz, v => (v / 1000).toFixed(2) + ' GHz'),
    bitStr(n.cpu_cache) && 'L3 ' + bitStr(n.cpu_cache));

  grouped('操作系统', bitStr(n.os),
    bitNum(n.os_version_id && (Number(n.os_version_id) || n.os_version_id), v => '版本 ' + v),
    bitStr(n.os_codename) && '(' + bitStr(n.os_codename) + ')');
  str('发行版 ID', n.os_id);
  str('内核版本', n.kernel);
  str('内核详情', n.kernel_full);

  grouped('进程',
    bitNum(n.procs, v => v + ' 个进程'), bitNum(n.running, v => v + ' 运行中'),
    bitNum(n.threads, v => v + ' 线程'));

  grouped('内存',
    bitNum(n.mem_total, v => bytes(v) + ' 内存'),
    bitNum(n.swap_total, v => '交换 ' + bytes(v) + (bitNum(n.swap_used) ? '（已用 ' + bytes(n.swap_used) + '）' : '')),
    bitNum(n.mem_cached, v => '缓存 ' + bytes(v)));

  grouped('磁盘', bitNum(n.disk_total, v => bytes(v) + ' 容量'), bitNum(n.disk, v => '已用 ' + v + '%'));

  grouped('主机',
    bitStr(n.virt) && bitStr(n.virt) + ' 虚拟化',
    bitNum(n.load1, () => '负载 ' + (Number(n.load1) || 0) + ' / ' + (Number(n.load5) || 0) + ' / ' + (Number(n.load15) || 0)),
    bitNum(n.iowait, v => 'iowait ' + v + '%'),
    bitNum(n.tcp_conn, v => 'TCP 连接 ' + v),
    bitNum(n.temp_c, v => v + '°C'));

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '暂无可用数据。';
    box.append(p);
    return;
  }
  rows.forEach(([label, value]) => {
    const r = document.createElement('div');
    r.className = 'spec-row';
    const l = document.createElement('em');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    r.append(l, v);
    box.append(r);
  });
  // 老客户端仍会上报内存/磁盘等旧字段，所以不能靠"整块为空"来判断。
  // 只要缺 CPU 型号和内核版本，就说明 agent 没升级，补一条提示。
  if (!bitStr(n.cpu_model) && !bitStr(n.kernel)) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '该节点客户端版本较旧，未上报 CPU 型号、系统与内核版本。' +
      '重新执行一次客户端安装命令后即可显示。';
    box.append(p);
  }
}

function renderDetailLoad(data) {
  const n = data.node || {};
  const samples = data.history || [];
  // 大号进度条，和列表页一致
  const bars = $('#detail-bars');
  bars.innerHTML = '';
  [['CPU', n.cpu], ['内存', n.memory], ['磁盘', n.disk]].forEach(([label, value]) => {
    const v = Math.min(Math.max(Number(value) || 0, 0), 100);
    const wrap = document.createElement('div');
    wrap.className = 'bar';
    const l = document.createElement('label');
    l.textContent = label;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = v + '%';
    fill.style.background = v > 80 ? 'linear-gradient(90deg,#ef4444,#f87171)'
      : v > 60 ? 'linear-gradient(90deg,#eab308,#facc15)'
      : 'linear-gradient(90deg,#10b981,#34d399)';
    track.append(fill);
    const b = document.createElement('b');
    b.textContent = v + '%';
    wrap.append(l, track, b);
    bars.append(wrap);
  });
  const hint = $('#detail-load-hint');
  if (hint) hint.textContent = PING_RANGE_LABELS[_detailRange] || '';
  pctLines(document.querySelector('#node-detail .load-svg'), samples, LOAD_SERIES, 96);
  memChart(document.querySelector('#node-detail .mem-svg'), samples, n.mem_total, 80);
}

function renderDetailNet(n, samples) {
  const box = $('#detail-net-stats');
  box.innerHTML = '';
  const stats = [
    ['实时下载', mbps(n.network_rx)],
    ['实时上传', mbps(n.network_tx)],
    ['累计流量', bytesTotal(n.net_total_rx, n.net_total_tx) || '—'],
    ['错误 / 丢包', (Number(n.net_err) || 0) + ' / ' + (Number(n.net_drop) || 0)],
  ];
  stats.forEach(([label, value]) => {
    const s = document.createElement('span');
    const l = document.createElement('em');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    s.append(l, v);
    box.append(s);
  });
  const canvas = document.querySelector('#node-detail .net-canvas');
  if (canvas) requestAnimationFrame(() => networkChart(canvas, samples, n, { count: 300, height: 120 }));
}

function renderDetailPing(samples, n) {
  const win = pingWindow({ ping_history: samples, updated: n.updated }, _detailRange);
  pingChart(document.querySelector('#node-detail .ping-svg'), win, 96);
  lossChart(document.querySelector('#node-detail .loss-svg'), win, 20);
  const lv = document.querySelector('#node-detail .loss-val');
  if (lv) {
    const st = lossStats(win);
    lv.textContent = st.total ? st.pct.toFixed(st.pct < 10 ? 1 : 0) + '%' : '—';
    lv.className = 'loss-val ' + (st.pct === 0 ? 'ok' : st.pct < 5 ? 'warn' : 'bad');
  }
  // 三网当前延迟徽章
  const prow = $('#detail-ping-row');
  prow.innerHTML = '';
  const icons = { ct: '电信', cu: '联通', cm: '移动' };
  ['ct', 'cu', 'cm'].forEach(k => {
    const v = n['tcp_ping_' + k];
    if (!v) return;
    const ms = Number(v);
    const cls = ms < 0 ? 'timeout' : ms <= 100 ? 'fast' : ms <= 300 ? 'mid' : 'slow';
    const s = document.createElement('span');
    s.className = `ping ${k} ${cls}`;
    s.textContent = `${icons[k]} ${ms < 0 ? '超时' : ms + 'ms'}`;
    prow.append(s);
  });
  // 区间内各运营商丢包率
  ['ct', 'cu', 'cm'].forEach(k => {
    let lost = 0, total = 0;
    win.forEach(s => {
      const v = Number(s[k]) || 0;
      if (v < 0) { lost++; total++; } else if (v > 0) total++;
    });
    if (!total) return;
    const pct = Math.round(lost / total * 100);
    const em = document.createElement('em');
    em.className = 'loss loss-' + (pct === 0 ? 'ok' : pct < 5 ? 'warn' : 'bad');
    em.textContent = icons[k] + ' ' + pct + '%';
    $('#detail-ping-row').append(em);
  });
}

/* 路由：只有 #/node/<id> 一种，其余一律回列表 */
function route() {
  const m = /^#\/node\/([0-9a-fA-F]{6,64})$/.exec(location.hash || '');
  if (m) openDetail(m[1]);
  else closeDetail();
}
window.addEventListener('hashchange', route);

$('#detail-back').onclick = () => { location.hash = ''; };
document.querySelectorAll('#detail-range button').forEach(btn => {
  btn.onclick = () => {
    const range = Number(btn.dataset.range) || DETAIL_DEFAULT_RANGE;
    if (range === _detailRange) return;
    _detailRange = range;
    document.querySelectorAll('#detail-range button')
      .forEach(x => x.classList.toggle('active', x === btn));
    if (_detailId) loadDetail();
  };
});

/* ---------- 管理后台 ---------- */
$('#login-btn').onclick = async () => {
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    _csrf = r.csrf || '';
    $('#password').value = '';
    $('#login').hidden = true; $('#manage').hidden = false;
    lastAdminSig = '';
    loadAdmin();
  } catch (e) { alert(e.message); }
};
$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  $('#manage').hidden = true; $('#login').hidden = false;
};

// 后台行渲染：只用 DOM API，绝不把服务器数据拼进 innerHTML（防 XSS）
let lastAdminSig = '';
async function loadAdmin() {
  const [keys, nodes, blocked, settings] = await Promise.all([
    api('/api/admin/keys'), api('/api/admin/nodes'), api('/api/admin/blocked'), api('/api/admin/settings'),
  ]);
  const sig = JSON.stringify([keys, nodes, blocked, settings]);
  if (sig === lastAdminSig) return; // 数据没变化不重绘，避免打断正在编辑的输入
  lastAdminSig = sig;
  renderKeys(keys.keys);
  renderAdminNodes(nodes.nodes);
  renderBlocked(blocked.blocked);
  renderSettings(settings);
}
function renderKeys(keys) {
  const k = $('#keys');
  k.innerHTML = '';
  keys.forEach(x => {
    const row = document.createElement('div');
    row.className = 'key';
    const info = document.createElement('span');
    const labelText = document.createElement('b');
    labelText.textContent = x.label;
    const labelInput = document.createElement('input');
    labelInput.value = x.label;
    labelInput.className = 'key-label';
    labelInput.style.display = 'none';
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑'; editBtn.className = 'small';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存'; saveBtn.className = 'small';
    saveBtn.style.display = 'none';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消'; cancelBtn.className = 'small';
    cancelBtn.style.display = 'none';
    const saveEdit = async () => {
      const v = labelInput.value.trim();
      if (!v) return;
      labelText.textContent = v; x.label = v;
      labelText.style.display = ''; editBtn.style.display = '';
      labelInput.style.display = 'none'; saveBtn.style.display = 'none'; cancelBtn.style.display = 'none';
      await api('/api/admin/keys/' + x.id, { method: 'POST', body: JSON.stringify({ label: v }) });
    };
    const cancelEdit = () => {
      labelInput.value = x.label;
      labelText.style.display = ''; editBtn.style.display = '';
      labelInput.style.display = 'none'; saveBtn.style.display = 'none'; cancelBtn.style.display = 'none';
    };
    editBtn.onclick = () => {
      labelInput.value = x.label;
      labelText.style.display = 'none'; editBtn.style.display = 'none';
      labelInput.style.display = ''; saveBtn.style.display = ''; cancelBtn.style.display = '';
      labelInput.focus();
    };
    saveBtn.onclick = saveEdit;
    cancelBtn.onclick = cancelEdit;
    labelInput.onkeydown = (e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); };
    const code = document.createElement('code');
    code.textContent = x.key;
    info.append(labelText, labelInput, editBtn, saveBtn, cancelBtn, document.createElement('br'), code);
    const actions = document.createElement('span');
    const use = document.createElement('button');
    use.textContent = '客户端安装'; use.className = 'small';
    use.onclick = async () => {
      const s = (await api('/api/install.sh?key=' + encodeURIComponent(x.key))).script;
      const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
      $('#install').textContent = `echo '${base64}' | base64 -d | bash`;
    };
    const del = document.createElement('button');
    del.textContent = '删除'; del.className = 'small danger';
    del.onclick = async () => {
      try {
        await api('/api/admin/keys/' + x.id, { method: 'DELETE' });
        loadAdmin();
      } catch (e) { alert(e.message); }
    };
    actions.append(use, del);
    row.append(info, actions);
    k.append(row);
  });
}
function renderAdminNodes(nodes) {
  const n = $('#admin-nodes');
  n.innerHTML = '';
  if (!nodes.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '暂无节点，等待客户端首次上报。';
    n.append(p);
    return;
  }
  const now = Date.now() / 1000;
  nodes.forEach(x => {
    // 每节点一张编辑卡片（网格布局，一行多个）
    const card = document.createElement('div');
    card.className = 'edit-node';
    // 头部：hostname + 在线状态
    const head = document.createElement('div');
    head.className = 'node-edit-head';
    const title = document.createElement('b');
    title.textContent = x.hostname || x.id || '未命名节点';
    const online = (x.updated || 0) > 0 && now - x.updated < 90;
    const meta = document.createElement('span');
    meta.className = 'node-edit-meta';
    const dot = document.createElement('i');
    dot.className = online ? '' : 'off';
    const metaText = document.createElement('span');
    metaText.textContent = online ? '在线' : '离线';
    meta.append(dot, metaText);
    head.append(title, meta);
    // 输入区
    const name = document.createElement('input');
    name.value = x.name || '';
    name.placeholder = '节点名称';
    name.title = '节点名称';
    const country = document.createElement('input');
    country.value = x.country || '';
    country.placeholder = '国家代码';
    country.title = '国家代码（两位，如 CN）';
    country.maxLength = 2;
    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'node-edit-actions';
    const save = document.createElement('button');
    save.textContent = '保存';
    save.onclick = async () => {
      await api('/api/admin/nodes', { method: 'POST', body: JSON.stringify({ id: x.id, name: name.value, country: country.value }) });
      refresh();
      loadAdmin();
    };
    const del = document.createElement('button');
    del.textContent = '删除节点'; del.className = 'danger';
    del.onclick = async () => {
      if (confirm('确定删除该节点吗？删除后其上报将被封禁，可在下方"已封禁节点"中解封。')) {
        await api('/api/admin/nodes/' + x.id, { method: 'DELETE' });
        refresh(); loadAdmin();
      }
    };
    actions.append(save, del);
    // 底部：最后上报时间
    const foot = document.createElement('div');
    foot.className = 'node-edit-meta';
    foot.textContent = '最后上报: ' + (x.updated ? new Date(x.updated * 1000).toLocaleString('zh-CN', { hour12: false }) : '—');
    card.append(head, name, country, actions, foot);
    n.append(card);
  });
}
function renderBlocked(blocked) {
  const n = $('#blocked-nodes');
  n.innerHTML = '';
  if (!blocked.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '暂无被封禁的节点';
    n.append(p);
    return;
  }
  blocked.forEach(x => {
    const row = document.createElement('div');
    row.className = 'edit-node';
    const info = document.createElement('span');
    info.className = 'blocked-info';
    info.textContent = (x.name || x.hostname || x.id) + (x.name && x.hostname ? `（${x.hostname}）` : '');
    const un = document.createElement('button');
    un.textContent = '解封';
    un.onclick = async () => {
      await api('/api/admin/unblock', { method: 'POST', body: JSON.stringify({ id: x.id }) });
      loadAdmin();
    };
    row.append(info, un);
    n.append(row);
  });
}
function renderSettings(s) {
  const u = $('#admin-user'); if (u && document.activeElement !== u) u.value = s.admin_user || '';
  ['ct', 'cu', 'cm'].forEach(k => { const el = $('#ping-' + k); if (el && document.activeElement !== el) el.value = s['ping_' + k] || ''; });
}

$('#new-key').onclick = async () => {
  try {
    await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ label: $('#key-label').value || '新密钥' }) });
    $('#key-label').value = '';
    loadAdmin();
  } catch (e) { alert(e.message); }
};
$('#save-user').onclick = async () => {
  try {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ admin_user: $('#admin-user').value.trim() }) });
    alert('管理员用户名已更新，下次登录请使用新用户名');
    loadAdmin();
  } catch (e) { alert(e.message); }
};
const sp = $('#save-ping');
if (sp) sp.onclick = async () => {
  try {
    const body = {};
    ['ct', 'cu', 'cm'].forEach(k => { const v = $('#ping-' + k).value.trim(); if (v) body['ping_' + k] = v; });
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
    alert('Ping 目标已保存，请重新生成客户端安装命令');
    loadAdmin();
  } catch (e) { alert(e.message); }
};
$('#copy-install').onclick = async () => {
  const cmd = $('#install').textContent;
  if (!cmd || cmd.startsWith('请')) return;
  const btn = $('#copy-install');
  try { await navigator.clipboard.writeText(cmd); }
  catch (_) {
    const ta = document.createElement('textarea');
    ta.value = cmd; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }
  btn.textContent = '已复制';
  setTimeout(() => btn.textContent = '复制', 2000);
};

/* ---------- 刷新与轮询 ---------- */
refresh();
setInterval(refresh, 5000);
// 管理后台打开期间每 10 秒自动刷新。
// 编辑保护：焦点停留在管理区内的输入框/按钮等可交互元素时跳过刷新，
// 避免实时刷新重绘 DOM 打断正在编辑的内容或操作。
function adminEditing() {
  const a = document.activeElement;
  if (!a || !$('#manage') || !$('#manage').contains(a)) return false;
  const t = a.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'BUTTON' || t === 'SELECT' || a.isContentEditable === true;
}
setInterval(() => {
  if (!$('#admin-panel').hidden && !$('#manage').hidden && !adminEditing()) loadAdmin().catch(() => {});
}, 10000);

/* ---------- 右侧浮动导航（回到顶部 + 节点锚点） ---------- */
function updateGroupNav() {
  const nav = $('#group-nav');
  if ($('#dashboard').hidden) { nav.style.display = 'none'; return; }
  nav.style.display = '';
  nav.querySelectorAll('.nav-node').forEach(el => el.remove());
  // 必须先断开：每次重绘都会生成一批全新的卡片，旧的被 remove 之后
  // IntersectionObserver 仍持有引用，页面开久了会一直累积。
  navObserver.disconnect();
  document.querySelectorAll('.card').forEach(card => {
    const s = card.querySelector('.node-title strong');
    if (!s) return;
    const na = document.createElement('a');
    na.className = 'nav-node';
    na.textContent = s.textContent;
    na.onclick = () => card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nav.insertBefore(na, nav.querySelector('.nav-top'));
  });
  document.querySelectorAll('.card').forEach(c => navObserver.observe(c));
}
$('#group-nav .nav-top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
$('#nav-toggle').onclick = () => $('#group-nav').classList.toggle('visible');
const navObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const s = e.target.querySelector('.node-title strong');
    if (!s) return;
    const key = s.textContent;
    document.querySelectorAll('#group-nav .nav-node').forEach(a => {
      a.classList.toggle('active', a.textContent === key);
    });
  });
}, { rootMargin: '-20% 0px -60% 0px' });

/* ---------- 启动 ---------- */
// 必须放在最后：route() 会走到 updateGroupNav()，而 navObserver 的 const 在上面才初始化，
// 提前调用会踩 TDZ 直接抛错（整页白屏）。
route();          // 支持直达 #/node/<id>（刷新/分享链接）
