#!/usr/bin/env node
// 客户只读档案：没填的项不占位。
// - 只填了名字和一个电话的客户：页面上没有「未填写 / 未设置 / 暂无备注」，地址、交易偏好里空着的行不列，
//   左栏最后一行「还没填：…」按页面从上到下列出空着的项，点「去填写」进编辑状态；没设复购周期时没有「复购提醒」卡，「最近订单」占两格。
// - 资料填全的客户：没有那一行，六张数字卡都在，永久备注和客户备注照旧。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

const data = {
  orders:[
    { ...base, id:'f1', num:'K26100101', client:'Full Profile Co', amount:900, paidAmount:900, stage:'done', createdAt:day(6) }
  ],
  customers:{
    'Phone Only':{ client:'Phone Only', phones:['+1 555 0100'], phone:'+1 555 0100' },
    'Full Profile Co':{
      client:'Full Profile Co', country:'🇺🇸 美国 United States', contacts:['Sam'], contact:'Sam', phones:['+1 555 0101'], phone:'+1 555 0101',
      emails:['sam@example.com'], email:'sam@example.com', primaryContactMethod:'WhatsApp', alibabaId:'sam-example',
      addresses:['1 Example Street, Springfield'], address:'1 Example Street, Springfield', currency:'USD', paymentMethod:'Paypal', productType:'假发',
      paymentEmail:'pay@example.com', level:'C级白金客户', owner:'Kris', repurchaseCycle:60, note:'普通备注', permanentNote:'只用无品牌包装'
    }
  }
};

const openProfile = async (page, name) => {
  await page.evaluate(client => openCustomerModal(client), name);
  await page.locator('#customerModal.open').waitFor();
  await h.quiet(page);
};
const visibleText = page => page.locator('#customerDetailView').innerText();

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, data, { width:1440, height:920 });

    // ---- 1. Only a name and a phone ----
    await openProfile(page, 'Phone Only');
    const text = await visibleText(page);
    for (const placeholder of ['未填写', '未设置', '暂无备注', '地址未填写', '国家未填写', '未设置提醒']) {
      assert.ok(!text.includes(placeholder), `no placeholder 「${placeholder}」 in the read-only profile:\n${text}`);
    }
    // The phone is listed; the address section, the copy button and empty preference rows are not.
    assert.match(await page.locator('#customerDetailInfoGrid').innerText(), /\+1 555 0100/);
    assert.equal(await page.locator('#customerDetailInfoGrid [data-copy-customer-address]').count(), 0, 'no copy button without an address');
    assert.equal(await page.locator('#customerDetailInfoGrid .customer-rail-address').count(), 0);
    const kvLabels = await page.locator('#customerDetailInfoGrid .customer-rail-kv > :first-child').allInnerTexts();
    // (A saved profile always has a payment method, 阿里巴巴 by default, and the level is judged automatically.)
    assert.deepEqual(kvLabels, ['默认币种', '收款方式', '客户等级', '负责人'], 'only rows with a value or a real state');
    assert.deepEqual(await page.locator('#customerDetailInfoGrid .customer-rail-kv strong.is-empty').allInnerTexts(), ['未分配'], '负责人 still says 未分配: a state, not a placeholder');
    // The last line of the rail lists what is empty, top to bottom.
    const last = page.locator('#customerDetailInfoGrid > :last-child');
    assert.equal(await last.evaluate(el => el.classList.contains('customer-rail-missing')), true);
    assert.equal(await last.innerText(), '还没填：联系人、邮箱、主要联系方式、阿里 ID、国家、详细地址、产品类型、付款邮箱、复购周期、永久备注、客户备注去填写 →');
    // Right side: no amber banner, no note card, five number cards with 最近订单 two columns wide.
    assert.equal(await page.locator('#customerDetailPermanentNote').isHidden(), true);
    assert.equal(await page.locator('#customerDetailNote').isHidden(), true);
    const cards = await page.locator('#customerProfileMetrics .customer-metric-card').evaluateAll(els => els.map(el => ({ label:el.querySelector('span').textContent, width:Math.round(el.getBoundingClientRect().width) })));
    assert.deepEqual(cards.map(card => card.label), ['订单数', '总成交', '已收款', '待收款', '最近订单']);
    assert.ok(cards[4].width > cards[0].width * 1.8, `最近订单 spans two columns: ${JSON.stringify(cards)}`);
    // 去填写 opens the edit form, like 编辑资料.
    await page.locator('#customerDetailInfoGrid [data-customer-fill-missing]').click();
    await page.waitForFunction(() => document.getElementById('customerForm').classList.contains('customer-edit-mode'));
    assert.equal(await page.locator('#customerDetailView').isHidden(), true);
    assert.equal(await page.locator('#customerModalSub').innerText(), '编辑客户档案');
    await page.evaluate(() => closeCustomerModal());

    // ---- 2. Everything filled ----
    await openProfile(page, 'Full Profile Co');
    assert.equal(await page.locator('#customerDetailInfoGrid .customer-rail-missing').count(), 0, 'nothing to fill');
    assert.equal(await page.locator('#customerProfileMetrics .customer-metric-card').count(), 6);
    assert.equal(await page.locator('#customerProfileMetrics .customer-metric-card.is-wide').count(), 0);
    assert.equal(await page.locator('#customerDetailInfoGrid [data-copy-customer-address]').count(), 1);
    assert.match(await page.locator('#customerDetailPermanentNote').innerText(), /只用无品牌包装/);
    assert.match(await page.locator('#customerDetailNote').innerText(), /普通备注/);
    assert.deepEqual(await page.locator('#customerDetailInfoGrid .customer-rail-kv > :first-child').allInnerTexts(),
      ['默认币种', '收款方式', '产品类型', '付款邮箱', '客户等级', '负责人', '复购周期', '下次跟进']);

    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(dialogs, []);
    console.log('Customer profile empty-field UI test passed: no placeholders, empty rows and sections left out, one 「还没填」 line with 去填写, 复购提醒 card only with a cycle, full profiles unchanged.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
