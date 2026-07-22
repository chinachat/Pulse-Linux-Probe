const $ = s => document.querySelector(s);
const api = (u, o = {}) => fetch(u, { headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, ...o })
  .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw Error(b.error || 'HTTP ' + r.status); return b; });

function countryFlag(code) {
  const cc = (code || '').toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? `<img src="https://flagcdn.com/w40/${cc.toLowerCase()}.png" width="20" height="15" alt="${cc}"> ${cc}` : '未知';
}
function mbpsNum(value) {
  const n = (Number(value) || 0) * 8 / 1e6;  // bytes/s -> megabits/s
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}
function mbps(value) { return mbpsNum(value) + ' Mbps'; }

function networkChart(canvas, history = [], current = {}) {
  const w = 270, h = 64, ml = 34, d = devicePixelRatio || 1, c = canvas.getContext('2d');
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
  // 曲线 + 末端圆点 + 当前值标注（rx 标在上方，tx 标在下方，避免重叠）
  [['rx', '#38bdf8', -7], ['tx', '#10b981', 14]].forEach(([key, color, dy]) => {
    c.beginPath();
    samples.forEach((x, i) => { i ? c.lineTo(px(i), py(x[key])) : c.moveTo(px(0), py(x[key])); });
    c.strokeStyle = color; c.lineWidth = 2; c.stroke();
    const last = samples[samples.length - 1];
    const lx = px(samples.length - 1), ly = py(last[key]);
    c.fillStyle = color;
    c.beginPath(); c.arc(lx, ly, 3, 0, Math.PI * 2); c.fill();
    const label = mbpsNum(last[key]);
    c.font = "10px 'DM Mono', monospace";
    const tx = Math.max(ml, lx - c.measureText(label).width - 6);
    const ty = Math.min(Math.max(ly + dy, 9), h - 2);
    c.fillText(label, tx, ty);
  });
}
function duration(s) {
  s = Number(s) || 0;
  if (s >= 86400) return Math.floor(s / 86400) + '天';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return `${h}小时 ${m}分`;
}
function gauge(canvas, v) {
  const c = canvas.getContext('2d'), d = devicePixelRatio || 1;
  c.canvas.width = c.canvas.height = 62 * d; c.scale(d, d); c.lineWidth = 6;
  c.strokeStyle = getComputedStyle(document.body).getPropertyValue('--line');
  c.beginPath(); c.arc(31, 31, 25, -1.57, 4.71); c.stroke();
  c.strokeStyle = v > 80 ? '#f97316' : '#10b981';
  c.beginPath(); c.arc(31, 31, 25, -1.57, 4.71 * v / 100 - 1.57); c.stroke();
}
function render(nodes) {
  $('#online').textContent = nodes.filter(n => n.online).length;
  const box = $('#nodes');
  box.innerHTML = '';
  nodes.forEach(n => {
    const e = $('#node-card').content.cloneNode(true);
    const ms = [n.cpu, n.memory, n.disk];
    // 标题行：状态点 + 主机名 + 国旗 + IP 一排展示
    e.querySelector('strong').textContent = n.name || '未命名节点';
    e.querySelector('.loc').innerHTML = countryFlag(n.country);
    e.querySelector('.ip').textContent = n.ip;
    e.querySelector('i').className = n.online ? '' : 'offline';
    e.querySelector('.status').textContent = n.online ? '在线' : '离线';
    e.querySelector('.os').textContent = n.os || '系统未知';
    e.querySelector('.uptime').textContent = '运行 ' + duration(n.uptime);
    // 网络区块：实时速率（Mbps）与动态图表放在一起
    e.querySelector('.net').textContent = mbps(n.network_rx) + ' ↓ / ' + mbps(n.network_tx) + ' ↑';
    e.querySelectorAll('.metrics div').forEach((x, i) => {
      gauge(x.querySelector('canvas'), ms[i] || 0);
      x.querySelector('b').textContent = (ms[i] || 0) + '%';
    });
    networkChart(e.querySelector('.network-chart canvas'), n.history, n);
    box.append(e);
  });
}
async function refresh() {
  try { render((await api('/api/nodes')).nodes); } catch (e) { console.error(e); }
}

$('#theme').onclick = () => {
  document.body.classList.toggle('dark');
  $('#theme').textContent = document.body.classList.contains('dark') ? '浅色' : '深色';
  refresh();
};
$('#layout').onclick = () => $('#nodes').classList.toggle('list');
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
  const [keys, nodes, blocked] = await Promise.all([
    api('/api/admin/keys'), api('/api/admin/nodes'), api('/api/admin/blocked'),
  ]);
  const sig = JSON.stringify([keys, nodes, blocked]);
  if (sig === lastAdminSig) return;  // 数据没变化不重绘，避免打断正在编辑的输入
  lastAdminSig = sig;
  renderKeys(keys.keys);
  renderAdminNodes(nodes.nodes);
  renderBlocked(blocked.blocked);
}
function renderKeys(keys) {
  const k = $('#keys');
  k.innerHTML = '';
  keys.forEach(x => {
    const row = document.createElement('div');
    row.className = 'key';
    const info = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = x.label;
    const code = document.createElement('code');
    code.textContent = x.key;
    info.append(label, document.createElement('br'), code);
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
$('#new-key').onclick = async () => {
  try {
    await api('/api/admin/keys', { method: 'POST', body: JSON.stringify({ label: $('#key-label').value || '新密钥' }) });
    $('#key-label').value = '';
    loadAdmin();
  } catch (e) { alert(e.message); }
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
