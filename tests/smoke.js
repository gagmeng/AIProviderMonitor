'use strict';
// 功能冒烟测试：不依赖 Electron，直接测试各核心模块
// 运行：node tests/smoke.js
const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-test-'));
process.env.AIPM_DATA_DIR = TMP;

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch((e) => { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); });
}

// ---------- Mock OpenAI 兼容服务器 ----------
function makeMockServer({ models = ['gpt-4o', 'gpt-4o-mini', 'dead-model'], chatFail = false } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        } else if (req.url === '/v1/chat/completions' && req.method === 'POST') {
          try {
            const j = JSON.parse(body);
            if (chatFail || j.model === 'dead-model') {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'model not found' } }));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
            }
          } catch (e) {
            res.writeHead(400); res.end('{}');
          }
        } else if (req.url === '/webhook') {
          res.writeHead(200); res.end('{"errcode":0}');
        } else {
          res.writeHead(404); res.end('{}');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  console.log('== AI Provider Monitor 冒烟测试 ==\n');

  // 1. 存储模块
  await test('store: 读写 providers.json', async () => {
    const store = require('../src/store');
    assert.ok(store.DATA_FILE.includes(TMP));
    const data = store.loadAll();
    assert.ok(Array.isArray(data.providers));
    assert.ok(data.global.notifyWeixinEnabled === false);
    store.saveAll({ global: { ...data.global, concurrency: 6 }, providers: [{ id: 1, name: 't' }] });
    const again = store.loadAll();
    assert.strictEqual(again.global.concurrency, 6);
    assert.strictEqual(again.providers.length, 1);
  });

  // 2. 模型列表提取
  await test('detector: extractModelIds 兼容多种格式', async () => {
    const { extractModelIds } = require('../src/detector');
    assert.deepStrictEqual(extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
    assert.deepStrictEqual(extractModelIds({ models: [{ name: 'x' }] }), ['x']);
    assert.deepStrictEqual(extractModelIds(['p', 'q']), ['p', 'q']);
    assert.deepStrictEqual(extractModelIds({}), []);
  });

  // 3. 检测引擎（对 mock 服务器完整检测）
  await test('detector: 完整检测（连接 + 模型可用性 + 失败原因）', async () => {
    const { srv, port } = await makeMockServer();
    const { detect } = require('../src/detector');
    const r = await detect({ id: 1, name: 'mock', url: `http://127.0.0.1:${port}`, apiKey: 'sk-test' });
    assert.strictEqual(r.status, 'up', `status=${r.status} err=${r.error}`);
    assert.strictEqual(r.modelsTotal, 3);
    assert.ok(r.modelsAvailable.includes('gpt-4o'));
    assert.ok(r.modelsAvailable.includes('gpt-4o-mini'));
    assert.ok(r.modelsUnavailable.includes('dead-model'));
    assert.ok(Array.isArray(r.modelDetails));
    const dead = r.modelDetails.find((d) => d.id === 'dead-model');
    assert.ok(dead && !dead.ok && /404/.test(dead.note), `dead-model note=${dead && dead.note}`);
    assert.ok(r.latency != null);
    srv.close();
  });

  await test('detector: 连接失败返回 down', async () => {
    const { detect } = require('../src/detector');
    const r = await detect({ id: 2, name: 'dead', url: 'http://127.0.0.1:1' });
    assert.strictEqual(r.status, 'down');
    assert.ok(r.error);
  });

  await test('detector: 所有模型不可用 => degraded', async () => {
    const { srv, port } = await makeMockServer({ models: ['m1'], chatFail: true });
    const { detect } = require('../src/detector');
    const r = await detect({ id: 3, name: 'bad', url: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.status, 'degraded');
    srv.close();
  });

  // 4. 通知文本构建与推送
  await test('notifier: 模型变化文本 + 微信 webhook 推送', async () => {
    const { buildModelChangeText, notifyModelChange } = require('../src/notifier');
    const { srv } = await makeMockServer();
    const provider = { id: 1, name: '测试服务商' };
    const prev = { status: 'up', modelsAvailable: ['a', 'b'] };
    const next = { status: 'up', modelsTotal: 3, modelsAvailable: ['b', 'c', 'd'] };
    const text = buildModelChangeText(provider, prev, next);
    assert.ok(text.includes('测试服务商'));
    assert.ok(text.includes('新增可用：c, d'));
    assert.ok(text.includes('失去可用：a'));

    // 真实推送（打到 mock webhook）
    const hooks = [];
    const srv2 = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push({ url: req.url, body: JSON.parse(b) }); res.writeHead(200); res.end('{}'); }); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    const p2 = srv2.address().port;
    await notifyModelChange(
      { notifyWeixinEnabled: true, weixinWebhook: `http://127.0.0.1:${p2}/wx`, notifyQQEnabled: false },
      provider, prev, next
    );
    assert.strictEqual(hooks.length, 1);
    assert.ok(hooks[0].body.text && hooks[0].body.text.content);
    srv.close(); srv2.close();
  });

  await test('notifier: 钉钉 webhook（含加签）', async () => {
    const { sendDingtalk } = require('../src/notifier');
    const crypto = require('crypto');
    const calls = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        calls.push({ url: req.url, body: JSON.parse(b) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;

    // 无加签
    await sendDingtalk({ dingtalkWebhook: `http://127.0.0.1:${p}/robot/send?access_token=t1` }, 'hello');
    assert.strictEqual(calls[0].body.msgtype, 'text');
    assert.strictEqual(calls[0].body.text.content, 'hello');
    assert.ok(!calls[0].url.includes('sign='));

    // 加签：URL 带 timestamp & sign，按钉钉官方算法复算验证（stringToSign = ts + '\n' + secret）
    const secret = 'SECxxxxxxxxxxxxxxxx';
    await sendDingtalk({ dingtalkWebhook: `http://127.0.0.1:${p}/robot/send?access_token=t2`, dingtalkSecret: secret }, 'hi');
    const u = new URL('http://x' + calls[1].url);
    const ts = u.searchParams.get('timestamp');
    const sign = u.searchParams.get('sign');
    const expect = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
    assert.strictEqual(sign, expect);

    // errcode 非 0 应抛出
    const srv2 = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ errcode: 310000, errmsg: 'sign not match' })); }); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    await assert.rejects(
      () => sendDingtalk({ dingtalkWebhook: `http://127.0.0.1:${srv2.address().port}/robot/send` }, 'm'),
      /errcode=310000/
    );
    srv.close(); srv2.close();
  });

  await test('notifier: QQ OneBot v11 私聊/群聊上报', async () => {
    const { sendQQ } = require('../src/notifier');
    const calls = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        calls.push({ url: req.url, auth: req.headers.authorization || '', body: JSON.parse(b) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'async', retcode: 0, data: null }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;

    // 私聊
    await sendQQ({ qqWebhook: `http://127.0.0.1:${p}`, qqTarget: '10001', qqTargetType: 'private', qqToken: 'sec' }, 'hello');
    assert.strictEqual(calls[0].url, '/send_private_msg');
    assert.strictEqual(calls[0].body.user_id, 10001);
    assert.strictEqual(calls[0].body.message, 'hello');
    assert.strictEqual(calls[0].auth, 'Bearer sec');

    // 群聊
    await sendQQ({ qqWebhook: `http://127.0.0.1:${p}/`, qqTarget: '20002', qqTargetType: 'group' }, 'hi');
    assert.strictEqual(calls[1].url, '/send_group_msg');
    assert.strictEqual(calls[1].body.group_id, 20002);

    // OneBot 错误 retcode 应抛出
    const srv2 = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: 'account not found' })); }); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    await assert.rejects(
      () => sendQQ({ qqWebhook: `http://127.0.0.1:${srv2.address().port}`, qqTarget: 'x', qqTargetType: 'private' }, 'm'),
      /retcode=100/
    );
    srv.close(); srv2.close();
  });

  // 5. 调度器：手动触发 + 结果回调
  await test('scheduler: runCheck 触发检测并回调', async () => {
    const { srv, port } = await makeMockServer();
    const { Scheduler } = require('../src/scheduler');
    const s = new Scheduler({ concurrency: 2 });
    const results = [];
    s.on('result', (p, r) => results.push(r));
    s.getProvider = (id) => ({ id, name: 'm', url: `http://127.0.0.1:${port}`, intervalSec: 60 });
    const r = await s.runCheck(9, { reason: 'manual' });
    assert.ok(r && r.status === 'up');
    assert.strictEqual(results.length, 1);
    await new Promise((res) => setTimeout(res, 50));
    s.stop();
    srv.close();
  });

  await test('scheduler: 周期调度启动与取消', async () => {
    const { Scheduler } = require('../src/scheduler');
    const s = new Scheduler({});
    s.schedule({ id: 5, intervalSec: 3600 });
    assert.ok(s.timers.has(5));
    s.cancel(5);
    assert.ok(!s.timers.has(5));
    s.stop();
  });

  // 5.5 变动判定逻辑（直接运行 main.js 的判定核心，剥离 electron 依赖）
  await test('change-detect: 首次检测建立基准、不标记变动', async () => {
    // 从 main.js 提取 applyResult 的核心判定（以函数注入方式测试真实实现）
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const m = src.match(/function applyResult[\s\S]*?\n}/);
    assert.ok(m, 'main.js 应包含 applyResult');
    const snapshot = (p) => p ? { status: p.status || 'unknown', modelsTotal: p.modelsTotal || 0, modelsAvailable: [...(p.modelsAvailable || [])] } : null;
    const logs = [];
    const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
    const pushes = [];
    const notifierStub = { notifyModelChange: async (cfg, p, prev, next) => { pushes.push({ p, prev, next }); } };
    const statusText = (s) => ({ up: '在线', degraded: '异常', down: '离线', unknown: '待检测' }[s] || s);
    // applyResult 现已依赖 history / alerts / notifyAlert / updateTrayStatus / DATA_DIR，
    // 这里注入受控替身：history 关闭落盘，alerts 用真实引擎以覆盖联动逻辑。
    const alertsReal = require('../src/alerts');
    alertsReal.resetState(1);
    const historyStub = { append: () => null };
    const alertPushes = [];
    const notifyAlertStub = async (cfg, p, a) => { alertPushes.push({ p, a }); };
    const updateTrayStatus = () => {};
    const DATA_DIR = TMP;
    const { diffBaseline } = require('../src/baseline');
    // 构造隔离环境执行真实 applyResult
    const fn = new Function('snapshot', 'logger', 'notifyModelChange', 'notifyAlert', 'statusText',
      'db', 'history', 'alerts', 'updateTrayStatus', 'DATA_DIR', 'diffBaseline', `
      ${m[0]}
      return applyResult;
    `);
    const applyResult = fn(snapshot, logger, notifierStub.notifyModelChange, notifyAlertStub, statusText,
      { global: { historyEnabled: false, alertFailThreshold: 99, alertOnModelChange: true, alertCooldownMin: 0 }, providers: [] },
      historyStub, alertsReal, updateTrayStatus, DATA_DIR, diffBaseline);

    // 首次检测（status=unknown 基线）
    const p = { id: 1, name: 'A', status: 'unknown', modelsAvailable: [], modelsTotal: 0, notifyOnModelChange: true };
    applyResult(p, { status: 'up', modelsTotal: 2, modelsAvailable: ['a', 'b'], modelsUnavailable: [], modelDetails: [], checkedAt: Date.now(), error: null }, 'manual');
    assert.strictEqual(p.modelChanged, false, '首次检测不应标记变动');
    assert.strictEqual(pushes.length, 0, '首次检测不应推送');

    // 第二次相同结果 → 无变动
    applyResult(p, { status: 'up', modelsTotal: 2, modelsAvailable: ['a', 'b'], modelsUnavailable: [], modelDetails: [], checkedAt: Date.now(), error: null }, 'auto');
    assert.strictEqual(p.modelChanged, false);
    assert.strictEqual(pushes.length, 0);

    // 第三次失去一个模型 → 变动 + 推送
    applyResult(p, { status: 'up', modelsTotal: 2, modelsAvailable: ['a'], modelsUnavailable: ['b'], modelDetails: [], checkedAt: Date.now(), error: null }, 'auto');
    assert.strictEqual(p.modelChanged, true, '失去模型应标记变动');
    assert.strictEqual(pushes.length, 1, '变动且开关开启应推送');

    // 连接失败没有新清单：不把基线模型当成消失，也不把状态翻转算成模型变动
    applyResult(p, { status: 'down', modelsTotal: 2, modelsAvailable: [], modelsUnavailable: [], modelDetails: [], checkedAt: Date.now(), error: '连接失败' }, 'auto');
    assert.strictEqual(p.modelChanged, false, '连接失败不应记成模型变动');
    assert.strictEqual(pushes.length, 1);

    // 连续 down（无变化）→ 不推送
    applyResult(p, { status: 'down', modelsTotal: 2, modelsAvailable: [], modelsUnavailable: [], modelDetails: [], checkedAt: Date.now(), error: '连接失败' }, 'auto');
    assert.strictEqual(p.modelChanged, false);
    assert.strictEqual(pushes.length, 1, '连续相同结果不应重复推送');

    // 开关关闭 → 变动但不推送
    p.status = 'up'; p.modelsAvailable = ['a']; p.modelsTotal = 2;
    p.notifyOnModelChange = false;
    applyResult(p, { status: 'up', modelsTotal: 3, modelsAvailable: ['a', 'x'], modelsUnavailable: [], modelDetails: [], checkedAt: Date.now(), error: null }, 'auto');
    assert.strictEqual(p.modelChanged, true, '模型总数+可用变化应标记变动');
    assert.strictEqual(pushes.length, 1, '开关关闭不应推送');
  });

  // 5.8 导入导出模块
  await test('transfer: 三种格式导出', async () => {
    const { exportProviders } = require('../src/transfer');
    const providers = [
      { name: 'A 甲', url: 'http://a', apiKey: 'k1', intervalSec: 60, notifyOnModelChange: true, note: 'note,1' },
      { name: 'B', url: 'http://b', apiKey: '', intervalSec: 30, notifyOnModelChange: false, note: '' }
    ];
    const j = JSON.parse(exportProviders(providers, { format: 'json' }));
    assert.strictEqual(j.length, 2);
    assert.strictEqual(j[0].apiKey, 'k1');

    const csv = exportProviders(providers, { format: 'csv' });
    assert.ok(csv.startsWith('name,url,apiKey,intervalSec,notifyOnModelChange,note'));
    assert.ok(csv.includes('"note,1"'), '含逗号字段应加引号转义');

    const t1 = exportProviders(providers, { format: 'text', delimiter: 'pipe' });
    assert.ok(t1.split('\n')[0].includes('|'));
    const t2 = exportProviders(providers, { format: 'text', delimiter: 'tab' });
    assert.ok(t2.split('\n')[0].includes('\t'));

    const nk = JSON.parse(exportProviders(providers, { format: 'json', withKey: false }));
    assert.strictEqual(nk[0].apiKey, '', 'withKey=false 应剥离密钥');
  });

  await test('transfer: 三种格式解析 + 分隔符 + 错误行', async () => {
    const { parseImport } = require('../src/transfer');
    // JSON（数组与 {providers} 两种包裹）
    let r = parseImport('[{"name":"A","url":"http://a","apiKey":"k","intervalSec":30,"notifyOnModelChange":true}]', { format: 'json' });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].intervalSec, 30);
    assert.strictEqual(r.items[0].notifyOnModelChange, true);
    r = parseImport('{"providers":[{"name":"B","url":"b.com"}]}', { format: 'json' });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].url, 'http://b.com', 'host:port 简写应补 http://');

    // CSV（含引号转义与中文表头）
    const csv = 'name,url,apiKey,intervalSec,notifyOnModelChange,note\n"A,1",http://a,k1,60,1,"备注""引" "\nB,http://b,,30,0,x"';
    r = parseImport(csv, { format: 'csv' });
    assert.strictEqual(r.items.length, 2, 'CSV 应解析两行');
    assert.strictEqual(r.items[0].name, 'A,1');
    assert.strictEqual(r.items[1].intervalSec, 30);

    // 文本 + 各种分隔符
    r = parseImport('A\thttp://a\tk1\t60\t1\t备注', { format: 'text', delimiter: 'tab' });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].name, 'A');
    assert.strictEqual(r.items[0].note, '备注');
    r = parseImport('A | http://a | k1 | 60 | 1', { format: 'text', delimiter: 'pipe' });
    assert.strictEqual(r.items.length, 1);
    r = parseImport('A,http://a,,60,0,备注,含,逗号', { format: 'text', delimiter: 'comma' });
    assert.strictEqual(r.items[0].note, '备注,含,逗号', '逗号分隔时多余列应并回备注');
    r = parseImport('A;http://a', { format: 'text', delimiter: 'semicolon' });
    assert.strictEqual(r.items.length, 1);
    // 简写：只有 名称+URL
    r = parseImport('C http://c'.replace(' ', '\t'), { format: 'text', delimiter: 'tab' });
    assert.strictEqual(r.items.length, 1);

    // 错误处理：缺 URL、空行、坏 JSON
    r = parseImport('A\thttp://a\n\n只有名字', { format: 'text', delimiter: 'tab' });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.errors.length, 1);
    r = parseImport('{bad json', { format: 'json' });
    assert.strictEqual(r.items.length, 0);
    assert.ok(r.errors[0].msg);
  });

  await test('transfer: applyImport 合并与追加', async () => {
    const { applyImport } = require('../src/transfer');
    const db = { providers: [{ id: 1, name: 'Old', url: 'http://a/', apiKey: '', intervalSec: 99, notifyOnModelChange: false, note: '' }] };
    const items = [
      { name: 'A-new', url: 'http://a', apiKey: 'k', intervalSec: 30, notifyOnModelChange: true, note: 'n' },
      { name: 'B', url: 'http://b', apiKey: '', intervalSec: 60, notifyOnModelChange: false, note: '' }
    ];
    const r1 = applyImport(db, items, 'merge');
    assert.strictEqual(r1.added, 1);
    assert.strictEqual(r1.updated, 1);
    assert.strictEqual(db.providers.length, 2);
    const merged = db.providers.find((p) => p.url === 'http://a');
    assert.strictEqual(merged.name, 'A-new');
    assert.strictEqual(merged.intervalSec, 30);
    // 追加模式：URL 重复也新增
    const r2 = applyImport(db, items, 'append');
    assert.strictEqual(r2.added, 2);
    assert.strictEqual(db.providers.length, 4);
  });


  await test('transfer: skipped 正确统计（无变化/空 URL 不计入更新）', async () => {
    const { applyImport } = require('../src/transfer');
    // 1) 完全相同的条目重复导入 => 既不新增也不更新，全部计入 skipped
    const db = { providers: [] };
    const items = [
      { name: 'A', url: 'http://a', apiKey: 'k', intervalSec: 30, notifyOnModelChange: true, note: 'n' },
      { name: 'B', url: 'http://b', apiKey: '', intervalSec: 60, notifyOnModelChange: false, note: '' }
    ];
    const r1 = applyImport(db, items, 'merge');
    assert.strictEqual(r1.added, 2, '首次应全部新增');
    assert.strictEqual(r1.skipped, 0);
    const r2 = applyImport(db, items, 'merge');
    assert.strictEqual(r2.added, 0, '重复导入不应新增');
    assert.strictEqual(r2.updated, 0, '内容一致不应算作更新');
    assert.strictEqual(r2.skipped, 2, '内容一致应计入 skipped');
    assert.strictEqual(db.providers.length, 2, '不应产生重复记录');

    // 2) 三数之和恒等于条目总数（修复前 skipped 恒为 0，此断言必然失败）
    assert.strictEqual(r2.added + r2.updated + r2.skipped, items.length);

    // 3) 真正有变化时仍计为 updated
    const r3 = applyImport(db, [{ ...items[0], intervalSec: 999 }], 'merge');
    assert.strictEqual(r3.updated, 1);
    assert.strictEqual(r3.skipped, 0);

    // 4) 空 URL 条目应跳过而非入库
    const before = db.providers.length;
    const r4 = applyImport(db, [{ name: 'NoUrl', url: '', intervalSec: 60 }], 'merge');
    assert.strictEqual(r4.skipped, 1);
    assert.strictEqual(r4.added, 0);
    assert.strictEqual(db.providers.length, before, '空 URL 不应入库');

    // 5) append 模式同样过滤空 URL
    const r5 = applyImport(db, [{ name: 'X', url: 'http://x' }, { name: 'Y', url: '   ' }], 'append');
    assert.strictEqual(r5.added, 1);
    assert.strictEqual(r5.skipped, 1);
  });

  await test('durfmt: 主进程与渲染层共用同一实现（双模导出）', async () => {
    const vm = require('vm');
    const durfmtSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'durfmt.js'), 'utf8');

    // 主进程侧：CommonJS
    const nodeSide = require('../src/durfmt');
    assert.strictEqual(typeof nodeSide.formatDuration, 'function');

    // 渲染层侧：无 module 对象，仅有 window
    const win = {};
    vm.runInNewContext(durfmtSrc, { window: win });
    assert.ok(win.durfmt, 'window.durfmt 应被挂载');

    // 两侧对同一批输入必须产出完全一致的结果（防止口径再次漂移）
    for (const sec of [1, 45, 90, 300, 3600, 5400, 86400, 604800, 2592000, 31536000, 7776000]) {
      assert.strictEqual(win.durfmt.formatDuration(sec), nodeSide.formatDuration(sec), `formatDuration(${sec}) 两侧应一致`);
      // vm 沙箱与主realm 的 Object.prototype 不同，deepStrictEqual 会因原型不一致误报，
      // 故以 JSON 序列化比对值本身。
      assert.strictEqual(
        JSON.stringify(win.durfmt.fromSeconds(sec)),
        JSON.stringify(nodeSide.fromSeconds(sec)),
        `fromSeconds(${sec}) 两侧应一致`
      );
    }
    assert.strictEqual(win.durfmt.toSeconds(2, 'hour'), 7200);
    assert.strictEqual(win.durfmt.EDITABLE_UNITS.length, nodeSide.EDITABLE_UNITS.length);

    // 渲染层不应再保留第二份实现
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
    assert.ok(!/const\s+DUR_UNITS\s*=\s*\[/.test(appSrc), 'renderer/app.js 不应再内联 DUR_UNITS 副本');
    // index.html 必须先于 app.js 加载 durfmt
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    assert.ok(html.indexOf('durfmt.js') > 0, 'index.html 应引入 durfmt.js');
    assert.ok(html.indexOf('durfmt.js') < html.indexOf('app.js'), 'durfmt.js 必须在 app.js 之前加载');
  });
  // 6. 备份/还原模块
  await test('backup: 导出、校验、覆盖还原、合并还原', async () => {
    const backup = require('../src/backup');
    const dataDir = path.join(TMP, 'bk-test');
    fs.mkdirSync(dataDir, { recursive: true });

    // 导出
    const data = {
      global: { concurrency: 6, notifyWeixinEnabled: true, weixinWebhook: 'http://x' },
      providers: [
        { id: 1, name: 'A', url: 'http://a', apiKey: 'k1', intervalSec: 60, notifyOnModelChange: true },
        { id: 2, name: 'B', url: 'http://b', apiKey: '', intervalSec: 30, notifyOnModelChange: false }
      ]
    };
    const file = path.join(dataDir, 'manual.json');
    backup.exportTo(data, file);
    assert.ok(fs.existsSync(file));

    // 校验非法文件
    const bad = path.join(dataDir, 'bad.json');
    fs.writeFileSync(bad, '{"foo":1}');
    assert.throws(() => backup.parseBackupFile(bad), /providers/);

    // 覆盖还原
    const target = { global: { concurrency: 4 }, providers: [{ id: 9, name: 'Old', url: 'http://old' }] };
    const r1 = backup.restoreFrom(target, file, 'overwrite');
    assert.strictEqual(r1.providers, 2);
    assert.strictEqual(target.providers.length, 2);
    assert.strictEqual(target.global.concurrency, 6, '覆盖还原应恢复 global');
    assert.strictEqual(target.providers[0].status, 'unknown', '还原后应重置检测状态');

    // 合并还原：http://b 已存在 => 更新；http://a 不在 => 新增
    const target2 = { global: { concurrency: 4 }, providers: [{ id: 2, name: 'B-old', url: 'http://b/', intervalSec: 99, notifyOnModelChange: false }] };
    const r2 = backup.restoreFrom(target2, file, 'merge');
    assert.strictEqual(r2.added, 1);
    assert.strictEqual(r2.updated, 1);
    assert.strictEqual(target2.providers.length, 2);
    const merged = target2.providers.find((p) => p.url === 'http://b');
    assert.strictEqual(merged.name, 'B', '合并应更新名称');
    assert.strictEqual(merged.intervalSec, 30, '合并应更新周期');
    assert.strictEqual(target2.global.concurrency, 4, '合并不应动 global');
  });

  await test('backup: 自动备份滚动保留', async () => {
    const backup = require('../src/backup');
    const dataDir = path.join(TMP, 'bk-auto');
    fs.mkdirSync(dataDir, { recursive: true });
    const data = { global: {}, providers: [{ id: 1, name: 'A', url: 'http://a' }] };
    const f1 = backup.autoBackup(data, dataDir, { keep: 2 });
    assert.ok(f1 && fs.existsSync(f1), '首次应生成自动备份');
    // 立即再跑一次不应生成（24h 内）
    const f2 = backup.autoBackup(data, dataDir, { keep: 2 });
    assert.strictEqual(f2, null);
    // 列表
    const list = backup.listAuto(dataDir);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].count, 1);
    // 伪造 2 份旧备份验证滚动删除
    const dir = backup.backupDir(dataDir);
    for (const n of ['auto-20260101-000000.json', 'auto-20260102-000000.json']) {
      fs.writeFileSync(path.join(dir, n), JSON.stringify({ providers: [] }));
    }
    // 将 marker 改为 25h 前，再生成一份，应触发滚动保留 2 份
    fs.writeFileSync(path.join(dir, '.last-auto'), String(Date.now() - 25 * 3600 * 1000));
    const f3 = backup.autoBackup(data, dataDir, { keep: 2 });
    assert.ok(f3);
    const list2 = backup.listAuto(dataDir);
    assert.strictEqual(list2.length, 2, '应只保留 2 份');
  });
  await test('logger: 写入、订阅、取消订阅', async () => {
    const logger = require('../src/logger');
    const seen = [];
    const un = logger.subscribe((l) => seen.push(l));
    logger.info('hello-test');
    un();
    const countBefore = seen.length;
    logger.info('after-unsub');
    assert.ok(logger.recent().some((l) => l.msg.includes('hello-test')));
    assert.strictEqual(seen.length, countBefore, '取消订阅后不应再收到回调');
  });

  // ---------- 新增能力：检测参数 / 告警 / 历史 / 扩展渠道 / 日志轮转 ----------

  await test('store: 新增全局默认字段齐备', async () => {
    const store = require('../src/store');
    for (const k of ['qqTarget', 'qqTargetType', 'qqToken', 'alertFailThreshold', 'probeLimit',
      'requestTimeoutMs', 'probeTimeoutMs', 'retries', 'proxyEnabled', 'historyEnabled',
      'historyKeepDays', 'logKeepDays', 'logLevel', 'theme', 'launchAtLogin']) {
      assert.ok(k in store.DEFAULT_GLOBAL, `DEFAULT_GLOBAL 缺少 ${k}`);
    }
  });

  await test('store: saveAll 原子写，无临时文件残留', async () => {
    const store = require('../src/store');
    store.saveAll({ global: { concurrency: 3 }, providers: [{ id: 42, name: 'atomic' }] });
    assert.strictEqual(store.loadAll().providers[0].id, 42);
    const leftover = fs.readdirSync(store.DATA_DIR).filter((f) => f.includes('.tmp-'));
    assert.strictEqual(leftover.length, 0, `残留临时文件: ${leftover.join(',')}`);
  });

  await test('detector: 模型列表为空 => degraded（非 up）', async () => {
    const { srv, port } = await makeMockServer({ models: [] });
    const { detect } = require('../src/detector');
    const r = await detect({ id: 10, name: 'empty', url: `http://127.0.0.1:${port}` });
    assert.strictEqual(r.status, 'degraded', '空模型列表应判 degraded');
    srv.close();
  });

  await test('detector: 超出上限的模型进入 modelsUnprobed 而非 unavailable', async () => {
    const { srv, port } = await makeMockServer({ models: ['a', 'b', 'c', 'd'] });
    const { detect } = require('../src/detector');
    const r = await detect({ id: 11, name: 'lim', url: `http://127.0.0.1:${port}` }, { probeLimit: 2 });
    assert.strictEqual(r.modelsUnprobed.length, 2, '应有 2 个未探测');
    assert.ok(!r.modelsUnavailable.includes('c'), '未探测不应混入不可用');
    srv.close();
  });

  await test('detector: probeMode=none 跳过单模型探测', async () => {
    const { srv, port } = await makeMockServer({ models: ['x', 'y'], chatFail: true });
    const { detect } = require('../src/detector');
    const r = await detect({ id: 12, name: 'none', url: `http://127.0.0.1:${port}`, probeMode: 'none' });
    assert.strictEqual(r.status, 'up', 'none 模式下不应因 chat 失败而降级');
    assert.strictEqual(r.modelsAvailable.length, 2);
    srv.close();
  });

  await test('detector: buildProbeRequest 支持多种探测方式', async () => {
    const { buildProbeRequest } = require('../src/detector');
    assert.ok(buildProbeRequest('http://h', 'm', {}).url.endsWith('/v1/chat/completions'));
    assert.ok(buildProbeRequest('http://h', 'm', { probeMode: 'embeddings' }).url.endsWith('/v1/embeddings'));
    assert.ok(buildProbeRequest('http://h', 'm', { probeMode: 'completions' }).url.endsWith('/v1/completions'));
    const c = buildProbeRequest('http://h', 'gpt-4', {
      probeMode: 'custom', probePath: '/api/probe', probeBody: '{"model":"{{model}}"}'
    });
    assert.strictEqual(c.url, 'http://h/api/probe');
    assert.strictEqual(JSON.parse(c.body).model, 'gpt-4');
  });

  await test('detector: isRetryable 区分可重试与终态错误', async () => {
    const { isRetryable } = require('../src/detector');
    assert.strictEqual(isRetryable(new Error('HTTP 404')), false);
    assert.strictEqual(isRetryable(new Error('HTTP 401')), false);
    assert.strictEqual(isRetryable(new Error('HTTP 429')), true);
    assert.strictEqual(isRetryable(new Error('HTTP 502')), true);
    assert.strictEqual(isRetryable(new Error('请求超时')), true);
  });

  await test('alerts: 连续失败消抖 + 恢复通知', async () => {
    const alerts = require('../src/alerts');
    const g = { alertFailThreshold: 3, alertCooldownMin: 0, alertRecoverNotify: true };
    const p = { id: 101, name: 'a1', status: 'down', modelsAvailable: [], modelsTotal: 0 };
    alerts.resetState(101);
    assert.strictEqual(alerts.evaluate(g, p, null, { firstCheck: true }).alerts.length, 0, '首检不告警');
    assert.strictEqual(alerts.evaluate(g, p, {}, {}).alerts.length, 0, '未达阈值不告警');
    const hit = alerts.evaluate(g, p, {}, {});
    assert.strictEqual(hit.alerts.length, 1, '达阈值应告警');
    assert.strictEqual(hit.alerts[0].kind, 'down');
    assert.strictEqual(alerts.evaluate(g, p, {}, {}).alerts.length, 0, '告警态内不重复推送');
    const rec = alerts.evaluate(g, { ...p, status: 'up', modelsAvailable: ['m'], modelsTotal: 1 }, {}, {});
    assert.strictEqual(rec.alerts[0].kind, 'recover', '恢复应告警');
  });

  await test('alerts: 静默时段支持跨零点', async () => {
    const alerts = require('../src/alerts');
    const g = { alertQuietEnabled: true, alertQuietStart: '23:00', alertQuietEnd: '07:00' };
    assert.strictEqual(alerts.inQuietHours(g, new Date(2026, 0, 1, 2, 30)), true, '02:30 应在静默内');
    assert.strictEqual(alerts.inQuietHours(g, new Date(2026, 0, 1, 23, 30)), true, '23:30 应在静默内');
    assert.strictEqual(alerts.inQuietHours(g, new Date(2026, 0, 1, 12, 0)), false, '12:00 不应静默');
    assert.strictEqual(alerts.inQuietHours({ alertQuietEnabled: false }, new Date(2026, 0, 1, 2, 0)), false);
  });

  await test('alerts: 冷却窗口内同类告警不重复', async () => {
    const alerts = require('../src/alerts');
    const g = { alertFailThreshold: 1, alertCooldownMin: 60, alertOnModelChange: true };
    const p = { id: 102, name: 'a2', status: 'up', modelsAvailable: ['m'], modelsTotal: 1, notifyOnModelChange: true };
    alerts.resetState(102);
    alerts.evaluate(g, p, {}, { firstCheck: true });
    const first = alerts.evaluate(g, p, {}, { modelChanged: true });
    assert.strictEqual(first.alerts.length, 1, '首次变动应告警');
    const second = alerts.evaluate(g, p, {}, { modelChanged: true });
    assert.strictEqual(second.alerts.length, 0, '冷却内不应重复');
    assert.ok(second.suppressed.some((s) => s.why === '冷却中'));
  });

  await test('history: 记录、汇总可用率与延迟分位、分桶、CSV', async () => {
    const history = require('../src/history');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-hist-'));
    const now = Date.now();
    const mk = (t, status, latency) => ({
      checkedAt: t, status, latency, modelsTotal: 2,
      modelsAvailable: status === 'up' ? ['a', 'b'] : [], modelsUnavailable: [], modelsUnprobed: []
    });
    history.append(dir, { id: 1, name: 'P1' }, mk(now - 3 * 60000, 'up', 100));
    history.append(dir, { id: 1, name: 'P1' }, mk(now - 2 * 60000, 'up', 200));
    history.append(dir, { id: 1, name: 'P1' }, mk(now - 60000, 'down', null));
    history.append(dir, { id: 2, name: 'P2' }, mk(now, 'up', 50));

    const sum = history.summarize(dir, { hours: 24 });
    assert.strictEqual(sum.overall.samples, 4);
    assert.strictEqual(sum.overall.providers, 2);
    const p1 = sum.perProvider.find((x) => x.id === 1);
    assert.strictEqual(p1.samples, 3);
    assert.ok(Math.abs(p1.uptime - 66.67) < 0.1, `uptime=${p1.uptime}`);
    assert.strictEqual(p1.latencyAvg, 150);
    assert.ok(p1.downMs > 0, '应统计到故障时长');

    const ser = history.series(dir, { hours: 24, buckets: 12 });
    assert.strictEqual(ser.buckets.length, 12);

    const csv = history.exportCSV(dir, { hours: 24 });
    assert.ok(csv.split('\r\n').length >= 5, 'CSV 应含表头与 4 行数据');

    const filtered = history.summarize(dir, { hours: 24, providerId: 2 });
    assert.strictEqual(filtered.overall.samples, 1, 'providerId 过滤应生效');
  });

  await test('history: prune 清理过期分片', async () => {
    const history = require('../src/history');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipm-hist2-'));
    const hdir = history.historyDir(dir);
    fs.mkdirSync(hdir, { recursive: true });
    fs.writeFileSync(path.join(hdir, 'hist-20200101.jsonl'), '{}\n', 'utf8');
    history.append(dir, { id: 1, name: 'now' }, {
      checkedAt: Date.now(), status: 'up', latency: 10,
      modelsTotal: 1, modelsAvailable: ['a'], modelsUnavailable: [], modelsUnprobed: []
    });
    const removed = history.prune(dir, 30);
    assert.strictEqual(removed, 1, '应删除 1 个过期分片');
    assert.ok(fs.readdirSync(hdir).length >= 1, '当日分片应保留');
  });

  await test('notifier: 8 个通道 + 启用判定 + 告警文案', async () => {
    const n = require('../src/notifier');
    assert.strictEqual(n.CHANNELS.length, 8);
    for (const f of ['sendTelegram', 'sendFeishu', 'sendSlack', 'sendServerChan', 'sendCustom',
      'notifyAlert', 'broadcast']) {
      assert.strictEqual(typeof n[f], 'function', `缺少 ${f}`);
    }
    assert.strictEqual(n.channelEnabled({ notifyTelegramEnabled: true, telegramToken: 't', telegramChatId: '1' }, 'telegram'), true);
    assert.strictEqual(n.channelEnabled({ notifyTelegramEnabled: true, telegramToken: 't' }, 'telegram'), false, '缺 chatId 应视为未配置');
    assert.strictEqual(n.channelEnabled({ notifySlackEnabled: true, slackWebhook: 'http://x' }, 'slack'), true);
    const txt = n.buildAlertText({ name: 'P', url: 'http://u', status: 'down', latency: 12 },
      { kind: 'down', reason: '连续 3 轮失败' });
    assert.ok(txt.includes('服务异常') && txt.includes('连续 3 轮失败'));
    assert.ok(n.buildAlertText({ name: 'P', status: 'up' }, { kind: 'recover', reason: 'ok' }).includes('服务恢复'));
  });

  await test('notifier: 通用 Webhook 模板渲染与非法模板拦截', async () => {
    const { sendCustom } = require('../src/notifier');
    let received = null;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { received = b; res.writeHead(200); res.end('{}'); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await sendCustom({ customWebhook: `http://127.0.0.1:${port}/h`, customTemplate: '{"msg":"{{text}}","n":"{{name}}"}' },
      'hello', { name: 'P1' });
    const parsed = JSON.parse(received);
    assert.strictEqual(parsed.msg, 'hello');
    assert.strictEqual(parsed.n, 'P1');
    await assert.rejects(
      () => sendCustom({ customWebhook: `http://127.0.0.1:${port}/h`, customTemplate: '{bad json' }, 'x', {}),
      /不是合法 JSON/
    );
    srv.close();
  });

  await test('notifier: Telegram / 飞书 / Slack 请求体正确', async () => {
    const n = require('../src/notifier');
    const hits = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { hits.push({ url: req.url, body: b }); res.writeHead(200); res.end('{"ok":true,"code":0}'); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    await n.sendTelegram({ telegramToken: 'TK', telegramChatId: '99', telegramApiBase: base }, 'tg-msg');
    assert.ok(hits[0].url.includes('/botTK/sendMessage'));
    assert.strictEqual(JSON.parse(hits[0].body).chat_id, '99');
    await n.sendFeishu({ feishuWebhook: `${base}/fs`, feishuSecret: 'sec' }, 'fs-msg');
    const fs1 = JSON.parse(hits[1].body);
    assert.strictEqual(fs1.msg_type, 'text');
    assert.ok(fs1.sign && fs1.timestamp, '配置密钥时应带签名');
    await n.sendSlack({ slackWebhook: `${base}/sk` }, 'sk-msg');
    assert.strictEqual(JSON.parse(hits[2].body).text, 'sk-msg');
    srv.close();
  });

  await test('logger: 级别过滤与轮转配置接口', async () => {
    const logger = require('../src/logger');
    assert.strictEqual(typeof logger.configure, 'function');
    assert.strictEqual(typeof logger.listFiles, 'function');
    const c = logger.configure({ logKeepDays: 5, logMaxFileMB: 2, logLevel: 'warn' });
    assert.strictEqual(c.keepDays, 5);
    assert.strictEqual(c.level, 'warn');
    logger.clear();
    logger.info('filtered-out');
    logger.error('kept');
    const msgs = logger.recent().map((l) => l.msg);
    assert.ok(!msgs.includes('filtered-out'), 'info 应被过滤');
    assert.ok(msgs.includes('kept'));
    logger.configure({ logLevel: 'debug' });   // 还原，避免影响后续
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();
