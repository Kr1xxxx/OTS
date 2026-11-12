#!/usr/bin/env node
// 第四轮 UI 修复，真实页面 + 真实键盘鼠标，一条修复一段：
// 1. 没填客户就保存：客户菜单在输入框下面，不再在字段抖完之后跳到窗口左上角；
// 2. 订单表单的必填项是页面里的中文红字，不是浏览器的英文气泡（novalidate）；
// 3. 客户表单邮箱报错时输入框不变窄；
// 4. 提示条叠着时后面的不露字，展开后按各自高度错开、不重叠；
// 5. 暗色下压在浅紫上的字（续费主按钮、左上角 T、新建客户左栏当前步骤）够深；
// 6–10. 搜索面板小字、物流抽屉运单号、设置里标签的删除叉、几处 9–10.5px 的字、灰字说明；
// 11. 粘贴识别结果里同一项不出现两次；
// 12. 合并客户选目标、续费服务商用 App 自己的建议菜单，页面里没有 datalist；
// 13. 复购周期的自定义值按天数排。
// 截图：OTS_SHOTS=<目录> 时把关键画面存下来（人看的），不设就不存。
const assert = require('node:assert/strict');
const path = require('node:path');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const shotsDir = process.env.OTS_SHOTS || '';
const shot = async (page, name) => { if (shotsDir) await page.screenshot({ path:path.join(shotsDir, `${name}.png`) }); };
const US = '🇺🇸 美国 United States';
const orders = [
  { ...base, id:'r1', num:'R4001', client:'Round Four Buyer', stage:'production', amount:1200, paidAmount:1200, createdAt:day(2), updated:`${day(2)} 10:00` },
  { ...base, id:'r2', num:'R4002', client:'Round Four Buyer', stage:'quote', amount:800, createdAt:day(3), updated:`${day(3)} 10:00` },
  { ...base, id:'r3', num:'R4003', client:'Second Buyer', stage:'quote', amount:300, createdAt:day(3), updated:`${day(3)} 11:00` }
];
const customers = {
  'Round Four Buyer':{ client:'Round Four Buyer', country:US, currency:'USD', repurchaseCycle:45 },
  'Second Buyer':{ client:'Second Buyer', country:US, currency:'USD' },
  'Rounded Corner Ltd':{ client:'Rounded Corner Ltd', country:US, currency:'USD' }
};
const trackingLookups = [
  { id:'lk-r4', trackingNumber:'1234567890', carrier:'DHL', checkedAt:`${day(4)} 08:00`, orderId:'r1', client:'Round Four Buyer', displayClient:'', orderNum:'R4001', shippedAt:day(3), status:'运输中', statusUpdatedAt:`${day(4)} 08:00`, queryMessage:'', online:'是', pinned:false, events:[{ time:`${day(4)} 08:00`, title:'Processed at LEIPZIG', location:'Leipzig' }] }
];
const data = { orders, customers, trackingLookups, orderSettings:{ tags:['月结', '样品客户'] } };

// 页面里算对比度：前景色叠在一层层背景上（半透明的往上找），任意颜色写法（oklch、color-mix）交给 canvas 换成 sRGB。
const contrastHelpers = () => {
  window.__rgba = color => {
    const ctx = (window.__ctx ||= Object.assign(document.createElement('canvas'), { width:1, height:1 }).getContext('2d', { willReadFrequently:true }));
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3])).concat(1);
  window.__background = el => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const color = window.__rgba(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    return layers.reverse().reduce((acc, layer) => over(layer, acc), window.__rgba(getComputedStyle(document.body).backgroundColor));
  };
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  window.__contrast = (el, colorOverride = '') => {
    const bg = window.__background(el);
    const fg = over(window.__rgba(colorOverride || getComputedStyle(el).color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
  };
};
const contrast = (page, selector) => page.evaluate(selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return { ratio:window.__contrast(el), size:parseFloat(getComputedStyle(el).fontSize) };
}, selector);
const waitIdle = page => page.evaluate(() => new Promise(resolve => {
  const check = () => (document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)) ? requestAnimationFrame(check) : resolve());
  requestAnimationFrame(check);
}));

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const { page, errors, dialogs, context, store } = await openBoard(browser, data, { width:1694, height:1082, theme, port:47995 });
      await page.evaluate(contrastHelpers);
      const light = theme === 'light';

      // ---- 2. 订单表单：页面里的中文必填提示 ----
      await page.evaluate(() => openOrder());
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      assert.deepEqual(await page.evaluate(() => [document.getElementById('orderForm').noValidate, document.getElementById('combinedOrderForm').noValidate]), [true, true],
        'the order forms skip the browser bubble');
      const hints = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#orderForm .customer-field-hint')]
        .map(hint => [document.querySelector(`#orderForm [aria-describedby="${hint.id}"]`)?.name || '?', hint.textContent])));
      // 出错时附上菜单每次被摆位时的样子，CI 上好查。
      await page.evaluate(() => {
        const t0 = performance.now();
        const log = window.__menuLog = [];
        const at = () => Math.round(performance.now() - t0);
        ['animationstart', 'animationend', 'animationcancel'].forEach(type => document.addEventListener(type, e => {
          if (e.target.closest?.('#orderModal')) log.push(`${at()} ${type} ${e.animationName} ${e.target.className}`);
        }, true));
        const position = window.positionFloatingMenu;
        window.positionFloatingMenu = function (menu, ...rest) {
          const result = position.call(this, menu, ...rest);
          if (menu.classList.contains('client-menu')) log.push(`${at()} position left=${menu.style.left} rect=${Math.round(menu.getBoundingClientRect().left)} running=${document.getAnimations().filter(a => a.playState !== 'finished').map(a => a.animationName).join(',')}`);
          return result;
        };
      });
      await h.click(page, 'button[type="submit"][form="orderForm"]', 'save order');
      assert.deepEqual(await hints(), { client:'请选择或输入客户', amount:'请填写订单金额' });
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'client', 'focus lands on the first field with a hint');
      assert.equal(await page.evaluate(() => document.getElementById('orderModal').classList.contains('open')), true, 'nothing was saved');

      // ---- 1. 字段抖完以后客户菜单还在输入框下面 ----
      // 抖动不用 transform：抖的那一刻去摆菜单，left 也是按窗口算的（以前这时算成 0，全靠动画结束的事件再摆回来，
      // 画面卡住、动画没开始类名就被拿掉时没有事件，菜单留在左上角）。
      const duringShake = await page.evaluate(() => {
        const input = document.querySelector('#orderForm [name="client"]');
        const field = input.closest('.field');
        field.classList.add('ui-err');
        positionClientMenu(activeClientPicker);
        const off = parseFloat(document.querySelector('#orderForm .client-menu').style.left) - input.getBoundingClientRect().left;
        field.classList.remove('ui-err');
        return off;
      });
      assert.ok(Math.abs(duringShake) <= 6, `a shaking field is not the menu's containing block (left off by ${duringShake}px)`);
      await waitIdle(page);
      const menuAt = await page.evaluate(() => {
        const menu = document.querySelector('#orderForm .client-menu');
        const input = document.querySelector('#orderForm [name="client"]').getBoundingClientRect();
        const rect = menu.getBoundingClientRect();
        return { open:menu.classList.contains('open'), dx:Math.abs(rect.left - input.left), gap:rect.top - input.bottom };
      });
      assert.ok(menuAt.open, 'focusing the empty client field opens the client menu');
      assert.ok(menuAt.dx <= 2, `the client menu stays under the field after the shake (off by ${menuAt.dx}px)\n${(await page.evaluate(() => window.__menuLog)).join('\n')}`);
      assert.ok(menuAt.gap >= 0 && menuAt.gap < 20, `the client menu is just below the field (gap ${menuAt.gap}px)`);
      await shot(page, `01-02-order-required-${theme}`);
      await page.keyboard.press('Escape');

      await page.locator('#orderForm [name="num"]').fill('');
      await page.locator('#orderForm [name="amount"]').fill('-5');
      await h.click(page, 'button[type="submit"][form="orderForm"]', 'save order');
      assert.deepEqual(await hints(), { num:'请填写订单号', client:'请选择或输入客户', amount:'金额不能小于 0' });
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'num');
      await shot(page, `02-order-num-hint-${theme}`);
      const borders = await page.evaluate(() => ['num', 'amount'].map(name => getComputedStyle(document.querySelector(`#orderForm [name="${name}"]`)).borderTopColor));
      const plainBorder = await page.evaluate(() => getComputedStyle(document.querySelector('#orderForm [name="country"]')).borderTopColor);
      borders.forEach(color => assert.notEqual(color, plainBorder, 'a field with a hint has the alert border'));
      await page.keyboard.type('R4999');
      await page.locator('#orderForm [name="amount"]').fill('250');
      await page.locator('#orderForm [name="client"]').fill('Round Four Buyer');
      assert.deepEqual(await hints(), {}, 'fixing the fields removes the hints');
      // 定金、已收不是必填，负数照样拦（以前靠 min="0"）。
      await page.evaluate(() => {
        const type = document.querySelector('#orderForm [name="orderType"]');
        type.value = '定金订单';
        type.dispatchEvent(new Event('change', { bubbles:true }));
      });
      const deposit = page.locator('#orderForm [name="depositAmount"]');
      await deposit.waitFor({ state:'visible' });
      await deposit.fill('-20');
      const savesBefore = store.saves;
      await h.click(page, 'button[type="submit"][form="orderForm"]', 'save order');
      assert.deepEqual(await hints(), { depositAmount:'金额不能小于 0' }, 'a negative deposit is stopped');
      assert.equal(store.saves, savesBefore, 'nothing was saved');
      await deposit.fill('100');
      assert.deepEqual(await hints(), {});
      await page.evaluate(() => closeOrder());
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));

      // ---- 11. 粘贴识别：同一项不出现两次 ----
      await page.evaluate(() => openOrder());
      await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
      await page.locator('#pasteAssistInput').fill('Hi, this is Emma from Aurora Beauty Ltd, UK. We want 200 boxes C curl 0.07 lashes, total 1,850 USD, pay by PayPal emma@aurora-beauty.example. Please ship by DHL. Phone +44 7700 900123');
      await h.click(page, '#pasteAssistAnalyzeBtn', 'analyze');
      await page.waitForSelector('#pasteAssistResults .paste-field-pill');
      const pills = await page.evaluate(() => [...document.querySelectorAll('#pasteAssistResults .paste-result-card')]
        .map(card => [...card.querySelectorAll('.paste-field-pill')].map(pill => pill.textContent.replace(/\s+/g, ''))));
      pills.forEach(list => {
        assert.deepEqual(list, [...new Set(list)], `no pill twice in one card (${list.join(' / ')})`);
        const payments = list.filter(text => /^(付款|收款方式)：/.test(text)).map(text => text.split('：')[1]);
        assert.deepEqual(payments, [...new Set(payments)], `付款 and 收款方式 are not both shown with the same value (${list.join(' / ')})`);
      });
      assert.ok(pills.flat().some(text => text.startsWith('产品：')), 'the product is still listed once');
      await waitIdle(page);
      await shot(page, `11-paste-${theme}`);
      await page.evaluate(() => closeOrder());
      await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));

      // ---- 3 + 5 + 13. 新建客户：邮箱报错不变窄、左栏当前步骤、复购周期 ----
      await h.click(page, '#topNewCustomerBtn', 'new customer');
      await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
      await waitIdle(page);
      const email = page.locator('#customerForm [name="email"]');
      const widthBefore = await email.evaluate(el => el.getBoundingClientRect().width);
      await h.click(page, email, 'email');
      await page.keyboard.type('not-an-email');
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.querySelector('#customerForm [name="email"]').getAttribute('aria-invalid') === 'true');
      assert.equal(await email.evaluate(el => el.getBoundingClientRect().width), widthBefore, 'the email field keeps its width when it shows a hint');
      await shot(page, `03-customer-email-${theme}`);
      const step = await contrast(page, '#customerModal .mnav button.on .mn-i');
      assert.ok(step.ratio >= 4.5, `current step number in the new-customer rail ${step.ratio}:1`);
      await page.evaluate(() => closeCustomerModal());
      await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
      if (light) {
        await page.evaluate(() => openCustomerModal('Round Four Buyer', { viewOnly:false }));
        await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
        assert.deepEqual(await page.evaluate(() => [...document.querySelector('#customerForm [name="repurchaseCycle"]').options].map(o => o.value)),
          ['', '30', '45', '60', '90', '180'], 'a custom cycle sits between the presets by its number of days');
        await page.evaluate(() => closeCustomerModal());
        await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
      }

      // ---- 5. 左上角的 T、续费主按钮 ----
      const logo = await contrast(page, '.logo-mark');
      assert.ok(logo.ratio >= 4.5, `logo mark ${logo.ratio}:1`);
      await page.evaluate(() => setPage('subscriptions'));
      await page.waitForSelector('#subsAddBtn', { state:'visible' });
      const subsBtn = await contrast(page, '#subsAddBtn');
      assert.ok(subsBtn.ratio >= 4.5, `「新增续费项」 ${subsBtn.ratio}:1`);
      await waitIdle(page);
      await shot(page, `05-subscriptions-${theme}`);

      // ---- 12. 续费服务商：App 自己的建议菜单，列表外的新值照样能填 ----
      const suggest = () => page.evaluate(() => {
        const el = document.getElementById('suggestMenu');
        return { open:Boolean(el && !el.hidden), items:el ? [...el.querySelectorAll('.app-select-option')].map(o => o.textContent.trim()) : [],
          label:el?.getAttribute('aria-label') || '' };
      });
      await page.evaluate(() => { subscriptionState.items.push({ id:'probe-sub', name:'Probe', provider:'Cloudflare' }); openSubscriptionEditor(); });
      await page.waitForFunction(() => document.getElementById('subscriptionProvider')?.offsetParent);
      await waitIdle(page);
      const provider = page.locator('#subscriptionProvider');
      await h.click(page, provider, 'provider');
      let menu = await suggest();
      assert.deepEqual([menu.open, menu.items, menu.label], [true, ['Cloudflare'], '服务商'], 'the provider field lists providers already used');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.equal(await provider.inputValue(), 'Cloudflare');
      await provider.evaluate(el => { el.focus(); el.select(); });
      await page.keyboard.type('Fresh Host', { delay:5 });
      assert.equal((await suggest()).open, false, 'no menu for a new provider');
      assert.equal(await provider.inputValue(), 'Fresh Host', 'a provider outside the list is kept as typed');
      await page.evaluate(() => { subscriptionState.items = subscriptionState.items.filter(item => item.id !== 'probe-sub'); });
      await page.keyboard.press('Escape');
      await page.evaluate(() => { document.querySelectorAll('.modal-backdrop.open').forEach(modal => setModalOpenState(modal, false)); setPage('dashboard'); });

      // ---- 12. 合并到其他客户：选目标用 App 自己的菜单 ----
      assert.equal(await page.locator('datalist').count(), 0, 'no system datalist left in the page');
      const merging = page.evaluate(() => mergeCustomerInto('Second Buyer'));
      merging.catch(() => {});
      await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      const confirmInput = page.locator('#confirmInput');
      await page.waitForFunction(() => document.activeElement?.id === 'confirmInput');
      await page.keyboard.type('roun', { delay:5 });
      menu = await suggest();
      assert.deepEqual([menu.open, menu.items, menu.label], [true, ['Round Four Buyer', 'Rounded Corner Ltd'], '并入的客户'], 'typing filters the customers');
      await waitIdle(page);
      await shot(page, `12-merge-target-${theme}`);
      await page.keyboard.press('Escape');
      assert.equal((await suggest()).open, false, 'Esc closes only the menu');
      assert.ok(await page.evaluate(() => document.getElementById('confirmModal').classList.contains('open')), 'the confirm dialog stays open');
      // 框里是打了一半的字：↓ 重新打开筛过的列表并停在第一项。
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.equal(await confirmInput.inputValue(), 'Round Four Buyer', 'Enter picks the highlighted customer and does not confirm');
      assert.ok(await page.evaluate(() => document.getElementById('confirmModal').classList.contains('open')));
      await h.click(page, '#confirmCancelBtn', 'cancel merge');
      await merging;
      assert.equal(await confirmInput.getAttribute('role'), null, 'the shared confirm input is plain again afterwards');
      assert.equal(await page.evaluate(() => document.getElementById('confirmInput').matches(suggestInputSelector)), false);

      // ---- 6. 搜索面板的小字 ----
      await h.click(page, '#searchInput', 'search');
      await page.keyboard.type('Round', { delay:5 });
      await page.waitForSelector('#globalSearchPanel.open .global-search-group-title');
      for (const selector of ['.global-search-group-title', '.global-search-kind', '.global-search-foot']) {
        const result = await contrast(page, `#globalSearchPanel ${selector}`);
        assert.ok(result.size >= 11.5, `${selector} is ${result.size}px`);
        assert.ok(result.ratio >= 4.5, `${selector} ${result.ratio}:1`);
      }
      await shot(page, `06-search-${theme}`);
      await page.keyboard.press('Escape');

      // ---- 9. 看板右上角的 全部 / 假发 / 睫毛 ----
      const filter = await contrast(page, '#boardProductFilter .segment-option');
      assert.ok(filter.size >= 11.5, `board filter ${filter.size}px`);

      // ---- 9. 订单抽屉「记录」里的相关订单 ----
      await page.evaluate(() => openOrderDetail('r1', { tab:'records' }));
      await page.waitForSelector('#orderDetailBody .order-detail-related-order', { state:'visible' });
      const smalls = await page.evaluate(() => [...document.querySelectorAll('#orderDetailBody .order-detail-related-order small')].map(el => parseFloat(getComputedStyle(el).fontSize)));
      assert.ok(smalls.length && smalls.every(size => size >= 11.5), `related orders small text ${smalls.join(', ')}px`);
      await page.evaluate(() => closeOrderDetail());

      // ---- 7 + 10. 物流：抽屉顶上的运单号、查询框下的提示 ----
      await page.evaluate(() => setPage('logistics'));
      const detect = await contrast(page, '.tracking-detect-empty');
      assert.ok(detect.ratio >= 4.5, `「粘贴后自动识别承运商」 ${detect.ratio}:1`);
      await page.evaluate(() => openTrackingDetail('lk-r4'));
      await page.waitForFunction(() => document.getElementById('trackingDetailDrawer').classList.contains('open'));
      await waitIdle(page);
      const trackingNum = await contrast(page, '#trackingDetailNum');
      assert.ok(trackingNum.ratio >= 4.5, `tracking number ${trackingNum.ratio}:1`);
      assert.ok(trackingNum.size >= 12.5, `tracking number ${trackingNum.size}px`);
      await shot(page, `07-tracking-${theme}`);
      await page.evaluate(() => closeTrackingDetail());

      // ---- 8 + 9 + 10. 设置：标签的删除叉、等级规则表的小字、添加框的占位字 ----
      await page.evaluate(() => setPage('settings'));
      await h.click(page, '.settings-menu-item[data-settings-tab="customer"]', 'settings tab customer');
      const chipBtn = page.locator('.settings-chip button[data-settings-remove]').first();
      await chipBtn.waitFor();
      const chip = await chipBtn.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { width:rect.width, height:rect.height, label:el.getAttribute('aria-label'), chipHeight:el.parentElement.getBoundingClientRect().height, chipText:el.parentElement.firstChild.textContent };
      });
      assert.ok(chip.width >= 20 && chip.height >= 20, `the delete × is ${chip.width}×${chip.height}`);
      assert.equal(chip.label, `删除 ${chip.chipText}`);
      assert.ok(chip.chipHeight <= 32, `the chip does not grow taller (${chip.chipHeight}px)`);
      const box = await chipBtn.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const hoverColor = await chipBtn.evaluate(el => window.__rgba(getComputedStyle(el).color));
      assert.ok(hoverColor[0] > hoverColor[1] + 40 && hoverColor[0] > hoverColor[2] + 40, `hovering the × turns it red (${hoverColor})`);
      await page.mouse.move(5, 5);
      const levelSmall = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.level-rule-row .level-rule-input small')).fontSize));
      assert.ok(levelSmall >= 11.5, `level rule unit ${levelSmall}px`);
      const placeholder = await page.evaluate(() => {
        const input = document.getElementById('settingsTagInput');
        return window.__contrast(input, getComputedStyle(input, '::placeholder').color);
      });
      assert.ok(placeholder >= 4, `tag input placeholder ${placeholder}:1`);
      await shot(page, `08-settings-${theme}`);

      // ---- 4. 提示条 ----
      await page.evaluate(() => setPage('dashboard'));
      await h.clearToasts(page);
      await page.evaluate(() => {
        uiToast('已保存订单 R4001', { desc:'放到「生产中」，还没收的尾款按已收齐记，这一行说明比较长会折成两行显示' });
        uiToast('已更新客户 Round Four Buyer');
        uiToast('已移到垃圾箱', { desc:'30 天内可以从垃圾箱恢复', undo:() => {} });
        uiToast('已复制运单号');
      });
      await waitIdle(page);
      const behind = await page.evaluate(() => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].slice(0, -1)
        .map(item => [...item.children].map(child => Number(getComputedStyle(child).opacity))));
      behind.forEach(opacities => assert.deepEqual([...new Set(opacities)], [0], 'stacked toasts show no text'));
      await shot(page, `04-toast-collapsed-${theme}`);
      const newest = await page.locator('#toast .toast-item:not(.leaving)').last().boundingBox();
      await page.mouse.move(newest.x + newest.width / 3, newest.y + newest.height / 2);
      await page.waitForFunction(() => document.getElementById('toast').matches(':hover'));
      await waitIdle(page);
      const rects = await page.evaluate(() => [...document.querySelectorAll('#toast .toast-item:not(.leaving)')].map(item => {
        const r = item.getBoundingClientRect();
        return { top:r.top, bottom:r.bottom, text:Number(getComputedStyle(item.lastElementChild).opacity) };
      }).sort((a, b) => a.top - b.top));
      assert.equal(rects.length, 4, 'all four toasts are laid out when expanded');
      rects.slice(1).forEach((rect, i) => assert.ok(rect.top - rects[i].bottom >= 6, `expanded toasts keep a gap (${rect.top - rects[i].bottom}px)`));
      assert.ok(rects.every(rect => rect.text === 1), 'expanded toasts show their text');
      await shot(page, `04-toast-expanded-${theme}`);
      await page.mouse.move(5, 5);
      await h.clearToasts(page);

      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      await context.close();
    }

    // ---- 9. 最小窗口：看板标题那一行不换行 ----
    const small = await openBoard(browser, data, { width:1294, height:847, port:47996 });
    const head = await small.page.evaluate(() => {
      const row = document.querySelector('.board-panel .section-head');
      const tops = [...row.querySelectorAll(':scope > *, .board-head-actions > *')].filter(el => el.offsetParent).map(el => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2));
      return { spread:Math.max(...tops) - Math.min(...tops), filterHeight:document.getElementById('boardProductFilter').getBoundingClientRect().height,
        optionWraps:[...document.querySelectorAll('#boardProductFilter .segment-option')].some(el => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().height > 30) };
    });
    assert.ok(head.spread <= 6, `the board head stays on one line at 1294×847 (spread ${head.spread}px)`);
    assert.equal(head.optionWraps, false, 'the board filter labels fit');
    await shot(small.page, '09-board-1294');
    assert.deepEqual(small.errors, []);
    await small.context.close();
    console.log('UI round 4 passed: client menu stays put after the shake, in-page order hints, steady email field, readable toast stack, dark ink on light purple, larger small text, deduplicated paste pills, in-app suggestion menus, sorted repurchase cycles.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
