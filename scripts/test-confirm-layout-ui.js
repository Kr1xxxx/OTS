#!/usr/bin/env node
// 确认框的版式（真实页面，浅色和深色）：
// - 副标题在标题下面一行，左边和标题对齐；没有副标题时不占一行；
// - 有 note 时底部是一条带分隔线的栏，note 在左边、按钮在右边，同一行；没有 note 时底部没有分隔线，也没有空的 note；
// - note 的字在两个主题下都和底色拉得开；
// - 关掉再开一个不带 note 的确认框，上一次的 note 不会留下来。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { freePortSync } = require('./helpers/free-port');

const luminance = rgb => {
  const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

(async () => {
  const browser = await launchBrowser();
  try {
    for (const theme of ['light', 'dark']) {
      const { page, context, errors, dialogs } = await openBoard(browser, { orders:[] }, { port:freePortSync(), theme, width:1100, height:760 });
      const open = options => page.evaluate(options => { window.__confirmResult = appConfirm(options); }, options);
      const waitOpen = () => page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
      const waitClosed = () => page.waitForFunction(() => !document.getElementById('confirmModal').classList.contains('open'));
      const layout = () => page.evaluate(() => {
        const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, height:r.height, width:r.width }; };
        const foot = document.getElementById('confirmFoot');
        const note = document.getElementById('confirmNote');
        const actions = foot.querySelector('.confirm-actions');
        const modal = document.querySelector('#confirmModal .modal');
        // 计算值可能是 oklch()：画到 1×1 的 canvas 上读回 rgb。
        const ctx = Object.assign(document.createElement('canvas'), { width:1, height:1 }).getContext('2d');
        const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return `rgb(${[...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})`; };
        const bg = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent|oklch\([^)]*\/ 0\)/.test(c)) return rgb(c); } return 'rgb(255, 255, 255)'; };
        return {
          title:box('confirmTitle'),
          sub:box('confirmSub'),
          subDisplay:getComputedStyle(document.getElementById('confirmSub')).display,
          noteHidden:note.hidden,
          noteDisplay:getComputedStyle(note).display,
          noteText:note.textContent,
          note:box('confirmNote'),
          noteColor:rgb(getComputedStyle(note).color),
          noteBg:bg(note),
          actions:(r => ({ top:r.top, bottom:r.bottom, left:r.left, right:r.right }))(actions.getBoundingClientRect()),
          hasNote:foot.classList.contains('has-note'),
          footBorder:getComputedStyle(foot).borderTopWidth,
          footRight:foot.getBoundingClientRect().right,
          modalRight:modal.getBoundingClientRect().right,
          describedBy:modal.getAttribute('aria-describedby')
        };
      });

      // ---- 1. 副标题 + note ----
      await open({ title:'删除客户', sub:'Zeta Trade · 名下没有订单', message:'客户档案会删除。', confirmText:'删除客户', danger:true, note:'删除前自动备份，6 秒内可以撤销' });
      await waitOpen();
      let l = await layout();
      assert.ok(l.sub.top >= l.title.bottom - 1, `sub sits under the title (${l.sub.top} vs ${l.title.bottom})`);
      assert.ok(Math.abs(l.sub.left - l.title.left) < 1, 'sub is left-aligned with the title');
      assert.equal(l.describedBy, 'confirmSub confirmMessage');
      assert.equal(l.noteHidden, false);
      assert.equal(l.noteText, '删除前自动备份，6 秒内可以撤销');
      assert.equal(l.hasNote, true);
      assert.equal(l.footBorder, '1px', 'a footer with a note has a separator line');
      assert.ok(l.note.right <= l.actions.left, 'the note is left of the buttons');
      assert.ok(l.note.top < l.actions.bottom && l.note.bottom > l.actions.top, 'the note and the buttons share one row');
      assert.ok(Math.abs(l.footRight - l.modalRight) < 1.5, 'the footer bar runs to the edge of the dialog');
      assert.ok(contrast(l.noteColor, l.noteBg) >= 3, `${theme}: note is readable (${l.noteColor} on ${l.noteBg})`);
      await page.keyboard.press('Escape');
      await waitClosed();
      assert.equal((await page.evaluate(() => window.__confirmResult)).confirmed, false, 'Escape cancels');

      // ---- 2. 副标题为空（默认是「需要确认」）、没有 note：上一次的 note 不留下 ----
      await open({ title:'放弃未保存的修改？', sub:'', message:'刚才填的内容还没保存。', confirmText:'放弃修改', cancelText:'继续编辑', danger:true });
      await waitOpen();
      l = await layout();
      assert.equal(l.subDisplay, 'none', 'an empty sub takes no row');
      assert.equal(l.noteHidden, true);
      assert.equal(l.noteDisplay, 'none');
      assert.equal(l.noteText, '');
      assert.equal(l.hasNote, false);
      assert.equal(l.footBorder, '0px', 'no separator without a note');
      await page.click('#confirmOkBtn');
      await waitClosed();
      assert.equal((await page.evaluate(() => window.__confirmResult)).confirmed, true);

      assert.deepEqual(dialogs, [], 'no native dialogs');
      assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
      await context.close();
    }
    console.log('Confirm dialog layout UI passed: sub under the title, empty sub hidden, note left of the buttons on a separated footer, readable in both themes, no leftover note.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
