const $ = s => document.querySelector(s);
const api = (u, o = {}) => fetch(u, { headers: { 'Content-Type': 'application/json', ...(o.headers || {}) }, ...o })
  .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw Error(b.error || 'HTTP ' + r.status); return b; });

function countryFlag(code) {
  const cc = (code || '').toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? `<img src="https://flagcdn.com/w40/${cc.toLowerCase()}.png" width="20" height="15" alt="${cc}"> ${cc}` : '未知';
}
function rate(value) {
  let n = Number(value) || 0;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
}
function networkChart(canvas, history = [], current = {}) {
  const w = 270, h = 56, d = devicePixelRatio || 1, c = canvas.getContext('2d');
  canvas.width = w * d; canvas.height = h * d; c.scale(d, d);
  let samples = history.slice(-30);
  if (!samples.length) samples = [{ rx: current.network_rx || 0, tx: current.network_tx || 0 }];
  const peak = Math.max(1, ...samples.flatMap(x => [Number(x.rx) || 0, Number(x.tx) || 0]));
  c.strokeStyle = getComputedStyle(document.body).getPropertyValue('--line');
  c.beginPath(); c.moveTo(0, h - 2); c.lineTo(w, h - 2); c.stroke();
  [['rx', '#38bdf8'], ['tx', '#10b981']].forEach(([key, color]) => {
    c.beginPath();
    samples.forEach((x, i) => {
      const px = samples.length > 1 ? i * w / (samples.length - 1) : w / 2;
      const py = h - (Number(x[key]) || 0) / peak * (h - 8) - 4;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    });
    c.strokeStyle = color; c.lineWidth = 2; c.stroke();
    const last = samples[samples.length - 1];
    const y = h - (Number(last[key]) || 0) / peak * (h - 8) - 4;
    c.fillStyle = color; c.beginPath();
    c.arc(samples.length > 1 ? w : w / 2, y, 3, 0, Math.PI * 2); c.fill();
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
    e.querySelector('strong').textContent = n.name || '未命名节点';
    e.querySelector('i').className = n.online ? '' : 'offline';
    e.querySelector('.status').textContent = n.online ? '在线' : '离线';
    e.querySelector('.ip').textContent = 'IP ' + n.ip;
    e.querySelector('.loc').innerHTML = countryFlag(n.country);
    e.querySelector('.os').textContent = n.os || '系统未知';
    e.querySelector('.uptime').textContent = '运行 ' + duration(n.uptime);
    e.querySelector('.net').textContent = '网络 ' + rate(n.network_rx) + ' ↓ / ' + rate(n.network_tx) + ' ↑';
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
    loadAdmin();
  } catch (e) { alert(e.message); }
};
$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST', body: '{}' });
  $('#manage').hidden = true; $('#login').hidden = false;
};

// Render admin rows with DOM APIs only - never interpolate server data into
// innerHTML, otherwise a hostile hostname/label could inject markup (XSS).
async function loadAdmin() {
  const [keys, nodes] = await Promise.all([api('/api/admin/keys'), api('/api/admin/nodes')]);
  renderKeys(keys.keys);
  renderAdminNodes(nodes.nodes);
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
    };
    const del = document.createElement('button');
    del.textContent = '删除节点';
    del.onclick = async () => {
      if (confirm('确定删除该节点吗？')) {
        await api('/api/admin/nodes/' + x.id, { method: 'DELETE' });
        refresh(); loadAdmin();
      }
    };
    row.append(name, country, save, del);
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
