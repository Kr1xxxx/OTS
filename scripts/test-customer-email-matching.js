// 客户邮箱兜底和按邮箱认人（页面数据全是合成的，网络全部拦截）：
// - 「gmail. com」「at / dot」「@ 两边空格」「全角＠．」「gmail。com」这些写法，本地识别能认出，AI 给对的邮箱也不会被当成编造丢掉；
// - 两位客户共用一个邮箱（或一位的邮箱是另一位的付款邮箱）：都列出来、不自动带出；原文写明的名字对不上时不算 100%；
// - 客户粘贴不把「Name: Tasha Green」换成匹配到的老客户名；
// - 拿邮箱当客户名不改大小写，粘贴同一个邮箱能认出这位客户；只有付款邮箱的客户列表里显示付款邮箱；
// - 付款邮箱同时是客户写明的主邮箱时，联系邮箱里保留它；
// - 「清除示例客户」不删用户改过 / 有订单（含垃圾箱）的同名档案，清除后可以撤销。
const assert = require('node:assert/strict');
const { launchBrowser, h, html } = require('./helpers/board-page');

const base = { currency:'USD', logisticsStatus:'未发货', createdAt:'2026-10-20', orderMonth:'2026-10', logs:[], productType:'假发', paymentChannel:'Paypal', owner:'未分配', country:'🇺🇸 美国 United States', updated:'2026-11-01 09:00', amount:1000, paidAmount:0, orderType:'全款订单', stage:'production', shipments:[], attachments:[] };
const data = {
  demoCleared:true,
  demoCustomersCleared:false,
  doneTasks:{},
  orders:[
    { ...base, id:'M1', num:'K9101', client:'Maria Lopez', country:'🇪🇸 西班牙 Spain', currency:'EUR' },
    { ...base, id:'E1', num:'K9102', client:'john.smith@gmail.com' }
  ],
  trashOrders:[{ ...base, id:'P1', num:'K9103', client:'Global Importers UK', trashedAt:'2026-11-02 10:00' }],
  deletedOrders:[],
  customers:{
    'Maria Lopez':{ client:'Maria Lopez', country:'🇪🇸 西班牙 Spain', emails:['maria@lopezhair.es'], email:'maria@lopezhair.es' },
    'Lopez Hair Studio':{ client:'Lopez Hair Studio', emails:['maria@lopezhair.es'], email:'maria@lopezhair.es' },
    'Alice Baker':{ client:'Alice Baker', emails:['alice@example.com'], email:'alice@example.com', paymentEmail:'alice.pay@example.com' },
    'Alice Twin':{ client:'Alice Twin', emails:['alice.pay@example.com'], email:'alice.pay@example.com' },
    'Pay Only Buyer':{ client:'Pay Only Buyer', paymentEmail:'payonly@example.com', paymentMethod:'Paypal' },
    // 和示例同名、但用户改成了自己的客户（加了电话和备注）。
    'Pacific North LLC':{ level:'C级白金客户', tags:['稳定客户'], paymentMethod:'T/T 银行转账', repurchaseCycle:60, note:'真实客户，西雅图仓', phones:['+1 206 555 0123'], phone:'+1 206 555 0123' }
  }
};

(async () => {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 } });
    await context.addInitScript(() => { try { localStorage.setItem('ots-greet-v1', new Date().toISOString().slice(0, 10)); } catch (_) {} });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    let stored = { app:'trade-order-system', revision:0, data };
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      if (pathname === '/api/data') return route.fulfill({ json:stored });
      if (pathname === '/api/save') {
        const body = route.request().postDataJSON();
        stored = { ...body.state, revision:stored.revision + 1 };
        return route.fulfill({ json:{ ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } } });
      }
      if (pathname === '/api/backup-before-change') return route.fulfill({ json:{ ok:true } });
      return route.fulfill({ json:{ ok:true } });
    });
    // 点之前等元素停稳，并确认那一点就是这个元素（没有被提示、弹窗挡住）。
    // 切页面后 setPage 还会在 80 / 240ms 时把页面滚回顶部：量完位置被滚走了就重新量（最多 5 次），不是挡住就不算失败。
    const click = async selector => {
      let hit = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const point = await h.center(page, selector);
        hit = await page.locator(selector).first().evaluate((el, p) => { const top = document.elementFromPoint(p.x, p.y); return top === el || el.contains(top) ? '' : (top?.outerHTML || 'nothing').slice(0, 160); }, point);
        if (!hit) return page.mouse.click(point.x, point.y);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.fail(`${selector} 被挡住了：${hit}`);
    };
    await page.goto('http://127.0.0.1:47981/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);

    // ---- 邮箱写法 ----
    const variants = await page.evaluate(() => [
      ['maria.lopez@gmail. com', 'maria.lopez@gmail.com'],
      ['maria.lopez@gmail .com', 'maria.lopez@gmail.com'],
      ['maria.lopez @ gmail.com', 'maria.lopez@gmail.com'],
      ['maria.lopez @gmail.com', 'maria.lopez@gmail.com'],
      ['maria_lopez AT gmail DOT com', 'maria_lopez@gmail.com'],
      ['maria.lopez at gmail dot com', 'maria.lopez@gmail.com'],
      ['maria.lopez at mail dot example dot co dot uk', 'maria.lopez@mail.example.co.uk'],
      ['maria.lopez＠gmail．com', 'maria.lopez@gmail.com'],
      ['maria.lopez＠gmail.com', 'maria.lopez@gmail.com'],
      ['maria.lopez@gmail。com', 'maria.lopez@gmail.com'],
      ['maria_lopez(at)gmail(dot)com', 'maria_lopez@gmail.com'],
      ['maria.lopez [at] gmail [dot] com', 'maria.lopez@gmail.com']
    ].map(([written, want]) => {
      const text = `Maria Lopez\nemail: ${written}`;
      const ai = normalizeAiCustomerFields({ name:'Maria Lopez', emails:[want] }, text);
      return { written, want, ai:ai.emails || null, local:(analyzeCustomerPasteText(text).extracted.email || '').toLowerCase() };
    }));
    variants.forEach(item => {
      assert.deepEqual(item.ai, [item.want], `AI 给对的邮箱不能当成编造丢掉：${item.written}`);
      assert.equal(item.local, item.want, `本地识别：${item.written}`);
    });
    const plain = await page.evaluate(() => ({
      sentence:findEmailsInText('I will be at home at 5, call me @ noon. Thanks'),
      afterEmail:findEmailsInText('send to maria@gmail.com. Thanks'),
      dotThanks:findEmailsInText('maria@gmail. Thanks for the quote'),
      invented:normalizeAiCustomerFields({ name:'Maria Lopez', emails:['made.up@example.org'] }, 'Maria Lopez\nemail: maria.lopez at gmail dot com').emails
    }));
    assert.deepEqual(plain.sentence, [], '普通句子里的 at / @ 不当成邮箱');
    assert.deepEqual(plain.afterEmail, ['maria@gmail.com']);
    assert.deepEqual(plain.dotThanks, [], '「gmail. Thanks」不拼成邮箱');
    assert.deepEqual(plain.invented, ['maria.lopez@gmail.com'], '编造的邮箱仍然不要，原文的还原写法找回来');

    // ---- 付款邮箱同时是客户写明的主邮箱 ----
    const mainPay = await page.evaluate(() => {
      const text = 'Maria Lopez\nEmail: maria@lopez.es (main)\nWork: m.lopez@salon-group.com\nPayPal: same as my main email maria@lopez.es';
      const ai = normalizeAiCustomerFields({ name:'Maria Lopez', emails:['maria@lopez.es', 'm.lopez@salon-group.com'], paymentEmail:'maria@lopez.es' }, text);
      const local = analyzeCustomerPasteText(text).extracted;
      const payOnly = normalizeAiCustomerFields({ paymentEmail:'pay@example.com' }, 'Alex Example\ncontact@example.com\nPaypal: pay@example.com');
      return { ai:[ai.email, ai.paymentEmail], local:[local.email, local.paymentEmail], payOnly:[payOnly.emails, payOnly.paymentEmail] };
    });
    assert.deepEqual(mainPay.ai, ['maria@lopez.es', 'maria@lopez.es'], 'AI：主邮箱留在联系邮箱第一位');
    assert.deepEqual(mainPay.local, ['maria@lopez.es', 'maria@lopez.es'], '本地识别同样');
    assert.deepEqual(mainPay.payOnly, [['contact@example.com'], 'pay@example.com'], '只在付款行出现的邮箱仍然不进联系邮箱');

    // ---- 按邮箱认人 ----
    const matching = await page.evaluate(() => {
      const list = text => matchClientsFromPaste(text).map(item => `${item.client.client}|${item.score}`);
      return {
        shared:list('my email: maria@lopezhair.es\n20 wigs total $1200'),
        sharedNamed:list("Hi it's Maria Lopez\nmy email: maria@lopezhair.es"),
        conflict:matchClientsFromPaste("Hi it's Tasha Green from Atlanta\nmy email: alice@example.com").map(item => `${item.client.client}|${item.score}|${item.reason}`),
        payCross:list('alice.pay@example.com wants 5 wigs'),
        crossDup:customerDuplicateCandidates().filter(item => /Twin/.test(item.primary.name + item.secondary.name)).map(item => item.reasons.join('/')),
        customerPaste:analyzeCustomerPasteText('Name: Tasha Green\nEmail: maria@lopezhair.es\nPhone: +1 404 555 0161').extracted.name,
        emailName:list('john.smith@gmail.com\n10 wigs, total $800'),
        capitalized:[autoCapitalizeCustomerName('john.smith@gmail.com'), clientDisplayName('john.smith@gmail.com'), autoCapitalizeCustomerName('maria lopez')]
      };
    });
    assert.deepEqual(matching.shared, ['Lopez Hair Studio|89', 'Maria Lopez|89'], '共用邮箱：两位都列出，都不自动带出');
    assert.deepEqual(matching.sharedNamed, ['Maria Lopez|100', 'Lopez Hair Studio|89'], '原文名字和其中一位完全一致就认这一位');
    assert.deepEqual(matching.conflict, ['Alice Baker|85|邮箱一致，但原文名字是 Tasha Green，需确认'], '名字对不上不算 100%');
    assert.deepEqual(matching.payCross, ['Alice Baker|89', 'Alice Twin|89']);
    assert.deepEqual(matching.crossDup, ['一方的邮箱是另一方的付款邮箱'], '重复提醒和粘贴匹配一个口径');
    assert.equal(matching.customerPaste, 'Tasha Green', '客户粘贴不换掉原文写明的名字');
    assert.deepEqual(matching.emailName, ['john.smith@gmail.com|100'], '拿邮箱当名字的客户，粘贴同一个邮箱能认出');
    assert.deepEqual(matching.capitalized, ['john.smith@gmail.com', 'john.smith@gmail.com', 'Maria Lopez']);

    // 订单粘贴：用真实键盘粘贴、点「识别」，共用邮箱的两位都出现，没有「给 X 新建订单」的自动卡片。
    await page.evaluate(() => setPage('dashboard'));
    await click('#newOrderBtn');
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    await click('#pasteAssistInput');
    await page.keyboard.insertText('my email: maria@lopezhair.es\n20 wigs total $1200, paypal');
    await click('#pasteAssistAnalyzeBtn');
    await page.waitForSelector('#pasteAssistResults [data-paste-use-client]');
    const cards = await page.evaluate(() => ({
      useClient:[...document.querySelectorAll('#pasteAssistResults [data-paste-use-client]')].map(btn => btn.dataset.pasteUseClient).sort(),
      autoCard:Boolean(document.querySelector('#pasteAssistResults [data-paste-use-existing-customer-order]')),
      text:document.getElementById('pasteAssistResults').innerText
    }));
    assert.deepEqual(cards.useClient, ['Lopez Hair Studio', 'Maria Lopez']);
    assert.equal(cards.autoCard, false, '不自动带出其中一位');
    assert.match(cards.text, /这个邮箱有 2 位客户在用/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open') || document.getElementById('confirmModal').classList.contains('open'));
    if (await page.evaluate(() => document.getElementById('confirmModal').classList.contains('open'))) {
      await click('#confirmOkBtn');
    }
    await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));

    // ---- 客户列表：邮箱当名字、只有付款邮箱 ----
    await page.evaluate(() => setPage('customers'));
    await page.waitForSelector('.customer-row[data-view-customer="Pay Only Buyer"]');
    const rows = await page.evaluate(() => Object.fromEntries(['john.smith@gmail.com', 'Pay Only Buyer'].map(name => [name, document.querySelector(`.customer-row[data-view-customer="${name}"]`).innerText.replace(/\s+/g, ' ')])));
    assert.match(rows['john.smith@gmail.com'], /john\.smith@gmail\.com 联系人未填写 · john\.smith@gmail\.com/);
    assert.doesNotMatch(rows['john.smith@gmail.com'], /Gmail/);
    assert.match(rows['Pay Only Buyer'], /payonly@example\.com（付款邮箱）/);

    // ---- 清除示例客户：改过的、垃圾箱里有自己订单的同名档案保留；可以撤销 ----
    const before = await page.evaluate(() => Object.keys(state.customers).filter(name => isDemoClientName(name)).length);
    assert.ok(before > 3, 'fixture has demo profiles');
    await page.evaluate(() => setPage('settings'));
    await click('#clearDemoCustomersBtn');
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    const first = await page.evaluate(() => document.getElementById('confirmMessage').textContent);
    assert.match(first, /以下 2 个和示例同名的档案你改过资料或下过单，会保留：/);
    assert.match(first, /Pacific North LLC/);
    assert.match(first, /Global Importers UK/);
    for (const step of ['第二步确认', '安全验证']) {
      await page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
      await click('#confirmOkBtn');
      await page.waitForFunction(step => document.getElementById('confirmSub').textContent === step, step);
    }
    await page.waitForFunction(() => document.activeElement?.id === 'confirmInput');
    await page.keyboard.type('13');
    await page.keyboard.press('Enter');
    await h.waitToast(page, '示例客户已清除');
    const after = await page.evaluate(() => ({ kept:['Pacific North LLC', 'Global Importers UK'].filter(name => Object.hasOwn(state.customers, name)), demo:Object.keys(state.customers).filter(name => isDemoClientName(name)).length, note:state.customers['Pacific North LLC']?.note }));
    assert.deepEqual(after.kept, ['Pacific North LLC', 'Global Importers UK']);
    assert.equal(after.demo, 2, '其余示例档案清除');
    assert.equal(after.note, '真实客户，西雅图仓');
    await h.clickUndo(page, '示例客户已清除');
    await h.waitToast(page, '已撤销：示例客户已恢复');
    assert.equal(await page.evaluate(() => Object.keys(state.customers).filter(name => isDemoClientName(name)).length), before, '撤销后示例档案回来');

    assert.deepEqual(dialogs, [], '没有原生弹窗');
    assert.deepEqual(errors, []);
    console.log('customer email matching test passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
