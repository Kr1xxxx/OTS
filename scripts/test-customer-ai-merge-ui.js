#!/usr/bin/env node
// 客户 AI 识别预览：填入老客户时的冲突确认、邮箱排除、国家编辑、补充到已有档案（V3.125 审查 14 的 P1-1 ~ P1-4）。
// 全程真实键盘鼠标；不用固定等待，等元素停稳（h.center / h.settle）、等条件成立。
const assert = require('node:assert/strict');
const { launchBrowser, h, html } = require('./helpers/board-page');

const fixture = {
  demoCleared:true, demoCustomersCleared:true, doneTasks:{},
  orders:[],
  customers:{
    'Bob Taylor':{ client:'Bob Taylor', country:'🇬🇧 英国 United Kingdom', currency:'GBP', contacts:['Bob'], contact:'Bob', phones:['+44 7700 900127', '+44 7700 900128'], phone:'+44 7700 900127', emails:['bob@example.co.uk', 'bob.accounts@example.co.uk'], email:'bob@example.co.uk', addresses:['1 High St, London E1 6AN'], address:'1 High St, London E1 6AN' },
    'Sunrise Beauty LLC':{ client:'Sunrise Beauty LLC', country:'🇺🇸 美国 United States', phones:['+1 305 555 0142'], phone:'+1 305 555 0142' }
  },
  orderSettings:{ ownEmails:['sales@our-shop.example'] }
};

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:960 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    let aiAnswer = {}, saves = 0;
    let stored = { app:'trade-order-system', revision:0, data:fixture };
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:stored });
      if (pathname === '/api/ai-settings') return route.fulfill({ json:{ enabled:'是', provider:'custom', baseUrl:'https://fixture.example/v1', model:'fixture', apiKeySaved:true } });
      if (pathname === '/api/ai-chat') return route.fulfill({ json:{ choices:[{ message:{ content:JSON.stringify(aiAnswer) } }] } }).catch(() => {});
      if (pathname === '/api/save') {
        saves += 1;
        stored = { ...route.request().postDataJSON().state, revision:stored.revision + 1 };
        return route.fulfill({ json:{ ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } } });
      }
      return route.fulfill({ json:{ ok:true } });
    });
    await page.goto('http://127.0.0.1:47982/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    const form = '#customerForm';
    const values = kind => page.locator(`${form} [data-customer-multi-kind="${kind}"] [data-customer-multi-input]`).evaluateAll(nodes => nodes.map(node => node.value));
    const click = async selector => {
      const p = await h.center(page, selector);
      const onTop = await page.locator(selector).first().evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), p);
      assert.equal(onTop, true, `${selector} is covered: ${await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.outerHTML.slice(0, 120), p)}`);
      await page.mouse.click(p.x, p.y);
    };
    const results = () => page.locator('#customerPasteResults').innerText();
    // 粘贴原文，点「AI 识别」，等识别完成。
    const recognize = async (text, answer, { rerunAfterEdits = false } = {}) => {
      aiAnswer = answer;
      await page.locator('#customerPasteInput').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(text);
      await click('#customerPasteAnalyzeBtn');
      if (rerunAfterEdits) {
        // 预览里有手动修改：先问会不会丢掉，默认焦点在「保留修改」。
        await page.locator('#confirmModal.open #confirmOkBtn').waitFor({ state:'visible' });
        assert.match(await page.locator('#confirmMessage').innerText(), /手动修改/);
        await page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
        await click('#confirmOkBtn');
      }
      await page.waitForFunction(() => !document.getElementById('customerPasteAnalyzeBtn').disabled && document.querySelector('[data-customer-paste-timing]'));
    };
    const openCustomer = async (name, viewOnly) => {
      await page.evaluate(({ name, viewOnly }) => openCustomerModal(name, { viewOnly }), { name, viewOnly });
      await page.locator('#customerModal.open').waitFor();
      await h.settle(page, '#customerModal .modal');
    };
    const confirmOpen = () => page.locator('#confirmModal.open #confirmOkBtn').waitFor({ state:'visible' });

    // ---- P1-1：编辑老客户时「填入」有冲突：列出改哪些字段，默认焦点在「只补空字段」，名字永远不改，旧电话 / 邮箱保留 ----
    await openCustomer('Bob Taylor', false);
    const bobText = 'Robert Taylor\n+44 7700 900999\nrob@newmail.co.uk\n5 New Rd, Leeds LS1 4AP, United Kingdom';
    const bobAnswer = { name:'Robert Taylor', phones:['+44 7700 900999'], emails:['rob@newmail.co.uk'], addresses:['5 New Rd, Leeds LS1 4AP, United Kingdom'], country:'United Kingdom' };
    await recognize(bobText, bobAnswer);
    assert.doesNotMatch(await results(), /匹配已有客户：Bob Taylor/, 'the customer being edited is not offered as a match to itself');
    await click('[data-customer-paste-fill]');
    await confirmOpen();
    const message = await page.locator('#confirmMessage').innerText();
    assert.match(message, /主电话：\+44 7700 900127 → \+44 7700 900999/);
    assert.match(message, /主邮箱：bob@example\.co\.uk → rob@newmail\.co\.uk/);
    assert.match(message, /客户名不会被改/);
    assert.equal(await page.locator('#confirmOkBtn').innerText(), '覆盖这些字段');
    await page.waitForFunction(() => document.activeElement?.id === 'confirmAltBtn');
    // 直接回车 = 安全选项「只补空字段」。
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator(`${form} [name="name"]`).inputValue(), 'Bob Taylor');
    assert.deepEqual(await values('phones'), ['+44 7700 900127', '+44 7700 900128', '+44 7700 900999'], 'keep-existing leaves the primary phone first and only appends the new one');
    assert.deepEqual(await values('addresses'), ['1 High St, London E1 6AN', '5 New Rd, Leeds LS1 4AP, United Kingdom']);
    // 再填一次选「覆盖」：新号码排第一，旧号码都还在；名字仍不改，名称框下给出提示。
    await click('[data-customer-paste-fill]');
    await confirmOpen();
    await click('#confirmOkBtn');
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator(`${form} [name="name"]`).inputValue(), 'Bob Taylor', 'overwrite never renames an existing customer');
    assert.deepEqual(await values('phones'), ['+44 7700 900999', '+44 7700 900127', '+44 7700 900128']);
    assert.deepEqual(await values('emails'), ['rob@newmail.co.uk', 'bob@example.co.uk', 'bob.accounts@example.co.uk']);
    assert.match(await page.locator(`${form} .customer-field-hint`).first().innerText(), /Robert Taylor/);
    assert.equal(saves, 0, 'filling never saves by itself');
    await page.evaluate(() => closeCustomerModal());

    // ---- P1-2：AI 漏掉邮箱时从原文找回，但不找回写错后更正的旧邮箱、收款用的我方邮箱 ----
    await openCustomer('', false);
    const mariaText = 'Maria Lopez\nmy email is maria.lopze@gmail.com\nsorry typo, correct one is maria.lopez@gmail.com\nI will send the payment to sales@our-shop.example\nPhone +34 612 345 678';
    await recognize(mariaText, { name:'Maria Lopez', phones:['+34 612 345 678'] });
    const mariaPreview = await results();
    assert.match(mariaPreview, /maria\.lopez@gmail\.com/);
    assert.doesNotMatch(mariaPreview, /maria\.lopze@gmail\.com/, 'a corrected typo is not recovered');
    assert.doesNotMatch(mariaPreview, /sales@our-shop\.example/, 'our own receiving email is never put into a customer');

    // ---- P1-3：预览里改国家：UK 是英国、US 是美国、列表外的按原文保留 ----
    const editCountry = async (typed, expected) => {
      await click('[data-customer-paste-edit="country"]');
      await page.locator('#customerPasteEditValue').waitFor();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(typed);
      await page.keyboard.press('Enter');
      await page.locator('#customerPasteEditValue').waitFor({ state:'detached' });
      assert.match(await page.locator('[data-customer-paste-edit="country"]').innerText(), expected, `${typed} → ${expected}`);
    };
    await recognize(mariaText, { name:'Maria Lopez', phones:['+34 612 345 678'], country:'Spain' });
    await editCountry('UK', /英国/);
    await editCountry('US', /美国/);
    await editCountry('Nigeria', /Nigeria/);
    assert.match(await results(), /不在国家列表里/);
    await recognize('Ade Bello\nLagos, Nigeria\n+234 803 555 0101', { name:'Ade Bello', country:'Nigeria', phones:['+234 803 555 0101'] }, { rerunAfterEdits:true });
    assert.match(await page.locator('[data-customer-paste-edit="country"]').innerText(), /Nigeria/, 'an AI country outside the list is kept, not dropped');
    await page.evaluate(() => closeCustomerModal());

    // ---- P1-4：识别出的是老客户（名称只差 LLC）：「补充到档案」打开老档案，只补空字段、电话追加在后面 ----
    await openCustomer('', false);
    await recognize('Sunrise Beauty\nMiami FL 33101\n+1 305 555 0199\norders@sunrise.example', { name:'Sunrise Beauty', phones:['+1 305 555 0199'], emails:['orders@sunrise.example'], addresses:['Miami FL 33101'] });
    assert.match(await results(), /Sunrise Beauty LLC/);
    await click('[data-customer-paste-merge]');
    await page.waitForFunction(() => document.querySelector('#customerForm [name="originalName"]').value === 'Sunrise Beauty LLC' && document.querySelectorAll('#customerForm [data-customer-multi-kind="phones"] [data-customer-multi-input]').length === 2);
    assert.equal(await page.locator(`${form} [name="name"]`).inputValue(), 'Sunrise Beauty LLC', 'merging keeps the existing name');
    assert.deepEqual(await values('phones'), ['+1 305 555 0142', '+1 305 555 0199']);
    assert.deepEqual(await values('emails'), ['orders@sunrise.example']);
    await click('#customerFooterSaveBtn');
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    const sunrise = await page.evaluate(() => JSON.parse(JSON.stringify(state.customers['Sunrise Beauty LLC'])));
    assert.deepEqual(sunrise.phones, ['+1 305 555 0142', '+1 305 555 0199']);
    assert.equal(await page.evaluate(() => Object.keys(state.customers).length), 2, 'no duplicate customer is created');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], 'no native alert / confirm / prompt');
    console.log('Customer AI merge UI passed: conflict confirm lists fields + safe default focus + name kept + old values kept, self not matched, typo / own email not recovered, UK / US / outside-list country editing, AI outside-list country kept, supplement into an existing LLC profile without duplicates.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
