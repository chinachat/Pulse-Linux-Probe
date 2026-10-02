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

/* ---------- 时间轴与统计工具 ---------- */
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

/* 区间内的真实丢包率：失败探测数 / 总探测数 */
function lossStats(samples) {
  let lost = 0, total = 0;
  samples.forEach(s => ['ct', 'cu', 'cm'].forEach(k => {
    const v = Number(s[k]) || 0;
    if (v < 0) { lost++; total++; } else if (v > 0) total++;
  }));
  return { lost, total, pct: total ? lost / total * 100 : 0 };
}

/* 采样点 < 2 时曲线画不出来：xPositions 只返回一个 x，折线和面积都会退化成零宽，
   界面上就是一片空白 —— 看着像功能坏了，其实只是数据还没攒够。这里用一句说明
   替代空白。返回 true 表示已用占位说明取代图表，调用方应跳过绘制。
   （延迟图不适用：pingChart 在单点时会画一个圆点，本来就看得到。） */
function chartPlaceholder(svg, samples) {
  if (!svg || !svg.parentElement) return false;
  const host = svg.parentElement;
  const existing = host.querySelector('.chart-empty');
  const n = samples ? samples.length : 0;
  if (n >= 2) {
    if (existing) existing.remove();
    return false;
  }
  const hint = existing || document.createElement('div');
  hint.className = 'chart-empty';
  hint.textContent = n === 0
    ? '该区间暂无采样点'
    : '采样点不足（' + n + '/2），下 1 分钟后即可画出曲线';
  if (!existing) host.append(hint);
  svg.innerHTML = '';
  return true;
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
  // Ping 延迟折线 + 丢包条（共用同一段区间）
  const ps = card.querySelector('.ping-svg');
  if (ps) pingChart(ps, win, 48);
  const ls = card.querySelector('.loss-svg');
  if (ls) lossChart(ls, win, 18);
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
const DETAIL_CACHE_MS = 120000;   // 缓存 2 分钟：够"来回切区间"用，又不会显示太旧的数据
let _detailId = null;
let _detailData = null;
let _detailRange = DETAIL_DEFAULT_RANGE;
let _detailEnd = null;            // 窗口右端；null = 贴着现在
let _detailExtent = { oldest: 0, newest: 0 };
let _detailTimer = null;
let _detailShownKey = null;       // 当前已渲染的 id:range:end，用来决定是否先用缓存顶一下
const _detailCache = new Map();

function cacheKey(id, range, end) {
  // 平移/缩放的窗口各自缓存，来回拖动不用反复请求
  return id + ':' + range + ':' + (end == null ? 'now' : Math.round(end));
}

function cacheGet(id, range, end) {
  const key = cacheKey(id, range, end);
  const hit = _detailCache.get(key);
  if (hit && Date.now() - hit.ts < DETAIL_CACHE_MS) return hit.data;
  try {
    const raw = sessionStorage.getItem('probe-detail:' + key);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && Date.now() - stored.ts < DETAIL_CACHE_MS) {
        _detailCache.set(key, stored);
        return stored.data;
      }
    }
  } catch (_) { /* sessionStorage 不可用就当没有缓存 */ }
  return null;
}

function cachePut(id, range, end, data) {
  const entry = { data, ts: Date.now() };
  const key = cacheKey(id, range, end);
  _detailCache.set(key, entry);
  try {
    sessionStorage.setItem('probe-detail:' + key, JSON.stringify(entry));
  } catch (_) { /* 超配额/隐私模式：内存缓存仍然有效 */ }
}

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
    _detailShownKey = null;
    _detailEnd = null;
    ['#detail-head', '#detail-spec', '#detail-bars', '#detail-net-stats', '#detail-ping-row',
     '#detail-events', '#detail-ifaces', '#detail-disks'].forEach(sel => {
      const el = $(sel);
      if (el) { el.innerHTML = ''; el.hidden = false; }
    });
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
  _detailShownKey = null;
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
  const id = _detailId, range = _detailRange, end = _detailEnd;
  if (!id) return;
  // 先用缓存顶一下（切区间/拖时间轴/重开该节点时几乎瞬开），随后仍会拉最新数据
  const key = cacheKey(id, range, end);
  if (_detailShownKey !== key) {
    const cached = cacheGet(id, range, end);
    if (cached) { _detailShownKey = key; _detailData = cached; renderDetail(cached); }
  }
  try {
    const q = `range=${range}` + (end == null ? '' : `&end=${Math.round(end)}`);
    const data = await api(`/api/nodes/${encodeURIComponent(id)}?${q}`);
    // 期间已切走/换了窗口，别用旧响应覆盖
    if (_detailId !== id || _detailRange !== range || _detailEnd !== end) return;
    cachePut(id, range, end, data);
    if (isFinite(Number(data.oldest))) {
      _detailExtent = { oldest: Number(data.oldest), newest: Number(data.newest) };
    }
    _detailShownKey = key;
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

/* 缩放/平移后统一走这里：只改窗口，不重复写渲染逻辑。
   end 传数值 = 钉住这个历史窗口；传 null = 贴着现在，跟着新数据往前走。 */
function setWindow(range, end) {
  _detailRange = Math.round(range);
  _detailEnd = end;
  syncRangeButtons();
  if (_detailId) loadDetail();
}

function applyWindow(next) {
  if (!next) return;
  setWindow(next.range, next.end);
}

/* 服务端给的数据边界。还没拿到响应时用"最近 24 小时"兜底，
   否则 clampWindow 会把窗口夹成 1 秒这种废值。 */
function detailExtent() {
  const ext = _detailExtent;
  if (ext && ext.newest > ext.oldest) return ext;
  const now = Math.floor(Date.now() / 1000);
  return { oldest: now - PING_MAX_RANGE, newest: now };
}

function currentWindow() {
  const ext = detailExtent();
  return clampWindow(_detailRange, _detailEnd, ext.oldest, ext.newest);
}

function renderDetail(data) {
  const n = data.node || {};
  renderDetailHead(n);
  renderDetailSpec(n);
  renderDetailLoad(data);
  renderDetailNet(n, data.history || []);
  renderDetailIfaces(n);
  renderDetailDisks(n);
  renderDetailPing(data.ping_history || [], n);
  renderDetailEvents(data.events || []);
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
  const loadSvg = document.querySelector('#node-detail .load-svg');
  if (!chartPlaceholder(loadSvg, samples)) pctLines(loadSvg, samples, LOAD_SERIES, 96);
  const memSvg = document.querySelector('#node-detail .mem-svg');
  if (!chartPlaceholder(memSvg, samples)) memChart(memSvg, samples, n.mem_total, 80);
  renderTimeAxis(document.querySelector('#node-detail .load-xaxis'), samples);
  renderTimeAxis(document.querySelector('#node-detail .mem-xaxis'), samples);
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
  const svg = document.querySelector('#node-detail .ping-svg');
  if (svg) {
    pingChart(svg, win, 96);
    // 框选放大的叠加层；曲线每次重画都要补回来
    const pick = document.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      : document.createElement('rect');
    pick.setAttribute('class', 'pick');
    pick.setAttribute('y', '0');
    pick.setAttribute('height', '96');
    pick.setAttribute('visibility', 'hidden');
    svg.append(pick);
  }
  lossChart(document.querySelector('#node-detail .loss-svg'), win, 18);
  const lv = document.querySelector('#node-detail .loss-val');
  if (lv) {
    const st = lossStats(win);
    lv.textContent = st.total ? (st.pct < 10 ? st.pct.toFixed(1) : st.pct.toFixed(0)) + '%' : '—';
    lv.className = 'loss-val ' + (st.pct === 0 ? 'ok' : st.pct < 5 ? 'warn' : 'bad');
  }
  renderTimeAxis(document.querySelector('#node-detail .ping-xaxis'), win);
  const winLabel = $('#ping-window');
  if (winLabel) {
    const st = lossStats(win);
    const pct = st.total ? (st.pct < 10 ? st.pct.toFixed(1) : st.pct.toFixed(0)) + '%' : '—';
    winLabel.textContent = `${win.length} 个采样点 · 丢包率 ${pct}`;
  }
  // 三网当前延迟徽章
  const prow = $('#detail-ping-row');
  if (!prow) return;
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
  // 三网丢包：每个运营商一行"时间线 + 区间丢包率"。
  // 百分比与"什么时候不通"放在同一行，因此不再往上面的徽章行里塞重复的百分比。
  const cbox = $('#detail-loss-carriers');
  if (cbox) {
    cbox.innerHTML = '';
    ['ct', 'cu', 'cm'].forEach(k => {
      let lost = 0, total = 0;
      win.forEach(s => {
        const v = Number(s[k]) || 0;
        if (v < 0) { lost++; total++; } else if (v > 0) total++;
      });
      const pct = total ? Math.round(lost / total * 100) : 0;
      const row = document.createElement('div');
      row.className = 'loss-row loss-carrier';
      const tag = document.createElement('span');
      tag.className = 'loss-tag';
      tag.textContent = icons[k];
      // 用 createElementNS：SVG 元素必须建在 SVG 命名空间里，否则画不出来。
      // 兜底走 createElement —— 测试用的最小 DOM 桩没有 createElementNS
      // （上面框选层的 rect 也是同样的写法）。
      const csvg = document.createElementNS
        ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        : document.createElement('svg');
      csvg.setAttribute('class', 'loss-svg');
      csvg.setAttribute('viewBox', '0 0 600 10');
      csvg.setAttribute('preserveAspectRatio', 'none');
      const val = document.createElement('b');
      val.className = 'loss-val ' + (pct === 0 ? 'ok' : pct < 5 ? 'warn' : 'bad');
      val.textContent = total ? pct + '%' : '—';
      row.append(tag, csvg, val);
      cbox.append(row);
      carrierLossChart(csvg, win, k, 10);
    });
  }
}

/* ---------- 事件日志 ---------- */
const EVENT_LEVELS = { error: '严重', warn: '警告', info: '信息' };
const EVENT_KINDS = {
  cpu: 'CPU', memory: '内存', disk: '磁盘', iowait: 'iowait',
  offline: '离线', ping_timeout: '超时', ping_loss: '丢包', ping_slow: '延迟',
};

function renderDetailEvents(events) {
  const box = $('#detail-events');
  if (!box) return;
  box.innerHTML = '';
  if (!events.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '当前区间内没有触发任何阈值或异常。';
    box.append(p);
    return;
  }
  events.forEach(e => {
    const row = document.createElement('div');
    row.className = 'event ev-' + (EVENT_LEVELS[e.level] ? e.level : 'info');
    const t = document.createElement('em');
    t.textContent = clock(e.time);
    const kind = document.createElement('span');
    kind.className = 'ev-kind';
    kind.textContent = EVENT_KINDS[e.kind] || e.kind || '事件';
    const text = document.createElement('b');
    text.textContent = e.text || '';
    row.append(t, kind, text);
    box.append(row);
  });
}

/* ---------- 按接口快照 ---------- */
function renderDetailIfaces(n) {
  const box = $('#detail-ifaces');
  if (!box) return;
  box.innerHTML = '';
  const list = Array.isArray(n.ifaces) ? n.ifaces : [];
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const table = document.createElement('table');
  table.className = 'mini-table';
  const head = document.createElement('tr');
  ['接口', '累计接收', '累计发送', '错误', '丢包'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  });
  table.append(head);
  list.forEach(it => {
    const tr = document.createElement('tr');
    const cells = [it.name, bytes(it.rx), bytes(it.tx),
                   String(Number(it.err) || 0), String(Number(it.drop) || 0)];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i >= 3 && Number(v) > 0) td.className = 'bad';
      tr.append(td);
    });
    table.append(tr);
  });
  box.append(table);
}

/* ---------- 多盘用量快照 ---------- */
/* 与"按接口"同样是列表型数据：只存当前值、不进历史（曲线与告警阈值仍只针对根盘 /）。
   服务端已按白名单重建过，这里只负责展示，并按使用率降序排，最紧张的盘排在最前。 */
function renderDetailDisks(n) {
  const box = $('#detail-disks');
  if (!box) return;
  box.innerHTML = '';
  const list = Array.isArray(n.disks) ? n.disks : [];
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const table = document.createElement('table');
  table.className = 'mini-table';
  const head = document.createElement('tr');
  ['挂载点', '容量', '已用', '使用率'].forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  });
  table.append(head);
  list.slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0)).forEach(d => {
    const tr = document.createElement('tr');
    const pct = Number(d.pct) || 0;
    const cells = [d.mount, bytes(d.total), bytes(d.used), pct + '%'];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      // 与丢包率同一套配色：≥90% 标红
      if (i === 3 && pct >= 90) td.className = 'bad';
      tr.append(td);
    });
    table.append(tr);
  });
  box.append(table);
}

/* ---------- 延迟折线 + 丢包条 ---------- */
let _uid = 0;

function pingChart(svg, samples = [], height = 48) {
  const w = 600, h = height, pad = 4;
  if (!svg) return;
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
  [[1, '3'], [0.5, '3,3']].forEach(([f, dash]) => {
    html += `<line x1="0" y1="${py(peak * f).toFixed(1)}" x2="${w}" y2="${py(peak * f).toFixed(1)}" stroke="var(--line)" stroke-dasharray="${dash}"/>`;
  });
  html += `<line x1="0" y1="${baseY}" x2="${w}" y2="${baseY}" stroke="var(--line)"/>`;
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
  const axis = svg.parentElement && svg.parentElement.querySelector('.y-axis');
  if (axis) {
    const spans = axis.querySelectorAll('span');
    if (spans[0]) spans[0].textContent = Math.round(peak);
    if (spans[1]) spans[1].textContent = Math.round(peak / 2);
    if (spans[2]) spans[2].textContent = '0';
  }
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

/* 丢包条：与上方延迟折线共用时间轴。柱子宽度跟随实际时间间隔，
   抽样后的老数据格子更宽，图才没有说谎。 */
function lossChart(svg, samples = [], height = 18) {
  const w = 600, h = height;
  if (!svg) return;
  if (!samples.length) { svg.innerHTML = ''; return; }
  const xs = xPositions(samples, w);
  let bars = '';
  for (let i = 0; i < samples.length; i++) {
    const ratio = sampleLoss(samples[i]);
    const x0 = xs[i];
    const x1 = i + 1 < samples.length ? xs[i + 1] : w;
    const bw = Math.max(1.2, x1 - x0);
    const bh = ratio > 0 ? Math.max(2.5, ratio * (h - 2)) : 1.2;
    const cls = ratio >= 1 ? 'bad' : ratio >= 0.34 ? 'warn' : ratio > 0 ? 'low' : 'none';
    bars += `<rect x="${x0.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" class="loss-bar ${cls}"/>`;
  }
  svg.innerHTML = `<line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="var(--line)"/>` + bars;
}

/* 单运营商丢包时间线：该采样点该运营商探测失败就画一根满高红条，成功则画一条细底线。
   单个采样点只有"通 / 不通"两种结果，所以画成"哪个运营商在什么时候不通"的时间线，
   比画成折线更有意义。与上方延迟折线共用时间轴，可直接对上。 */
function carrierLossChart(svg, samples = [], key = 'ct', height = 10) {
  const w = 600, h = height;
  if (!svg) return;
  if (!samples.length) { svg.innerHTML = ''; return; }
  svg.setAttribute('viewBox', '0 0 600 ' + h);
  svg.setAttribute('preserveAspectRatio', 'none');
  const xs = xPositions(samples, w);
  let bars = '';
  for (let i = 0; i < samples.length; i++) {
    const v = Number(samples[i][key]) || 0;
    const x0 = xs[i];
    const x1 = i + 1 < samples.length ? xs[i + 1] : w;
    const bw = Math.max(1.2, x1 - x0).toFixed(1);
    if (v < 0) {
      bars += `<rect x="${x0.toFixed(1)}" y="1" width="${bw}" height="${h - 2}" class="loss-bar bad"/>`;
    } else if (v > 0) {
      bars += `<rect x="${x0.toFixed(1)}" y="${h - 3}" width="${bw}" height="2" class="loss-bar low"/>`;
    } else {
      bars += `<rect x="${x0.toFixed(1)}" y="${h - 1}" width="${bw}" height="1" class="loss-bar none"/>`;
    }
  }
  svg.innerHTML = `<line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="var(--line)"/>` + bars;
}

/* ---------- 详情页：延迟折线 + 丢包条 + 时间轴缩放的刻度 ---------- */
const CARRIERS = [['ct', '电信', '#2979FF'], ['cu', '联通', '#E64A19'], ['cm', '移动', '#00C853']];

/* 刻度步长：跨度越大格子越粗。
   一律对齐到本地整点（而不是 UTC 整点），否则半小时时区（如印度 +5:30）
   标签会落在 :30 上。 */
function pickTickStep(span) {
  if (span <= 3600) return { step: 600, fmt: 'HH:MM' };          // ≤1h  → 10 分钟
  if (span <= 3 * 3600) return { step: 900, fmt: 'HH:MM' };      // ≤3h  → 15 分钟
  if (span <= 6 * 3600) return { step: 1800, fmt: 'HH:MM' };     // ≤6h  → 30 分钟
  if (span <= 12 * 3600) return { step: 3600, fmt: 'HH:00' };    // ≤12h → 1 小时
  if (span <= 86400) return { step: 3600, fmt: 'HH:00' };        // ≤24h → 1 小时
  return { step: 21600, fmt: 'MM-DD HH' };
}

function fmtTick(ts, fmt) {
  const d = new Date(ts * 1000), p = n => String(n).padStart(2, '0');
  if (fmt === 'HH:MM') return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (fmt === 'MM-DD HH') return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}时`;
  return `${p(d.getHours())}:00`;
}

/* 时间刻度。SVG 用了 preserveAspectRatio="none"，在里面放文字会被横向拉变形，
   所以刻度用 HTML 绝对定位叠在图的下面。 */
function renderTimeAxis(box, samples) {
  if (!box) return;
  box.innerHTML = '';
  if (!samples || samples.length < 2) return;
  const t0 = Number(samples[0].time) || 0;
  const t1 = Number(samples[samples.length - 1].time) || 0;
  if (!(t1 > t0)) return;
  const span = t1 - t0;
  const { step, fmt } = pickTickStep(span);
  const offset = new Date(t0 * 1000).getTimezoneOffset() * 60;   // 秒
  const ticks = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) {
    ticks.push({ x: (t - t0) / span, label: fmtTick(t, fmt) });
  }
  // 宽度不够就抽稀，宁可少几个也不要糊成一片
  const width = box.clientWidth || 0;
  const maxTicks = width ? Math.max(2, Math.floor(width / 46)) : ticks.length;
  const stride = Math.max(1, Math.ceil(ticks.length / maxTicks));
  ticks.forEach((tick, i) => {
    if (i % stride) return;
    const el = document.createElement('span');
    el.className = 'tick';
    el.style.left = (tick.x * 100).toFixed(3) + '%';
    el.textContent = tick.label;
    box.append(el);
  });
}

// 画框选区域（拖拽时显示），用叠加层而不是重画曲线
function drawSelection(svg, x0, x1) {
  const rect = svg.querySelector('.pick');
  if (!rect) return;
  rect.setAttribute('x', Math.min(x0, x1).toFixed(1));
  rect.setAttribute('width', Math.abs(x1 - x0).toFixed(1));
  rect.setAttribute('visibility', Math.abs(x1 - x0) < 2 ? 'hidden' : 'visible');
}

/* ---------- 时间窗口计算（纯函数，便于单测） ---------- */
const PING_MIN_RANGE = 300;
const PING_MAX_RANGE = 86400;

function clampWindow(range, end, oldest, newest) {
  const span = Math.max(1, newest - oldest);
  const r = Math.min(Math.max(range, PING_MIN_RANGE), Math.min(PING_MAX_RANGE, span));
  let e = (end == null || !isFinite(end)) ? newest : end;
  e = Math.min(Math.max(e, oldest + r), newest);
  if (oldest + r > newest) e = newest;      // 数据比窗口还短，贴着最新
  return { range: r, end: e };
}

/* factor < 1 放大，> 1 缩小；focus 是缩放中心的时间戳 */
function zoomWindow(range, end, factor, focus, oldest, newest) {
  const { range: r0, end: e0 } = clampWindow(range, end, oldest, newest);
  const since = e0 - r0;
  const ratio = Math.min(Math.max((focus - since) / r0, 0), 1);
  const r = r0 * factor;
  return clampWindow(r, focus + (1 - ratio) * r, oldest, newest);
}

function panWindow(range, end, deltaT, oldest, newest) {
  const { range: r0, end: e0 } = clampWindow(range, end, oldest, newest);
  return clampWindow(r0, e0 + deltaT, oldest, newest);
}

/* ---------- 路由：只有 #/node/<id> 一种，其余一律回列表 ---------- */
function route() {
  const m = /^#\/node\/([0-9a-fA-F]{6,64})$/.exec(location.hash || '');
  if (m) openDetail(m[1]);
  else closeDetail();
}
window.addEventListener('hashchange', route);

$('#detail-back').onclick = () => { location.hash = ''; };

$('#detail-share').onclick = async () => {
  const btn = $('#detail-share');
  const url = (typeof location !== 'undefined' && String(location.href || '')
    .replace(/#.*$/, '') || '') + '#/node/' + (_detailId || '');
  try {
    await navigator.clipboard.writeText(url);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* 复制不了就算了，链接已在地址栏 */ }
    document.body.removeChild(ta);
  }
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = '分享'; }, 2000);
};

/* ---------- 时间轴：预设区间 / 缩放 / 平移 / 框选 ---------- */
function syncRangeButtons() {
  document.querySelectorAll('#detail-range button').forEach(x => {
    x.classList.toggle('active', Number(x.dataset.range) === _detailRange && _detailEnd == null);
  });
}

document.querySelectorAll('#detail-range button').forEach(btn => {
  btn.onclick = () => {
    const range = Number(btn.dataset.range) || DETAIL_DEFAULT_RANGE;
    if (range === _detailRange && _detailEnd == null) return;
    setWindow(range, null);            // 预设按钮 = 贴着现在，跟着新数据走
  };
});

/* 缩放：factor < 1 放大。有 focus（0~1 的横向比例）就以该点为中心。 */
function zoomBy(factor, focusRatio) {
  const cur = currentWindow();
  const focus = focusRatio == null ? cur.end - cur.range / 2
                                   : cur.end - cur.range * (1 - focusRatio);
  applyWindow(zoomWindow(cur.range, cur.end, factor, focus,
                         detailExtent().oldest, detailExtent().newest));
}

function shiftBy(fraction) {
  const cur = currentWindow();
  applyWindow(panWindow(cur.range, cur.end, cur.range * fraction,
                        detailExtent().oldest, detailExtent().newest));
}

const onId = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
onId('#ping-in', () => zoomBy(0.5, 0.5));
onId('#ping-out', () => zoomBy(2, 0.5));
onId('#ping-left', () => shiftBy(-0.5));
onId('#ping-right', () => shiftBy(0.5));
onId('#ping-reset', () => setWindow(_detailRange, null));   // 回到"最新"

/* 在图上拖拽 = 框选一段时间并放大 */
(function wireDragSelect() {
  const svg = document.querySelector('#node-detail .ping-svg');
  if (!svg) return;
  let startX = null;
  const svgX = ev => {
    const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    if (!rect || !rect.width) return null;
    return (ev.clientX - rect.left) / rect.width * 600;
  };
  svg.addEventListener('mousedown', ev => {
    const x = svgX(ev);
    if (x == null) return;
    startX = x;
    drawSelection(svg, x, x);
  });
  svg.addEventListener('mousemove', ev => {
    if (startX == null) return;
    const x = svgX(ev);
    if (x != null) drawSelection(svg, startX, x);
  });
  const finish = ev => {
    if (startX == null) return;
    const endX = svgX(ev);
    const from = startX;
    startX = null;
    drawSelection(svg, 0, 0);
    if (endX == null || Math.abs(endX - from) < 8) return;   // 太窄当误触
    const cur = currentWindow();
    const since = cur.end - cur.range;
    const t0 = since + Math.min(from, endX) / 600 * cur.range;
    const t1 = since + Math.max(from, endX) / 600 * cur.range;
    applyWindow(clampWindow(t1 - t0, t1, detailExtent().oldest, detailExtent().newest));
  };
  svg.addEventListener('mouseup', finish);
  svg.addEventListener('mouseleave', ev => {
    if (startX != null) finish(ev);
  });
  // 滚轮缩放：必须按住 Ctrl/⌘，否则会和页面滚动打架
  svg.addEventListener('wheel', ev => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const x = svgX(ev);
    zoomBy(ev.deltaY > 0 ? 2 : 0.5, x == null ? 0.5 : x / 600);
  }, { passive: false });
})();

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
  renderThresholds(s.threshold_meta || [], s.thresholds || {});
}

/* ---------- 后台：告警阈值 ---------- */
function renderThresholds(meta, values) {
  const box = $('#th-grid');
  if (!box) return;
  // 元信息来自服务端，前端不抄一份取值范围；正在编辑的输入框不动
  const editing = box.contains && box.contains(document.activeElement);
  if (editing) return;
  box.innerHTML = '';
  meta.forEach(m => {
    const wrap = document.createElement('label');
    wrap.className = 'th-item';
    const name = document.createElement('span');
    name.textContent = m.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.id = 'th-' + m.key;
    input.min = String(m.min);
    input.max = String(m.max);
    input.value = String(values[m.key] != null ? values[m.key] : m.default);
    input.title = `${m.min} ~ ${m.max}（默认 ${m.default}）`;
    wrap.append(name, input);
    box.append(wrap);
  });
}

$('#save-th').onclick = async () => {
  const box = $('#th-grid');
  const thresholds = {};
  box.querySelectorAll('input').forEach(inp => {
    const key = inp.id.replace(/^th-/, '');
    const v = Number(inp.value);
    if (Number.isFinite(v)) thresholds[key] = v;
  });
  try {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ thresholds }) });
    alert('阈值已保存');
    loadAdmin();
  } catch (e) { alert(e.message); }
};

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
