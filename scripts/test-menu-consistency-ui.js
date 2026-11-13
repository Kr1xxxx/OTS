#!/usr/bin/env node
// 下拉菜单和弹窗的一致性（真实页面 + 真实鼠标）：
// - 下拉框的菜单和看板右键菜单是同一个外框（圆角、边框、阴影）；选中项用强调色并带对勾图标；
// - 窄按钮下面的菜单按最长的选项撑开，选项不折成两行，也不超出窗口；
// - 展开的下拉框和聚焦的输入框都是强调色边框，输入框不再叠一圈全局轮廓；
// - 没有输入框的确认框不留错误提示那一行的空位，有输入框的照旧留着；
// - 看板卡片设置、客户 + 订单、图片预览三个弹窗的关闭按钮是 × 图标。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const orders = [
  { ...base, id:'m1', num:'K0001', client:'Menu Buyer One', stage:'quote', orderType:'全款订单', amount:1200, paidAmount:0, createdAt:day(2), updated:`${day(2)} 10:00` },
  { ...base, id:'m2', num:'K0002', client:'Menu Buyer Two', stage:'production', orderType:'全款订单', amount:800, paidAmount:800, createdAt:day(3), updated:`${day(3)} 10:00` }
];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:47961 });
    const frame = selector => page.evaluate(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { radius:style.borderTopLeftRadius, border:style.borderTopColor, shadow:style.boxShadow, background:style.backgroundColor };
    }, selector);
    const accent = () => page.evaluate(() => {
      const probe = document.createElement('i');
      // 字压在强调色淡底上用 --accent-ink（亮色下比 --accent 深一点，暗色下就是 --accent）。
      probe.style.cssText = 'color:var(--accent-ink); border:1px solid var(--accent)';
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const value = { ink:style.color, border:style.borderTopColor };
      probe.remove();
      return value;
    });

    // ---- 右键菜单的外框 ----
    await page.locator('#pipeline .board-card[data-id="m1"]').click({ button:'right' });
    await page.waitForSelector('.board-menu');
    const cardMenu = await frame('.board-menu');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.board-menu'));

    // ---- 工作台「本月订单额」：按钮很窄，菜单按选项撑开 ----
    const statButton = page.locator('#page-dashboard .amount-stat .app-select-button').first();
    await h.click(page, statButton, 'dashboard month select');
    await page.waitForSelector('.app-select-popover:not([hidden])');
    const narrow = await page.evaluate(() => {
      const popover = document.querySelector('.app-select-popover:not([hidden])');
      const box = popover.getBoundingClientRect();
      const options = [...popover.querySelectorAll('.app-select-option')];
      const selected = popover.querySelector('.app-select-option.selected');
      // 一行字的高度：折成两行的选项，文字那一块比行高高出一截。
      const wrapped = options.filter(option => {
        const label = option.querySelector('.app-select-option-label');
        return label.getBoundingClientRect().height > parseFloat(getComputedStyle(label).lineHeight) * 1.5;
      }).map(option => option.textContent.trim());
      return { wrapped, count:options.length, left:box.left, right:box.right, vw:document.documentElement.clientWidth,
        selectedText:selected?.textContent.trim() || '', selectedColor:selected ? getComputedStyle(selected).color : '', icon:Boolean(selected?.querySelector('.app-select-option-check svg')),
        checks:popover.querySelectorAll('.app-select-option-check svg').length };
    });
    assert.ok(narrow.count > 3, 'the month select lists months');
    assert.deepEqual(narrow.wrapped, [], 'no option of a narrow select is folded into two lines');
    assert.ok(narrow.left >= 0 && narrow.right <= narrow.vw, `the widened menu stays inside the window: ${JSON.stringify(narrow)}`);
    assert.equal(narrow.icon, true, 'the selected option carries a check icon');
    assert.equal(narrow.checks, 1, 'only the selected option has a check');
    assert.equal(narrow.selectedColor, (await accent()).ink, 'the selected option is written in the accent ink colour');
    const selectMenu = await frame('.app-select-popover:not([hidden])');
    assert.deepEqual({ radius:selectMenu.radius, border:selectMenu.border, shadow:selectMenu.shadow, background:selectMenu.background }, cardMenu, 'the select menu and the card menu share one frame');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.app-select-popover:not([hidden])'));

    // ---- 最长的一项真实宽度带小数（比如 184.39）时也不折行，不管今天几号 ----
    // 菜单宽度以前取 offsetWidth（四舍五入的整数），小数部分不到 0.5 的那一项就差一点、折成两行：
    // 2026 年 12 月起「2026年12月 · 本月」就是这样。这里把月份下拉选中的那项换成下面这些字，逐个打开量，
    // 小数部分是多少取决于字体，换十几串总有往下舍的。
    const longLabels = [];
    for (const year of [2026, 2027]) for (const month of [10, 11, 12]) for (const suffix of ['本月', '上月']) longLabels.push(`${year}年${month}月 · ${suffix}`);
    let roundedDown = 0;
    for (const label of longLabels) {
      await page.evaluate(label => {
        const select = document.getElementById('totalRange');
        // 选中的那项带对勾，是菜单里最宽的一项：换它的字。
        select.options[select.selectedIndex].textContent = label;
      }, label);
      await h.click(page, statButton, `dashboard month select (${label})`);
      await page.waitForSelector('.app-select-popover:not([hidden])');
      const result = await page.evaluate(label => {
        const popover = document.querySelector('.app-select-popover:not([hidden])');
        const option = [...popover.querySelectorAll('.app-select-option')].find(item => item.textContent.trim() === label);
        const text = option?.querySelector('.app-select-option-label');
        const folded = text ? text.getBoundingClientRect().height > parseFloat(getComputedStyle(text).lineHeight) * 1.5 : null;
        // 菜单不受约束时的真实宽度（工作台上没有缩放，getBoundingClientRect 就是布局宽度）。
        const width = popover.style.width;
        popover.style.width = 'max-content';
        const natural = popover.getBoundingClientRect().width;
        popover.style.width = width;
        return { folded, natural };
      }, label);
      assert.equal(result.folded, false, `「${label}」 stays on one line (natural menu width ${result.natural})`);
      const fraction = result.natural - Math.floor(result.natural);
      if (fraction > 0.001 && fraction < 0.5) roundedDown += 1;
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.app-select-popover:not([hidden])'));
    }
    assert.ok(roundedDown > 0, `at least one label has a width that rounds down, so the check above covers the case (${longLabels.length} labels)`);

    // ---- 展开的下拉框、聚焦的输入框：强调色边框；输入框没有第二圈轮廓 ----
    await page.evaluate(() => openCustomerModal('', { viewOnly:false }));
    await page.waitForSelector('#customerModal.open');
    const nameInput = page.locator('#customerForm [name="name"]');
    await h.click(page, nameInput, 'customer name');
    // 边框颜色有过渡：等它走到强调色再量（刚点下去时还是原来的灰色）。
    const accentBorder = (await accent()).border;
    const reachesAccent = (locator, what) => locator.evaluate((el, expected) => new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        const now = getComputedStyle(el).borderTopColor;
        if (now === expected) return resolve();
        if (performance.now() - started > 3000) return reject(new Error(`border is ${now}, expected ${expected}`));
        requestAnimationFrame(check);
      };
      check();
    }), accentBorder).catch(error => assert.fail(`${what}: ${error.message.split('\n')[0]}`));
    await reachesAccent(nameInput, 'a focused text field has an accent border');
    const focused = await nameInput.evaluate(el => { const style = getComputedStyle(el); return { active:document.activeElement === el, outline:style.outlineStyle, shadow:style.boxShadow }; });
    assert.equal(focused.active, true);
    assert.equal(focused.outline, 'none', 'a focused text field has one focus style, not an outline around it as well');
    assert.notEqual(focused.shadow, 'none', 'a focused text field keeps its soft ring');
    const levelButton = page.locator('#customerForm select[name="level"] + .app-select-button, #customerForm .app-select:has(select[name="level"]) .app-select-button').first();
    await levelButton.scrollIntoViewIfNeeded();
    await h.click(page, levelButton, 'customer level select');
    await page.waitForSelector('.app-select-popover:not([hidden])');
    await reachesAccent(levelButton, 'an open select has the same accent border as a focused field');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.app-select-popover:not([hidden])'));
    await page.evaluate(() => { const modal = document.getElementById('customerModal'); modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.classList.remove('modal-open'); });

    // ---- 确认框：没有输入框时不留错误提示的空位 ----
    const confirmGap = () => page.evaluate(() => {
      const message = document.getElementById('confirmMessage').getBoundingClientRect();
      const actions = document.querySelector('#confirmModal .confirm-actions').getBoundingClientRect();
      const error = document.getElementById('confirmError');
      return { gap:Math.round(actions.top - message.bottom), errorShown:error.getClientRects().length > 0 };
    });
    await page.evaluate(() => { window.__plain = appConfirm({ title:'恢复这份备份？', message:'恢复前会先自动备份一次。', confirmText:'恢复' }); });
    await page.waitForSelector('#confirmModal.open');
    const plain = await confirmGap();
    assert.equal(plain.errorShown, false, 'a confirm box without an input does not reserve the error line');
    assert.ok(plain.gap <= 20, `message and buttons sit one gap apart (${plain.gap}px)`);
    await h.click(page, '#confirmCancelBtn', 'cancel');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    await page.evaluate(() => { window.__typed = appConfirm({ title:'替换全部数据？', message:'文件里没有的订单会被删除。', confirmText:'替换', danger:true, inputLabel:'输入「替换」确认', validate:value => value === '替换' || '请输入「替换」' }); });
    await page.waitForSelector('#confirmModal.open');
    assert.equal((await confirmGap()).errorShown, true, 'a confirm box with an input keeps the error line, so the box does not jump when the error appears');
    await h.click(page, '#confirmOkBtn', 'confirm without typing');
    await page.waitForFunction(() => document.getElementById('confirmError').textContent.includes('替换'));
    await h.click(page, '#confirmCancelBtn', 'cancel');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));

    // ---- 关闭按钮是图标 ----
    const closeButtons = await page.evaluate(() => ['boardCardSettingsCloseBtn', 'combinedCloseBtn', 'attachmentPreviewCloseBtn', 'calendarTaskCloseBtn', 'trackingDetailCloseBtn', 'confirmCloseBtn'].map(id => {
      const button = document.getElementById(id);
      return { id, icon:Boolean(button.querySelector('svg')), text:button.textContent.trim(), label:button.getAttribute('aria-label') };
    }));
    for (const button of closeButtons) {
      assert.equal(button.icon, true, `${button.id} shows the × icon`);
      assert.equal(button.text, '', `${button.id} has no text beside the icon`);
      assert.ok(button.label, `${button.id} is named for screen readers`);
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], 'no native alert / confirm / prompt');
    console.log('Menu consistency UI passed: select menu = card menu frame, accent selected option with check icon, no folded options, accent focus without a second ring, confirm box without the empty error line, × icons on six dialogs.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
