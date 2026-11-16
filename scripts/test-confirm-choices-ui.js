#!/usr/bin/env node
// 确认框的二选一卡片（appConfirm 的 choices）和结构化正文（blocks），真实页面，浅色和深色：
// - 两张卡片，默认选第一张；defaultFocus:'alt' 选第二张；焦点在选中的那张上，没有第三个按钮；
// - 执行按钮的字跟着选中的卡片变（有 action 用 action），选中 danger 的卡片按钮变红；
// - 返回值和以前的 altText 一样：第一张 = { confirmed:true }，第二张 = { confirmed:false, alt:true }，取消 / × / Esc = { confirmed:false }；
// - 单选框上回车 = 执行，方向键在两张之间切换；
// - 危险操作（danger:true）打开时焦点仍落在「取消」上；
// - blocks 的每一种都按数据画出来，文字是 textContent（带尖括号的值原样显示，不变成元素）；两边一样的行变淡；
// - 下一次打开不带 choices / blocks 的确认框，上一次的卡片、内容都不留下，正文照常显示；
// - 卡片和红色的字在两个主题下都拉得开。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');
const { contrastHelpers, contrast } = require('./helpers/contrast');

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const { page, context, errors, dialogs } = await openBoard(browser, { orders:[] }, { port:freePortSync(), theme, width:1100, height:800 });
      const open = options => page.evaluate(options => { window.__confirmResult = appConfirm(options); }, options);
      const waitOpen = () => page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      const waitClosed = () => page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
      const result = async () => { await waitClosed(); return page.evaluate(() => window.__confirmResult); };
      const state = () => page.evaluate(() => ({
        cards:[...document.querySelectorAll('#confirmChoices .pick-option')].map(card => ({ label:card.querySelector('b').textContent, desc:card.querySelector('span')?.textContent || '', danger:card.classList.contains('danger') })),
        checked:[...document.querySelectorAll('#confirmChoices input')].findIndex(input => input.checked),
        focused:document.activeElement?.matches('#confirmChoices input') ? document.activeElement.value : document.activeElement?.id || '',
        ok:document.getElementById('confirmOkBtn').textContent,
        okDanger:document.getElementById('confirmOkBtn').classList.contains('btn-danger'),
        altVisible:document.getElementById('confirmAltBtn').getClientRects().length > 0,
        choicesVisible:document.getElementById('confirmChoices').getClientRects().length > 0,
        groupRole:document.getElementById('confirmChoices').getAttribute('role'),
        groupName:document.getElementById('confirmChoices').getAttribute('aria-label'),
        blocksVisible:document.getElementById('confirmBlocks').getClientRects().length > 0,
        messageVisible:document.getElementById('confirmMessage').getClientRects().length > 0
      }));
      const pasteLike = {
        title:'用识别结果改这张订单？', sub:'粘贴识别 · 2 处和现在不一样', message:'下面这些已经有内容，和识别结果不一样：',
        blocks:[{ type:'rows', rows:[{ label:'金额', from:'7500', to:'8200' }, { label:'收款方式', from:'TT', to:'Paypal' }] }],
        choices:[{ label:'全部改', desc:'这 2 处换成识别结果' }, { label:'只补空字段', desc:'这 2 处保持不变' }],
        cancelText:'取消'
      };

      // ---- 1. 默认选第一张，焦点在它上面；按钮跟着选择变；第二张执行 = alt ----
      await open(pasteLike);
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.matches('#confirmChoices input'));
      let s = await state();
      assert.deepEqual(s.cards.map(card => card.label), ['全部改', '只补空字段']);
      assert.equal(s.checked, 0);
      assert.equal(s.focused, '0', 'focus sits on the picked card');
      assert.equal(s.ok, '全部改');
      assert.equal(s.altVisible, false, 'no third button');
      assert.equal(s.groupRole, 'radiogroup');
      assert.ok(s.groupName, 'the card group has a name');
      await page.locator('#confirmChoices .pick-option').nth(1).click();
      s = await state();
      assert.equal(s.checked, 1);
      assert.equal(s.ok, '只补空字段', 'the button says what the picked card does');
      await page.click('#confirmOkBtn');
      assert.deepEqual(await result(), { confirmed:false, alt:true, value:'' });

      // ---- 2. 第一张执行 = confirmed；方向键切换后回车执行 ----
      await open(pasteLike);
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.matches('#confirmChoices input'));
      await page.click('#confirmOkBtn');
      assert.deepEqual(await result(), { confirmed:true, value:'' });
      await open(pasteLike);
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.matches('#confirmChoices input'));
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.getElementById('confirmOkBtn').textContent === '只补空字段');
      await page.keyboard.press('Enter');
      assert.deepEqual(await result(), { confirmed:false, alt:true, value:'' }, 'Enter on a card runs the picked one');

      // ---- 3. Esc 和 × 都是取消 ----
      await open(pasteLike);
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.matches('#confirmChoices input'));
      await page.keyboard.press('Escape');
      assert.deepEqual(await result(), { confirmed:false, value:'' });
      await open(pasteLike);
      await waitOpen();
      await page.click('#confirmCloseBtn');
      assert.deepEqual(await result(), { confirmed:false, value:'' });

      // ---- 4. defaultFocus:'alt' 选第二张；action 覆盖按钮文字；回车直接执行默认那张 ----
      await open({ ...pasteLike, defaultFocus:'alt', choices:[{ label:'覆盖这些字段', desc:'a' }, { label:'只补空字段', action:'只补空着的字段', desc:'b' }] });
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.matches('#confirmChoices input[value="1"]'));
      s = await state();
      assert.equal(s.checked, 1);
      assert.equal(s.ok, '只补空着的字段');
      await page.keyboard.press('Enter');
      assert.deepEqual(await result(), { confirmed:false, alt:true, value:'' });

      // ---- 5. 危险的确认框：焦点在「取消」；选中 danger 的卡片描边变红，按钮仍是红色 ----
      await open({ title:'清除查询记录', sub:'5 条', message:'订单里的物流状态不受影响。', note:'清除后可以撤销', confirmText:'清除', danger:true,
        choices:[{ label:'清除未置顶的 3 条', desc:'置顶的 2 条留着' }, { label:'连置顶一起清除', desc:'5 条全部清除', danger:true }] });
      await waitOpen();
      await page.waitForFunction(() => document.activeElement?.id === 'confirmCancelBtn');
      s = await state();
      assert.equal(s.ok, '清除未置顶的 3 条');
      assert.equal(s.okDanger, true);
      assert.deepEqual(s.cards.map(card => card.danger), [false, true]);
      await page.locator('#confirmChoices .pick-option').nth(1).click();
      // 描边有过渡动画：等它停在红色上。
      await page.waitForFunction(() => {
        const card = document.querySelectorAll('#confirmChoices .pick-option')[1];
        const probe = document.createElement('span');
        probe.style.color = 'var(--s-red)';
        card.append(probe);
        const red = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(card).borderTopColor === red;
      }, null, { timeout:3000 });
      await page.keyboard.press('Escape');
      assert.equal((await result()).confirmed, false);

      // ---- 6. blocks：每一种都画出来，文字原样；两边一样的行变淡、不一样的加粗 ----
      await open({
        title:'结构化正文', sub:'', confirmText:'知道了', cancelText:'',
        blocks:[
          { type:'rows', label:'字段', rows:[{ label:'金额', from:'<b>1</b>', to:'2' }, { label:'备注', to:'只有新值' }] },
          { type:'table', columns:['', '现在', '恢复后'], rows:[{ cells:['订单', 8, 7] }, { cells:['客户', 6, 6] }] },
          { type:'list', label:'恢复后会变的', items:[{ text:'少 2 张订单', detail:'K1、K2', tone:'bad' }, { text:'1 位客户改回备份时的内容' }] },
          { type:'checks', items:[{ label:'订单号重复', detail:'K1 / k1', count:'1 组', bad:true }, { label:'金额异常', count:'0' }] },
          { type:'text', text:'' },
          { type:'text', text:'最后一句说明。', fine:true }
        ]
      });
      await waitOpen();
      s = await state();
      assert.equal(s.messageVisible, false, 'an empty message takes no row when there are blocks');
      assert.equal(s.blocksVisible, true);
      assert.equal(s.choicesVisible, false);
      const blocks = await page.evaluate(() => {
        const root = document.getElementById('confirmBlocks');
        const weight = el => Number(getComputedStyle(el).fontWeight);
        const rows = [...root.querySelectorAll('.confirm-table tbody tr')];
        return {
          count:root.querySelectorAll(':scope > .confirm-block').length,
          injected:root.querySelectorAll('.confirm-rows b').length,
          from:root.querySelector('.confirm-rows .from').textContent,
          fromStruck:getComputedStyle(root.querySelector('.confirm-rows .from')).textDecorationLine,
          twoCells:root.querySelectorAll('.confirm-rows > div')[1].children.length,
          tableClasses:rows.map(tr => tr.className),
          diffWeight:weight(rows[0].querySelector('td')),
          sameWeight:weight(rows[1].querySelector('td')),
          sameColor:getComputedStyle(rows[1].querySelector('td')).color,
          diffColor:getComputedStyle(rows[0].querySelector('td')).color,
          listBad:root.querySelector('.confirm-list li.bad b').textContent,
          checks:[...root.querySelectorAll('.confirm-checks li')].map(li => li.className),
          fine:root.querySelector('.confirm-text.fine')?.textContent || ''
        };
      });
      assert.equal(blocks.count, 5, 'an empty text block is skipped');
      assert.equal(blocks.injected, 0, 'values are text, never markup');
      assert.equal(blocks.from, '<b>1</b>');
      assert.equal(blocks.fromStruck, 'line-through');
      assert.equal(blocks.twoCells, 2, 'a row without an old value has two cells');
      assert.deepEqual(blocks.tableClasses, ['diff', 'same']);
      assert.ok(blocks.diffWeight > blocks.sameWeight, 'changed rows are bolder');
      assert.notEqual(blocks.sameColor, blocks.diffColor, 'unchanged rows are dimmer');
      assert.equal(blocks.listBad, '少 2 张订单');
      assert.deepEqual(blocks.checks, ['bad', 'ok']);
      assert.equal(blocks.fine, '最后一句说明。');
      // 红色的字和卡片底色拉得开。
      await page.evaluate(contrastHelpers);
      for (const selector of ['.confirm-list li.bad b', '.confirm-checks li.bad b', '.confirm-checks li.bad .n', '.confirm-checks li.ok b']) {
        const { ratio } = await contrast(page, `#confirmBlocks ${selector}`);
        assert.ok(ratio >= 4.5, `${theme}: ${selector} is readable (${ratio})`);
      }
      await page.click('#confirmOkBtn');
      assert.equal((await result()).confirmed, true);

      // ---- 7. 下一次普通确认框：卡片、内容都不留下，正文照常显示 ----
      await open({ title:'放弃未保存的修改？', sub:'', message:'刚才填的内容还没保存。', confirmText:'放弃修改', cancelText:'继续编辑', danger:true });
      await waitOpen();
      s = await state();
      assert.equal(s.choicesVisible, false);
      assert.equal(s.blocksVisible, false);
      assert.equal(s.messageVisible, true);
      assert.equal(s.ok, '放弃修改');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#confirmChoices *, #confirmBlocks *').length), 0);
      await page.keyboard.press('Escape');
      await result();

      assert.deepEqual(dialogs, [], 'no native dialogs');
      assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
      await context.close();
    }
    console.log('Confirm choices UI passed: two cards with the default pick and focus, the button follows the pick, alt / confirm / cancel results, Enter and arrows, danger focus and outline, every block kind drawn as text, nothing left over, readable in both themes.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
