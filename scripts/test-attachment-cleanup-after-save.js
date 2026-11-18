#!/usr/bin/env node
// 保存订单之后就清一轮附件，不用等下次打开 App（用户 2026-11-18）：真实 mac-app/server.js + 临时数据目录。
// - 放了一天以上、数据库和备份都没用到的图：保存后删掉；订单里用着的图、刚传上来还没保存的图留着。
// - 补压换成压缩版的旧原图：附件文件夹和备份的附件文件夹里一起删掉，不等备份轮换；
//   用户删掉的附件（没有压缩版接替）照旧留在备份里，恢复时还能找回。
// - attachment-cleanup.js 认「换掉的」规则：同一张单、同名同时间、现在是压缩版且指向别的文件。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { freePortSync } = require('./helpers/free-port');
const { replacedOriginalUrls, ordersOf } = require('../mac-app/attachment-cleanup');

const root = path.resolve(__dirname, '..');
const token = 'attachment-cleanup-test-token';

// 规则本身（不起服务）。
{
  const original = { name:'K1-1', time:'2026-10-01 10:00', type:'图片附件', fileUrl:'/attachments/K1/K1-1.png', thumbUrl:'/attachments/K1/K1-1-thumb.webp' };
  const removed = { name:'K1-2', time:'2026-10-01 10:00', type:'图片附件', fileUrl:'/attachments/K1/K1-2.png', thumbUrl:'/attachments/K1/K1-2-thumb.webp' };
  const link = { name:'PI', time:'2026-10-01 10:00', type:'PI', link:'https://example.com/pi' };
  const compressed = { ...original, fileUrl:'/attachments/K1/K1-1-1.webp', thumbUrl:'/attachments/K1/K1-1-1-thumb.webp', compressed:true };
  const backup = [{ id:'o1', attachments:[original, removed, link] }, { id:'o2', attachments:[{ ...original, fileUrl:'/attachments/K2/K1-1.png' }] }];
  assert.deepEqual([...replacedOriginalUrls([{ id:'o1', attachments:[compressed] }], backup)].sort(), ['/attachments/K1/K1-1-thumb.webp', '/attachments/K1/K1-1.png'],
    '只认同一张单里同名同时间、已换成压缩版的那张；删掉的附件、别的单、链接都不算');
  assert.equal(replacedOriginalUrls([{ id:'o1', attachments:[{ ...original, compressed:true }] }], backup).size, 0, '原地标成压缩（文件没换）不删');
  assert.equal(replacedOriginalUrls([{ id:'o1', attachments:[compressed, { name:'old', fileUrl:'/attachments/K1/K1-1.png' }] }], backup).has('/attachments/K1/K1-1.png'), false, '现在的数据还用着的不删');
  assert.equal(replacedOriginalUrls([{ id:'o1', attachments:[compressed] }], [{ id:'o1', attachments:[{ ...original, compressed:true }] }]).size, 0, '备份里那张本来就是压缩版：不是原图');
  assert.equal(replacedOriginalUrls([{ id:'o1', attachments:[compressed] }], [{ id:'o1', attachments:[{ ...original, time:'' }] }]).size, 0, '没有时间的认不出来，不删');
  assert.deepEqual(ordersOf({ orders:[{ id:'a' }], trashOrders:[{ id:'b' }], deletedOrders:[{ id:'c' }] }).map(o => o.id), ['a', 'b', 'c']);
}

async function withServer(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-attachment-cleanup-'));
  const port = freePortSync();
  const child = spawn(process.execPath, [path.join(root, 'mac-app', 'server.js')], {
    env:{ ...process.env, TRADE_APP_PORT:String(port), TRADE_APP_DATA_DIR:dataDir, TRADE_API_TOKEN:token, TRADE_APP_NO_OPEN:'1', TRADE_EXPORT_DIR:path.join(dataDir, '__downloads'), TRADE_EXPORT_NO_REVEAL:'1', TRADE_ATTACHMENT_CLEANUP_DELAY_MS:'0', TRADE_ATTACHMENT_CLEANUP_GAP_MS:'0' },
    stdio:'ignore'
  });
  const request = async (route, body) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method:body === undefined ? 'GET' : 'POST',
          headers:{ Authorization:`Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
          ...(body === undefined ? {} : { body:JSON.stringify(body) })
        });
        return { status:res.status, data:await res.json().catch(() => ({})) };
      } catch (error) {
        if (attempt > 100) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  };
  const save = async orders => {
    const current = (await request('/api/data')).data;
    const res = await request('/api/save', { state:{ app:'trade-order-system', version:'t', data:{ orders, trashOrders:[], deletedOrders:[], customers:{}, demoCleared:true, demoCustomersCleared:true } }, baseRevision:current.revision });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data;
  };
  try {
    await request('/api/health');
    await run({ dataDir, request, save });
  } finally {
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
}
const waitFor = async (check, label) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out: ${label}`);
};
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const order = attachments => ({ id:'c1', num:'K26110101', client:'Cleanup Buyer', amount:100, paidAmount:0, currency:'USD', stage:'quote', orderType:'定金订单', orderMonth:'2026-11', logs:[], shipments:[], attachments });

(async () => {
  // 没人用的旧图：保存后删；用着的、刚传上来的留着。
  await withServer(async ({ dataDir, save }) => {
    // 服务启动时那一轮清理已经跑过：下面的文件是之后才放进去的，只有保存后的那一轮能删它们。
    const folder = path.join(dataDir, 'attachments', 'K26110101');
    fs.mkdirSync(folder, { recursive:true });
    const file = name => path.join(folder, name);
    ['K26110101-1.webp', 'K26110101-1-thumb.webp', 'unused-old.png', 'unused-old-thumb.webp', 'just-pasted.webp'].forEach(name => fs.writeFileSync(file(name), name));
    ['K26110101-1.webp', 'K26110101-1-thumb.webp', 'unused-old.png', 'unused-old-thumb.webp'].forEach(name => fs.utimesSync(file(name), twoDaysAgo, twoDaysAgo));
    await save([order([{ name:'K26110101-1', time:'2026-11-01 10:00', type:'图片附件', fileUrl:'/attachments/K26110101/K26110101-1.webp', thumbUrl:'/attachments/K26110101/K26110101-1-thumb.webp', compressed:true }])]);
    await waitFor(() => !fs.existsSync(file('unused-old.png')) && !fs.existsSync(file('unused-old-thumb.webp')), 'unused old images removed after the save');
    assert.equal(fs.existsSync(file('K26110101-1.webp')), true, '订单里用着的图要留着');
    assert.equal(fs.existsSync(file('K26110101-1-thumb.webp')), true, '订单里用着的缩略图要留着');
    assert.equal(fs.existsSync(file('just-pasted.webp')), true, '刚传上来、还没保存进订单的图要留着');
  });

  // 补压换掉的旧原图：连备份里的一起删；用户删掉的附件留在备份里。
  await withServer(async ({ dataDir, save }) => {
    const folder = path.join(dataDir, 'attachments', 'K26110101');
    fs.mkdirSync(folder, { recursive:true });
    const file = name => path.join(folder, name);
    ['orig.png', 'orig-thumb.webp', 'deleted.png', 'deleted-thumb.webp'].forEach(name => {
      fs.writeFileSync(file(name), name);
      fs.utimesSync(file(name), twoDaysAgo, twoDaysAgo);
    });
    const original = { name:'K26110101-1', time:'2026-10-01 10:00', type:'图片附件', fileUrl:'/attachments/K26110101/orig.png', thumbUrl:'/attachments/K26110101/orig-thumb.webp' };
    const deleted = { name:'K26110101-2', time:'2026-10-01 10:00', type:'图片附件', fileUrl:'/attachments/K26110101/deleted.png', thumbUrl:'/attachments/K26110101/deleted-thumb.webp' };
    const first = await save([order([original, deleted])]);
    assert.equal(first.backup?.ok, true, '第一次保存要做一份备份');
    const backupFolder = path.join(first.backup.file + '.attachments', 'K26110101');
    assert.equal(fs.existsSync(path.join(backupFolder, 'orig.png')), true, '备份里有旧原图');

    // 页面补压：同名同时间的附件换成压缩版；用户同时删掉了第二张。
    ['compact.webp', 'compact-thumb.webp'].forEach(name => fs.writeFileSync(file(name), name));
    await save([order([{ ...original, fileUrl:'/attachments/K26110101/compact.webp', thumbUrl:'/attachments/K26110101/compact-thumb.webp', compressed:true, optimizer:'本机压缩' }])]);
    await waitFor(() => !fs.existsSync(file('orig.png')), 'replaced original removed from the attachments folder');
    assert.equal(fs.existsSync(file('orig-thumb.webp')), false, '旧原图的缩略图一起删');
    assert.equal(fs.existsSync(path.join(backupFolder, 'orig.png')), false, '备份里的旧原图也删');
    assert.equal(fs.existsSync(path.join(backupFolder, 'orig-thumb.webp')), false, '备份里的旧缩略图也删');
    assert.equal(fs.existsSync(file('compact.webp')), true, '压缩版留着');
    assert.equal(fs.existsSync(file('deleted.png')), true, '用户删掉的附件：备份还用着，附件文件夹里留着');
    assert.equal(fs.existsSync(path.join(backupFolder, 'deleted.png')), true, '用户删掉的附件留在备份里');
  });
  console.log('Attachment cleanup after save passed: unused images older than a day go right after a save, replaced originals go from backups too, deleted attachments stay in backups.');
})().catch(error => { console.error(error); process.exitCode = 1; });
