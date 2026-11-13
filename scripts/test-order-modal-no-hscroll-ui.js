const assert = require('node:assert/strict');
const { launchBrowser, openBoard, h, base, day } = require('./helpers/board-page');

// 订单弹窗中栏不能左右滑：附件名、附件类型、纯文字备注、链接、操作记录里出现中间断不开的长串（文件名、链接、长编号）时，
// 名称在自己那一列换行，链接和备注单行省略（最多 160px，悬停看全文），操作记录换行。以前这些长串把中栏撑宽，
// 中栏能往右拉，拉过去表单左边被切掉。订单抽屉的「记录」页是同一个毛病。普通数据的附件行和记录不变。
const LONG = 'A'.repeat(100);
const LONG_URL = `https://example.com/files/download?id=${'x9'.repeat(40)}&token=${'Q'.repeat(40)}`;
const THUMB = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#ccc"/></svg>')}`;
const time = `${day(3)} 10:00`;
const orders = [
  {
    ...base, id:'long', num:'K801', client:'Mila Lash Studio', amount:1000, paidAmount:1000, stage:'shipped', orderType:'全款订单',
    note:`客户要的链接 ${LONG_URL}`, orderDetail:LONG, updated:time,
    attachments:[
      { name:`${LONG}.jpg`, type:'付款截图', time, size:123456, optimizer:LONG, fileUrl:'/attachments/long/a.jpg', thumbUrl:THUMB },
      { name:`${LONG}.pdf`, type:LONG, time, link:LONG },
      { name:'发票', type:'发票', time, link:LONG_URL }
    ],
    logs:[
      { text:`备注：空 → 客户要的链接 ${LONG_URL}`, time },
      { text:`订单详情：空 → ${LONG}`, time }
    ]
  },
  {
    ...base, id:'plain', num:'K802', client:'Mila Lash Studio', amount:500, paidAmount:500, stage:'shipped', orderType:'全款订单', updated:time,
    attachments:[
      { name:'付款截图.jpg', type:'付款截图', time, size:45678, fileUrl:'/attachments/plain/a.jpg', thumbUrl:THUMB },
      { name:'合同', type:'合同', time, link:'https://example.com/c' }
    ],
    logs:[{ text:'新建订单', time }]
  }
];
const customers = {
  'Mila Lash Studio': { client:'Mila Lash Studio', country:base.country, currency:'USD', paymentMethod:'Paypal', level:'D级黄金客户', address:'1 Sample Road, Springfield' }
};

const openEdit = async (page, id) => {
  await page.evaluate(id => openOrder(id), id);
  await page.waitForFunction(() => document.getElementById('orderModal').classList.contains('open'));
  await h.settle(page, '#orderModal .order-modal');
};
const closeEdit = async page => {
  await page.evaluate(() => closeOrder());
  await page.waitForFunction(() => !document.getElementById('orderModal').classList.contains('open'));
};

// 中栏能不能横向滚、每个分区里有没有东西伸出分区右边、附件行各格的尺寸。
const measure = page => page.evaluate(() => {
  const main = document.querySelector('#orderModal .order-main');
  main.scrollLeft = 9999;
  const scrollLeft = main.scrollLeft;
  main.scrollLeft = 0;
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const sticking = [];
  main.querySelectorAll('.order-section').forEach(section => {
    if (!visible(section)) return;
    const edge = section.getBoundingClientRect().right;
    section.querySelectorAll('*').forEach(el => {
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width && r.right > edge + 0.5) sticking.push(`${section.dataset.orderSection || section.id}: ${el.tagName.toLowerCase()}.${[...el.classList].join('.')} 伸出 ${Math.round(r.right - edge)}px`);
    });
  });
  const rows = [...document.querySelectorAll('#attachmentList .attachment-item')].map(row => {
    const name = row.querySelector('.attachment-name');
    const tail = row.querySelector('.attachment-link, .attachment-note');
    const nameStyle = getComputedStyle(name);
    return {
      name:name.textContent,
      nameWidth:name.getBoundingClientRect().width,
      nameLines:Math.round(name.getBoundingClientRect().height / parseFloat(nameStyle.lineHeight)),
      tail:tail ? { text:tail.textContent, title:tail.title, width:tail.getBoundingClientRect().width, clipped:tail.scrollWidth > tail.clientWidth } : null
    };
  });
  const logs = [...document.querySelectorAll('#historyList .log')].map(el => ({ right:el.getBoundingClientRect().right, textRight:el.lastElementChild.getBoundingClientRect().right }));
  return { client:main.clientWidth, scroll:main.scrollWidth, scrollLeft, sticking, rows, logs, mainRight:main.getBoundingClientRect().right };
});

(async () => {
  const browser = await launchBrowser();
  try {
    for (const viewport of [{ width:1440, height:920 }, { width:1294, height:847 }]) {
      const { page, context, errors, dialogs } = await openBoard(browser, { orders, customers }, viewport);
      const at = `${viewport.width}×${viewport.height}`;

      // ===== 1. 长串放进每个位置：中栏不能横向滚，内容也没被裁掉 =====
      await openEdit(page, 'long');
      const long = await measure(page);
      assert(long.scroll <= long.client, `${at} 中栏没有横向可滚的宽度（${long.client} → ${long.scroll}）`);
      assert.equal(long.scrollLeft, 0, `${at} 中栏拉不动`);
      assert.deepEqual(long.sticking, [], `${at} 中栏每个分区里没有东西伸出分区右边`);
      assert.equal(long.rows.length, 3, `${at} 三条附件都在`);
      long.logs.forEach(log => assert(log.textRight <= log.right + 0.5, `${at} 操作记录的文字在记录里换行：${JSON.stringify(log)}`));
      const [thumbRow, noteRow, linkRow] = long.rows;
      assert(thumbRow.nameLines > 1, `${at} 有缩略图的长附件名在自己那一列换行：${JSON.stringify(thumbRow)}`);
      assert(noteRow.nameLines > 1, `${at} 没缩略图的长附件名换行：${JSON.stringify(noteRow)}`);
      assert.equal(noteRow.tail.text, LONG, `${at} 纯文字备注照原文`);
      assert(noteRow.tail.width <= 160.5 && noteRow.tail.clipped, `${at} 纯文字备注单行省略、最宽 160px：${JSON.stringify(noteRow.tail)}`);
      assert.equal(noteRow.tail.title, LONG, `${at} 纯文字备注悬停看全文`);
      assert(linkRow.tail.width <= 160.5 && linkRow.tail.clipped, `${at} 长链接单行省略、最宽 160px：${JSON.stringify(linkRow.tail)}`);
      assert.equal(linkRow.tail.title, LONG_URL, `${at} 长链接悬停看全文`);
      assert(linkRow.nameWidth >= 100, `${at} 长链接那一行的名称没被挤没（${linkRow.nameWidth}px）`);
      assert.equal(linkRow.nameLines, 1, `${at} 长链接那一行的短名称仍是一行`);
      await closeEdit(page);

      // ===== 2. 普通数据：附件名一行，「查看图片」和短链接完整显示 =====
      await openEdit(page, 'plain');
      const plain = await measure(page);
      assert(plain.scroll <= plain.client && plain.sticking.length === 0, `${at} 普通订单中栏不越界：${JSON.stringify(plain)}`);
      plain.rows.forEach(row => {
        assert.equal(row.nameLines, 1, `${at} 普通附件名一行：${JSON.stringify(row)}`);
        assert(!row.tail.clipped, `${at} 「${row.tail.text}」完整显示：${JSON.stringify(row)}`);
      });
      assert.deepEqual(plain.rows.map(row => row.tail.text), ['查看图片', 'https://example.com/c']);
      await closeEdit(page);

      // ===== 3. 订单抽屉「记录」页：长串换行，抽屉不横向滚 =====
      await page.evaluate(() => openOrderDetail('long', { tab:'records' }));
      await page.waitForFunction(() => document.getElementById('orderDetailDrawer').classList.contains('open') && document.querySelector('#orderDetailBody .detail-log'));
      await h.settle(page, '#orderDetailBody');
      const drawer = await page.evaluate(() => {
        const body = document.getElementById('orderDetailBody');
        const logs = [...body.querySelectorAll('.detail-log')].filter(el => el.getClientRects().length);
        return { client:body.clientWidth, scroll:body.scrollWidth, logs:logs.length };
      });
      assert(drawer.logs > 0, `${at} 抽屉「记录」页显示了操作记录`);
      assert(drawer.scroll <= drawer.client, `${at} 抽屉「记录」页不横向滚（${drawer.client} → ${drawer.scroll}）`);

      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
      await context.close();
    }
    console.log('Order modal no-hscroll UI passed: long names / links / notes / logs wrap or ellipsize, middle column and drawer records do not scroll sideways, plain rows unchanged.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
