#!/usr/bin/env node
// 占用空间（mac-app/storage-usage.js）的口径，在一个临时目录里搭出数据文件夹、备份和 .app：
// - 软件本身 = .app 整个包，运行环境单独报；没有 .app 时为 null；
// - 图片和附件：订单在用的按订单汇总（占得最多的在前、只取 top 张），缩略图单独算，没人用的算「不再使用」；
// - 备份：只认 OTS 起名的备份和它旁边的文件夹、.missing.json（用户选的备份目录里别的东西不算）；数据库副本照算；备份附件夹里和原图一样（克隆）或和更早备份同一个文件（硬链接）的只算一次，记进 sharedBytes；
//   和原图不一样的（换过的图）照算；
// - 数据库含 -wal；缓存目录照算；其他 = 数据目录里剩下的；一共 = 各项相加。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { measureStorage, diskBytes } = require('../mac-app/storage-usage');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-storage-usage-'));
const write = (file, size, time) => {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  if (time) fs.utimesSync(file, time, time);
  return file;
};
const bytes = file => diskBytes(fs.lstatSync(file));
const sum = files => files.reduce((total, file) => total + bytes(file), 0);

(async () => {
  try {
    const support = path.join(root, 'data');
    const attachments = path.join(support, 'attachments');
    const backups = path.join(support, 'backups');
    const database = path.join(support, 'trade-order-system.sqlite');
    const app = path.join(root, 'Applications', 'TradeOrderSystem.app');
    const runtime = write(path.join(app, 'Contents', 'Resources', 'node-runtime'), 300000);
    const page = write(path.join(app, 'Contents', 'Resources', 'trade-order-system.html'), 40000);
    const cache = write(path.join(root, 'Library', 'Caches', 'com.local.tradeordersystem', 'Cache.db'), 25000);
    const db = [write(database, 90000), write(`${database}-wal`, 12000)];
    const other = [write(path.join(support, 'backup-meta.json'), 200), write(path.join(support, 'migration-archive', 'old.json'), 5000)];
    const old = new Date('2026-01-02T03:04:05Z');
    const a1 = write(path.join(attachments, 'K1', 'IMG_1.webp'), 200000, old);
    const a1t = write(path.join(attachments, 'K1', 'IMG_1-thumb.webp'), 30000, old);
    const a2 = write(path.join(attachments, 'K1', 'IMG_2.webp'), 150000, old);
    const b1 = write(path.join(attachments, 'K2', 'IMG_3.webp'), 400000, old);
    const unused = write(path.join(attachments, 'K1', 'IMG_old.png'), 700000, old);

    // 第一份备份：附件和原图一模一样（在 Mac 上是克隆）；第二份：同一张图是第一份的硬链接，另有一张和原图不一样的。
    const first = path.join(backups, 'trade-order-data-20260101-000000.sqlite');
    const second = path.join(backups, 'trade-order-data-20260102-000000.sqlite');
    const copies = [write(first, 80000), write(second, 85000)];
    const firstAtt = `${first}.attachments`;
    const secondAtt = `${second}.attachments`;
    const clone = write(path.join(firstAtt, 'K1', 'IMG_1.webp'), 200000, old);
    const cloneOld = write(path.join(firstAtt, 'K1', 'IMG_old.png'), 700000, old);
    fs.mkdirSync(path.join(secondAtt, 'K1'), { recursive:true });
    fs.linkSync(clone, path.join(secondAtt, 'K1', 'IMG_1.webp'));
    const changed = write(path.join(secondAtt, 'K2', 'IMG_3.webp'), 123000, new Date('2025-06-01T00:00:00Z'));
    const missingNote = write(`${second}.missing.json`, 300);
    // 备份目录是用户自己选的文件夹（iCloud、网盘）时，里面别的东西不算备份。
    write(path.join(backups, 'notes.sqlite'), 50000);
    write(path.join(backups, 'Photos', 'holiday.jpg'), 600000);
    write(path.join(backups, 'other.attachments', 'x.png'), 40000);

    const owners = [
      { label:'K1', files:[a1, a1t, a2] },
      { label:'K2', files:[b1] },
      { label:'K3', files:[path.join(attachments, 'K3', 'missing.webp')] }
    ];
    const result = await measureStorage({
      appDir:app, runtimeFile:runtime, supportDir:support, attachmentsDir:attachments, databaseFile:database, backupDir:backups,
      cacheDirs:[path.join(root, 'Library', 'Caches', 'com.local.tradeordersystem'), path.join(root, 'Library', 'WebKit', 'nothing-here')],
      owners, thumbs:new Set([a1t]), top:1
    });

    assert.equal(result.ok, true);
    assert.equal(result.app.bytes, sum([runtime, page]), 'app = the whole bundle');
    assert.equal(result.app.runtime, bytes(runtime), 'runtime reported on its own');
    assert.equal(result.database.bytes, sum(db), 'database counts the -wal file');
    assert.equal(result.caches.bytes, bytes(cache), 'cache folders that exist are counted, missing ones are 0');
    assert.equal(result.other.bytes, sum(other), 'other = the rest of the data folder');

    const att = result.attachments;
    assert.equal(att.bytes, sum([a1, a1t, a2, b1, unused]), 'every file in attachments');
    assert.equal(att.files, 3, 'three attachments in use, the thumbnail is not one');
    assert.equal(att.thumbBytes, bytes(a1t), 'thumbnail bytes on their own');
    assert.equal(att.unusedFiles, 1, 'the file no order uses');
    assert.equal(att.unusedBytes, bytes(unused));
    assert.equal(att.orderCount, 2, 'an order whose files are gone is not listed');
    assert.deepEqual(att.top, [{ label:'K2', files:1, bytes:bytes(b1) }], 'largest order first, cut to top');

    const bk = result.backups;
    // 克隆的 IMG_1 和 IMG_old、第二份里 IMG_1 的硬链接都共用；换过的 IMG_3 照算。
    assert.equal(bk.bytes, sum([...copies, changed, missingNote]), 'backups: database copies, the missing-files note and the changed image only; other files in the folder are not backups');
    assert.equal(bk.sharedBytes, sum([clone, cloneOld, clone]), 'shared copies are reported for the Finder note');
    assert.equal(bk.count, 2, 'two backups');
    assert.equal(bk.insideData, true);
    assert.equal(bk.otherDisk, false);

    assert.equal(result.total, result.app.bytes + result.database.bytes + att.bytes + bk.bytes + result.caches.bytes + result.other.bytes, 'total adds every row');

    // 原图被删掉以后（只剩备份在用）：第一份备份里的那张算进备份，后面同样的不再算。
    fs.rmSync(unused);
    const later = await measureStorage({ supportDir:support, attachmentsDir:attachments, databaseFile:database, backupDir:backups, owners });
    assert.equal(later.app, null, 'no .app: app is null');
    assert.equal(later.attachments.unusedFiles, 0);
    assert.equal(later.backups.bytes, sum([...copies, changed, missingNote, cloneOld]), 'the only copy left of a deleted original belongs to the backups');
    // 没给 thumbs 时按文件名里的 -thumb 认缩略图。
    assert.equal(later.attachments.thumbBytes, bytes(a1t));

    // 什么都还没有（全新安装）：全是 0，不报错。
    const empty = await measureStorage({ supportDir:path.join(root, 'none'), attachmentsDir:path.join(root, 'none', 'attachments'), databaseFile:path.join(root, 'none', 'db.sqlite'), backupDir:path.join(root, 'none', 'backups') });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.attachments.top, []);
    console.log('Storage usage test passed');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
