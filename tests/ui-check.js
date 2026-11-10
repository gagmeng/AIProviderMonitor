'use strict';
// Hidden, isolated windows verify cross-page layout and real keyboard interactions.
const path = require('path'), fs = require('fs');
const { app, BrowserWindow } = require('electron');
const root = path.join(__dirname, '..');
const { fixture, registerFixture } = require('./renderer-fixture'); registerFixture();

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1180, height: 820,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (event) => { if (['error', 'warning'].includes(event.level)) errs.push(event.message); });
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const probe = await win.webContents.executeJavaScript(`(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; };
    // 切到服务商视图，让工具栏参与布局
    const navProv = document.querySelector('[data-view="providers"]');
    if (navProv) navProv.click();
    const num = document.querySelector('#concurrency');
    const numCS = cs(num);
    const gf = document.querySelector('#groupFilter'), sf = document.querySelector('#statusFilter');
    const imp = document.querySelector('#btnImport'), exp = document.querySelector('#btnExport');
    const chk = document.querySelector('#btnCheckSel');
    const lf = document.querySelector('#logFilter'), si = document.querySelector('#searchInput');
    const lfCS = cs(lf), siCS = cs(si);
    const tb = document.querySelector('.toolbar');
    const kids = tb ? [...tb.children].map((c) => ({ id: c.id || c.className, ...rect(c) })) : [];
    const rows = [...new Set(kids.filter(k => k.w > 0).map((k) => k.y))];
    return {
      numAlign: numCS && numCS.textAlign, numW: numCS && numCS.width, numAppearance: numCS && (numCS.MozAppearance || numCS.appearance),
      numRect: rect(num),
      groupW: rect(gf), statusW: rect(sf),
      impRect: rect(imp), expRect: rect(exp), chkRect: rect(chk),
      impText: imp && imp.textContent, expText: exp && exp.textContent, chkText: chk && chk.textContent,
      impHasIcon: !!(imp && imp.querySelector('svg')), expHasIcon: !!(exp && exp.querySelector('svg')), chkHasIcon: !!(chk && chk.querySelector('svg')),
      logFilterBg: lfCS && lfCS.backgroundColor, searchBg: siCS && siCS.backgroundColor,
      logFilterRadius: lfCS && lfCS.borderRadius, searchRadius: siCS && siCS.borderRadius,
      logFilterPadLeft: lfCS && lfCS.paddingLeft, searchPadLeft: siCS && siCS.paddingLeft,
      logFilterBorder: lfCS && lfCS.borderStyle,
      hasInvert: !!document.querySelector('#btnInvert'),
      selAllText: (document.querySelector('#selAllText')||{}).textContent,
      toolbarRows: rows.length, toolbarW: rect(tb),
      btnWhiteSpace: imp && cs(imp).whiteSpace
    };
  })()`);

  // Actions and filters use separate rows at standard desktop widths.
  const tbH = probe.toolbarW ? probe.toolbarW.h : 0;
  const checks = [
    ['数字输入框文字居中', probe.numAlign === 'center'],
    ['数字输入框隐藏微调箭头', String(probe.numAppearance).includes('textfield')],
    ['分组筛选框已收窄(<=110px)', probe.groupW && probe.groupW.w <= 110],
    ['状态筛选框已收窄(<=110px)', probe.statusW && probe.statusW.w <= 110],
    ['检测按钮无图标', probe.chkHasIcon === false && probe.chkText.trim() === '检测'],
    ['导入按钮无图标', probe.impHasIcon === false && probe.impText.trim() === '导入'],
    ['导出按钮无图标', probe.expHasIcon === false && probe.expText.trim() === '导出'],
    ['导入按钮未折行(高<=34)', probe.impRect && probe.impRect.h <= 34],
    ['按钮 white-space:nowrap', probe.btnWhiteSpace === 'nowrap'],
    ['工具栏按操作与筛选分区布局', tbH > 0 && tbH <= 110],
    ['反选按钮已移除', probe.hasInvert === false],
    ['全选文案存在', !!probe.selAllText],
    ['日志过滤框与搜索框同背景', probe.logFilterBg === probe.searchBg],
    ['日志过滤框与搜索框同圆角', probe.logFilterRadius === probe.searchRadius],
    ['日志过滤框左内边距留出图标位', probe.logFilterPadLeft === probe.searchPadLeft],
    ['日志过滤框无默认边框', probe.logFilterBorder === 'none']
  ];
  let bad = 0;
  for (const [n, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); }
  console.log('probe:', JSON.stringify(probe));
  if (errs.length) { console.log('renderer errors:'); errs.slice(0, 6).forEach((e) => console.log('  ERR>', String(e).slice(0, 160))); }

  // Narrow windows may wrap groups, while button labels stay on one line.
  win.setSize(820, 760);
  await new Promise((r) => setTimeout(r, 500));
  const narrow = await win.webContents.executeJavaScript(`(() => {
    const tb = document.querySelector('.toolbar');
    const imp = document.querySelector('#btnImport');
    return { tbH: Math.round(tb.getBoundingClientRect().height), impH: Math.round(imp.getBoundingClientRect().height) };
  })()`);
  const narrowOK = narrow.impH <= 34;
  console.log(`${narrowOK ? 'PASS' : 'FAIL'}  窄窗口(820px)下导入按钮不折行  ${JSON.stringify(narrow)}`);
  if (!narrowOK) bad++;

  // 统计页头部：时间筛选框 + 三个按钮同排单行（1180px 与 820px 双档）
  const statsProbe = () => win.webContents.executeJavaScript(`(() => {
    const navStats = document.querySelector('[data-view="stats"]');
    if (navStats) navStats.click();
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const sel = r('#stRange'), c1 = r('#stExportCsv'), c2 = r('#stExportReport'), c3 = r('#stRefresh');
    if (!sel || !c1 || !c2 || !c3) return { ok: false };
    const ys = [sel.y, c1.y, c2.y, c3.y];
    return { ok: true,
      oneRow: Math.max(...ys) - Math.min(...ys) < 2,
      btnH: Math.max(c1.h, c2.h, c3.h),
      selW: sel.w,
      order: sel.x < c1.x && c1.x < c2.x && c2.x < c3.x };
  })()`);
  win.setSize(1180, 820);
  await new Promise((r) => setTimeout(r, 400));
  const st = await statsProbe();
  const stOK = st.ok && st.oneRow && st.btnH <= 40 && st.selW <= 200 && st.order;
  console.log(`${stOK ? 'PASS' : 'FAIL'}  统计页头部筛选+按钮单行(1180px)  ${JSON.stringify(st)}`);
  if (!stOK) bad++;
  win.setSize(820, 760);
  await new Promise((r) => setTimeout(r, 400));
  const st2 = await statsProbe();
  const st2OK = st2.ok && st2.oneRow && st2.btnH <= 40;
  console.log(`${st2OK ? 'PASS' : 'FAIL'}  统计页头部单行(820px窄窗)  ${JSON.stringify(st2)}`);
  if (!st2OK) bad++;

  // 通道健康面板：已启用未发送 / 发送成功 / 连续失败 / 配置不完整 四态区分
  // （历史缺陷：只在有发送记录时才不是「未使用」，导致刚启用钉钉仍显示未使用）
  win.setSize(1180, 820);
  await new Promise((r) => setTimeout(r, 300));
  const health = await win.webContents.executeJavaScript(`(() => {
    const cell = (ch) => {
      const items = [...document.querySelectorAll('#notifyHealthList .health-item')];
      const el = items.find((n) => n.querySelector('.health-name').textContent.trim() === ch);
      if (!el) return null;
      return {
        dot: el.querySelector('.health-dot').className.replace('health-dot ', '').trim(),
        meta: el.querySelector('.health-meta').textContent.trim()
      };
    };
    // 通过页面全局绑定直接构造状态，绕开测试环境缺失的主进程 IPC
    state = { ...state, global: { notifyDingtalkEnabled: true, dingtalkWebhookConfigured: true }, selfmon: { notifyHealth: {} } };
    renderNotifyHealth();
    const enabled = cell('钉钉');
    state.selfmon.notifyHealth = { dingtalk: { fails: 0, lastOkAt: Date.now(), lastFailAt: 0, lastError: '' } };
    renderNotifyHealth();
    const okState = cell('钉钉');
    state.selfmon.notifyHealth = { dingtalk: { fails: 3, lastOkAt: 0, lastFailAt: Date.now(), lastError: 'errcode=310000' } };
    renderNotifyHealth();
    const badState = cell('钉钉');
    state.global = { notifyDingtalkEnabled: true, dingtalkWebhookConfigured: false };
    state.selfmon.notifyHealth = {};
    renderNotifyHealth();
    const incomplete = cell('钉钉');
    state.global = { notifyDingtalkEnabled: false };
    renderNotifyHealth();
    const disabled = cell('钉钉');
    return { enabled, okState, badState, incomplete, disabled };
  })()`);
  const healthChecks = [
    ['已启用未发送显示「已启用 · 待发送」', health.enabled && health.enabled.meta.includes('已启用') && health.enabled.dot === 'idle'],
    ['发送成功显示绿灯与最后成功', health.okState && health.okState.dot === 'ok' && health.okState.meta.includes('最后成功')],
    ['连续失败显示红灯与次数', health.badState && health.badState.dot === 'bad' && health.badState.meta.includes('3')],
    ['开关开着但没填地址提示配置不完整', health.incomplete && health.incomplete.meta.includes('配置不完整')],
    ['未启用的通道显示未使用', health.disabled && health.disabled.meta === '未使用' && health.disabled.dot === 'idle'],
    ['已启用未发送时不再显示未使用', health.enabled && !health.enabled.meta.includes('未使用')]
  ];
  for (const [n, ok] of healthChecks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); }
  if (healthChecks.some(([, ok]) => !ok)) console.log('health probe:', JSON.stringify(health));

  // A week of isolated observations exercises populated tables, long names, unknown time and breached budgets.
  const history = require('../src/history'), now = Date.now(), interval = 300;
  fixture.providers = [
    { id: 11, name: 'Production Gateway', intervalSec: interval, sloTarget: 99.9 },
    { id: 12, name: 'Research Inference', intervalSec: interval, sloTarget: 99.95 },
    { id: 13, name: 'Local Ollama · Development', intervalSec: interval, sloTarget: 99.5 },
    { id: 14, name: 'Embedding Service', intervalSec: interval, sloTarget: 99.9 }
  ].map((p, index) => ({ ...p, url: 'https://service-' + (index + 1) + '.example/v1',
    status: ['up', 'down', 'degraded', 'unknown'][index], enabled: index !== 3,
    group: index < 2 ? '生产环境' : '开发环境', tags: index === 2 ? ['local', 'experimental'] : ['OpenAI API'],
    modelsAvailable: index === 1 ? [] : ['model-a', 'model-b'], modelsUnavailable: index === 1 ? ['model-a', 'model-b'] : [],
    modelsTotal: 2, latency: index === 1 ? null : 182 + index * 93, checkedAt: now - index * 45000,
    lastError: index === 1 ? 'HTTP 503 · Service temporarily unavailable' : '', notifyOnModelChange: index < 2 }));
  for (let i = 0; i < 7 * 288; i++) {
    for (let n = 0; n < fixture.providers.length; n++) {
      if (n === 2 && i < 288) continue;
      const down = (n === 1 && i > 1930 && i < 1947) || (n === 2 && i > 1800 && i < 1840);
      history.append(process.env.AIPM_DATA_DIR, fixture.providers[n], { checkedAt: now - (7 * 288 - i) * interval * 1000,
        status: down ? 'down' : 'up', latency: Math.round(160 + n * 90 + Math.sin(i / 9) * 65 + (i % 73 === 0 ? 250 : 0)) });
    }
  }
  await history.flush();
  fixture.global.sloWindowDays = 7; fixture.global.hotkeyEnabled = true; fixture.global.onboardingDismissed = true;
  fixture.global.notifyDingtalkEnabled = true; fixture.global.dingtalkWebhookConfigured = true;
  fixture.selfmon.notifyHealth = { dingtalk: { fails: 0, lastOkAt: now - 90000 } };
  fixture.schedule = fixture.providers.filter((p) => p.enabled).map((p) => ({ id: p.id, dueAt: now + 120000 }));
  fixture.logLines = Array.from({ length: 12 }, (_, index) => ({ t: '16:' + String(30 + index).padStart(2, '0') + ':05',
    level: index === 4 ? 'error' : index === 7 ? 'warn' : 'info',
    msg: ['[Production Gateway] 检测完成：2 / 2 个模型可用，延迟 182 ms', '[Research Inference] HTTP 503 · Service temporarily unavailable', '[调度器] 已完成本轮检测，等待下次计划'][index % 3] }));
  fixture.logFileList = [{ file: '2026-11-10.log', size: 38400, mtime: now }];
  fixture.backupList = [{ file: 'auto-2026-11-10.json', path: path.join(process.env.AIPM_DATA_DIR, 'auto-fixture.json'), at: now, count: 4, size: 9400 }];
  await win.webContents.insertCSS('* { transition:none !important; animation:none !important; }');
  const shots = path.join(root, 'uishots'); fs.mkdirSync(shots, { recursive: true });
  const screenshot = async (name) => {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  };
  for (const width of [1280, 1020, 820]) {
    win.setSize(width, 900); await new Promise((r) => setTimeout(r, 150));
    await win.webContents.executeJavaScript('(async () => { state = await window.aipm.getState(); renderNav(); navTo("stats"); await renderStats(); document.querySelector("#main").scrollTop = 0; })()');
    const layout = await win.webContents.executeJavaScript(`(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const panels = [...document.querySelectorAll('#view-stats .analytics-panel')].map((e) => e.getBoundingClientRect());
      return { noPageOverflow: document.querySelector('#main').scrollWidth <= document.querySelector('#main').clientWidth + 1,
        alignedCards: Math.abs(r('#stUptime').top - r('#stCoverageValue').top) < 2,
        tablesContained: panels.every((p) => p.right <= innerWidth),
        rows: document.querySelectorAll('#sloTable tbody tr').length,
        hasPoints: document.querySelectorAll('#stChart svg polyline').length > 0 };
    })()`);
    const ok = layout.noPageOverflow && layout.alignedCards && layout.tablesContained && layout.rows === 4 && layout.hasPoints;
    console.log(`${ok ? 'PASS' : 'FAIL'}  analytics populated layout ${width}px ${JSON.stringify(layout)}`); if (!ok) bad++;
    await screenshot(`analytics-${width}.png`);
    if (width === 1280) {
      await win.webContents.executeJavaScript('document.querySelector("#main").scrollTop = 640;');
      await screenshot('analytics-slo-details.png');
      await win.webContents.executeJavaScript('state.global.theme = "dark"; applyTheme(); document.querySelector("#main").scrollTop = 0;');
      await screenshot('analytics-dark.png');
      await win.webContents.executeJavaScript('state.global.theme = "light"; applyTheme();');
    }
  }
  await win.webContents.executeJavaScript('state.global.lang = "en"; applyLang();');
  await win.webContents.executeJavaScript('renderSLO({windowDays:7, overall:{ unknownMs:0, allowedDowntimeMs:0, budgetRemainingMs:0 }, perProvider:[]});');
  const englishOK = await win.webContents.executeJavaScript('document.querySelector("#sloTable").textContent.includes("No providers in this scope")');
  console.log(`${englishOK ? 'PASS' : 'FAIL'}  analytics translated empty state`); if (!englishOK) bad++;
  await win.webContents.executeJavaScript('state.global.lang = "zh"; applyLang();');
  win.setSize(1280, 900);
  await win.webContents.executeJavaScript('notifyFormInitialized = false; navTo("settings"); document.querySelector(".hotkey-row").scrollIntoView({block:"center"});');
  const shortcutLayout = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#hotkeyRecorder'), row = button.closest('.opt-row');
    return { labels: [...button.querySelectorAll('kbd')].map((e) => e.textContent).join('+'),
      fits: button.getBoundingClientRect().right <= row.getBoundingClientRect().right,
      height: Math.round(button.getBoundingClientRect().height) };
  })()`);
  const hotkeyOK = shortcutLayout.labels === 'Ctrl+Alt+M' && shortcutLayout.fits && shortcutLayout.height <= 42;
  console.log(`${hotkeyOK ? 'PASS' : 'FAIL'}  shortcut key caps fit settings row ${JSON.stringify(shortcutLayout)}`); if (!hotkeyOK) bad++;
  await screenshot('settings-hotkey.png');

  // Use rendered foreground/background colors so palette changes cannot regress small-text readability.
  for (const theme of ['light', 'dark']) {
    const readability = await win.webContents.executeJavaScript(`(() => {
      state.global.theme = '${theme}'; applyTheme();
      const rgba = (value) => value.match(/[\\d.]+/g).map(Number);
      const blend = (front, back) => {
        const a = front[3] ?? 1;
        return front.slice(0, 3).map((v, i) => v * a + back[i] * (1 - a));
      };
      const background = (node) => {
        if (!node) return [255, 255, 255];
        return blend(rgba(getComputedStyle(node).backgroundColor), background(node.parentElement));
      };
      const luminance = (rgb) => rgb.map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const measure = (name, selector) => {
        const node = document.querySelector(selector), style = getComputedStyle(node), bg = background(node);
        const front = luminance(blend(rgba(style.color), bg)), back = luminance(bg);
        return { name, ratio: +((Math.max(front, back) + .05) / (Math.min(front, back) + .05)).toFixed(2), size: parseFloat(style.fontSize) };
      };
      navTo('providers');
      const checks = [measure('primary button', '#btnAdd'), measure('sidebar metadata', '.brand-sub'),
        measure('provider status', '.status-pill.st-up')];
      navTo('settings'); selectSettingsCategory('appearance');
      checks.push(measure('sidebar navigation', '#nav-settings'), measure('settings explanation', '#settings-appearance .opt-sub'),
        measure('shortcut key', '#hotkeyRecorder kbd'));
      return checks;
    })()`);
    const readable = readability.every((r) => r.ratio >= 4.5 && r.size >= 12);
    console.log(`${readable ? 'PASS' : 'FAIL'}  ${theme} rendered text contrast ${JSON.stringify(readability)}`); if (!readable) bad++;
  }
  await win.webContents.executeJavaScript('state.global.theme = "light"; applyTheme();');

  // Full-page review: all navigation destinations must fit without horizontal page scrolling.
  for (const width of [1280, 1020, 820]) {
    win.setSize(width, 900); await new Promise((r) => setTimeout(r, 100));
    for (const page of ['dashboard', 'providers', 'notify', 'backup', 'settings', 'logs']) {
      await win.webContents.executeJavaScript(`navTo('${page}'); document.querySelector('#main').scrollTop = 0;`);
      await new Promise((r) => setTimeout(r, 130));
      const result = await win.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('#main'), page = document.querySelector('.view.active');
        const outside = [...page.querySelectorAll('.view-head,.provider-filters,.toolbar-batch,.toolbar-transfer,.log-toolbar,.settings-categories,.panel,.table-card,.stat-card')]
          .filter((node) => node.getClientRects().length && node.getBoundingClientRect().right > main.getBoundingClientRect().right + 1).map((node) => node.className);
        const cards = [...document.querySelectorAll('#view-backup .backup-task')].map((node) => node.getBoundingClientRect());
        const backupAligned = page.id !== 'view-backup' || Math.abs(cards[0].top - cards[1].top) > 1 ||
          Math.abs(cards[0].height - cards[1].height) <= 1 && Math.abs(document.querySelector('#bkSaveAs').getBoundingClientRect().bottom - document.querySelector('#bkPick').getBoundingClientRect().bottom) <= 1;
        return { noPageOverflow: main.scrollWidth <= main.clientWidth + 1, outside, backupAligned,
          tableScroll: document.querySelector('.provider-table-scroll').scrollWidth > document.querySelector('.provider-table-scroll').clientWidth };
      })()`);
      const ok = result.noPageOverflow && !result.outside.length && result.backupAligned;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${page} layout ${width}px ${JSON.stringify(result)}`); if (!ok) bad++;
      if (width === 1280 || width === 820) await screenshot(`ui-${page}-${width}.png`);
    }
  }
  // A selected backup or a save result may grow one card; its sibling and action baseline must follow.
  win.setSize(1280, 900);
  for (const language of ['zh', 'en']) {
    const backup = await win.webContents.executeJavaScript(`(() => {
      state.global.lang = '${language}'; applyLang(); navTo('backup'); document.querySelector('#main').scrollTop = 0;
      const message = document.querySelector('#bkPicked'), hint = document.querySelector('#bkHint');
      message.style.display = 'flex'; message.textContent = '${language}' === 'zh' ? '已选择：production-gateway-backup-2026-11-10.json（4 个服务商，含通知设置）' : 'Selected: production-gateway-backup-2026-11-10.json (4 providers, includes notification settings)';
      hint.textContent = '${language}' === 'zh' ? '已备份到备份目录' : 'Saved to the backup directory';
      const cards = [...document.querySelectorAll('#view-backup .backup-task')].map((node) => node.getBoundingClientRect());
      return { heights: cards.map((r) => Math.round(r.height)), sameHeight: Math.abs(cards[0].height - cards[1].height) <= 1,
        actionsAligned: Math.abs(document.querySelector('#bkSaveAs').getBoundingClientRect().bottom - document.querySelector('#bkPick').getBoundingClientRect().bottom) <= 1,
        contentFits: [...document.querySelectorAll('#view-backup .backup-task .panel-body')].every((node) => node.scrollWidth <= node.clientWidth + 1) };
    })()`);
    const ok = backup.sameHeight && backup.actionsAligned && backup.contentFits;
    console.log(`${ok ? 'PASS' : 'FAIL'}  backup cards and actions stay aligned with ${language} messages ${JSON.stringify(backup)}`); if (!ok) bad++;
    await screenshot(`ui-backup-selected-${language}.png`);
  }
  await win.webContents.executeJavaScript('document.querySelector("#bkPicked").style.display="none"; document.querySelector("#bkHint").textContent=""; state.global.lang="zh"; applyLang();');
  // A category switch must preserve draft values and accessible keyboard navigation.
  win.setSize(1280, 900);
  const categories = await win.webContents.executeJavaScript(`(() => {
    navTo('settings'); selectSettingsCategory('network');
    document.querySelector('#proxyUrl').value = 'http://127.0.0.1:9876';
    selectSettingsCategory('appearance'); selectSettingsCategory('network');
    const kept = document.querySelector('#proxyUrl').value === 'http://127.0.0.1:9876';
    document.querySelector('#settings-tab-network').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));
    const keyboard = settingsCategory === 'storage' && document.activeElement.id === 'settings-tab-storage';
    const single = [...document.querySelectorAll('[data-settings-section]')].filter((el) => !el.hidden).length === 1;
    selectSettingsCategory('all');
    const all = [...document.querySelectorAll('[data-settings-section]')].every((el) => !el.hidden);
    selectSettingsCategory('appearance');
    return { kept, keyboard, single, all };
  })()`);
  const categoriesOK = Object.values(categories).every(Boolean);
  console.log(`${categoriesOK ? 'PASS' : 'FAIL'}  settings categories preserve drafts and support keyboard ${JSON.stringify(categories)}`); if (!categoriesOK) bad++;
  const filtering = await win.webContents.executeJavaScript(`(() => {
    navTo('providers');
    const search = document.querySelector('#searchInput'); search.value = 'no-such-provider'; search.dispatchEvent(new Event('input'));
    const empty = !!document.querySelector('[data-provider-empty="clear"]') && !document.querySelector('#providerClearFilters').hidden;
    document.querySelector('[data-provider-empty="clear"]').click();
    const cleared = document.querySelectorAll('#providerList .p-row').length === 4 && search.value === '';
    const check = document.querySelector('#providerList [data-sel]'); check.focus(); check.click();
    const focus = document.activeElement.hasAttribute('data-sel');
    const partial = document.querySelector('#selAll').indeterminate;
    return { empty, cleared, focus, partial };
  })()`);
  const filterOK = Object.values(filtering).every(Boolean);
  console.log(`${filterOK ? 'PASS' : 'FAIL'}  provider empty action, clear filters and keyboard selection ${JSON.stringify(filtering)}`); if (!filterOK) bad++;
  const channel = await win.webContents.executeJavaScript(`(() => {
    navTo('notify'); document.querySelector('[data-channel="dingtalk"]').click();
    return document.activeElement.id === 'dtWebhook';
  })()`);
  console.log(`${channel ? 'PASS' : 'FAIL'}  channel health card locates configuration`); if (!channel) bad++;
  await win.webContents.executeJavaScript('navTo(\'settings\'); selectSettingsCategory(\'all\');');
  await new Promise((r) => setTimeout(r, 100));
  await win.webContents.executeJavaScript('document.querySelector(\'#main\').scrollTop = 500; navTo(\'providers\');');
  await new Promise((r) => setTimeout(r, 80));
  await win.webContents.executeJavaScript('navTo(\'settings\');');
  await new Promise((r) => setTimeout(r, 80));
  const position = await win.webContents.executeJavaScript('document.querySelector(\'#main\').scrollTop >= 499');
  console.log(`${position ? 'PASS' : 'FAIL'}  navigation restores each page scroll position`); if (!position) bad++;
  await win.webContents.executeJavaScript('selectSettingsCategory(\'appearance\'); navTo(\'dashboard\'); document.querySelector(\'[data-act]\').click();');
  const detail = await win.webContents.executeJavaScript('document.querySelector(\'#detailModal\').classList.contains(\'show\')');
  console.log(`${detail ? 'PASS' : 'FAIL'}  dashboard activity opens details in one click`); if (!detail) bad++;
  await win.webContents.executeJavaScript('document.querySelector(\'#detailModal\').classList.remove(\'show\'); navTo(\'logs\'); document.querySelector(\'#logFilter\').value = \'no-such-log\'; appendLogLines(logLines,true);');
  const logEmpty = await win.webContents.executeJavaScript('document.querySelector(\'#logCard\').textContent.includes(\'没有匹配的日志\') && document.querySelector(\'#logResultCount\').textContent.includes(\'0\')');
  console.log(`${logEmpty ? 'PASS' : 'FAIL'}  filtered logs show an explicit empty state`); if (!logEmpty) bad++;
  await win.webContents.executeJavaScript('document.querySelector(\'#logFilter\').value = \'\'; appendLogLines(logLines,true); state.global.theme=\'dark\'; applyTheme();');
  for (const page of ['providers', 'settings', 'notify', 'backup']) {
    await win.webContents.executeJavaScript(`navTo('${page}'); document.querySelector('#main').scrollTop = 0;`);
    await new Promise((r) => setTimeout(r, 100)); await screenshot(`ui-${page}-dark.png`);
  }
  await win.webContents.executeJavaScript('state.global.lang=\'en\'; applyLang(); navTo(\'settings\'); selectSettingsCategory(\'appearance\');');
  const accessibility = await win.webContents.executeJavaScript(`(() => {
    const toggle = document.querySelector('#hotkeyEnabled'), nav = document.querySelector('#nav-settings');
    return { toggleFocusable: getComputedStyle(toggle).display !== 'none', navigation: nav.getAttribute('aria-current') === 'page',
      inactiveInert: document.querySelector('#view-providers').inert, label: document.querySelector('#nav').getAttribute('aria-label') === 'Main navigation' };
  })()`);
  const accessibilityOK = Object.values(accessibility).every(Boolean);
  console.log(`${accessibilityOK ? 'PASS' : 'FAIL'}  accessible toggles, current navigation and translated labels ${JSON.stringify(accessibility)}`); if (!accessibilityOK) bad++;
  await screenshot('ui-settings-english.png');
  win.setSize(820, 900);
  await new Promise((r) => setTimeout(r, 100));
  await screenshot('ui-settings-english-820.png');
  win.setSize(1280, 900);
  await win.webContents.executeJavaScript('state.global.lang=\'zh\'; state.global.theme=\'light\'; applyTheme(); applyLang();');
  await win.webContents.executeJavaScript('navTo("providers"); openProviderModal(11);');
  for (const advanced of [false, true]) {
    await win.webContents.executeJavaScript(`document.querySelector('#fAdvanced').open = ${advanced};`);
    const formFits = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('#providerModal .modal').getBoundingClientRect();
      const body = document.querySelector('#providerModal .modal-body'), save = document.querySelector('#pmSave').getBoundingClientRect();
      return modal.left >= 0 && modal.right <= innerWidth && save.bottom <= innerHeight && body.scrollWidth <= body.clientWidth + 1;
    })()`);
    console.log(`${formFits ? 'PASS' : 'FAIL'}  ${advanced ? 'advanced' : 'basic'} provider form keeps actions visible`); if (!formFits) bad++;
    await screenshot(`ui-provider-${advanced ? 'advanced' : 'basic'}.png`);
  }
  await win.webContents.executeJavaScript('document.querySelector("#pmCancel").click();');
  fixture.providers = [];
  await win.webContents.executeJavaScript('(async () => { state = await window.aipm.getState(); navTo("stats"); await renderStats(); document.querySelector("#main").scrollTop = 0; })()');
  const emptyOK = await win.webContents.executeJavaScript('document.querySelector("#stProviders").textContent === "0" && document.querySelector("#stTable").textContent.includes("当前范围内没有服务商")');
  console.log(`${emptyOK ? 'PASS' : 'FAIL'}  empty current scope does not resurrect retained providers`); if (!emptyOK) bad++;
  await screenshot('analytics-empty.png');

  if (errs.length) { bad++; console.error('FAIL renderer errors:', errs); }
  console.log(bad === 0 ? 'UI-CHECK-OK' : 'UI-CHECK-FAILED');
  app.exit(bad === 0 ? 0 : 1);
}).catch((e) => { console.error('UI-CHECK-ERROR', e); app.exit(1); });
