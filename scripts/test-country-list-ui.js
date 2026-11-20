#!/usr/bin/env node
// 国家 / 地区：
// 1. 列表是完整的（联合国 193 个会员国 + 常见地区）：「津巴布韦」不再提示「不在国家列表里」，以前按原文存的旧订单读进来就归到列表写法；
// 2. 按名字找国家：整个对上优先（Niger 不变成 Nigeria），整段文字里被更长的国名盖住的不算（印度尼西亚不算印度），
//    产品名里的产地（越南发）、人名（Jordan）、我们自己这边的 China 不当成客户的国家；
// 3. 下拉一打开只列常用的（订单里用得多的在前，不够的用默认国家和主要市场补），底下一行灰字说其余的打字查；
// 4. 框里是选好的国家时它是一个整体：点进去整段选中，打字、删除、输入法都是换一个，不会把字插进国家名中间；
// 5. 客户档案里以前手填的国家（津巴布韦、UAE）读进来也归到列表写法、带国旗，订单弹窗里手打的英文名保存时也一样；
//    CA、GA 这类和美国州 / 加拿大省缩写撞车的国家代码、Georgia（州还是格鲁吉亚）猜不准，照原文留着。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base, day } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');
const { inputMethod } = require('./helpers/input-method');

const US = '🇺🇸 美国 United States';
const NG = '🇳🇬 尼日利亚 Nigeria';
const GB = '🇬🇧 英国 United Kingdom';
const ZW = '🇿🇼 津巴布韦 Zimbabwe';
const order = (id, client, country) => ({ ...base, id, num:`CL-${id}`, client, country, stage:'quote', amount:100, createdAt:day(2), updated:`${day(2)} 10:00` });
const orders = [
  order('n1', 'Lagos Hair', NG), order('n2', 'Lagos Hair', NG), order('n3', 'Abuja Lashes', NG),
  order('g1', 'London Lashes', GB), order('g2', 'London Lashes', GB),
  // 以前列表里没有津巴布韦，只能按原文存下来的旧订单。
  order('z1', 'Harare Beauty', '津巴布韦')
];

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors, dialogs } = await openBoard(browser, { orders }, { port:freePortSync() });

    // ---- 1. 列表完整，旧数据归入 ----
    const list = await page.evaluate(() => ({
      size:countryDefs.length,
      zhUnique:new Set(countryDefs.map(def => def.split(' ')[1])).size === countryDefs.length,
      zhNoSpace:countryDefs.every(def => /^\S+ \S+ \S/u.test(def)),
      flagUnique:new Set(countryDefs.filter(def => !def.startsWith('🌐') && !def.includes('中国台湾')).map(def => def.split(' ')[0])).size,
      others:countryDefs.filter(def => def.startsWith('🌐')),
      zw:canonicalCountry('津巴布韦'),
      zwEn:canonicalCountry('zimbabwe'),
      zwStored:storedCountry('Zimbabwe'),
      oldOrder:state.orders.find(o => o.id === 'z1').country
    }));
    assert.ok(list.size >= 223, `193 UN members + Vatican, Palestine, Kosovo + regions (${list.size})`);
    assert.ok(list.zhUnique && list.zhNoSpace, 'every entry is "flag zh en" with a one-word Chinese name, no two share it');
    assert.equal(list.flagUnique, list.size - 2, 'every flag belongs to one entry');
    assert.deepEqual(list.others, ['🌐 其他 Other'], '「其他」 stays the only entry without a flag');
    assert.deepEqual([list.zw, list.zwEn, list.zwStored, list.oldOrder], [ZW, ZW, ZW, ZW], 'Zimbabwe is in the list; an old order saved as 津巴布韦 is read as the list entry');
    // 以前只能按原文存的别名（UAE、KSA）读进来也归到列表写法，按国家筛选、统计不分成两个；只写 Congo 不替人猜是哪个刚果。
    const stored = await page.evaluate(() => ['UAE', 'KSA', 'England', 'Congo', 'Atlantis'].map(storedCountry));
    assert.deepEqual(stored, ['🇦🇪 阿联酋 United Arab Emirates', '🇸🇦 沙特阿拉伯 Saudi Arabia', GB, 'Congo', 'Atlantis'],
      'an old order saved under a common other name joins the list entry; an ambiguous or unknown name stays as written');

    const names = await page.evaluate(() => Object.fromEntries([
      'UAE', 'Ivory Coast', "Cote d'Ivoire", 'Korea', '香港', '刚果(金)', 'Swaziland', 'Burma', 'turkiye', 'Deutschland', 'US'
    ].map(text => [text, customerCountryFromInput(text)])));
    assert.deepEqual(names, {
      UAE:'🇦🇪 阿联酋 United Arab Emirates',
      'Ivory Coast':"🇨🇮 科特迪瓦 Côte d'Ivoire",
      "Cote d'Ivoire":"🇨🇮 科特迪瓦 Côte d'Ivoire",
      Korea:'🇰🇷 韩国 South Korea',
      '香港':'🇭🇰 中国香港 Hong Kong',
      '刚果(金)':'🇨🇩 刚果（金） DR Congo',
      Swaziland:'🇸🇿 斯威士兰 Eswatini',
      Burma:'🇲🇲 缅甸 Myanmar',
      turkiye:'🇹🇷 土耳其 Turkey',
      Deutschland:'🇩🇪 德国 Germany',
      US
    }, 'common other names of a country');

    // ---- 2. 按名字找国家 ----
    const normalized = await page.evaluate(() => ['Niger', 'Dominica', 'Sudan', 'Guinea', 'US', 'Samoa', 'Zimbabwe'].map(normalizeCountry));
    assert.deepEqual(normalized, ['🇳🇪 尼日尔 Niger', '🇩🇲 多米尼克 Dominica', '🇸🇩 苏丹 Sudan', '🇬🇳 几内亚 Guinea', US, '🇼🇸 萨摩亚 Samoa', ZW],
      'a whole-name match wins over a longer name that contains it (Niger is not Nigeria, US is not Austria)');
    const found = await page.evaluate(() => Object.fromEntries([
      'Harare, Zimbabwe', 'Lagos, Nigeria', 'Niamey, Niger', 'Jakarta, Indonesia', '印度尼西亚 雅加达', 'Port Moresby, Papua New Guinea',
      'Juba, South Sudan', '索马里 摩加迪沙', 'Accra Ghana 00233',
      '越南发 20寸 3 bundles', '韩国丝 睫毛 0.07', 'Jordan Smith', 'Made in China, ship from Qingdao', '马里兰州 巴尔的摩',
      '1200 Peachtree St, Atlanta, Georgia 30309, United States'
    ].map(text => [text, findCountryInText(text)])));
    assert.deepEqual(found, {
      'Harare, Zimbabwe':ZW,
      'Lagos, Nigeria':NG,
      'Niamey, Niger':'🇳🇪 尼日尔 Niger',
      'Jakarta, Indonesia':'🇮🇩 印度尼西亚 Indonesia',
      '印度尼西亚 雅加达':'🇮🇩 印度尼西亚 Indonesia',
      'Port Moresby, Papua New Guinea':'🇵🇬 巴布亚新几内亚 Papua New Guinea',
      'Juba, South Sudan':'🇸🇸 南苏丹 South Sudan',
      '索马里 摩加迪沙':'🇸🇴 索马里 Somalia',
      'Accra Ghana 00233':'🇬🇭 加纳 Ghana',
      '越南发 20寸 3 bundles':'',
      '韩国丝 睫毛 0.07':'',
      'Jordan Smith':'',
      'Made in China, ship from Qingdao':'',
      '马里兰州 巴尔的摩':'',
      '1200 Peachtree St, Atlanta, Georgia 30309, United States':US
    }, 'country names inside free text');

    // ---- 3. 下拉一打开只列常用的 ----
    await page.evaluate(() => openOrder());
    await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
    const country = page.locator('#orderForm [name="country"]');
    await country.waitFor({ state:'visible' });
    const menu = () => page.evaluate(() => {
      const el = document.getElementById('suggestMenu');
      return { open:Boolean(el && !el.hidden), items:el ? [...el.querySelectorAll('.app-select-option')].map(o => o.textContent.trim()) : [],
        active:el?.querySelector('.app-select-option.active')?.textContent.trim() || '', note:el?.querySelector('.app-select-group')?.textContent.trim() || '' };
    });
    await country.fill('');
    await page.keyboard.press('Escape');
    await country.evaluate(el => { el.value = '🇺🇸 美国 United States'; el.dispatchEvent(new Event('input', { bubbles:true })); el.blur(); });
    await country.click();
    let shown = await menu();
    assert.deepEqual(shown.items, [NG, GB, ZW, US, '🇨🇦 加拿大 Canada', '🇩🇪 德国 Germany', '🇫🇷 法国 France', '🇮🇹 意大利 Italy'],
      'opening the menu lists the countries used most, then the default country and main markets, eight in all');
    assert.equal(shown.active, US, 'the current country is highlighted');
    assert.equal(shown.note, '其他国家 / 地区：输入中文或英文名查找', 'a grey line says how to find the rest');

    // ---- 4. 选好的国家是一个整体 ----
    const selection = () => country.evaluate(el => [el.selectionStart, el.selectionEnd, el.value.length]);
    const box = await country.boundingBox();
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2);
    let [start, end, length] = await selection();
    assert.deepEqual([start, end], [0, length], 'clicking inside a chosen country selects all of it');
    await page.keyboard.type('zimb', { delay:5 });
    assert.equal(await country.inputValue(), 'zimb', 'typing replaces the chosen country');
    shown = await menu();
    assert.deepEqual([shown.items[0], shown.active, shown.note], [ZW, ZW, ''], 'the typed text searches the whole list');
    await page.keyboard.press('Enter');
    assert.equal(await country.inputValue(), ZW);

    // 光标停在中间（键盘挪过去），按一个字母：还是整个换掉。
    await country.evaluate(el => el.setSelectionRange(4, 4));
    await page.keyboard.press('g');
    assert.equal(await country.inputValue(), 'g', 'a key typed with the caret inside a chosen country replaces it');
    await page.keyboard.press('Escape');
    await country.evaluate(el => { el.value = '🇬🇧 英国 United Kingdom'; el.setSelectionRange(el.value.length, el.value.length); });
    await page.keyboard.press('Backspace');
    assert.equal(await country.inputValue(), '', 'Backspace clears a chosen country instead of eating its last letter');

    // 中文输入法：光标在国家名中间开始组字，上屏后只留新打的字，按它查。
    await country.evaluate(el => { el.value = '🇺🇸 美国 United States'; el.focus(); el.setSelectionRange(5, 5); });
    const ime = await inputMethod(page);
    await ime.compose('sha');
    await ime.compose('sha\'te');
    await ime.commit('沙特');
    assert.equal(await country.inputValue(), '沙特', 'composed text does not land inside the chosen country');
    shown = await menu();
    assert.deepEqual([shown.open, shown.active], [true, '🇸🇦 沙特阿拉伯 Saudi Arabia'], 'the committed text searches the list');

    // 列表外的写法照常能挪光标改。
    await page.keyboard.press('Escape');
    await country.evaluate(el => { el.value = 'Atlantis'; el.focus(); el.setSelectionRange(3, 3); });
    await page.keyboard.type('x');
    assert.equal(await country.inputValue(), 'Atlxantis', 'free text outside the list is edited normally');

    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);

    // ---- 5. 客户档案里手填的旧国家也归到列表写法 ----
    // 以前列表里没有津巴布韦、阿联酋，客户档案只能手填；订单读进来会归到列表写法，档案以前不会，客户列表里就没有国旗。
    const legacy = await openBoard(browser, {
      orders:[order('h1', 'Harare Beauty', '津巴布韦')],
      customers:{
        'Harare Beauty':{ client:'Harare Beauty', country:'津巴布韦' },
        'Dubai Lashes':{ client:'Dubai Lashes', country:' UAE ' },
        'Atlantis Wigs':{ client:'Atlantis Wigs', country:'Atlantis' },
        'Golden State Hair':{ client:'Golden State Hair', country:'CA' },
        'Peach Lashes':{ client:'Peach Lashes', country:'Georgia' },
        'Keystone Wigs':{ client:'Keystone Wigs', country:'p.a.' },
        'Blank Co':{ client:'Blank Co', country:'' }
      }
    }, { port:freePortSync() });
    const profiles = await legacy.page.evaluate(() => Object.fromEntries(Object.entries(state.customers).map(([name, profile]) => [name, profile.country])));
    assert.deepEqual(profiles, {
      'Harare Beauty':ZW, 'Dubai Lashes':'🇦🇪 阿联酋 United Arab Emirates', 'Atlantis Wigs':'Atlantis', 'Blank Co':'',
      'Golden State Hair':'CA', 'Peach Lashes':'Georgia', 'Keystone Wigs':'p.a.'
    }, 'a hand-typed country in a customer profile is read as the list entry; one outside the list stays as written, a blank one stays blank; CA / Georgia (a US state or a country) stay as written');
    await legacy.page.evaluate(() => setPage('customers'));
    const row = legacy.page.locator('.customer-row[data-view-customer="Harare Beauty"] .customer-cell-stack').first();
    assert.equal((await row.locator('strong').innerText()).trim(), '🇿🇼 津巴布韦', 'the customer list shows the flag');

    // 客户表单里手打 CA、离开国家框：不替人换成加拿大，提示可能是州；打 Canada 照旧换成列表写法。
    const typed = await legacy.page.evaluate(() => {
      const input = document.querySelector('#customerForm [name="country"]');
      const check = text => { input.value = text; checkCustomerCountryInput(input); return [input.value, input.closest('.field')?.querySelector('.customer-field-hint')?.textContent || '']; };
      return { ca:check('CA'), georgia:check('georgia'), canada:check('Canada'), list:storedCountry('🇬🇪 格鲁吉亚 Georgia') };
    });
    assert.equal(typed.ca[0], 'CA', 'typed CA is not turned into Canada');
    assert.match(typed.ca[1], /州|省/, 'the hint says CA may be a state or province');
    assert.equal(typed.georgia[0], 'georgia', 'typed Georgia is not turned into the country Georgia');
    assert.equal(typed.canada[0], '🇨🇦 加拿大 Canada', 'typed Canada still becomes the list entry');
    assert.equal(typed.list, '🇬🇪 格鲁吉亚 Georgia', 'Georgia picked from the list stays the country');

    // 订单弹窗里手打的英文名（没有离开框的整理）保存时也存成列表写法；随这次保存，档案也按列表写法写回数据库。
    await legacy.page.evaluate(() => openOrder('h1'));
    await legacy.page.waitForSelector('#orderModal.open');
    await legacy.page.evaluate(() => { document.querySelector('#orderForm [name="country"]').value = 'zimbabwe'; document.getElementById('orderForm').requestSubmit(); });
    await legacy.page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
    await legacy.page.evaluate(() => flushPendingSave());
    const saved = legacy.store.current.data || legacy.store.current;
    assert.equal(saved.orders.find(o => o.id === 'h1').country, ZW, 'a typed English name is saved as the list entry');
    assert.equal(saved.customers['Harare Beauty'].country, ZW, 'the profile is written back in the list spelling');
    assert.equal(saved.customers['Atlantis Wigs'].country, 'Atlantis', 'a country outside the list is kept as written');
    assert.deepEqual(legacy.errors, []);
    assert.deepEqual(legacy.dialogs, []);
    console.log('Country list passed: full list, old entries mapped, names matched as a whole, common countries first, a chosen country edits as one piece, hand-typed countries in profiles join the list, CA / Georgia stay as typed.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
