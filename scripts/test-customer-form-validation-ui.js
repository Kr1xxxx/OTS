#!/usr/bin/env node
// 客户新建 / 编辑：邮箱、电话、国家、币种的校验和保存（V3.125 审查 13 的 P1-1 / P1-2 / P1-3 及键盘、变更记录）。
// 全程真实键盘鼠标；不用固定等待，等元素停稳（h.center / h.settle）、等条件成立。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

(async () => {
  const browser = await launchBrowser();
  try {
    const data = {
      orders:[
        { ...base, id:'d1', num:'K25010001', client:'Dubai Buyer', amount:500, paidAmount:500, currency:'AED', country:'🇦🇪 阿联酋 United Arab Emirates', stage:'done', createdAt:day(2) },
        { ...base, id:'b1', num:'K25010002', client:'Bob Taylor', amount:300, paidAmount:300, stage:'done', createdAt:day(3) }
      ],
      customers:{
        'Dubai Buyer':{ client:'Dubai Buyer', currency:'AED', country:'🇦🇪 阿联酋 United Arab Emirates', paymentMethod:'TT' },
        'Bob Taylor':{ client:'Bob Taylor', country:'🇬🇧 英国 United Kingdom', phones:['+44 7700 900127', '+44 7700 900128'], phone:'+44 7700 900127', emails:['bob@example.co.uk'], email:'bob@example.co.uk' }
      },
      orderSettings:{ ownEmails:['sales@our-shop.example'] }
    };
    const { page, store, errors, dialogs } = await openBoard(browser, data, { port:47981 });
    const form = '#customerForm';
    const phoneInputs = page.locator(`${form} [data-customer-multi-kind="phones"] [data-customer-multi-input]`);
    const emailInputs = page.locator(`${form} [data-customer-multi-kind="emails"] [data-customer-multi-input]`);
    const values = locator => locator.evaluateAll(nodes => nodes.map(node => node.value));
    const hintOf = locator => locator.evaluate(input => document.getElementById(input.getAttribute('aria-describedby') || '')?.textContent || '');
    // 真实鼠标点：等元素停稳再量，点之前确认那一点上确实是它（没被提示条之类盖住）。
    const click = async selector => {
      const p = await h.center(page, selector);
      const onTop = await page.locator(selector).first().evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), p);
      assert.equal(onTop, true, `${selector} is covered: ${await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0, 120), p)}`);
      await page.mouse.click(p.x, p.y);
    };
    const focusedName = () => page.evaluate(() => document.activeElement?.name || document.activeElement?.id || '');
    const selectAll = async () => page.keyboard.press('ControlOrMeta+A');

    // ---- 新建：打开后焦点就在「客户名称」上 ----
    await click('#topNewCustomerBtn');
    await page.locator('#customerModal.open').waitFor();
    await h.settle(page, '#customerModal .modal');
    await page.waitForFunction(() => document.activeElement?.name === 'name');
    await page.keyboard.type('Lagos Buyer');
    // 回车不再直接保存：跳到下一个框。
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#customerModal.open').count(), 1, 'Enter in a single-line field must not save and close');
    assert.notEqual(await focusedName(), 'name', 'Enter moves to the next field');

    // ---- P1-1：写错的邮箱留着原样，红字说明原因，保存被拦下 ----
    await emailInputs.first().click();
    await page.keyboard.type('carl@diaz,de');
    await page.keyboard.press('Tab');
    assert.equal(await emailInputs.first().inputValue(), 'carl@diaz,de', 'an invalid email is kept as typed, not wiped');
    assert.equal(await emailInputs.first().getAttribute('aria-invalid'), 'true');
    assert.match(await hintOf(emailInputs.first()), /逗号|「,」/);
    // 我方自己的邮箱不能存进客户档案。
    await page.locator(`${form} [name="paymentEmail"]`).click();
    await page.keyboard.type('sales@our-shop.example');
    await page.keyboard.press('Tab');
    assert.match(await hintOf(page.locator(`${form} [name="paymentEmail"]`)), /我方/);

    // ---- P1-2：电话按国家补成国际格式，同号去重，位数不对报错 ----
    await page.locator(`${form} [name="country"]`).click();
    await selectAll();
    await page.keyboard.type('UK');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(`${form} [name="country"]`).inputValue(), '🇬🇧 英国 United Kingdom', 'UK resolves to United Kingdom, not Ukraine');
    await phoneInputs.first().click();
    await page.keyboard.type('07700 900123');
    await page.keyboard.press('Tab');
    assert.equal(await phoneInputs.first().inputValue(), '+44 7700 900123', 'a UK local number becomes international');
    assert.match(await hintOf(phoneInputs.first()), /国际格式/);
    await click(`${form} [data-add-customer-value="phones"]`);
    await page.waitForFunction(() => document.activeElement?.closest?.('[data-customer-multi-kind="phones"]'));
    await page.keyboard.type('+44 (0)7700 900123');
    await page.keyboard.press('Tab');
    assert.match(await hintOf(phoneInputs.nth(1)), /同一个号码/);
    await click(`${form} [data-add-customer-value="phones"]`);
    await page.waitForFunction(() => document.querySelectorAll('#customerForm [data-customer-multi-kind="phones"] [data-customer-multi-input]').length === 3 && document.activeElement === document.querySelectorAll('#customerForm [data-customer-multi-kind="phones"] [data-customer-multi-input]')[2]);
    await page.keyboard.type('12345');
    await page.keyboard.press('Tab');
    assert.equal(await phoneInputs.nth(2).getAttribute('aria-invalid'), 'true');
    assert.match(await hintOf(phoneInputs.nth(2)), /位/);

    // 有错时保存：不关、不存，焦点停在第一个出错的框上。
    await click('#customerFooterSaveBtn');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
    assert.equal(await page.locator('#customerModal.open').count(), 1);
    assert.equal(store.saves, 0, 'nothing is saved while fields are invalid');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#customerForm [data-customer-multi-kind="emails"] [data-customer-multi-input]')), true, 'focus goes to the first invalid field');

    // 改正：邮箱、付款邮箱、删掉坏电话。
    await selectAll();
    await page.keyboard.type('carl@diaz.de');
    await page.locator(`${form} [name="paymentEmail"]`).click();
    await selectAll();
    await page.keyboard.press('Backspace');
    const badRow = page.locator(`${form} [data-customer-multi-kind="phones"] .customer-multi-row`).nth(2);
    await click(`${form} [data-customer-multi-kind="phones"] .customer-multi-row:nth-child(3) [data-remove-customer-value]`);
    await badRow.waitFor({ state:'detached' });
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll('#customerForm [data-customer-multi-kind="phones"] [data-customer-multi-input]')[1]), true, 'removing a row focuses the previous row');
    // ⌘S / Ctrl+S 保存。
    await page.keyboard.press('ControlOrMeta+S');
    await page.locator('#customerModal.open').waitFor({ state:'detached' }).catch(() => {});
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    await page.waitForFunction(() => state.customers['Lagos Buyer']);
    const lagos = await page.evaluate(() => JSON.parse(JSON.stringify(state.customers['Lagos Buyer'])));
    assert.deepEqual(lagos.phones, ['+44 7700 900123'], 'the same number written two ways is stored once');
    assert.deepEqual(lagos.emails, ['carl@diaz.de']);
    assert.equal(lagos.paymentEmail || '', '');
    assert.equal(lagos.country, '🇬🇧 英国 United Kingdom');

    // ---- P1-3：列表外币种（AED）编辑时照常显示，只改备注保存后仍是 AED；默认值不写进变更记录 ----
    await page.evaluate(() => openCustomerModal('Dubai Buyer', { viewOnly:true }));
    await page.locator('#customerModal.open').waitFor();
    await click('#customerDetailEditBtn');
    await page.waitForFunction(() => document.activeElement?.name === 'name', null, { timeout:3000 });
    assert.equal(await page.locator(`${form} select[name="currency"]`).inputValue(), 'AED');
    await page.locator(`${form} textarea[name="note"]`).click();
    await page.keyboard.type('prefers TT');
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    const dubai = await page.evaluate(() => JSON.parse(JSON.stringify(state.customers['Dubai Buyer'])));
    assert.equal(dubai.currency, 'AED', 'a currency outside the built-in list survives an unrelated edit');
    assert.equal(dubai.productType || '', '', 'an untouched default is not written into the profile');
    assert.doesNotMatch(dubai.history?.[0]?.text || '', /产品类型|付款方式/);
    assert.match(dubai.history?.[0]?.text || '', /备注/);
    // 给这位客户新建订单：币种跟着档案是 AED，不是「请选择」或 USD。
    await page.evaluate(() => openNewOrderForCustomer('Dubai Buyer'));
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open') && document.querySelector('#orderForm select[name="currency"]').value === 'AED', null, { timeout:3000 });
    await page.evaluate(() => closeOrder());

    // ---- 变更记录记下电话的增删；「设为主要」对调第一条 ----
    await page.evaluate(() => openCustomerModal('Bob Taylor', { viewOnly:false }));
    await page.locator('#customerModal.open').waitFor();
    await h.settle(page, '#customerModal .modal');
    await click(`${form} [data-customer-multi-kind="phones"] .customer-multi-row:nth-child(2) [data-promote-customer-value]`);
    assert.deepEqual(await values(phoneInputs), ['+44 7700 900128', '+44 7700 900127']);
    await click('#customerFooterSaveBtn');
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    const bob = await page.evaluate(() => JSON.parse(JSON.stringify(state.customers['Bob Taylor'])));
    assert.equal(bob.phone, '+44 7700 900128');
    assert.match(bob.history?.[0]?.text || '', /电话.*主要/);

    // 只读档案：每个电话 / 邮箱有自己的复制按钮。
    await page.evaluate(() => openCustomerModal('Bob Taylor', { viewOnly:true }));
    await page.locator('#customerModal.open').waitFor();
    assert.equal(await page.locator('#customerDetailInfoGrid [data-copy-customer-value]').count() >= 3, true);

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], 'no native alert / confirm / prompt');
    console.log('Customer form validation UI passed: email kept + reason + blocked save, own email rejected, UK country, phone to international + dedupe + length error, focus on first error, row removal focus, ⌘S / ⌘Enter, AED kept on edit and new order, untouched defaults not logged, promote primary logged, per-value copy.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
