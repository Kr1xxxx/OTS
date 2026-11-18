// 设置 → 数据管理 →「占用空间」：软件本身、图片和附件、备份、数据库、缓存各占这台 Mac 多少硬盘。
//
// 量的是「占用」（文件实际占的块，stat.blocks × 512），不是文件名义上的大小。
// 备份里的附件文件夹和 attachments/ 共用硬盘空间（APFS 克隆或硬链接，见 backup-attachments.js），
// 访达「显示简介」会把它们各算一遍。这里只算一次：
// - 硬链接：同一个 inode 只算第一次。
// - 克隆：同一块硬盘上、同一个相对路径、大小和修改时间都一样（克隆和复制都带原文件的时间），
//   算作和本体共用；本体已经删了的，第一份算进备份，后面的同样共用。
// 跳过的部分记在 sharedBytes，页面拿它解释「访达里看到的为什么更大」。
const fs = require('fs');
const path = require('path');
const { sameAttachment } = require('./backup-attachments');
const { isOtsBackupFile } = require('./backup-names');

const thumbPattern = /-thumb(?:-\d+)?\.[a-z0-9]+$/i;

function diskBytes(stat) {
  if (!stat) return 0;
  return Number.isFinite(stat.blocks) && stat.blocks >= 0 ? stat.blocks * 512 : stat.size;
}

async function lstat(file) {
  try { return await fs.promises.lstat(file); } catch (_) { return null; }
}

// 一层一层往下走；符号链接不跟（量的是这个文件夹自己占的）。visit(file, stat, relative) 对每个普通文件调用一次。
async function walk(dir, visit, { skip = () => false, relativeTo = dir } = {}) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (skip(file)) continue;
    if (entry.isDirectory()) {
      await walk(file, visit, { skip, relativeTo });
    } else if (entry.isFile()) {
      const stat = await lstat(file);
      if (stat) visit(file, stat, path.relative(relativeTo, file));
    }
  }
}

async function folderBytes(dir, options = {}) {
  let bytes = 0;
  await walk(dir, (file, stat) => { bytes += diskBytes(stat); }, options);
  return bytes;
}

const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// owners：[{ label, files: Iterable<绝对路径> }]，每张订单一项（订单号 + 它引用的附件文件，含缩略图）。
// thumbs：被当作缩略图引用的文件（thumbUrl 和 fileUrl 不同的那个）；没给就按文件名里的「-thumb」认。
async function measureStorage({
  appDir = '', runtimeFile = '', supportDir, attachmentsDir, databaseFile, backupDir,
  cacheDirs = [], owners = [], thumbs = null, top = 5
} = {}) {
  const result = { ok: true, measuredAt: Date.now() };

  // 软件本身：.app 整个包；其中运行环境（Node）单独报。开发和测试时没有 .app，返回 null。
  if (appDir && fs.existsSync(appDir)) {
    const runtime = runtimeFile && inside(runtimeFile, appDir) ? diskBytes(await lstat(runtimeFile)) : 0;
    result.app = { bytes: await folderBytes(appDir), runtime, dir: appDir };
  } else {
    result.app = null;
  }

  // 数据库：sqlite 本体加上 -wal、-shm。
  let databaseBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) databaseBytes += diskBytes(await lstat(databaseFile + suffix));
  result.database = { bytes: databaseBytes };

  // 图片和附件：attachments/ 里每个文件。现在的数据还引用着的按订单汇总，没人引用的是「不再使用」
  // （备份还引用着、或等着清理，cleanupOrphanAttachments 会在没有备份引用后删掉）。
  const live = new Map();
  await walk(attachmentsDir, (file, stat, relative) => { live.set(relative, stat); });
  const referenced = new Set();
  const orders = [];
  for (const owner of owners) {
    let bytes = 0;
    let files = 0;
    for (const file of new Set(owner.files || [])) {
      const stat = live.get(path.relative(attachmentsDir, file));
      if (!stat) continue;
      referenced.add(file);
      bytes += diskBytes(stat);
      if (!isThumb(file)) files += 1;
    }
    if (bytes) orders.push({ label: String(owner.label || ''), files, bytes });
  }
  function isThumb(file) {
    return thumbs ? thumbs.has(file) : thumbPattern.test(path.basename(file));
  }
  const attachments = { bytes: 0, files: 0, thumbBytes: 0, unusedBytes: 0, unusedFiles: 0, orderCount: orders.length };
  for (const [relative, stat] of live) {
    const file = path.join(attachmentsDir, relative);
    const bytes = diskBytes(stat);
    attachments.bytes += bytes;
    if (!referenced.has(file)) {
      attachments.unusedBytes += bytes;
      attachments.unusedFiles += 1;
    } else if (isThumb(file)) {
      attachments.thumbBytes += bytes;
    } else {
      attachments.files += 1;
    }
  }
  attachments.top = orders.sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label)).slice(0, top);
  result.attachments = attachments;

  // 备份：数据库副本照实算；附件文件夹里和本体（或更早一份备份）共用的不算。
  const supportStat = await lstat(supportDir);
  const backupStat = await lstat(backupDir);
  const backups = {
    bytes: 0, sharedBytes: 0, count: 0, dir: backupDir,
    insideData: inside(backupDir, supportDir),
    // 备份目录在另一块硬盘上（外接盘、网络盘）：不算进这台 Mac 的「一共」。
    otherDisk: Boolean(supportStat && backupStat && supportStat.dev !== backupStat.dev)
  };
  const seenInodes = new Set();
  const seenCopies = new Map();
  let entries = [];
  try { entries = await fs.promises.readdir(backupDir, { withFileTypes: true }); } catch (_) {}
  // 备份目录可以是用户自己选的文件夹（iCloud、网盘），里面可能还有别的东西：只认 OTS 起名的备份、它旁边的 .missing.json 和 .attachments 文件夹。
  const ownName = name => isOtsBackupFile(name) || isOtsBackupFile(name.replace(/\.(missing\.json|attachments)$/, ''));
  for (const entry of entries) {
    if (!ownName(entry.name)) continue;
    const full = path.join(backupDir, entry.name);
    if (entry.isFile()) {
      const stat = await lstat(full);
      backups.bytes += diskBytes(stat);
      if (isOtsBackupFile(entry.name)) backups.count += 1;
      continue;
    }
    if (!entry.isDirectory()) continue;
    await walk(full, (file, stat, relative) => {
      const bytes = diskBytes(stat);
      const inode = `${stat.dev}:${stat.ino}`;
      if (stat.nlink > 1 && seenInodes.has(inode)) { backups.sharedBytes += bytes; return; }
      if (stat.nlink > 1) seenInodes.add(inode);
      if (!entry.name.endsWith('.attachments')) { backups.bytes += bytes; return; }
      const original = live.get(relative);
      const earlier = seenCopies.get(relative);
      const shared = (original && original.dev === stat.dev && sameAttachment(stat, original))
        || (earlier && earlier.dev === stat.dev && sameAttachment(stat, earlier));
      if (shared) { backups.sharedBytes += bytes; return; }
      seenCopies.set(relative, stat);
      backups.bytes += bytes;
    });
  }
  result.backups = backups;

  // 缓存：网页（WKWebView）的缓存和本地存储，macOS 放在「资源库」的几个地方。
  let cacheBytes = 0;
  for (const dir of cacheDirs) {
    const stat = await lstat(dir);
    if (!stat) continue;
    cacheBytes += stat.isDirectory() ? await folderBytes(dir) : diskBytes(stat);
  }
  result.caches = { bytes: cacheBytes };

  // 其他：数据目录里剩下的（设置、迁移前的旧数据、密钥文件…）。
  const databaseFiles = new Set(['', '-wal', '-shm'].map(suffix => databaseFile + suffix));
  result.other = {
    bytes: await folderBytes(supportDir, {
      skip: file => file === attachmentsDir || file === backupDir || databaseFiles.has(file)
    })
  };

  result.total = (result.app?.bytes || 0) + databaseBytes + attachments.bytes
    + (backups.otherDisk ? 0 : backups.bytes) + cacheBytes + result.other.bytes;
  return result;
}

module.exports = { measureStorage, diskBytes };
