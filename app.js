const $ = s => document.querySelector(s);
const api = (u, o = {}) => fetch(u, { headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, ...o })
  .then(async r => {
    let b = {};
    try { b = await r.json(); } catch (_) { /* non-json body */ }
    if (!r.ok) throw Error(b.error || 'HTTP ' + r.status);
    return b;
  });

function countryFlag(code) {
  const cc = (code || '').toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? `<img src="https://flagcdn.com/w40/${cc.toLowerCase()}.png" width="20" height="15" alt="${cc}"> ${cc}` : '未知';
}
function mbpsNum(value) {
  const n = (Number(value) || 0) * 8 / 1e6;  // bytes/s -> megabits/s
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}
function mbps(value) { return mbpsNum(value) + ' Mbps'; }

function pingChart(canvas, history = []) {
  const w = 270, h = 64, ml = 34, d = devicePixelRatio || 1, c = canvas.getContext('2d');
  const parentW = canvas.parentElement.clientWidth;
  const pw = (parentW || w);
  canvas.width = pw * d; canvas.height = h * d; canvas.style.width = pw + 'px';
  c.scale(d, d);
  const samples = history.slice(-60);
  if (!samples.length) return;
  const colors = { ct: '#2979FF', cu: '#E64A19', cm: '#00C853' };
  const px = i => ml + (samples.length > 1 ? i * (pw - ml) / (samples.length - 1) : (pw - ml) / 2);
  const all = samples.flatMap(s => ['ct','cu','cm'].map(k => Number(s[k]) || 0)).filter(v => v > 0);
  const peak = Math.max(1, ...all);
  if (!all.length) return;
  const py = v => h - 6 - (Number(v) || 0) / peak * (h - 14);
  const cs = getComputedStyle(document.body);
  const muted = cs.getPropertyValue('--muted'), grid = cs.getPropertyValue('--line');
  c.font = "8px 'DM Mono', monospace";
  [[1, []], [0.5, [3,3]], [0.25, [1,2]]].forEach(([f, dash]) => {
    c.strokeStyle = grid; c.setLineDash(dash);
    const y = py(peak * f);
    c.beginPath(); c.moveTo(ml, y); c.lineTo(pw, y); c.stroke();
    c.setLineDash([]);
    c.fillStyle = muted; c.fillText(Math.round(peak * f), 0, y + 3);
  });
  c.strokeStyle = grid;
  c.beginPath(); c.moveTo(ml, h - 4); c.lineTo(pw, h - 4); c.stroke();
  ['ct','cu','cm'].forEach(key => {
    const color = colors[key];
    c.beginPath();
    samples.forEach((s, i) => { const v = Number(s[key]) || 0; if (!v) return; i ? c.lineTo(px(i), py(v)) : c.moveTo(px(0), py(v)); });
    c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
  });
}
function networkChart(canvas, history = [], current = {}) {
  const parentW = canvas.parentElement.clientWidth;
  const w = parentW || 270, h = 64, ml = 34, d = devicePixelRatio || 1, c = canvas.getContext('2d');
  canvas.width = w * d; canvas.height = h * d; c.scale(d, d);
  const cs = getComputedStyle(document.body);
  const muted = cs.getPropertyValue('--muted'), grid = cs.getPropertyValue('--line');
  let samples = history.slice(-30);
  if (!samples.length) samples = [{ rx: current.network_rx || 0, tx: current.network_tx || 0 }];
  const peak = Math.max(1, ...samples.flatMap(x => [Number(x.rx) || 0, Number(x.tx) || 0]));
  const pw = w - ml;
  const px = i => ml + (samples.length > 1 ? i * pw / (samples.length - 1) : pw / 2);
  const py = v => h - (Number(v) || 0) / peak * (h - 18) - 6;
  // Y 轴刻度：峰值实线 + 半峰虚线，数字单位 Mbps
  c.font = "9px 'DM Mono', monospace";
  [[1, []], [0.5, [3, 3]]].forEach(([f, dash]) => {
    c.strokeStyle = grid; c.setLineDash(dash);
    c.beginPath(); c.moveTo(ml, py(peak * f)); c.lineTo(w, py(peak * f)); c.stroke();
    c.setLineDash([]);
    c.fillStyle = muted; c.fillText(mbpsNum(peak * f), 0, py(peak * f) + 3);
  });
  // 基线
  c.strokeStyle = grid;
  c.beginPath(); c.moveTo(ml, h - 4); c.lineTo(w, h - 4); c.stroke();
  // 曲线 + 末端圆点
  [['rx', '#38bdf8'], ['tx', '#10b981']].forEach(([key, color]) => {
    c.beginPath();
    samples.forEach((x, i) => { i ? c.lineTo(px(i), py(x[key])) : c.moveTo(px(0), py(x[key])); });
    c.strokeStyle = color; c.lineWidth = 2; c.stroke();
    const last = samples[samples.length - 1];
    const lx = px(samples.length - 1), ly = py(last[key]);
    c.fillStyle = color;
    c.beginPath(); c.arc(lx, ly, 3, 0, Math.PI * 2); c.fill();
  });
}
function duration(s) {
  s = Number(s) || 0;
  if (s >= 86400) return Math.floor(s / 86400) + '天';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return `${h}小时 ${m}分`;
}
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
  const src = 'https://cdn.jsdelivr.net/npm/simple-icons@14/icons/' + cls.replace('rocky','rockylinux').replace('alma','almalinux').replace('arch','archlinux').replace('alpine','alpinelinux').replace('suse','opensuse') + '.svg';
  return '<span class="os-tag ' + cls + '"><img src="' + src + '" class="os-svg" onerror="this.remove()"><b>' + label + '</b>' + ver + '</span>';
}
function bytesTotal(rx, tx) {
  if (!rx && !tx) return '';
  const f = v => { v = Number(v) || 0; return v >= 1e12 ? (v/1e12).toFixed(1)+'TB' : v >= 1e9 ? (v/1e9).toFixed(1)+'GB' : (v/1e6).toFixed(1)+'MB'; };
  return f(rx) + ' ↓ / ' + f(tx) + ' ↑';
}
function bytes(v) {
  v = Number(v) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(1) + ' TB';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + ' GB';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB';
  return (v / 1e3).toFixed(0) + ' KB';
}
function gauge(canvas, v, label, sub) {
  const c = canvas.getContext('2d'), d = devicePixelRatio || 1;
  c.canvas.width = c.canvas.height = 40 * d; c.scale(d, d); c.lineWidth = 5;
  c.strokeStyle = getComputedStyle(document.body).getPropertyValue('--line');
  c.beginPath(); c.arc(20, 20, 16, -1.57, 4.71); c.stroke();
  c.strokeStyle = v > 80 ? '#f97316' : '#10b981';
  c.beginPath(); c.arc(20, 20, 16, -1.57, 4.71 * v / 100 - 1.57); c.stroke();
  const cs = getComputedStyle(document.body);
  c.fillStyle = cs.getPropertyValue('--text');
  c.font = "bold 10px 'DM Mono', monospace";
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(label, 20, sub ? 17 : 20);
  if (sub) {
    c.fillStyle = cs.getPropertyValue('--muted');
    c.font = "7px 'Noto Sans SC', sans-serif";
    c.fillText(sub, 20, 27);
  }
}
function createCard(n, container) {
  const e = $('#node-card').content.cloneNode(true);
  const ms = [n.cpu, n.memory, n.disk];
  e.querySelector('strong').textContent = n.name || '未命名节点';
  e.querySelector('.loc').innerHTML = countryFlag(n.country);
  e.querySelector('.ip').textContent = n.ip;
  e.querySelector('i').className = n.online ? '' : 'offline';
  e.querySelector('.status').textContent = n.online ? '在线' : '离线';
    e.querySelector('.os').innerHTML = osIcon(n.os);
    e.querySelector('.uptime').textContent = '运行 ' + duration(n.uptime);
    e.querySelector('.traffic').textContent = bytesTotal(n.net_total_rx, n.net_total_tx);
    e.querySelector('.net').textContent = mbps(n.network_rx) + ' ↓ / ' + mbps(n.network_tx) + ' ↑';
    const prow = e.querySelector('.ping-row');
    if (prow) {
      const icons = { ct: '电信', cu: '联通', cm: '移动' };
      prow.innerHTML = ['ct','cu','cm'].map(k => {
        const v = n['tcp_ping_' + k];
        if (!v) return '';
        const ms = Number(v);
        const cls = ms < 0 ? 'timeout' : ms <= 100 ? 'fast' : ms <= 300 ? 'mid' : 'slow';
        return '<span class="ping ' + k + ' ' + cls + '"><i>' + icons[k] + '</i> ' + (ms < 0 ? '超时' : ms) + '</span>';
      }).join('');
    }
  container.append(e);
  const card = container.lastElementChild;
  card.querySelectorAll('.mg').forEach((x, i) => {
    const labels = [
      [ms[0] + '%', n.cpu_cores ? n.cpu_cores + '核' : ''],
      [ms[1] + '%', n.mem_total ? bytes(n.mem_total) : ''],
      [ms[2] + '%', n.disk_total ? bytes(n.disk_total) : ''],
    ];
    gauge(x.querySelector('canvas'), ms[i] || 0, labels[i][0], labels[i][1]);
    x.querySelector('b').textContent = labels[i][0];
    x.querySelector('small').textContent = labels[i][1];
  });
  const pc = card.querySelector('.ping-chart canvas');
  if (pc && n.ping_history) pingChart(pc, n.ping_history);
}
function render(nodes) {
  $('#online').textContent = nodes.filter(n => n.online).length;
  const box = $('#nodes');
  box.innerHTML = '';
  // group online nodes by country
  const groups = {}; const offline = [];
  nodes.forEach(n => {
    if (n.online) { const cc = n.country || '??'; (groups[cc] = groups[cc] || []).push(n); }
    else { offline.push(n); }
  });
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
  // controls
  const ctrl = document.createElement('div'); ctrl.className = 'group-controls';
  ctrl.innerHTML = '<button class="small">全部展开</button><button class="small">全部收起</button>';
  ctrl.children[0].onclick = () => { box.querySelectorAll('.group-content,.group-header').forEach(el => el.classList.remove('collapsed')); localStorage.removeItem('probe-groups'); };
  ctrl.children[1].onclick = () => { box.querySelectorAll('.group-content,.group-header').forEach(el => el.classList.add('collapsed')); const all = {}; box.querySelectorAll('.group-header b').forEach(b => { all[b.textContent] = true; }); localStorage.setItem('probe-groups', JSON.stringify(all)); };
  box.appendChild(ctrl);
  // online groups
  Object.keys(groups).sort().forEach(cc => addGroup(countryFlag(cc) + ' ' + cc, groups[cc]));
  if (offline.length) addGroup('离线节点', offline, true);
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
  } catch (e) { console.error(e); alert('渲染失败: ' + e.message); }
}

$('#theme').onclick = () => {
  document.body.classList.toggle('dark');
  $('#theme').textContent = document.body.classList.contains('dark') ? '浅色' : '深色';
  if (_lastNodes) render(_lastNodes);
};
$('#admin').onclick = () => { $('#dashboard').hidden = true; $('#admin-panel').hidden = false; };
$('#back').onclick = () => { $('#dashboard').hidden = false; $('#admin-panel').hidden = true; };

$('#login-btn').onclick = async () => {
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
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

// Render admin rows with DOM APIs only - never interpolate server data into
// innerHTML, otherwise a hostile hostname/label could inject markup (XSS).
let lastAdminSig = '';
async function loadAdmin() {
  const [keys, nodes, blocked, settings] = await Promise.all([
    api('/api/admin/keys'), api('/api/admin/nodes'), api('/api/admin/blocked'), api('/api/admin/settings'),
  ]);
  const sig = JSON.stringify([keys, nodes, blocked, settings]);
  if (sig === lastAdminSig) return;  // 数据没变化不重绘，避免打断正在编辑的输入
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
    editBtn.textContent = '编辑';
    editBtn.className = 'small';
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
    use.textContent = '客户端安装';
    use.onclick = async () => {
      const s = (await api('/api/install.sh?key=' + encodeURIComponent(x.key))).script;
      const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
      $('#install').textContent = `echo '${base64}' | base64 -d | bash`;
    };
    const del = document.createElement('button');
    del.textContent = '删除';
    del.onclick = async () => {
      await fetch('/api/admin/keys/' + x.id, { method: 'DELETE' });
      loadAdmin();
    };
    actions.append(use, del);
    row.append(info, actions);
    k.append(row);
  });
}
function renderAdminNodes(nodes) {
  const n = $('#admin-nodes');
  n.innerHTML = '';
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
      loadAdmin();  // 后台列表同步刷新，不然改名/归属地看起来没生效
    };
    const del = document.createElement('button');
    del.textContent = '删除节点';
    del.onclick = async () => {
      if (confirm('确定删除该节点吗？删除后其上报将被封禁，可在下方“已封禁节点”中解封。')) {
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
  ['ct','cu','cm'].forEach(k => { const el = $('#ping-' + k); if (el && document.activeElement !== el) el.value = s['ping_' + k] || ''; });
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
    ['ct','cu','cm'].forEach(k => { const v = $('#ping-' + k).value.trim(); if (v) body['ping_' + k] = v; });
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
refresh();
setInterval(refresh, 5000);
// 管理后台打开期间每 10 秒自动刷新密钥与节点列表；
// 正在编辑（光标停在任意输入框）时跳过本次刷新，避免冲掉输入内容
setInterval(() => {
  const a = document.activeElement;
  const editing = a && a.tagName === 'INPUT' && $('#manage').contains(a);
  if (!$('#admin-panel').hidden && !$('#manage').hidden && !editing) loadAdmin().catch(() => {});
}, 10000);
function updateGroupNav() {
  const nav = $('#group-nav');
  if ($('#dashboard').hidden) { nav.style.display = 'none'; return; }
  nav.style.display = '';
  nav.querySelectorAll('.nav-group').forEach(el => el.remove());
  document.querySelectorAll('.group').forEach(g => {
    const b = g.querySelector('.group-header b');
    if (!b) return;
    const a = document.createElement('a');
    a.className = 'nav-group';
    a.innerHTML = b.innerHTML;
    a.onclick = () => g.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nav.insertBefore(a, nav.querySelector('.nav-top'));
  });
  document.querySelectorAll('.group').forEach(g => navObserver.observe(g));
}
$('#group-nav .nav-top').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
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
