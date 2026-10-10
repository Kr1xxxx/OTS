#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1360, height:900 } });
    const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
    let stored = {
      app:'trade-order-system',
      revision:0,
      data:{
        demoCleared:true,
        demoCustomersCleared:true,
        orders:[{
          id:'order-priority', num:'K99010101', client:'Priority Buyer', country:'英国 United Kingdom',
          amount:320, paidAmount:160, currency:'USD', createdAt:'2026-09-01', updated:'2026-09-20 10:00',
          productType:'睫毛', paymentChannel:'阿里巴巴', orderType:'定金订单', stage:'production', note:'本单备注保持独立', logs:[]
        }],
        customers:{
          'Legacy Buyer':{ client:'Legacy Buyer', country:'美国 United States', note:'旧档案' },
          'Priority Buyer':{
            client:'Priority Buyer', country:'英国 United Kingdom', primaryContactMethod:'WhatsApp',
            alternativeContactMethods:['邮件','iMessage'], permanentNote:'所有订单使用无品牌包装',
            email:'priority@example.com', emails:['priority@example.com'], note:'普通客户备注'
          }
        }
      }
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:stored });
      if (pathname === '/api/health') return route.fulfill({ json:{ ok:true, storageMode:'sqlite', counts:{ orders:1 }, backups:{ sqliteCount:1 } } });
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        stored = { ...body.state, revision:stored.revision + 1 };
        return route.fulfill({ json:{ ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } } });
      }
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    await page.evaluate(() => openCustomerModal(''));
    const customerPreferenceLayout = await page.evaluate(() => {
      const tradeGrid = document.querySelector('#customerForm .customer-trade-preference-grid');
      const contactPanel = document.querySelector('#customerForm .customer-contact-preference-panel');
      const tradeItems = [...tradeGrid.children].map(node => node.getBoundingClientRect());
      const contactItems = [...contactPanel.children].map(node => node.getBoundingClientRect());
      return {
        tradeCount:tradeItems.length,
        firstTradeRowAligned:tradeItems.slice(0, 3).every(rect => Math.abs(rect.top - tradeItems[0].top) < 1),
        secondTradeRowAligned:tradeItems.slice(3).every(rect => Math.abs(rect.top - tradeItems[3].top) < 1),
        tradeRowsSeparated:tradeItems[3].top > tradeItems[0].top,
        contactCount:contactItems.length,
        contactsAligned:contactItems.every(rect => Math.abs(rect.top - contactItems[0].top) < 1)
      };
    });
    assert.deepEqual(customerPreferenceLayout, {
      tradeCount:6,
      firstTradeRowAligned:true,
      secondTradeRowAligned:true,
      tradeRowsSeparated:true,
      contactCount:2,
      contactsAligned:true
    }, '客户编辑页的交易偏好应为两行三列，联系方式应并排对齐');
    if (process.env.UI_SCREENSHOT) {
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.locator('#customerForm .customer-preference-block').screenshot({ path:`${process.env.UI_SCREENSHOT}.${theme}.png`, animations:'disabled' });
      }
    }
    assert.equal(await page.locator('#customerForm [name="primaryContactMethod"]').inputValue(), 'WhatsApp', '新客户应默认 WhatsApp');
    assert.equal(await page.locator('#customerForm .customer-primary-contact-field .app-select-button').innerText(), 'WhatsApp');
    assert.equal(await page.locator('#customerForm [name="alternativeContactMethods"][value="WhatsApp"]').isDisabled(), true, '主联系方式不能同时作为备选');
    await page.evaluate(() => closeCustomerModal());

    await page.evaluate(() => openCustomerModal('Legacy Buyer', { viewOnly:false }));
    assert.equal(await page.locator('#customerForm [name="primaryContactMethod"]').inputValue(), '', '旧客户不能被自动写成 WhatsApp');
    await page.evaluate(() => closeCustomerModal());

    await page.evaluate(() => openCustomerModal('Priority Buyer'));
    assert.match(await page.locator('#customerDetailInfoGrid').innerText(), /WhatsApp · 备选：邮件、iMessage/);
    assert.match(await page.locator('#customerDetailInfoGrid').innerText(), /所有订单使用无品牌包装/);
    await page.locator('#customerDetailEditBtn').click();
    await page.locator('#customerForm .customer-primary-contact-field .app-select-button').click();
    // A scroll event queued before the click must not close a stationary menu.
    await page.evaluate(() => document.getElementById('customerForm').dispatchEvent(new Event('scroll')));
    assert.equal(await page.locator('.app-select-popover').isVisible(), true);
    await page.locator('.app-select-popover [data-app-select-value="邮件"]').click();
    assert.equal(await page.locator('#customerForm [name="primaryContactMethod"]').inputValue(), '邮件');
    assert.equal(await page.locator('#customerForm [name="alternativeContactMethods"][value="邮件"]').isDisabled(), true);
    await page.locator('#customerForm [name="alternativeContactMethods"][value="阿里巴巴"]').check({ force:true });
    await page.locator('#customerForm [name="permanentNote"]').fill('所有订单使用无品牌包装\n发货前再次确认地址');
    await page.locator('#customerHeaderSaveBtn').click();
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    assert.equal(stored.data.customers['Priority Buyer'].primaryContactMethod, '邮件');
    assert.deepEqual(stored.data.customers['Priority Buyer'].alternativeContactMethods, ['阿里巴巴','iMessage']);
    assert.match(stored.data.customers['Priority Buyer'].permanentNote, /发货前再次确认地址/);
    assert.equal(stored.data.orders[0].note, '本单备注保持独立', '永久备注不能改写订单备注');

    await page.evaluate(() => openOrderDetail('order-priority'));
    const detailText = await page.locator('#orderDetailBody').innerText();
    assert.match(detailText, /客户永久备注/);
    assert.match(detailText, /发货前再次确认地址/);
    assert.match(detailText, /邮件 · 备选：阿里巴巴、iMessage/);
    await page.evaluate(() => closeOrderDetail());

    await page.evaluate(() => openOrder('order-priority'));
    const summaryText = await page.locator('#orderClientAutofillSummary').innerText();
    assert.match(summaryText, /发货前再次确认地址/);
    assert.match(summaryText, /邮件 · 备选：阿里巴巴、iMessage/);
    await page.evaluate(() => closeOrder());

    await page.evaluate(() => openCombinedCustomerOrderModal({ customerFields:{ name:'New Combined Buyer' }, orderFields:{} }));
    const combinedPreferenceLayout = await page.evaluate(() => {
      const tradeItems = [...document.querySelectorAll('#combinedCustomerForm .customer-trade-preference-grid > .field')].map(node => node.getBoundingClientRect());
      const contactItems = [...document.querySelectorAll('#combinedCustomerForm .customer-contact-preference-panel > .field')].map(node => node.getBoundingClientRect());
      return {
        tradeCount:tradeItems.length,
        firstTradeRowAligned:tradeItems.slice(0, 2).every(rect => Math.abs(rect.top - tradeItems[0].top) < 1),
        contactsStacked:contactItems.length === 2 && contactItems[1].top > contactItems[0].top
      };
    });
    assert.deepEqual(combinedPreferenceLayout, {
      tradeCount:6,
      firstTradeRowAligned:true,
      contactsStacked:true
    }, '客户订单组合页应使用两列交易偏好，并纵向排列联系方式');
    const combinedPrimary = page.locator('#combinedCustomerForm .customer-primary-contact-field .app-select-button');
    assert.equal(await combinedPrimary.innerText(), 'WhatsApp');
    // Finish Playwright's scroll before opening a menu that intentionally closes on scroll.
    await combinedPrimary.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await combinedPrimary.click();
    await page.locator('.app-select-popover [data-app-select-value="邮件"]').click();
    assert.equal(await page.locator('#combinedCustomerForm [name="primaryContactMethod"]').inputValue(), '邮件');
    assert.equal(await page.locator('#combinedCustomerForm [name="alternativeContactMethods"][value="邮件"]').isDisabled(), true);
    await combinedPrimary.click();
    await page.evaluate(() => {
      const form = document.getElementById('combinedCustomerForm');
      form.closest('.modal-body').scrollTop = 0;
    });
    await page.waitForFunction(() => document.querySelector('.app-select-popover').hidden);
    await page.evaluate(() => closeCombinedCustomerOrderModal());

    await page.setViewportSize({ width:720, height:800 });
    await page.evaluate(() => openCustomerModal(''));
    const narrowLayout = await page.evaluate(() => {
      const modal = document.querySelector('#customerModal .customer-modal-shell').getBoundingClientRect();
      const checks = document.querySelector('#customerForm .contact-method-checks').getBoundingClientRect();
      const tradeItems = [...document.querySelectorAll('#customerForm .customer-trade-preference-grid > .field')].map(node => node.getBoundingClientRect());
      const contactItems = [...document.querySelectorAll('#customerForm .customer-contact-preference-panel > .field')].map(node => node.getBoundingClientRect());
      return {
        modalLeft:modal.left,
        modalRight:modal.right,
        viewport:window.innerWidth,
        checksRight:checks.right,
        tradeItemsStacked:tradeItems.every((rect, index) => index === 0 || rect.top > tradeItems[index - 1].top),
        contactItemsStacked:contactItems.length === 2 && contactItems[1].top > contactItems[0].top
      };
    });
    assert.ok(narrowLayout.modalLeft >= 0 && narrowLayout.modalRight <= narrowLayout.viewport + 1, '窄屏客户弹窗不能超出视口');
    assert.ok(narrowLayout.checksRight <= narrowLayout.modalRight + 1, '窄屏联系方式选项不能溢出弹窗');
    assert.equal(narrowLayout.tradeItemsStacked, true, '窄屏交易偏好应改为单列');
    assert.equal(narrowLayout.contactItemsStacked, true, '窄屏联系方式应改为单列');
    if (process.env.UI_SCREENSHOT) await page.locator('#customerForm .customer-preference-block').screenshot({ path:`${process.env.UI_SCREENSHOT}.narrow.png` });
    await page.evaluate(() => closeCustomerModal());

    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Customer contact preferences UI passed: defaults, legacy behavior, editing, persistence, live order display, and note isolation verified.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
