#!/usr/bin/env node
// 订单弹窗客户选择器（V3.118）：↗ 档案叠在订单上打开、不丢表单；选客户后摘要和永久备注出现；换客户不沿用旧国家 / 币种 / 收款；
// 两字母前缀和 holland 先按名字；联系人 / 邮箱 / 电话能搜到；不按方向键直接 Enter；大小写重复和「未命名草稿」不进列表；
// 已选客户再打开列出全部；字母筛选收起即复位；超长名字和 ↗ 有悬停说明；深色模式等级胶囊看得清；一次选择只带入一次。
// 用 Mac App（WKWebView）的焦点行为模拟：点按钮不会把焦点交给按钮。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
const US = '🇺🇸 美国 United States', UK = '🇬🇧 英国 United Kingdom', CA = '🇨🇦 加拿大 Canada', NL = '🇳🇱 荷兰 Netherlands', FR = '🇫🇷 法国 France';
const longName = 'Bella Hair Studio Professional Extensions and Lashes International Trading Company Limited';
const customers = {
  'Alice Baker':{ country:US, currency:'USD', paymentMethod:'Zelle', level:'A级钻石客户' },
  'Bob Taylor':{ country:UK, currency:'GBP', paymentMethod:'Paypal' },
  'Carol Smith':{ country:UK, currency:'GBP', paymentMethod:'Paypal', level:'C级白金客户', address:'1 High Street, London', permanentNote:'永远用 DHL，发货前先发视频' },
  'Lisa Holland':{ country:US, currency:'USD', paymentMethod:'Zelle' },
  'Nora Jansen':{ country:NL, currency:'EUR', paymentMethod:'TT' },
  'Hannah Moore':{ country:CA, currency:'CAD', paymentMethod:'Paypal' },
  'Acme Beauty LLC':{ country:US, currency:'USD', paymentMethod:'TT', contact:'John Doe', email:'john@acme.example', phone:'+1 415 555 0101' },
  'Mia Chen':{ country:CA, currency:'CAD', paymentMethod:'Paypal', contact:'Chen Mei' },
  'Émilie Durand':{ country:FR, currency:'EUR', paymentMethod:'Paypal' },
  [longName]:{ country:US, currency:'USD', paymentMethod:'TT' }
};
const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
const order = (id, client, extra = {}) => ({ id, num:`K${id}`, client, country:US, currency:'USD', amount:100, paidAmount:0, orderType:'定金订单', stage:'quote', productType:'睫毛', paymentChannel:'Paypal', createdAt:`${month}-01`, orderMonth:month, updated:`${month}-01 09:00`, logs:[], logisticsStatus:'未发货', ...extra });
const orders = [
  order('1', 'Alice Baker', { paymentChannel:'Zelle' }),
  order('2', 'Carol Smith', { country:UK, currency:'GBP' }),
  // 旧数据：档案叫 Alice Baker，旧订单写成 alice baker；存草稿时客户留空生成的「未命名草稿」。
  order('3', 'alice baker', { paymentChannel:'Zelle' }),
  order('4', '未命名草稿', { isDraft:true })
];

function contrast(fg, bg) {
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:920 } });
    const errors = [];
    const dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    let stored = { app:'trade-order-system', revision:0, data:{ orders, customers, demoCleared:true, demoCustomersCleared:true } };
    await page.route('**/*', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/trade-order-system.html') return route.fulfill({ contentType:'text/html', body:html });
      let response = { ok:true };
      if (pathname === '/api/data') response = stored;
      if (pathname === '/api/health') response = { ok:true, storageMode:'sqlite', counts:{ orders:orders.length }, backups:{ sqliteCount:0 } };
      if (pathname === '/api/save') {
        stored = { ...request.postDataJSON().state, revision:stored.revision + 1 };
        response = { ok:true, revision:stored.revision, backup:{ ok:true, skipped:true } };
      }
      return route.fulfill({ json:response });
    });
    await page.addInitScript(() => {
      window.addEventListener('mousedown', e => {
        if (e.defaultPrevented || !e.target.closest?.('button')) return;
        e.preventDefault();
        document.activeElement?.blur?.();
      });
    });
    await page.goto('http://127.0.0.1:47999/trade-order-system.html');
    await page.waitForFunction(() => window.pendingSaveStatus?.().loaded);
    await page.evaluate(() => {
      window.__calls = { select:0, fill:0, render:0 };
      for (const [name, key] of [['selectClientFromMenu', 'select'], ['fillClientFromHistory', 'fill'], ['renderClientMenu', 'render']]) {
        const original = window[name];
        window[name] = function (...args) { window.__calls[key] += 1; return original.apply(this, args); };
      }
    });
    const input = page.locator('#orderForm .client-picker input[name="client"]');
    const menu = page.locator('#orderForm .client-menu');
    const rows = () => menu.locator('[data-select-client]').evaluateAll(nodes => nodes.map(n => n.dataset.selectClient));
    const field = name => page.locator(`#orderForm [name="${name}"]`).inputValue();
    const pick = async (query, name) => {
      await input.fill(query);
      await menu.locator(`[data-select-client="${name}"]`).click();
    };
    await page.locator('#newOrderBtn').click();
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));

    // 选择器列表：大小写重复的旧写法并进有档案的那一行；「未命名草稿」不是客户；É 归到 E。
    await input.click();
    const all = await rows();
    assert.equal(all.filter(name => name.toLowerCase() === 'alice baker').length, 1, `duplicate Alice rows: ${all}`);
    assert.ok(all.includes('Alice Baker'));
    assert.ok(!all.includes('未命名草稿'));
    assert.ok(await menu.locator('button[data-client-letter="E"]').count(), 'Émilie is listed under E');
    // 超长名字有悬停全文；↗ 有说明。
    const longStrong = menu.locator(`[data-select-client="${longName}"] strong`);
    assert.equal(await longStrong.getAttribute('title'), await longStrong.textContent(), 'the full (display) name is in the tooltip');
    assert.ok((await longStrong.getAttribute('title')).length > 80);
    assert.match(await menu.locator('[data-open-client="Alice Baker"]').getAttribute('title'), /打开客户档案/);

    // 搜索：两字母前缀、holland 先按名字；联系人 / 邮箱 / 电话能搜到并注明命中哪一项。
    const search = async query => { await input.fill(query); return rows(); };
    assert.equal((await search('Al'))[0], 'Alice Baker', 'Al (Albania) still finds Alice');
    const ca = await search('Ca');
    assert.equal(ca[0], 'Carol Smith', 'Ca (Canada) lists Carol first');
    assert.ok(ca.includes('Hannah Moore') && ca.includes('Mia Chen'), 'Ca still lists Canadian customers');
    assert.deepEqual(await search('holland'), ['Lisa Holland', 'Nora Jansen']);
    assert.deepEqual(await search('john'), ['Acme Beauty LLC']);
    assert.match(await menu.locator('[data-select-client="Acme Beauty LLC"] small').innerText(), /联系人 John Doe/);
    assert.deepEqual(await search('john@acme'), ['Acme Beauty LLC']);
    assert.deepEqual(await search('555 0101'), ['Acme Beauty LLC']);
    assert.deepEqual(await search('chen mei'), ['Mia Chen']);
    assert.deepEqual(await search('US'), ['Acme Beauty LLC', 'Alice Baker', longName, 'Lisa Holland'], 'country code search still works');
    // 没有匹配：文案说清楚会按新客户记录；Enter 收起菜单、保留输入。
    await input.fill('New Buyer Inc');
    assert.match(await menu.innerText(), /没有找到“New Buyer Inc”/);
    await input.press('Enter');
    assert.equal(await menu.evaluate(el => el.classList.contains('open')), false);
    assert.equal(await input.inputValue(), 'New Buyer Inc');

    // 不按方向键直接 Enter：只剩一位就选中，带出客户摘要和永久备注（以前 form.id 被 name="id" 遮住，从不显示）。
    await input.fill('Carol');
    await input.press('Enter');
    assert.equal(await input.inputValue(), 'Carol Smith');
    const summary = page.locator('#orderClientAutofillSummary');
    assert.equal(await summary.isVisible(), true, 'customer summary must show after picking a customer');
    assert.match(await summary.innerText(), /永远用 DHL，发货前先发视频/);
    assert.match(await summary.innerText(), /1 High Street, London/);
    assert.deepEqual([await field('country'), await field('currency'), await field('paymentChannel')], [UK, 'GBP', 'Paypal']);

    // 换客户：上一个客户带入的国家 / 币种 / 收款方式跟着换，定金币种标签和头部标签同步。
    await page.evaluate(() => { window.__calls.select = 0; window.__calls.fill = 0; });
    await pick('Alice', 'Alice Baker');
    assert.deepEqual(await page.evaluate(() => [window.__calls.select, window.__calls.fill]), [1, 1], 'one click selects once and fills once');
    assert.deepEqual([await field('country'), await field('currency'), await field('paymentChannel')], [US, 'USD', 'Zelle']);
    await pick('Bob', 'Bob Taylor');
    assert.deepEqual([await field('country'), await field('currency'), await field('paymentChannel')], [UK, 'GBP', 'Paypal'], 'Zelle from Alice must not stick');
    assert.equal(await page.locator('#orderForm [data-deposit-currency]').innerText(), 'GBP');
    assert.equal(await page.locator('#orderForm [name="paymentChannel"] + .binary-segment .binary-option.active').innerText(), 'Paypal', 'the chip that looks selected is the one that was filled in');
    assert.match(await page.locator('#modalSummary').innerText(), /Bob Taylor/, 'the preview rail follows the picked customer');
    // 用户自己改过的值不动。
    await page.locator('#orderForm [name="country"]').fill(FR);
    await pick('Lisa', 'Lisa Holland');
    assert.equal(await field('country'), FR, 'a country the user typed must be kept');
    assert.equal(await field('currency'), 'USD');

    // 已选客户再点输入框：列出全部客户并高亮当前这位，不用先清空；字母筛选收起后复位。
    assert.equal(await menu.evaluate(el => el.classList.contains('open')), false);
    await input.click();
    assert.ok((await rows()).length > 5, 'focusing a picked customer lists everyone');
    assert.equal(await menu.locator('.client-option.active').getAttribute('data-client'), 'Lisa Holland');
    await menu.locator('button[data-client-letter="B"]').click();
    assert.ok((await rows()).every(name => name.startsWith('B')));
    await input.press('Escape');
    await page.locator('#orderForm .client-trigger').click();
    assert.ok((await rows()).length > 5, 'letter filter resets after the menu closes');
    await input.press('Escape');

    // 输入法组字中途不重画列表，上屏后再画。
    await input.fill('');
    await page.evaluate(() => { window.__calls.render = 0; });
    await input.evaluate(el => { el.value = 'wang xiao'; el.dispatchEvent(new InputEvent('input', { bubbles:true, isComposing:true })); });
    assert.equal(await page.evaluate(() => window.__calls.render), 0, 'composition must not re-render the menu');
    await input.evaluate(el => { el.value = '王小'; el.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true, data:'王小' })); });
    assert.equal(await page.evaluate(() => window.__calls.render), 1);
    await input.press('Escape');

    // ↗：档案叠在订单上打开，订单弹窗和填了一半的内容都在；关掉档案回到订单。
    await pick('Carol', 'Carol Smith');
    await page.locator('#orderForm [name="amount"]').fill('1234');
    await input.fill('Alice');
    await menu.locator('[data-open-client="Alice Baker"]').click();
    await page.waitForFunction(() => document.getElementById('customerModal').classList.contains('open'));
    assert.equal(await page.locator('#orderModal').evaluate(el => el.classList.contains('open')), true, '↗ must not close the order');
    assert.equal(await page.locator('#customerModalTitle').innerText(), 'Alice Baker');
    assert.equal(await page.locator('#confirmModal').evaluate(el => el.classList.contains('open')), false);
    // 档案里「＋ 新建订单」会清空下面这张订单：先问。选「继续编辑」就什么都不动。
    await page.locator('#customerNewOrderBtn').click();
    await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#confirmTitle').innerText(), '放弃未保存的修改？');
    await page.locator('#confirmCancelBtn').click();
    await page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
    assert.equal(await page.locator('#customerModal').evaluate(el => el.classList.contains('open')), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('customerModal').classList.contains('open'));
    assert.equal(await page.locator('#orderModal').evaluate(el => el.classList.contains('open')), true, 'Esc closes only the profile on top');
    assert.equal(await field('amount'), '1234', 'order form keeps what was typed');
    assert.equal(await input.inputValue(), 'Alice');
    assert.equal(await menu.evaluate(el => el.classList.contains('open')), false, 'returning focus must not pop the menu open again');

    // 深色模式：等级胶囊和等级客户名对比度够（以前 C 级只有 1.5:1）；浅色模式等级名 ≥ 4.5:1。
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await input.fill('');
      const pairs = await page.evaluate(() => {
        // Theme tokens are oklch / color-mix: let a canvas convert any CSS color to sRGB.
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently:true });
        const parse = value => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r, g, b, a / 255];
        };
        const blend = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3]));
        const menuBg = parse(getComputedStyle(document.querySelector('#orderForm .client-menu')).backgroundColor);
        return [...document.querySelectorAll('#orderForm .client-menu .client-option')].flatMap(option => {
          const pill = option.querySelector('.client-level[class*="client-level-"]');
          const name = option.querySelector('strong[class*="client-name-level-"]');
          const out = [];
          if (pill) {
            const bg = blend(parse(getComputedStyle(pill).backgroundColor), menuBg);
            out.push({ what:`${pill.className} pill`, fg:parse(getComputedStyle(pill).color).slice(0, 3), bg });
          }
          if (name) out.push({ what:`${name.className} name`, fg:parse(getComputedStyle(name).color).slice(0, 3), bg:menuBg.slice(0, 3) });
          return out;
        });
      });
      assert.ok(pairs.length >= 3, `level styles found in ${theme}`);
      for (const pair of pairs) {
        const ratio = contrast(pair.fg, pair.bg);
        if (process.env.DEBUG_CONTRAST) console.log(theme, pair.what, JSON.stringify(pair), ratio.toFixed(2));
        assert.ok(ratio >= 4.5, `${theme} ${pair.what} contrast ${ratio.toFixed(2)}:1`);
      }
    }

    assert.deepEqual(dialogs, [], 'native dialogs are not allowed');
    assert.deepEqual(errors, []);
    console.log('Client picker fixes UI passed: stacked profile keeps the order, summary + permanent note, re-autofill on switch, name-first short queries, contact search, Enter, dedupe, reopen, letter reset, IME, titles, contrast.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
