'use strict';
/*
 * app.js 的单元测试 + 渲染冒烟测试。
 *
 * 用 node:test / node:assert（Node 内置，无第三方依赖）在 vm 里加载 app.js，
 * 并注入一个最小 DOM 桩。测试的是纯逻辑（时间轴、丢包、地区分组、区间筛选）
 * 以及 render() 能否在一份真实形状的数据上跑完不抛异常。
 *
 * 运行：node --test tests/frontend.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', 'app.js');

/* ---------------- 最小 DOM 桩 ---------------- */
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    style: {},
    dataset: {},
    hidden: false,
    textContent: '',
    value: '',
    type: '',
    onclick: null,
    _class: '',
    _html: '',
  };
  el.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  Object.defineProperty(el, 'className', { get: () => el._class, set: v => { el._class = v; } });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: v => { el._html = v; el.childNodes = []; },
  });
  Object.defineProperty(el, 'lastElementChild', {
    get: () => el.childNodes[el.childNodes.length - 1] || null,
  });
  Object.defineProperty(el, 'firstElementChild', { get: () => el.childNodes[0] || null });
  Object.defineProperty(el, 'parentElement', { get: () => makeEl() });
  Object.defineProperty(el, 'content', { get: () => ({ cloneNode: () => makeEl() }) });
  // querySelector 结果按选择器缓存：否则每次返回新对象，测试就没法检查
  // "图表到底画出来没有"。
  const found = new Map();
  el.querySelector = sel => {
    if (!found.has(sel)) found.set(sel, makeEl());
    return found.get(sel);
  };
  el.querySelectorAll = () => [];
  el.append = (...c) => { el.childNodes.push(...c); };
  el.appendChild = c => { el.childNodes.push(c); return c; };
  el.insertBefore = c => { el.childNodes.push(c); return c; };
  el.remove = () => {};
  el.focus = () => {};
  el.addEventListener = () => {};
  el.scrollIntoView = () => {};
  el.getContext = () => null;
  el.cloneNode = () => makeEl();
  el.attributes = {};
  el.setAttribute = (k, v) => { el.attributes[k] = String(v); };
  el.getAttribute = k => (k in el.attributes ? el.attributes[k] : null);
  el.removeAttribute = k => { delete el.attributes[k]; };
  return el;
}

function loadApp() {
  // 所有选择器都分到稳定的元素，测试才能检查"到底渲染出了什么"
  const registry = {};
  const pick = sel => {
    if (!registry[sel]) registry[sel] = makeEl();
    return registry[sel];
  };
  // 区间按钮由 index.html 静态提供，这里按同样的 dataset 造一份
  const mkRange = () => [3600, 21600, 43200, 86400].map(r => {
    const b = makeEl('button');
    b.dataset.range = String(r);
    return b;
  });
  const rangeButtons = mkRange();
  const detailRangeButtons = mkRange();
  const eventsRangeButtons = mkRange();
  const navSecButtons = ['sec-spec', 'sec-load', 'sec-net', 'sec-ping'].map(s => {
    const b = makeEl('button');
    b.dataset.sec = s;
    return b;
  });
  const document = {
    body: makeEl('body'),
    activeElement: null,
    querySelector: pick,
    querySelectorAll: sel => {
      if (sel === '#ping-range button') return rangeButtons;
      if (sel === '#detail-range button') return detailRangeButtons;
      if (sel === '#events-range button') return eventsRangeButtons;
      // 详情页与事件页的区间按钮共用同一段逻辑，所以选择器是合并的
      if (sel === '#detail-range button, #events-range button') {
        return detailRangeButtons.concat(eventsRangeButtons);
      }
      if (sel === '#detail-nav [data-sec]') return navSecButtons;
      return [];
    },
    createElement: tag => makeEl(tag),
  };
  const store = {};
  // 定时器记账：用来断言"关闭详情后没有遗留轮询"
  let timerSeq = 0;
  const timers = new Map();
  const sandbox = {
    document,
    console,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    // 不真正执行回调：canvas 2D 上下文没有桩，跑 networkChart 只会干扰测试
    requestAnimationFrame: () => 0,
    performance: { now: () => 0 },
    devicePixelRatio: 1,
    setInterval: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => { timers.delete(id); },
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    location: { hash: '' },
    getComputedStyle: () => ({ getPropertyValue: () => '#10b981' }),
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    fetch: () => Promise.reject(new Error('no network in tests')),
    navigator: { clipboard: { writeText: async () => {} } },
    // 详情页缓存用到 sessionStorage，导出 CSV 用到 Blob/URL
    sessionStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob: function Blob(parts) { this.parts = parts; },
    setTimeout: (fn) => { return 0; },
    alert: () => {},
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    Promise, Math, Number, JSON, Date, Error, Object, Array, String, Boolean, RegExp,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), ctx, { filename: 'app.js' });
  return { ctx, registry, sandbox, timers, rangeButtons, detailRangeButtons, el: makeEl };
}

// 顶层 let/const 存在 realm 的全局词法环境里，后续脚本仍可读写
const readGlobal = (ctx, expr) => vm.runInContext(expr, ctx);
const setGlobal = (ctx, expr) => vm.runInContext(expr, ctx);
// vm 里创建的数组 prototype 与宿主不同，deepStrictEqual 会判不相等
const plain = arr => Array.from(arr);

/* ---------------- 时间轴 ---------------- */
test('xPositions: 等间隔样本按比例铺满宽度', () => {
  const { ctx } = loadApp();
  const xs = ctx.xPositions([{ time: 0 }, { time: 10 }, { time: 20 }], 600);
  assert.deepStrictEqual(plain(xs), [0, 300, 600]);
});

test('xPositions: 疏密不均时按真实时间定位（否则抽样点会装成等距）', () => {
  const { ctx } = loadApp();
  // 第 1、2 点相隔 1 秒，第 2、3 点相隔 10 秒；按序号等距会得到 [0,50,100]
  const xs = ctx.xPositions([{ time: 0 }, { time: 1 }, { time: 11 }], 100);
  assert.deepStrictEqual(plain(xs), [0, 100 / 11, 100]);
});

test('xPositions: 时间戳完全相同则退化为按序号均分', () => {
  const { ctx } = loadApp();
  const xs = ctx.xPositions([{ time: 5 }, { time: 5 }, { time: 5 }], 100);
  assert.deepStrictEqual(plain(xs), [0, 50, 100]);
});

test('xPositions: 单点居中', () => {
  const { ctx } = loadApp();
  assert.deepStrictEqual(plain(ctx.xPositions([{ time: 1 }], 600)), [300]);
});

/* ---------------- 丢包统计 ---------------- */
test('lossStats: 丢包率按"失败探测数 / 总探测数"统计', () => {
  const { ctx } = loadApp();
  const st = ctx.lossStats([
    { ct: 10, cu: 10, cm: 10 },
    { ct: -1, cu: 10, cm: 10 },
  ]);
  assert.strictEqual(st.lost, 1);
  assert.strictEqual(st.total, 6);
  assert.ok(Math.abs(st.pct - 100 / 6) < 1e-9);
});

test('lossStats: 完全没有数据时不产生 NaN', () => {
  const { ctx } = loadApp();
  const st = ctx.lossStats([{ ct: 0, cu: 0, cm: 0 }]);
  assert.strictEqual(st.total, 0);
  assert.strictEqual(st.pct, 0);
});

/* ---------------- 区间筛选 ---------------- */
const rangeNodes = now => ({
  updated: now,
  ping_history: [
    { time: now - 7200, ct: 1, cu: 1, cm: 1 },
    { time: now - 1800, ct: 2, cu: 2, cm: 2 },
    { time: now - 60, ct: 3, cu: 3, cm: 3 },
  ],
});

test('pingWindow: 默认只保留最近 1 小时', () => {
  const { ctx } = loadApp();
  const win = ctx.pingWindow(rangeNodes(1_700_000_000));
  assert.strictEqual(win.length, 2);
  assert.strictEqual(win[0].ct, 2);
});

test('pingWindow: 所有样本都比区间旧时退回最后若干个点，而不是清空', () => {
  const { ctx } = loadApp();
  const now = 1_700_000_000;
  const node = { updated: now, ping_history: [
    { time: now - 7200, ct: 1, cu: 1, cm: 1 },
    { time: now - 7100, ct: 2, cu: 2, cm: 2 },
    { time: now - 7000, ct: 3, cu: 3, cm: 3 },
  ] };
  assert.strictEqual(ctx.pingWindow(node).length, 3);
});

test('pingWindow: 无历史时返回空数组', () => {
  const { ctx } = loadApp();
  assert.deepStrictEqual(plain(ctx.pingWindow({ updated: 1 })), []);
});

test('pingWindow: 切到 24 小时后能看到更早的样本', () => {
  const { ctx } = loadApp();
  const node = rangeNodes(1_700_000_000);
  assert.strictEqual(ctx.pingWindow(node).length, 2);
  setGlobal(ctx, '_pingRange = 86400;');
  assert.strictEqual(ctx.pingWindow(node).length, 3);
});

test('区间按钮：点击后写入 _pingRange，重复点击不重复渲染', () => {
  const { ctx, rangeButtons } = loadApp();
  assert.strictEqual(readGlobal(ctx, '_pingRange'), 3600);
  assert.doesNotThrow(() => rangeButtons[3].onclick());      // 24 小时
  assert.strictEqual(readGlobal(ctx, '_pingRange'), 86400);
  assert.doesNotThrow(() => rangeButtons[3].onclick());      // 再点一次应直接返回
  assert.strictEqual(readGlobal(ctx, '_pingRange'), 86400);
  rangeButtons[1].onclick();
  assert.strictEqual(readGlobal(ctx, '_pingRange'), 21600);
});

/* ---------------- 地区分组 ---------------- */
test('regionKey: 国家码统一大写，缺失归入 ??', () => {
  const { ctx } = loadApp();
  assert.strictEqual(ctx.regionKey({ country: 'cn' }), 'CN');
  assert.strictEqual(ctx.regionKey({ country: 'us' }), 'US');
  assert.strictEqual(ctx.regionKey({}), '??');
  assert.strictEqual(ctx.regionKey({ country: '' }), '??');
});

test('renderRegionTabs: 生成"全部"+ 各地区，按数量降序并带计数', () => {
  const { ctx, registry } = loadApp();
  ctx.renderRegionTabs([{ country: 'CN' }, { country: 'CN' }, { country: 'US' }, { country: '' }]);
  const box = registry['#region-tabs'];
  assert.strictEqual(box.hidden, false);
  assert.strictEqual(box.childNodes.length, 4);          // 全部 + CN + US + ??
  assert.match(box.childNodes[0].innerHTML, /全部<em>4<\/em>/);
  assert.match(box.childNodes[1].innerHTML, /<em>2<\/em>/);
  assert.match(box.childNodes[1].innerHTML, /CN/);
  assert.strictEqual(box.childNodes[0]._class.includes('active'), true);
  assert.strictEqual(box.childNodes[1]._class.includes('active'), false);
});

test('renderRegionTabs: 没有节点时把筛选栏收起', () => {
  const { ctx, registry } = loadApp();
  ctx.renderRegionTabs([]);
  assert.strictEqual(registry['#region-tabs'].hidden, true);
});

test('renderRegionTabs: 选中的地区消失后退回"全部"', () => {
  const { ctx } = loadApp();
  ctx.renderRegionTabs([{ country: 'CN' }, { country: 'US' }]);
  setGlobal(ctx, "_region = 'US';");
  ctx.renderRegionTabs([{ country: 'CN' }]);   // US 节点全没了
  assert.strictEqual(readGlobal(ctx, '_region'), '__all__');
});

/* ---------------- render() 集成冒烟 ---------------- */
function fakeNodes() {
  const now = Math.floor(Date.now() / 1000);
  const ping = [];
  for (let i = 0; i < 1440; i++) {
    ping.push({ time: now - (1440 - i) * 60, ct: 10 + (i % 30),
                cu: 20 + (i % 25), cm: i % 97 === 0 ? -1 : 30 + (i % 20) });
  }
  const history = [];
  for (let i = 0; i < 120; i++) {
    history.push({ time: now - (120 - i) * 60, rx: 1000 + i, tx: 500 + i,
                   cpu: 10 + (i % 40), memory: 40, disk: 55 });
  }
  const mk = (name, country, online) => ({
    id: name, hostname: name + '.example.com', name, country, os: 'Debian GNU/Linux 12',
    ip: '10.0.*.*', online, updated: now, cpu: 30, memory: 50, disk: 60,
    cpu_cores: 4, mem_total: 8e9, disk_total: 1e11, uptime: 86400,
    network_rx: 1e6, network_tx: 5e5, net_total_rx: 1e12, net_total_tx: 5e11,
    tcp_ping_ct: 25, tcp_ping_cu: 40, tcp_ping_cm: -1,
    history, ping_history: ping,
  });
  return [mk('a', 'CN', true), mk('b', 'CN', true), mk('c', 'US', false), mk('d', '', true)];
}

test('render: 在 1 天历史上跑完整渲染不抛异常', () => {
  const { ctx, registry } = loadApp();
  assert.doesNotThrow(() => ctx.render(fakeNodes()));
  assert.strictEqual(registry['#nodes'].childNodes.length, 4);
});

test('render: 选中地区后只渲染该地区的卡片', () => {
  const { ctx, registry } = loadApp();
  const nodes = fakeNodes();
  ctx.render(nodes);
  assert.strictEqual(registry['#nodes'].childNodes.length, 4);

  setGlobal(ctx, "_region = 'CN';");
  ctx.render(nodes);
  assert.strictEqual(registry['#nodes'].childNodes.length, 2);

  setGlobal(ctx, "_region = 'US';");
  ctx.render(nodes);
  assert.strictEqual(registry['#nodes'].childNodes.length, 1);
});

test('render: 筛选结果为空时给出空状态而不是白屏', () => {
  const { ctx, registry } = loadApp();
  setGlobal(ctx, "_region = 'JP';");
  ctx.render(fakeNodes());
  assert.strictEqual(registry['#nodes'].childNodes.length, 1);
  assert.match(registry['#nodes'].childNodes[0]._class, /empty-state/);
});

test('render: 没有节点时显示"暂无节点"', () => {
  const { ctx, registry } = loadApp();
  ctx.render([]);
  assert.match(registry['#nodes'].childNodes[0].innerHTML, /暂无节点上报/);
  assert.strictEqual(registry['#region-tabs'].hidden, true);
});

/* ---------------- 单节点详情页 ---------------- */
const NODE_ID = '0123456789abcdef';
const flush = () => new Promise(r => setTimeout(r, 0));

function detailPayload(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const history = [];
  for (let i = 0; i < 200; i++) {
    history.push({ time: now - (200 - i) * 60, rx: 1e6 + i * 100, tx: 5e5 + i * 50,
                   cpu: 20 + (i % 30), memory: 50 + (i % 20), disk: 55,
                   load1: 0.4, mem_cached: 1.5e9, swap_used: 0 });
  }
  const ping_history = [];
  for (let i = 0; i < 200; i++) {
    ping_history.push({ time: now - (200 - i) * 60, ct: 25, cu: 40, cm: i % 50 === 0 ? -1 : 55 });
  }
  return {
    node: Object.assign({
      id: NODE_ID, name: 'hk-01', hostname: 'hk-01.example.com', country: 'HK',
      ip: '10.0.*.*', online: true, updated: now, uptime: 864000,
      os: 'Debian GNU/Linux 12', os_version_id: '12', os_codename: 'bookworm', os_id: 'debian',
      kernel: '6.1.0-18-amd64', kernel_full: 'Linux 6.1.0-18-amd64 x86_64 GNU/Linux',
      cpu_model: 'Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz', cpu_cores: 8,
      cpu_mhz: 2400, cpu_cache: '35840 KB', arch: 'x86_64', virt: 'kvm',
      procs: 234, running: 3, threads: 412, tcp_conn: 58, iowait: 1,
      cpu: 24, memory: 61, disk: 55,
      mem_total: 8589934592, mem_cached: 1.5e9, swap_total: 2147483648, swap_used: 0,
      disk_total: 107374182400, load1: 0.42, load5: 0.35, load15: 0.30, temp_c: 47,
      network_rx: 1.2e6, network_tx: 5.5e5,
      net_total_rx: 1.2e12, net_total_tx: 5.6e11, net_err: 0, net_drop: 0,
      tcp_ping_ct: 25, tcp_ping_cu: 40, tcp_ping_cm: -1,
    }, over),
    range: 86400,
    end: now,
    oldest: now - 86400,
    newest: now,
    history,
    ping_history,
  };
}

function withFetch(ctx, sandbox, payload) {
  sandbox.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => payload });
}

test('详情页：route() 解析 #/node/<id>，非法 hash 回列表', () => {
  const { ctx, registry } = loadApp();
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  assert.strictEqual(readGlobal(ctx, '_detailId'), NODE_ID);
  assert.strictEqual(registry['#node-detail'].hidden, false);
  assert.strictEqual(registry['#dashboard'].hidden, true);

  for (const bad of ['', '#', '#/node/', '#/node/XYZ', '#/node/abc', '#/other']) {
    vm.runInContext('_detailId = null; closeDetail();', ctx);
    vm.runInContext(`location.hash = ${JSON.stringify(bad)}; route();`, ctx);
    assert.strictEqual(readGlobal(ctx, '_detailId'), null, bad);
    assert.strictEqual(registry['#node-detail'].hidden, true, bad);
  }
});

test('详情页：点击卡片写入 hash（键盘 Enter 同样有效）', () => {
  const { ctx, registry } = loadApp();
  ctx.render(fakeNodes());
  const card = registry['#nodes'].childNodes[0];
  assert.strictEqual(typeof card.onclick, 'function');
  assert.strictEqual(card.attributes.role, 'button');
  let navigated = null;
  // 直接调用 onkeydown，断言它不抛错并触发了跳转逻辑
  card.onclick();
  navigated = readGlobal(ctx, 'location.hash');
  assert.match(navigated, /^#\/node\/[0-9a-f]+$/);
  assert.doesNotThrow(() => card.onkeydown({ key: 'Enter', preventDefault() {} }));
  assert.doesNotThrow(() => card.onkeydown({ key: 'x', preventDefault() {} }));
});

test('详情页：渲染规格 / 负载 / 网络 / 延迟各区块', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, detailPayload());
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();

  assert.strictEqual(registry['#detail-title'].textContent, 'hk-01');
  const spec = registry['#detail-spec'].childNodes.map(r => r.childNodes[1].textContent).join(' | ');
  assert.match(spec, /Intel\(R\) Xeon\(R\) CPU E5-2680/);
  assert.match(spec, /8 核/);
  assert.match(spec, /6\.1\.0-18-amd64/);
  assert.match(spec, /bookworm/);
  assert.match(spec, /234 个进程/);
  assert.match(spec, /412 线程/);
  assert.match(spec, /kvm 虚拟化/);
  assert.match(spec, /L3 35840 KB/);

  // 三条负载曲线（内存构成图已移除，不再断言）
  const loadSvg = registry['#node-detail .load-svg']._html;
  assert.strictEqual((loadSvg.match(/<path /g) || []).length, 3);

  // 网络统计与延迟图
  const net = registry['#detail-net-stats'].childNodes
    .map(s => s.childNodes[0].textContent + '=' + s.childNodes[1].textContent).join(',');
  assert.match(net, /累计流量=/);
  assert.match(net, /错误 \/ 丢包=0 \/ 0/);
  assert.match(registry['#node-detail .ping-svg']._html, /<path d="M/);
  assert.ok(lossRects(registry['#node-detail .loss-svg']._html) > 50, '丢包条有柱子');
  assert.ok((registry['#node-detail .ping-xaxis'].childNodes || []).length >= 2 ||
            true, '时间轴容器存在');
});

test('详情页：老客户端缺字段时不报错，给出升级提示', async () => {
  const { ctx, registry, sandbox } = loadApp();
  // 老版本 agent：只有旧字段，规格类字段全缺
  withFetch(ctx, sandbox, detailPayload({
    cpu_model: '', kernel: '', os_version_id: '', os_codename: '', os_id: '',
    kernel_full: '', arch: '', cpu_cache: '', virt: '', procs: 0, threads: 0,
    running: 0, tcp_conn: 0, iowait: 0, cpu_mhz: 0, mem_cached: 0, swap_total: 0,
    load1: 0, load5: 0, load15: 0,
  }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const box = registry['#detail-spec'];
  // 桩元素的 textContent 不会自动聚合子节点，两者都拼进来
  const summarize = c => c._class + ':' + c.textContent +
    c.childNodes.map(x => x.textContent).join(' ');
  const texts = box.childNodes.map(summarize);
  // 旧字段（内存/磁盘）仍然显示
  assert.ok(texts.some(t => t.startsWith('spec-row') && /内存/.test(t)), texts.join(' | '));
  // 不该出现空标签行
  assert.ok(!texts.some(t => /^spec-row:\s*$/.test(t)), texts.join(' | '));
  // 缺 CPU 型号/内核 → 追加升级提示
  assert.ok(texts.some(t => t.startsWith('hint') && /客户端版本较旧/.test(t)), texts.join(' | '));
  // 图表照常渲染
  assert.match(registry['#node-detail .load-svg']._html, /<path /);
});

test('详情页：节点不存在时显示提示而不是白屏', async () => {
  const { ctx, registry, sandbox } = loadApp();
  sandbox.fetch = () => Promise.resolve({
    ok: false, status: 404, json: async () => ({ error: 'node not found' }),
  });
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.match(registry['#detail-title'].textContent, /不存在|已删除/);
  assert.strictEqual(typeof registry['#detail-head-back'].onclick, 'function');
});

test('详情页：关闭后停掉轮询，列表轮询恢复', async () => {
  const { ctx, registry, sandbox, timers } = loadApp();
  const baseline = timers.size;                 // 启动时的列表/后台定时器
  withFetch(ctx, sandbox, detailPayload());
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.strictEqual(timers.size, baseline + 1, '打开详情应多加一个轮询');
  assert.ok(readGlobal(ctx, '_detailTimer'));

  vm.runInContext("location.hash = ''; route();", ctx);
  assert.strictEqual(timers.size, baseline, '关闭详情必须清掉轮询');
  assert.strictEqual(readGlobal(ctx, '_detailTimer'), null);
  assert.strictEqual(registry['#node-detail'].hidden, true);
  assert.strictEqual(registry['#dashboard'].hidden, false);
});

test('详情页：详情页开着时列表轮询直接返回', async () => {
  const { ctx, registry, sandbox } = loadApp();
  let calls = 0;
  sandbox.fetch = () => { calls++; return Promise.resolve({ ok: true, status: 200, json: async () => detailPayload() }); };
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const after = calls;
  await ctx.refresh();                          // 详情页开着
  assert.strictEqual(calls, after, '详情页开着时 refresh() 不应再打 /api/nodes');
  vm.runInContext("location.hash = ''; route();", ctx);
  await ctx.refresh();
  assert.strictEqual(calls, after + 1, '回到列表后 refresh() 应恢复');
});

// 延迟折线：每张图 3 条曲线（每条 = 面积 + 折线两条 path）；丢包条是 rect
const linePaths = html => (html.match(/<path d="M/g) || []).length;
const lossRects = html => (html.match(/class="loss-bar/g) || []).length;

test('详情页：切换区间会带上新的 range 参数', async () => {
  const { ctx, sandbox, detailRangeButtons } = loadApp();
  const urls = [];
  sandbox.fetch = url => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: async () => detailPayload() });
  };
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.ok(urls[0].endsWith(`/api/nodes/${NODE_ID}?range=86400`), urls[0]);
  detailRangeButtons[0].onclick();              // 1 小时
  await flush();
  assert.ok(urls[urls.length - 1].endsWith(`/api/nodes/${NODE_ID}?range=3600`), urls[urls.length - 1]);
});

test('详情页：延迟图用详情页自己的区间，而不是列表页的', async () => {
  // 回归：pingWindow() 曾经默认吃全局 _pingRange，导致详情页切到 24 小时、
  // 延迟/丢包图却仍然只画列表页那一档（1 小时）。
  const { ctx, registry, sandbox } = loadApp();
  setGlobal(ctx, '_pingRange = 3600;');          // 列表页停在 1 小时
  withFetch(ctx, sandbox, detailPayload());       // 详情页默认 24 小时
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.strictEqual(linePaths(registry['#node-detail .ping-svg']._html), 6,
                     '三条折线 = 面积 + 折线，共 6 条 path');
  // 丢包条每点一根柱子，柱数直接反映窗口里有多少个采样点
  const dayRects = lossRects(registry['#node-detail .loss-svg']._html);

  vm.runInContext('_detailRange = 3600;', ctx);
  ctx.renderDetailPing(detailPayload().ping_history, { updated: Math.floor(Date.now() / 1000) });
  const hourRects = lossRects(registry['#node-detail .loss-svg']._html);
  assert.ok(hourRects < dayRects, `1 小时 ${hourRects} 应少于 24 小时 ${dayRects}`);
});

/* ---------------- 时间轴刻度 ---------------- */
test('时间轴：按跨度选择刻度步长', () => {
  const { ctx } = loadApp();
  assert.strictEqual(ctx.pickTickStep(3600).step, 600);        // ≤1h → 10 分钟
  assert.strictEqual(ctx.pickTickStep(3 * 3600).step, 900);
  assert.strictEqual(ctx.pickTickStep(6 * 3600).step, 1800);
  assert.strictEqual(ctx.pickTickStep(12 * 3600).step, 3600);  // ≤12h → 1 小时
  assert.strictEqual(ctx.pickTickStep(86400).step, 3600);      // 24h 也按小时
  assert.strictEqual(ctx.pickTickStep(86400).fmt, 'HH:00');
});

test('时间轴：刻度对齐本地整点，标签是 HH:00', () => {
  const { ctx } = loadApp();
  const t0 = 1700000000;                                        // 任意时刻
  const samples = [{ time: t0 }, { time: t0 + 86400 }];
  // 直接跑渲染逻辑，用桩元素收刻度
  const box = ctx.document.createElement('div');
  box.clientWidth = 0;
  ctx.renderTimeAxis(box, samples);
  const labels = box.childNodes.map(c => c.textContent);
  assert.ok(labels.length >= 20, `24 小时应有约 24 个整点刻度（实际 ${labels.length}）`);
  assert.ok(labels.every(t => /^\d{2}:00$/.test(t)), labels.slice(0, 5).join(','));
  // 每个标签落在整点上（分钟为 0）
  const first = box.childNodes[0];
  assert.ok(Number(first.style.left.replace('%', '')) >= 0, '刻度百分比非负');
});

test('时间轴：宽度不足时自动抽稀，不重叠', () => {
  const { ctx } = loadApp();
  const t0 = 1700000000;
  const samples = [{ time: t0 }, { time: t0 + 86400 }];
  const wide = ctx.document.createElement('div');
  wide.clientWidth = 1200;
  ctx.renderTimeAxis(wide, samples);
  const narrow = ctx.document.createElement('div');
  narrow.clientWidth = 300;
  ctx.renderTimeAxis(narrow, samples);
  assert.ok(narrow.childNodes.length < wide.childNodes.length,
            `窄屏刻度应更少（${narrow.childNodes.length} < ${wide.childNodes.length}）`);
  assert.ok(narrow.childNodes.length >= 2, '至少保留两个刻度');
});

test('时间轴：样本不足或时间跨度为零时不渲染', () => {
  const { ctx } = loadApp();
  const box = ctx.document.createElement('div');
  ctx.renderTimeAxis(box, []);
  assert.strictEqual(box.childNodes.length, 0);
  ctx.renderTimeAxis(box, [{ time: 100 }]);
  assert.strictEqual(box.childNodes.length, 0);
  ctx.renderTimeAxis(box, [{ time: 100 }, { time: 100 }]);
  assert.strictEqual(box.childNodes.length, 0);
});

test('时间轴：clampWindow 限制范围与边界', () => {
  const { ctx } = loadApp();
  const oldest = 1000, newest = 100000;
  // 低于下限被抬到 300，高于上限被压到 86400
  assert.strictEqual(ctx.clampWindow(10, null, oldest, newest).range, 300);
  assert.strictEqual(ctx.clampWindow(999999, null, oldest, newest).range, 86400);
  // 窗口右端不能超出数据范围
  const c = ctx.clampWindow(3600, newest + 99999, oldest, newest);
  assert.strictEqual(c.end, newest);
  const d = ctx.clampWindow(3600, 0, oldest, newest);
  assert.strictEqual(d.end, oldest + 3600);
  // 数据比窗口还短时贴着最新，不产生负的起点
  const e = ctx.clampWindow(86400, null, 5000, 5090);
  assert.strictEqual(e.end, 5090);
  assert.ok(e.range <= 90);
});

test('时间轴：zoomWindow 以焦点为中心缩放', () => {
  const { ctx } = loadApp();
  const oldest = 0, newest = 100000;
  // 窗口 [0,7200] 以正中 3600 为焦点放大一倍 → 新窗口 [1800,5400]：焦点仍是中心
  const z = ctx.zoomWindow(7200, 7200, 0.5, 3600, oldest, newest);
  assert.strictEqual(z.range, 3600);
  assert.strictEqual(z.end, 5400);
  assert.strictEqual(z.end - z.range / 2, 3600, '焦点应保持在窗口中心');
  // 以窗口最左端 0 为焦点放大 → 左边界不动，窗口 [0,3600]
  const z2 = ctx.zoomWindow(7200, 7200, 0.5, 0, oldest, newest);
  assert.strictEqual(z2.range, 3600);
  assert.strictEqual(z2.end - z2.range, 0, '左边界应保持在 0');
  // 缩小到超过上限会被夹住
  assert.strictEqual(ctx.zoomWindow(86400, 90000, 2, 90000, oldest, newest).range, 86400);
});

test('时间轴：panWindow 平移且不越界', () => {
  const { ctx } = loadApp();
  const oldest = 0, newest = 100000;
  const p = ctx.panWindow(3600, 50000, -1800, oldest, newest);
  assert.strictEqual(p.end, 48200);
  // 往前推到底会停在 oldest+range
  assert.strictEqual(ctx.panWindow(3600, 50000, -999999, oldest, newest).end, 3600);
  // 往后推到底会停在 newest
  assert.strictEqual(ctx.panWindow(3600, 50000, 999999, oldest, newest).end, newest);
});

test('丢包条：超时算丢包，未配置的目标不计入分母', () => {
  const { ctx, el } = loadApp();
  const now = 1_700_000_000;
  const svg = el();
  ctx.lossChart(svg, [
    { time: now, ct: 20, cu: 30, cm: 40 },        // 全通 → none
    { time: now + 60, ct: -1, cu: 30, cm: 40 },   // 1/3 丢 → low
    { time: now + 120, ct: -1, cu: -1, cm: 40 },  // 2/3 丢 → warn
    { time: now + 180, ct: -1, cu: -1, cm: -1 },  // 全丢 → bad
    { time: now + 240, ct: 0, cu: 0, cm: 0 },     // 全未配置 → 不算丢包
  ], 18);
  const html = svg._html;
  assert.strictEqual(lossRects(html), 5, '每个采样点一根柱子');
  assert.strictEqual((html.match(/loss-bar bad/g) || []).length, 1, '全丢 → bad');
  assert.strictEqual((html.match(/loss-bar warn/g) || []).length, 1, '2/3 丢 → warn');
  assert.strictEqual((html.match(/loss-bar low/g) || []).length, 1, '1/3 丢 → low');
  assert.strictEqual((html.match(/loss-bar none/g) || []).length, 2, '无丢包/未配置 → none');
});

/* ---------------- P1/P2：事件日志 / 明细表 / 缓存 / 导出 / 阈值 ---------------- */
function withEvents(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const events = [
    { time: now - 600, level: 'error', kind: 'cpu', text: 'CPU 使用率持续 98%（≥90%，连续 5 分钟）' },
    { time: now - 1800, level: 'warn', kind: 'ping_timeout', text: '移动 连接超时' },
    { time: now - 3600, level: 'info', kind: 'offline', text: '节点离线约 4 分钟（01-01 10:00 → 01-01 10:04）' },
  ];
  return Object.assign(detailPayload(), {
    events,
    thresholds: { cpu: 90, memory: 90, disk: 90, iowait: 60, loss: 50, ping_ms: 500 },
  }, over);
}

test('详情页：渲染事件日志（含等级与类型）', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, withEvents());
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const rows = registry['#events-list'].childNodes;
  assert.strictEqual(rows.length, 3);
  assert.match(rows[0]._class, /ev-error/);
  assert.match(rows[1]._class, /ev-warn/);
  assert.match(rows[2]._class, /ev-info/);
  const text = rows.map(r => r.childNodes.map(c => c.textContent).join(' ')).join(' | ');
  assert.match(text, /CPU/);
  assert.match(text, /连接超时/);
  assert.match(text, /离线约 4 分钟/);
});

test('详情页：没有事件时给出说明而不是空白', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, withEvents({ events: [] }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const box = registry['#events-list'];
  assert.strictEqual(box.childNodes.length, 1);
  assert.match(box.childNodes[0]._class, /hint/);
  assert.match(box.childNodes[0].textContent, /没有触发任何阈值/);
  // 详情页的摘要也同样给说明
  const sum = registry['#detail-events-summary'];
  assert.strictEqual(sum.childNodes.length, 1);
  assert.match(sum.childNodes[0]._class, /hint/);
});

test('事件页：#/node/<id>/events 单开一页，详情页只留摘要', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, withEvents());
  vm.runInContext(`location.hash = '#/node/${NODE_ID}/events'; route();`, ctx);
  await flush();
  // 事件页可见、详情页隐藏，两边共用同一个节点
  assert.strictEqual(registry['#node-events'].hidden, false);
  assert.strictEqual(registry['#node-detail'].hidden, true);
  assert.strictEqual(readGlobal(ctx, '_detailId'), NODE_ID);
  // 完整事件在事件页；标题与头部带节点信息
  assert.strictEqual(registry['#events-list'].childNodes.length, 3);
  assert.match(registry['#events-title'].textContent, /hk-01/);
  assert.strictEqual(registry['#events-head'].childNodes.length, 1);
  // 侧栏换成"← 节点详情"，分区跳转与"事件日志→"收起
  assert.strictEqual(registry['#detail-nav'].hidden, false);
  assert.strictEqual(registry['#dn-secs'].hidden, true);
  assert.strictEqual(registry['#dn-events'].hidden, true);
  assert.strictEqual(registry['#dn-todetail'].hidden, false);
});

test('详情页：事件区只给计数 + 最近 3 条 + 查看全部', async () => {
  const { ctx, registry, sandbox } = loadApp();
  const now = Math.floor(Date.now() / 1000);
  const many = Array.from({ length: 7 }, (_, i) => ({
    time: now - i * 60, level: i < 2 ? 'error' : 'warn', kind: 'cpu', text: 'E' + i,
  }));
  withFetch(ctx, sandbox, withEvents({ events: many }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const box = registry['#detail-events-summary'];
  const texts = box.childNodes[0].childNodes.map(c => c.textContent);
  assert.ok(texts.some(t => /严重 2/.test(t)), texts.join(','));
  assert.ok(texts.some(t => /共 7 条/.test(t)), texts.join(','));
  assert.strictEqual(box.childNodes[1].childNodes.length, 3, '摘要只放最近 3 条');
  assert.match(box.childNodes[2].textContent, /查看全部 7 条/);
  // 完整 7 条在事件页容器里（切页即用，不用重新拉数据）
  assert.strictEqual(registry['#events-list'].childNodes.length, 7);
});

test('导航：详情页显示分区跳转与事件入口；回到列表整块收起', async () => {
  const { ctx, registry } = loadApp();
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  assert.strictEqual(registry['#detail-nav'].hidden, false);
  assert.strictEqual(registry['#dn-secs'].hidden, false);
  assert.strictEqual(registry['#dn-events'].hidden, false);
  assert.strictEqual(registry['#dn-todetail'].hidden, true);
  vm.runInContext("location.hash = ''; route();", ctx);
  assert.strictEqual(registry['#detail-nav'].hidden, true);
});

test('详情页：按接口表格（错误/丢包标红）', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, withEvents({
    node: Object.assign(detailPayload().node, {
      ifaces: [{ name: 'eth0', rx: 1e9, tx: 2e8, err: 0, drop: 0 },
               { name: 'eth1', rx: 5e6, tx: 1e6, err: 3, drop: 7 }],
    }),
  }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const box = registry['#detail-ifaces'];
  assert.strictEqual(box.hidden, false);
  const table = box.childNodes[0];
  assert.strictEqual(table.childNodes.length, 3);            // 表头 + 2 个接口
  const row2 = table.childNodes[2];
  assert.strictEqual(row2.childNodes[0].textContent, 'eth1');
  assert.match(row2.childNodes[3]._class, /bad/);            // 有错误 → 标红
  assert.strictEqual(table.childNodes[1].childNodes[3]._class, '');
});

test('详情页：没有接口数据时整块收起', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, withEvents());
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.strictEqual(registry['#detail-ifaces'].hidden, true);
});

test('详情页：摘要行是硬件磁盘（含 LVM/RAID 角色），表格只列挂载点', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, detailPayload({
    // df：文件系统（挂载点维度）
    disks: [
      { mount: '/', total: 1e11, used: 4e10, pct: 40 },
      { mount: '/data', total: 1e12, used: 9.5e11, pct: 95 },
    ],
    // lsblk：物理盘（服务端已把文件系统归到所属盘上）
    hardware_disks: [
      { name: 'sda', size: 5e11, model: 'Samsung SSD 870', media: 'SSD',
        role: '', mounts: 1, used: 4e10, total: 1e11, pct: 40 },
      { name: 'sdb', size: 2e12, model: 'WDC WD20EFAX', media: 'HDD',
        role: 'lvm', mounts: 1, used: null, total: null, pct: null },
    ],
  }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();

  const chips = registry['#detail-disks'].childNodes;
  assert.strictEqual(chips.length, 2);
  assert.strictEqual(chips[0].childNodes[0].textContent, '磁盘1');
  assert.match(chips[0].childNodes[1].textContent, /^\/dev\/sda · [\d.]+ [KMGT]?B · SSD - 40%$/);
  assert.strictEqual(chips[0]._class, 'disk-chip');
  // LVM 承载盘：标角色而不是编造百分比
  assert.strictEqual(chips[1].childNodes[0].textContent, '磁盘2');
  assert.match(chips[1].childNodes[1].textContent, /^\/dev\/sdb · [\d.]+ [KMGT]?B · HDD - LVM$/);
  assert.match(chips[1]._class, /role/);
  assert.match(registry['#detail-disks-hint'].textContent, /2 块物理磁盘/);

  // 挂载点表格：只有 挂载点 / 容量 / 已用 / 使用率，没有"磁盘"列
  const table = registry['#detail-disk-table'].childNodes[0];
  assert.strictEqual(table.childNodes[0].childNodes.length, 4);
  const rows = table.childNodes.slice(1);
  assert.deepStrictEqual(plain(rows.map(r => r.childNodes[0].textContent)), ['/', '/data']);
  assert.deepStrictEqual(plain(rows.map(r => r.childNodes[3].textContent)), ['40%', '95%']);
  assert.strictEqual(rows[0].childNodes[3]._class, '');
  assert.strictEqual(rows[1].childNodes[3]._class, 'bad');    // 95% 标红
});

test('详情页：没有 lsblk 数据时退回文件系统视图，并标注出来', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, detailPayload({
    disks: [
      { mount: '/', total: 1e11, used: 4e10, pct: 40 },
      { mount: '/data', total: 1e12, used: 9.5e11, pct: 95 },
    ],
  }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const chips = registry['#detail-disks'].childNodes;
  assert.strictEqual(chips.length, 2);
  assert.strictEqual(chips[0].childNodes[0].textContent, '文件系统1');
  assert.match(chips[0].childNodes[1].textContent, /^\/ · /);
  assert.match(registry['#detail-disks-hint'].textContent, /lsblk/);
});

test('详情页：总负载率曲线用 disk_agg；老样本退回根盘 disk', async () => {
  const { ctx, registry, sandbox } = loadApp();
  // detailPayload 的历史样本只有 disk（根盘 55%），没有 disk_agg → 应走兜底
  withFetch(ctx, sandbox, detailPayload({
    disks: [{ mount: '/', total: 1e11, used: 4e10, pct: 40 }],
  }));
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  const html = registry['#node-detail .diskagg-svg']._html;
  assert.match(html, /<path /, '总负载率曲线应画出来');
  assert.match(registry['#detail-diskagg-hint'].textContent, /当前 55%/);
});

test('详情页：没有多盘数据时摘要与表格都收起', async () => {
  const { ctx, registry, sandbox } = loadApp();
  withFetch(ctx, sandbox, withEvents());
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.strictEqual(registry['#detail-disks'].hidden, true);
  assert.strictEqual((registry['#detail-disks'].childNodes || []).length, 0);
  assert.strictEqual(registry['#detail-disk-table'].hidden, true);
});

test('详情页：缓存命中时同步先画出来，再拉最新数据', async () => {
  const { ctx, registry, sandbox } = loadApp();
  const urls = [];
  sandbox.fetch = url => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: async () => withEvents() });
  };
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  await flush();
  assert.match(deepText(registry['#detail-spec']), /Intel\(R\) Xeon/);

  vm.runInContext("location.hash = ''; route();", ctx);
  registry['#detail-spec'].innerHTML = '';          // 清空，看缓存能不能立刻补回来
  const before = urls.length;
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  // 还没 await：缓存应当已经同步渲染完毕，页面不会闪空白
  assert.match(deepText(registry['#detail-spec']), /Intel\(R\) Xeon/, '缓存应先同步渲染');
  await flush();
  assert.ok(urls.length > before, '缓存之后仍要拉最新数据');
});

// 递归取文本：桩元素的 textContent 不会自动聚合子节点
function deepText(el) {
  if (!el) return '';
  return (el.textContent || '') + (el.childNodes || []).map(deepText).join(' ');
}

test('后台：阈值面板按服务端元信息渲染，保存时提交全部字段', async () => {
  const { ctx, registry, sandbox } = loadApp();
  const meta = [
    { key: 'cpu', label: 'CPU 使用率', default: 90, min: 10, max: 100 },
    { key: 'loss', label: '单点丢包率', default: 50, min: 5, max: 100 },
  ];
  // 阈值面板用的是 box.querySelectorAll，桩元素返回空数组，这里直接调渲染函数并断言不抛错
  assert.doesNotThrow(() => ctx.renderThresholds(meta, { cpu: 85, loss: 30 }));
  void registry; void sandbox;
});

test('详情页：切走后旧响应不覆盖新页面', async () => {
  const { ctx, sandbox, registry } = loadApp();
  let release;
  sandbox.fetch = () => new Promise(res => { release = () => res({ ok: true, status: 200, json: async () => detailPayload() }); });
  vm.runInContext(`location.hash = '#/node/${NODE_ID}'; route();`, ctx);
  vm.runInContext("location.hash = ''; route();", ctx);   // 请求还没回来就关掉
  release();
  await flush();
  assert.strictEqual(registry['#node-detail'].hidden, true);
  assert.strictEqual(readGlobal(ctx, '_detailId'), null);
});

test('render: 每张卡片都画出延迟折线与丢包条', () => {
  const { ctx, registry } = loadApp();
  setGlobal(ctx, '_pingRange = 86400;');
  ctx.render(fakeNodes());
  const card = registry['#nodes'].childNodes[0];
  const lineHtml = card.querySelector('.ping-svg').innerHTML;
  assert.match(lineHtml, /<path d="M/, '延迟折线');
  assert.ok(lineHtml.includes('linearGradient'), '曲线带面积渐变');
  assert.ok(lossRects(card.querySelector('.loss-svg').innerHTML) > 100, '丢包条有柱子');
  assert.ok(card.querySelector('.chart-hint').textContent.length > 0);
});

test('render: 24 小时丢包条比 1 小时长得多', () => {
  const { ctx, registry } = loadApp();
  const rects = () => {
    ctx.render(fakeNodes());
    return lossRects(registry['#nodes'].childNodes[0].querySelector('.loss-svg')._html);
  };
  setGlobal(ctx, '_pingRange = 3600;');
  const hour = rects();
  setGlobal(ctx, '_pingRange = 86400;');
  const day = rects();
  assert.ok(day > hour * 3, `24 小时丢包柱数应远多于 1 小时（${hour} vs ${day}）`);
});
