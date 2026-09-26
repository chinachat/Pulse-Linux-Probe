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
  return el;
}

function loadApp() {
  const registry = {
    '#region-tabs': makeEl('nav'),
    '#nodes': makeEl('section'),
    '#dashboard': makeEl('main'),
  };
  // 区间按钮由 index.html 静态提供，这里按同样的 dataset 造一份
  const rangeButtons = [3600, 21600, 43200, 86400].map(r => {
    const b = makeEl('button');
    b.dataset.range = String(r);
    return b;
  });
  const document = {
    body: makeEl('body'),
    activeElement: null,
    querySelector: sel => registry[sel] || makeEl(),
    querySelectorAll: sel => (sel === '#ping-range button' ? rangeButtons : []),
    createElement: tag => makeEl(tag),
  };
  const store = {};
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
    setInterval: () => 0,
    clearInterval: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '#10b981' }),
    IntersectionObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    fetch: () => Promise.reject(new Error('no network in tests')),
    navigator: {},
    alert: () => {},
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    Promise, Math, Number, JSON, Date, Error, Object, Array, String, Boolean, RegExp,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), ctx, { filename: 'app.js' });
  return { ctx, registry, rangeButtons };
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
test('sampleLoss: 全部正常为 0', () => {
  const { ctx } = loadApp();
  assert.strictEqual(ctx.sampleLoss({ ct: 10, cu: 20, cm: 30 }), 0);
});

test('sampleLoss: 3 个运营商挂 1 个 = 1/3', () => {
  const { ctx } = loadApp();
  assert.strictEqual(ctx.sampleLoss({ ct: -1, cu: 20, cm: 30 }), 1 / 3);
});

test('sampleLoss: 未配置目标（0）不计入分母', () => {
  const { ctx } = loadApp();
  assert.strictEqual(ctx.sampleLoss({ ct: 0, cu: 0, cm: 0 }), 0);
  assert.strictEqual(ctx.sampleLoss({ ct: -1, cu: 0, cm: 0 }), 1);
  assert.strictEqual(ctx.sampleLoss({ ct: -1, cu: -1, cm: 0 }), 1);
});

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

test('render: 每张卡片都真的画出了延迟曲线和丢包柱', () => {
  const { ctx, registry } = loadApp();
  ctx.render(fakeNodes());
  const card = registry['#nodes'].childNodes[0];
  assert.match(card.querySelector('.ping-svg').innerHTML, /<path d="M/);
  assert.match(card.querySelector('.loss-svg').innerHTML, /<rect /);
  assert.match(card.querySelector('.loss-val').textContent, /%$/);
  assert.ok(card.querySelector('.chart-hint').textContent.length > 0);
});

test('render: 切到 24 小时后图里包含整天的点', () => {
  const { ctx, registry } = loadApp();
  const bars = () => {
    ctx.render(fakeNodes());
    const card = registry['#nodes'].childNodes[0];
    return (card.querySelector('.loss-svg')._html.match(/<rect /g) || []).length;
  };
  setGlobal(ctx, '_pingRange = 3600;');
  const hour = bars();
  setGlobal(ctx, '_pingRange = 86400;');
  const day = bars();
  assert.ok(day > hour * 10, `24 小时区间应包含远多于 1 小时的点（${hour} vs ${day}）`);
});
