const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { h } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

// Mac App（WKWebView / Safari）里才会出现的交互问题，在 Chromium 里按 WebKit 的规则模拟后逐条回归：
// - 按钮、链接、summary 不接收鼠标焦点：按下时焦点交给最近的可聚焦祖先，没有就直接失焦（relatedTarget 为空）。
// - 中文输入法上屏的回车 / Esc：先 compositionend，再来一个 keyCode 229、isComposing=false 的 keydown。
// - 网页下载（blob 链接）会被 App 拦下，导出改走本地服务；window.open 带 noopener 时返回 null。
const webkitFocusSim = () => {
  window.addEventListener('mousedown', e => {
    if (e.defaultPrevented || e.button !== 0) return;
    const control = e.target.closest?.('button, input[type=button], input[type=submit], input[type=checkbox], input[type=radio], a[href], summary');
    if (!control) return;
    e.preventDefault();
    let el = control.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.isContentEditable || (el.hasAttribute('tabindex') && !el.matches('button, input, select, textarea, a[href]'))) break;
      el = el.parentElement;
    }
    if (el && el !== document.body && el !== document.documentElement) el.focus({ preventScroll:true });
    else document.activeElement?.blur?.();
  });
};

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const base = { currency:'USD', logisticsStatus:'未发货', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], productType:'睫毛', paymentChannel:'Zelle' };
    const orders = [
      { ...base, id:'o1', num:'K1', client:'Alice Brown', country:'🇺🇸 美国 United States', amount:1000, paidAmount:0, orderType:'定金订单', stage:'quote' },
      { ...base, id:'o2', num:'K2', client:'Bob Taylor', country:'🇬🇧 英国 United Kingdom', amount:500, paidAmount:200, orderType:'定金订单', stage:'balance' },
      { ...base, id:'o3', num:'K3', client:'Carl Diaz', country:'🇩🇪 德国 Germany', amount:800, paidAmount:800, orderType:'全款订单', stage:'production' },
      { ...base, id:'o4', num:'K4', client:'Dana Evans', country:'🇫🇷 法国 France', amount:300, paidAmount:300, orderType:'全款订单', stage:'shipment', trackingNumber:'1Z999AA10123456784', carrier:'UPS', logisticsStatus:'运输中' }
    ];
    const customers = { 'Alice Brown':{ country:'🇺🇸 美国 United States' }, 'Bob Taylor':{ country:'🇬🇧 英国 United Kingdom' } };
    let stored = { app:'trade-order-system', revision:0, data:{ orders, customers, demoCleared:true, demoCustomersCleared:true } };
    const exports = [];
    let exportFails = false;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/ecb-rates') response = { ok:true, rates:[] };
      if (pathname === '/api/save') {
        const body = request.postDataJSON();
        stored = { ...body.state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      if (pathname === '/api/open-url') return route.fulfill({ status:400, json:{ ok:false, message:'unsupported url' } });
      if (pathname === '/api/export-file') {
        if (exportFails) return route.fulfill({ status:500, json:{ ok:false, message:'磁盘已满' } });
        const body = request.postDataJSON();
        exports.push(body);
        response = { ok:true, name:body.name, path:`/Users/test/Downloads/${body.name}` };
      }
      return route.fulfill({ json:response });
    });
    await page.addInitScript(webkitFocusSim);
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    const isOpen = id => page.evaluate(id => document.getElementById(id).classList.contains('open'), id);
    const toastText = () => page.locator('#toast').textContent();
    // Safari 的输入法上屏：compositionend 先到，随后的回车 / Esc keydown 带 keyCode 229、isComposing=false。
    const imeKey = (selector, text, key) => page.evaluate(({ selector, text, key }) => {
      const el = document.querySelector(selector);
      el.focus();
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles:true, data:'' }));
      if (text !== null) {
        el.value = text;
        el.dispatchEvent(new InputEvent('input', { bubbles:true, isComposing:true, data:text, inputType:'insertCompositionText' }));
      }
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true, data:text || '' }));
      return el.dispatchEvent(new KeyboardEvent('keydown', { key, code:key, keyCode:229, which:229, bubbles:true, cancelable:true, isComposing:false }));
    }, { selector, text, key });

    // 1. 订单弹窗客户下拉的 ▾：点一下收起、再点一下打开（以前先被失焦收起再被 click 打开，永远收不起来）。
    await page.locator('#newOrderBtn').click();
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    // 新建订单一屏放得下、中间一栏不滚；把收着的分区都展开（和编辑订单一样），1b 才有东西可滚。
    await page.evaluate(() => uiOrderCompact(document.getElementById('orderForm'), false));
    const clientInput = page.locator('#orderForm .client-picker input[name="client"]');
    const clientMenuOpen = () => page.locator('#orderForm .client-menu').evaluate(n => n.classList.contains('open'));
    await clientInput.click();
    assert.equal(await clientMenuOpen(), true, 'focusing the client field opens the menu');
    // 1a. 弹窗还在滑入（transform 动画让输入框的位置一直在变）时来一个迟到的滚动事件，没有任何祖先真的滚过，菜单不能被收掉。
    //     以前只比输入框的 getBoundingClientRect，机器慢的时候（CI）刚打开就被收起，接着点 ▾ 变成「重新打开」。
    const slide = await page.evaluate(() => {
      const anim = document.querySelector('#orderModal .modal').animate([{ transform:'translateY(60px)' }, { transform:'none' }], { duration:10000 });
      window.__slideAnim = anim;
      return Math.round(anim.currentTime || 0);
    });
    await page.waitForFunction(at => (window.__slideAnim.currentTime || 0) > at + 150, slide);
    assert.deepEqual(await page.evaluate(() => {
      document.querySelector('#orderForm .order-main').dispatchEvent(new Event('scroll'));
      const result = { moving:window.__slideAnim.playState, open:document.querySelector('#orderForm .client-menu').classList.contains('open') };
      window.__slideAnim.cancel();
      return result;
    }), { moving:'running', open:true }, 'a late scroll event while the modal is still sliding in must not close the client menu');
    // 弹窗停下后再来一个迟到的滚动事件：菜单跟着输入框重新定位，不能停在滑动中的旧位置盖住 ▾。
    assert.deepEqual(await page.evaluate(() => {
      document.querySelector('#orderForm .order-main').dispatchEvent(new Event('scroll'));
      const trigger = document.querySelector('#orderForm .client-trigger').getBoundingClientRect();
      const hit = document.elementFromPoint(trigger.left + trigger.width / 2, trigger.top + trigger.height / 2);
      return { open:document.querySelector('#orderForm .client-menu').classList.contains('open'), triggerOnTop:!!hit?.closest('.client-trigger') };
    }), { open:true, triggerOnTop:true }, 'after the modal settles the client menu follows the field and leaves ▾ clickable');
    // 1b. 真把弹窗内容往下滚一点（想够到菜单下沿外面的几项）：输入框还看得见，菜单跟过去、不收；滚到输入框看不见才收。
    const gap = () => page.evaluate(() => {
      const input = document.querySelector('#orderForm input[name="client"]').getBoundingClientRect();
      const menu = document.querySelector('#orderForm .client-menu');
      const box = menu.getBoundingClientRect();
      return { open:menu.classList.contains('open'), gap:Math.round(menu.dataset.placement === 'top' ? input.top - box.bottom : box.top - input.bottom) };
    });
    const scrollForm = by => page.evaluate(by => new Promise(resolve => {
      const main = document.querySelector('#orderForm .order-main');
      main.addEventListener('scroll', () => requestAnimationFrame(resolve), { once:true });
      main.scrollTop += by;
    }), by);
    await page.evaluate(() => { document.querySelector('#orderForm .order-main').scrollTop = 0; });
    await scrollForm(30);
    assert.deepEqual(await gap(), { open:true, gap:6 }, 'scrolling the modal a little keeps the client menu open and attached to the field');
    await scrollForm(2000);
    assert.equal(await clientMenuOpen(), false, 'scrolling the field out of the modal closes the client menu');
    await page.evaluate(() => { document.querySelector('#orderForm .order-main').scrollTop = 0; });
    await clientInput.click();
    assert.equal(await clientMenuOpen(), true, 'focusing the client field again reopens the menu');
    // 1c. 弹窗还在做入场缩放（transform 让它成了 fixed 菜单的定位参照）时打开菜单：菜单照样贴在输入框下面，不往下错开到可视区外。
    assert.deepEqual(await page.evaluate(() => {
      const modal = document.querySelector('#orderModal .modal');
      const anim = modal.animate([{ transform:'translateY(40px) scale(.96)' }, { transform:'none' }], { duration:10000 });
      anim.pause();
      positionClientMenu(document.querySelector('#orderForm .client-picker'));
      const input = document.querySelector('#orderForm input[name="client"]').getBoundingClientRect();
      const menu = document.querySelector('#orderForm .client-menu');
      const box = menu.getBoundingClientRect();
      const result = Math.round(menu.dataset.placement === 'top' ? input.top - box.bottom : box.top - input.bottom);
      anim.cancel();
      positionClientMenu(document.querySelector('#orderForm .client-picker'));
      return result;
    }), 6, 'a client menu opened while the modal is still scaling in sits right next to the field');
    await page.locator('#orderForm .client-trigger').click();
    assert.equal(await clientMenuOpen(), false, '▾ must close the open client menu');
    await page.locator('#orderForm .client-trigger').click();
    assert.equal(await clientMenuOpen(), true, '▾ must reopen the client menu');
    await page.locator('#orderForm .client-menu-heading').first().click();
    assert.equal(await clientMenuOpen(), true, 'clicking the menu heading must not close the menu');
    await page.keyboard.press('Escape');
    await page.evaluate(() => closeOrder());

    // 2. 承运商等自绘下拉跟着代码赋的值走：填了 UPS 单号，按钮要显示 UPS，不能停在「自动识别」。
    const staleSelects = () => page.evaluate(() => {
      const out = [];
      document.querySelectorAll('select').forEach(select => {
        const wrap = select.parentElement?.classList?.contains('app-select') ? select.parentElement : null;
        if (wrap) {
          const option = select.options[select.selectedIndex];
          const expected = option ? (select.closest('#customerForm, #combinedCustomerForm') ? option.textContent : selectButtonLabel(select, option)) || option.value : '请选择';
          const shown = wrap.querySelector('.app-select-value')?.textContent || '';
          if (shown !== expected) out.push(`${select.id || select.name}: shows "${shown}", value "${select.value}"`);
        }
        if (select.classList.contains('binary-native') && select.value !== '') {
          const active = select.nextElementSibling?.querySelector('.binary-option.active')?.dataset.binaryValue;
          if (active !== select.value) out.push(`${select.id || select.name} segment: "${active}", value "${select.value}"`);
        }
      });
      return out;
    });
    await page.evaluate(() => openOrder(''));
    const trackingInput = page.locator('#orderForm [data-shipment-number]').first();
    await trackingInput.evaluate(el => el.closest('.order-section')?.classList.remove('is-folded'));
    await trackingInput.fill('1Z999AA10123456784');
    await trackingInput.evaluate(el => el.blur());
    await h.endsOn(() => page.locator('#orderForm [data-shipment-carrier]').first().inputValue(), 'UPS');
    await h.endsOn(staleSelects, [], 'a dropdown shows a different value than it holds after the tracking number was filled');
    await page.evaluate(() => { const form = document.getElementById('orderForm'); form.elements.currency.value = 'EUR'; form.elements.orderType.value = '全款订单'; });
    await h.endsOn(staleSelects, [], 'code-assigned select values (currency / order type) are not shown');
    await page.evaluate(() => closeOrder());
    for (const id of ['o2', 'o4']) {
      await page.evaluate(id => openOrder(id), id);
      await h.endsOn(staleSelects, [], `order ${id} opens with stale dropdown labels`);
      await page.evaluate(() => closeOrder());
    }

    // 3. 输入法上屏的回车 / Esc 不能被当成「打开结果」「添加」「关闭」。
    await imeKey('#searchInput', 'bob', 'Enter');
    // Nothing may open, also not once the search box's 100 ms debounce (debouncedGlobalSearchRender) has drawn the panel.
    await h.waitPageTime(page, 150);
    assert.equal(await isOpen('customerModal') || await isOpen('orderDetailDrawer'), false, 'IME Enter in global search opened a result');
    await page.evaluate(() => { document.getElementById('searchInput').value = ''; document.getElementById('searchInput').blur(); });
    await page.evaluate(() => { setPage('settings'); uiSettingsTab('customer'); });
    const tagsBefore = await page.evaluate(() => JSON.stringify(state.customerTags || []));
    await imeKey('#settingsTagInput', '月结', 'Enter');
    assert.equal(await page.evaluate(() => JSON.stringify(state.customerTags || [])), tagsBefore, 'IME Enter added a customer tag');
    await h.openDrawer(page, 'o2', 'info');
    await imeKey('#orderDetailBody [data-dedit="note"]', '备注', 'Escape');
    assert.equal(await isOpen('orderDetailDrawer'), true, 'IME Escape closed the order detail drawer');
    await page.evaluate(() => { uiDetailMarkClean?.(); closeOrderDetail(); });

    // 4. 全局搜索的 → 按钮：有关键词时打开完整搜索结果（以前点了被失焦吞掉，没反应）。
    await page.evaluate(() => setPage('dashboard'));
    await page.locator('#searchInput').click();
    await page.locator('#searchInput').fill('Bob');
    await page.locator('#globalSearchBtn').click();
    await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'page-search-results');
    assert.equal(await page.locator('#fullSearchInput').inputValue(), 'Bob');
    await page.evaluate(() => { document.getElementById('searchInput').value = ''; setPage('dashboard'); });

    // 5. 在输入框里拖选文字、松手落到灰色背景上，弹窗不能关（以前直接关掉，没保存的内容就丢了）；真点背景照常关闭。
    await page.evaluate(() => openCustomerModal());
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    await h.quiet(page);
    const nameInput = page.locator('#customerForm input[name="name"]');
    await nameInput.fill('Drag Select Buyer');
    const box = await nameInput.boundingBox();
    await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps:4 });
    await page.mouse.move(6, box.y + box.height / 2, { steps:4 });
    await page.mouse.up();
    assert.equal(await isOpen('customerModal'), true, 'releasing a text selection over the backdrop closed the customer modal');
    assert.equal(await isOpen('confirmModal'), false, 'releasing a text selection over the backdrop counted as a backdrop click');
    assert.equal(await nameInput.inputValue(), 'Drag Select Buyer');
    await page.evaluate(() => closeCustomerModal());
    await page.evaluate(() => openCustomerModal());
    await h.quiet(page);
    await page.mouse.click(6, 460);
    await h.endsOn(() => isOpen('customerModal'), false, 'a real click on the backdrop must still close the modal');

    // 6. 「更多筛选与排序」浮层：里面的下拉能选，点外面 / Esc 收起。
    await page.evaluate(() => setPage('order-list'));
    const more = page.locator('#orderListMoreFilters');
    await page.locator('#orderListMoreFilters summary').click();
    assert.equal(await more.evaluate(n => n.open), true);
    await page.locator('#orderListSort').locator('xpath=..').locator('.app-select-button').click();
    await page.locator('.app-select-popover [data-app-select-value="amountDesc"]').click();
    assert.equal(await page.locator('#orderListSort').inputValue(), 'amountDesc');
    assert.equal(await more.evaluate(n => n.open), true, 'picking a sort option must keep the panel open');
    await page.mouse.click(720, 860);
    assert.equal(await more.evaluate(n => n.open), false, 'clicking outside must close the filter panel');
    await page.locator('#orderListMoreFilters summary').click();
    await page.keyboard.press('Escape');
    assert.equal(await more.evaluate(n => n.open), false, 'Esc must close the filter panel');
    await page.evaluate(() => resetOrderListFilters());

    // 7. 月份改成下拉选（Mac App 的 WebKit 不支持 type=month）；开始晚于结束时另一头跟过去。
    await page.evaluate(() => setPage('amount'));
    const monthInfo = await page.evaluate(() => ['chartFrom', 'chartTo', 'analysisMonthInput'].map(id => {
      const el = document.getElementById(id);
      return { id, tag:el.tagName, count:el.options?.length || 0, value:el.value };
    }));
    monthInfo.forEach(info => {
      assert.equal(info.tag, 'SELECT', `${info.id} must be a select`);
      assert.ok(info.count >= 12, `${info.id} needs month options`);
      assert.match(info.value, /^\d{4}-\d{2}$/);
    });
    const months = await page.evaluate(() => Array.from(document.getElementById('chartFrom').options).map(o => o.value));
    await page.evaluate(newest => { const from = document.getElementById('chartFrom'); from.value = newest; from.dispatchEvent(new Event('change', { bubbles:true })); }, months[0]);
    const range = await page.evaluate(() => ({ from:chartFrom.value, to:chartTo.value, range:document.getElementById('chartRange').value, months:chartMonths().length }));
    assert.equal(range.range, 'custom');
    assert.ok(range.from <= range.to, `custom range ${range.from} > ${range.to}`);
    assert.ok(range.months >= 1, 'custom range produced an empty chart');
    await page.evaluate(() => { activeBusinessMonth = monthOffset(normalizeMonth(new Date().toISOString()), -20); analysisMonthTouched = true; renderAnalysisPage(); });
    const analysis = await page.evaluate(() => ({ value:document.getElementById('analysisMonthInput').value, active:activeBusinessMonth, label:document.getElementById('analysisMonthInput').parentElement.querySelector('.app-select-value')?.textContent }));
    assert.equal(analysis.value, analysis.active, 'analysis month select does not show the month being analysed');
    assert.match(analysis.label || '', /年\d+月/);

    // 8. 复制失败要明说，不再提示「已复制」，也不在订单记录里记一次跟进。
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:() => Promise.reject(new Error('denied')) } });
      document.execCommand = () => false;
      openOrderDetail('o2');
    });
    const logsBefore = await page.evaluate(() => state.orders.find(o => o.id === 'o2').logs.length);
    await page.locator('#detailCopyTextBtn').click();
    await page.locator('#detailCopyMenu [data-copy-text="status"]').click();
    await h.endsOn(toastText, /复制失败/);
    assert.notEqual((await page.locator('#detailCopyTextBtn').innerText()).trim(), '已复制');
    assert.equal(await page.evaluate(() => state.orders.find(o => o.id === 'o2').logs.length), logsBefore, 'a failed copy was logged as a follow-up');
    await page.evaluate(() => closeOrderDetail());

    // 9. 官网查询：本地服务打不开时退回 window.open，不能把整个页面跳到物流官网。
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (...args) => { window.__opened.push(args); return null; };
      window.__before = location.href;
      openOfficialTracking('1Z999AA10123456784', 'UPS');
    });
    // The local service answers 400, then the page falls back to window.open.
    await page.waitForFunction(() => window.__opened.length > 0);
    const opened = await page.evaluate(() => ({ opened:window.__opened, same:location.href === window.__before }));
    assert.equal(opened.same, true, 'the app page navigated away to the carrier site');
    assert.equal(opened.opened.length, 1);
    assert.match(opened.opened[0][0], /^https:\/\/www\.ups\.com\//);

    // 10. Mac App 的导出：交给本地服务写进「下载」文件夹；失败时按钮不显示「已导出」。
    await page.evaluate(() => { setPage('settings'); uiSettingsTab('data'); });
    await page.locator('#dataExportCsvBtn').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已导出到「下载」文件夹'));
    assert.equal(exports.length, 1);
    assert.match(exports[0].name, /^trade-orders-.+\.csv$/);
    assert.ok(exports[0].text.startsWith('﻿'), 'CSV export lost its BOM');
    assert.match(exports[0].text, /K2/);
    assert.match(await page.locator('#dataExportCsvBtn').innerText(), /已导出/);
    exportFails = true;
    await page.locator('#exportDataFileBtn').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('导出失败'));
    assert.match(await toastText(), /磁盘已满/);
    assert.doesNotMatch(await page.locator('#exportDataFileBtn').innerText(), /已导出/, 'a failed export showed 已导出');

    assert.deepEqual(errors, []);
    console.log('WebKit interactions UI passed: client ▾, synced dropdowns, IME Enter/Esc, search →, backdrop drag-select, filter panel, month selects, copy failure, carrier site, Mac exports.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
