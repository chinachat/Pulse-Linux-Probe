/* Pulse Linux Probe — 前端逻辑
   零依赖原生 JS；遵守 CSP：script-src 'self'（无内联脚本/事件处理器） */
const $ = s => document.querySelector(s);
let _csrf = '';

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
function bytes(v) {
  v = Number(v) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(1) + ' TB';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB';
  return (v / 1e3).toFixed(0) + ' KB';
}
/* hex 颜色转 rgba（用于 canvas 渐变） */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ---------- OS 图标（CSP 兼容：不在 HTML 中内联 onerror，由 JS 绑定） ---------- */
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
  const src = 'https://cdn.jsdelivr.net/npm/simple-icons@14/icons/'
    + cls.replace('rocky', 'rockylinux').replace('alma', 'almalinux')
        .replace('arch', 'archlinux').replace('alpine', 'alpinelinux')
        .replace('suse', 'opensuse') + '.svg';
  return `<span class="os-tag ${cls}"><img src="${src}" class="os-svg" alt="" loading="lazy"><b>${label}</b>${ver}</span>`;
}

/* ---------- Ping 历史图（SVG 折线 + 面积渐变 + 端点） ---------- */
let _uid = 0;
function pingChart(svg, history = []) {
  const w = 600, h = 48, pad = 4;
  const samples = history.slice(-60);
  if (!samples.length) return;
  const all = samples.flatMap(s => ['ct', 'cu', 'cm'].map(k => Number(s[k]) || 0)).filter(v => v > 0);
  const peak = Math.max(1, ...all);
  if (!all.length) return;
  const py = v => h - pad - (Number(v) || 0) / peak * (h - pad * 2);
  const px = i => (samples.length > 1 ? i * w / (samples.length - 1) : w / 2);
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
      if (v > 0) pts.push([px(i), py(v)]);
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

/* ---------- 实时网络速率图（canvas 面积渐变 + 双曲线） ---------- */
function networkChart(canvas, history = [], current = {}) {
  const parentW = canvas.parentElement.clientWidth;
  const w = parentW || 270, h = 64, ml = 36, d = devicePixelRatio || 1, c = canvas.getContext('2d');
  canvas.width = w * d; canvas.height = h * d; c.scale(d, d);
  const cs = getComputedStyle(document.body);
  const muted = cs.getPropertyValue('--muted').trim() || '#64766e';
  const grid = cs.getPropertyValue('--line').trim() || '#22302b';
  const rxColor = cs.getPropertyValue('--net-rx').trim() || '#38bdf8';
  const txColor = cs.getPropertyValue('--net-tx').trim() || '#10b981';
  const cardBg = cs.getPropertyValue('--card').trim() || '#121a17';
  let samples = (history || []).slice(-30).map(x => ({ rx: Number(x.rx) || 0, tx: Number(x.tx) || 0 }));
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
  // OS 标签（error 事件用 JS 绑定，规避 CSP 对内联 onerror 的限制）
  e.querySelector('.os').innerHTML = osIcon(n.os);
  e.querySelectorAll('.os-svg').forEach(img => img.addEventListener('error', () => img.remove()));
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
  // Ping 徽章 + 丢包率
  const prow = e.querySelector('.ping-row');
  if (prow) {
    const icons = { ct: '电信', cu: '联通', cm: '移动' };
    const lr = {};
    if (n.ping_history && n.ping_history.length) {
      ['ct', 'cu', 'cm'].forEach(k => {
        const lost = n.ping_history.filter(s => Number(s[k]) <= 0).length;
        lr[k] = Math.round(lost / n.ping_history.length * 100);
      });
    }
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
  // Ping 历史图
  const ps = card.querySelector('.ping-svg');
  if (ps && n.ping_history) pingChart(ps, n.ping_history);
  // 网络速率图（等布局完成后绘制，保证 canvas 宽度正确）
  const netCanvas = card.querySelector('.net-canvas');
  if (netCanvas) requestAnimationFrame(() => networkChart(netCanvas, n.history, n));
}

/* ---------- 仪表盘渲染 ---------- */
function render(nodes) {
  const onlineCount = nodes.filter(n => n.online).length;
  animateNumber($('#online'), onlineCount);
  animateNumber($('#total'), nodes.length);
  const box = $('#nodes');
  box.innerHTML = '';
  // 按国家分组
  const groups = {}; const offline = [];
  nodes.forEach(n => {
    if (n.online) { const cc = n.country || '??'; (groups[cc] = groups[cc] || []).push(n); }
    else { offline.push(n); }
  });
  // 空状态
  if (!nodes.length) {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.innerHTML = '<b>&#128225;</b><p>暂无节点上报</p><p>请在管理后台生成 API Key 并在目标主机安装客户端。</p>';
    box.appendChild(d);
    updateGroupNav();
    return;
  }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('probe-groups') || '{}'); } catch (_) {}
  function addGroup(label, groupNodes, alwaysOpen) {
    const g = document.createElement('div'); g.className = 'group';
    const h = document.createElement('div'); h.className = 'group-header';
    h.innerHTML = '<b>' + label + '</b><span>' + groupNodes.length + '</span>';
    const c = document.createElement('div'); c.className = 'group-content';
    groupNodes.forEach(n => createCard(n, c));
    const key = label.replace(/<[^>]+>/g, '').trim();
    if (!alwaysOpen && saved[key]) { c.classList.add('collapsed'); h.classList.add('collapsed'); }
    h.onclick = () => {
      c.classList.toggle('collapsed'); h.classList.toggle('collapsed');
      saved[key] = c.classList.contains('collapsed');
      localStorage.setItem('probe-groups', JSON.stringify(saved));
    };
    g.append(h, c); box.appendChild(g);
  }
  Object.keys(groups).sort().forEach(cc => addGroup(countryFlag(cc), groups[cc]));
  if (offline.length) addGroup('离线节点', offline, true);
  // 分组控制
  const ctrl = document.createElement('div'); ctrl.className = 'group-controls';
  const expandBtn = document.createElement('button');
  expandBtn.className = 'small'; expandBtn.textContent = '全部展开';
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'small'; collapseBtn.textContent = '全部收起';
  ctrl.append(expandBtn, collapseBtn);
  expandBtn.onclick = () => { box.querySelectorAll('.group-content,.group-header').forEach(el => el.classList.remove('collapsed')); localStorage.removeItem('probe-groups'); };
  collapseBtn.onclick = () => {
    box.querySelectorAll('.group-content,.group-header').forEach(el => el.classList.add('collapsed'));
    const all = {}; box.querySelectorAll('.group-header b').forEach(b => { all[b.textContent] = true; });
    localStorage.setItem('probe-groups', JSON.stringify(all));
  };
  box.insertBefore(ctrl, box.firstChild);
  updateGroupNav();
}

let _lastNodes = null;
let _lastNodesSig = '';
async function refresh() {
  try {
    const data = (await api('/api/nodes')).nodes;
    const sig = JSON.stringify(data);
    if (sig === _lastNodesSig) return;
    _lastNodesSig = sig;
    _lastNodes = data;
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
$('#admin').onclick = () => { $('#dashboard').hidden = true; $('#admin-panel').hidden = false; };
$('#back').onclick = () => { $('#dashboard').hidden = false; $('#admin-panel').hidden = true; };

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
  nodes.forEach(x => {
    const row = document.createElement('div');
    row.className = 'edit-node';
    const name = document.createElement('input');
    name.value = x.name || '';
    name.placeholder = '节点名称';
    const country = document.createElement('input');
    country.value = x.country || '';
    country.placeholder = '国家代码';
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
    row.append(name, country, save, del);
    n.append(row);
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
// 管理后台打开期间每 10 秒自动刷新；正在编辑（光标停在输入框）时跳过
setInterval(() => {
  const a = document.activeElement;
  const editing = a && a.tagName === 'INPUT' && $('#manage').contains(a);
  if (!$('#admin-panel').hidden && !$('#manage').hidden && !editing) loadAdmin().catch(() => {});
}, 10000);

/* ---------- 分组侧边导航 ---------- */
function updateGroupNav() {
  const nav = $('#group-nav');
  if ($('#dashboard').hidden) { nav.style.display = 'none'; return; }
  nav.style.display = '';
  nav.querySelectorAll('.nav-group,.nav-node,.nav-ctrl').forEach(el => el.remove());
  document.querySelectorAll('.group').forEach(g => {
    const b = g.querySelector('.group-header b');
    if (!b) return;
    const a = document.createElement('a');
    a.className = 'nav-group';
    a.innerHTML = b.innerHTML;
    a.onclick = () => g.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nav.insertBefore(a, nav.querySelector('.nav-top'));
    g.querySelectorAll('.node-row strong, .node-title strong').forEach(s => {
      const na = document.createElement('a');
      na.className = 'nav-node';
      na.textContent = s.textContent;
      na.onclick = (e) => {
        e.stopPropagation();
        const card = s.closest('.card');
        const group = card.closest('.group');
        if (group) {
          const gc = group.querySelector('.group-content');
          const gh = group.querySelector('.group-header');
          if (gc.classList.contains('collapsed')) {
            gc.classList.remove('collapsed'); gh.classList.remove('collapsed');
            const key = (gh.querySelector('b') || {}).textContent || '';
            const saved = JSON.parse(localStorage.getItem('probe-groups') || '{}');
            delete saved[key.replace(/<[^>]+>/g, '').trim()];
            localStorage.setItem('probe-groups', JSON.stringify(saved));
          }
        }
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      nav.insertBefore(na, nav.querySelector('.nav-top'));
    });
  });
  document.querySelectorAll('.group').forEach(g => navObserver.observe(g));
}
$('#group-nav .nav-top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
$('#nav-toggle').onclick = () => $('#group-nav').classList.toggle('visible');
const navObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const b = e.target.querySelector('.group-header b');
    if (!b) return;
    const key = b.textContent;
    document.querySelectorAll('#group-nav .nav-group').forEach(a => {
      const ab = a.querySelector('b');
      a.classList.toggle('active', ab && ab.textContent === key);
    });
  });
}, { rootMargin: '-20% 0px -60% 0px' });
