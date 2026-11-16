// 读确认框（appConfirm）里写了什么：正文、结构化内容（blocks）和二选一卡片，拼成一段字给断言用。
// 字段对照写成「名字：旧 → 新」，对照表一行写成「名字 · 值 · 值」，卡片写成「标题：说明」。
// 也给测试一个「选第几张卡片」的办法：先点卡片，执行按钮的字跟着变，再由测试自己点执行按钮。

function readConfirm() {
  const parts = [];
  const message = document.getElementById('confirmMessage');
  if (!message.hidden && message.textContent) parts.push(message.textContent);
  document.querySelectorAll('#confirmBlocks > .confirm-block').forEach(block => {
    const lines = [];
    const label = block.querySelector(':scope > .pick-label');
    if (label) lines.push(label.textContent);
    block.querySelectorAll('.confirm-rows > div').forEach(row => {
      const k = row.querySelector('.k')?.textContent || '';
      const from = row.querySelector('.from');
      const to = row.querySelector('.to')?.textContent || '';
      lines.push(from ? `${k}：${from.textContent} → ${to}` : `${k}：${to}`);
    });
    block.querySelectorAll('.confirm-table tr').forEach(tr => lines.push([...tr.children].map(cell => cell.textContent).join(' · ')));
    block.querySelectorAll('.confirm-list li, .confirm-checks li').forEach(li => lines.push([...li.querySelectorAll('b, small, .n')].map(node => node.textContent).join(' ')));
    block.querySelectorAll('.confirm-text').forEach(p => lines.push(p.textContent));
    parts.push(lines.join('\n'));
  });
  const choices = document.getElementById('confirmChoices');
  if (!choices.hidden) {
    choices.querySelectorAll('.pick-option').forEach(card => parts.push(`${card.querySelector('b').textContent}：${card.querySelector('span')?.textContent || ''}`));
  }
  return parts.join('\n\n');
}

// 确认框里的全部文字（等它打开）。
async function confirmText(page) {
  await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('open'));
  return page.evaluate(readConfirm);
}

// 两张卡片的标题、哪张选中、执行按钮现在的字。
function confirmChoices(page) {
  return page.evaluate(() => {
    const box = document.getElementById('confirmChoices');
    return {
      shown:!box.hidden,
      labels:[...box.querySelectorAll('.pick-option > b')].map(b => b.textContent),
      checked:[...box.querySelectorAll('input[type="radio"]')].findIndex(input => input.checked),
      ok:document.getElementById('confirmOkBtn').textContent,
      altHidden:document.getElementById('confirmAltBtn').hidden
    };
  });
}

// 选第 index 张卡片（0 = 第一张），用真鼠标点卡片。
async function pickConfirmChoice(page, index) {
  const card = page.locator('#confirmChoices .pick-option').nth(index);
  await card.waitFor({ state:'visible' });
  await card.click();
  await page.waitForFunction(i => document.querySelectorAll('#confirmChoices input[type="radio"]')[i]?.checked, index);
}

module.exports = { confirmText, confirmChoices, pickConfirmChoice, readConfirm };
