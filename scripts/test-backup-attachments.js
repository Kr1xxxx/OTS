#!/usr/bin/env node
// 备份里的附件：每份备份都有自己完整的一套，但上一份备份里已经有的文件不再重写一遍
// （本机磁盘上克隆，别的盘上和上一份备份共用同一个文件，都不行才真复制）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAttachmentCopier, sameAttachment } = require('../mac-app/backup-attachments');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-backup-attachments-'));
const cleanup = [root];
try {
  const live = path.join(root, 'attachments');
  const backup = name => path.join(root, 'backups', `${name}.attachments`);
  const write = (relative, text, at) => {
    const file = path.join(live, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    if (at) fs.utimesSync(file, at, at);
    return file;
  };
  // What the server does for one backup: every referenced file into the backup's own folder.
  const run = (name, files, options = {}) => {
    const previousDir = options.previousDir || '';
    const copier = createAttachmentCopier({ clone: false, ...options, previous: relative => previousDir ? path.join(previousDir, relative) : '' });
    const how = {};
    for (const relative of files) {
      const target = path.join(backup(name), relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      how[relative] = copier.place(path.join(live, relative), target, relative);
    }
    return { how, counts: copier.counts };
  };
  const inode = file => fs.statSync(file).ino;
  const morning = new Date(2020, 0, 1, 9, 0, 0);

  write('o1/photo.webp', 'photo-bytes', morning);
  write('o1/photo-thumb.webp', 'thumb', morning);

  // 1. The first backup on a volume has nothing to share with: real copies, carrying the time of their source.
  const first = run('b1', ['o1/photo.webp', 'o1/photo-thumb.webp']);
  assert.deepEqual(first.counts, { cloned: 0, linked: 0, copied: 2 });
  assert.equal(fs.readFileSync(path.join(backup('b1'), 'o1/photo.webp'), 'utf8'), 'photo-bytes');
  assert.equal(fs.statSync(path.join(backup('b1'), 'o1/photo.webp')).mtimeMs, morning.getTime(), 'a copy keeps the time of its source, so the next backup recognises it');
  assert.equal(fs.statSync(path.join(backup('b1'), 'o1/photo.webp')).mode & 0o777, 0o600);
  assert.notEqual(inode(path.join(backup('b1'), 'o1/photo.webp')), inode(path.join(live, 'o1/photo.webp')), 'never a link to the live file');

  // 2. The next backup: unchanged files are shared with the previous backup, only the new one is written.
  write('o2/invoice.png', 'invoice', new Date(2020, 0, 1, 10, 0, 0));
  const second = run('b2', ['o1/photo.webp', 'o1/photo-thumb.webp', 'o2/invoice.png'], { previousDir: backup('b1') });
  assert.deepEqual(second.how, { 'o1/photo.webp': 'linked', 'o1/photo-thumb.webp': 'linked', 'o2/invoice.png': 'copied' });
  assert.equal(inode(path.join(backup('b2'), 'o1/photo.webp')), inode(path.join(backup('b1'), 'o1/photo.webp')));
  assert.equal(fs.readFileSync(path.join(backup('b2'), 'o2/invoice.png'), 'utf8'), 'invoice');

  // 3. Each backup is still complete on its own: deleting the older one (rotation) leaves the newer one readable.
  fs.rmSync(backup('b1'), { recursive: true });
  assert.equal(fs.readFileSync(path.join(backup('b2'), 'o1/photo.webp'), 'utf8'), 'photo-bytes');
  assert.equal(fs.statSync(path.join(backup('b2'), 'o1/photo.webp')).nlink, 1);

  // 4. Same name, different file (a name freed by cleanup and used again): copied, not shared.
  //    Same size with another time, and same time with another size.
  write('o1/photo.webp', 'PHOTO-BYTES', new Date(2020, 0, 2, 9, 0, 0));
  write('o1/photo-thumb.webp', 'thumb+', morning);
  const third = run('b3', ['o1/photo.webp', 'o1/photo-thumb.webp', 'o2/invoice.png'], { previousDir: backup('b2') });
  assert.deepEqual(third.how, { 'o1/photo.webp': 'copied', 'o1/photo-thumb.webp': 'copied', 'o2/invoice.png': 'linked' });
  assert.equal(fs.readFileSync(path.join(backup('b3'), 'o1/photo.webp'), 'utf8'), 'PHOTO-BYTES');
  assert.equal(fs.readFileSync(path.join(backup('b2'), 'o1/photo.webp'), 'utf8'), 'photo-bytes', 'the older backup keeps the older file');

  // 5. Volumes that round times (HFS+ one second, FAT two): still the same file.
  const stat = (size, mtimeMs) => ({ isFile: () => true, size, mtimeMs });
  assert.equal(sameAttachment(stat(5, 1000000), stat(5, 1000999)), true);
  assert.equal(sameAttachment(stat(5, 1000000), stat(5, 1002000)), false);
  assert.equal(sameAttachment(stat(5, 1000000), stat(6, 1000000)), false);
  assert.equal(sameAttachment(undefined, stat(5, 1000000)), false);
  assert.equal(sameAttachment({ isFile: () => false, size: 5, mtimeMs: 1000000 }, stat(5, 1000000)), false);

  // 6. Sharing switched off, or the previous backup gone: plain copies.
  assert.deepEqual(run('b4', ['o2/invoice.png'], { previousDir: backup('b3'), link: false }).counts, { cloned: 0, linked: 0, copied: 1 });
  assert.deepEqual(run('b5', ['o2/invoice.png'], { previousDir: backup('nowhere') }).counts, { cloned: 0, linked: 0, copied: 1 });

  // 7. The previous backup is on another volume (the backup folder was moved): the link is refused,
  //    the file is copied, and the rest of this backup does not try again.
  const elsewhere = ['/dev/shm', '/run/shm'].find(dir => {
    try { return fs.statSync(dir).isDirectory() && fs.statSync(dir).dev !== fs.statSync(root).dev; } catch (_) { return false; }
  });
  if (elsewhere) {
    const other = fs.mkdtempSync(path.join(elsewhere, 'ots-backup-attachments-'));
    cleanup.push(other);
    for (const relative of ['o1/photo.webp', 'o2/invoice.png']) {
      fs.mkdirSync(path.dirname(path.join(other, relative)), { recursive: true });
      fs.copyFileSync(path.join(live, relative), path.join(other, relative));
      const source = fs.statSync(path.join(live, relative));
      fs.utimesSync(path.join(other, relative), source.atime, source.mtime);
    }
    const crossed = run('b6', ['o1/photo.webp', 'o2/invoice.png'], { previousDir: other });
    assert.deepEqual(crossed.counts, { cloned: 0, linked: 0, copied: 2 });
    assert.equal(fs.readFileSync(path.join(backup('b6'), 'o1/photo.webp'), 'utf8'), 'PHOTO-BYTES');
  }

  // 8. As the app runs it (cloning allowed): whatever this disk supports, the backup has the bytes and its own names.
  const real = run('b7', ['o1/photo.webp', 'o2/invoice.png'], { previousDir: backup('b3'), clone: true });
  assert.equal(real.counts.cloned + real.counts.linked + real.counts.copied, 2);
  if (real.counts.cloned) assert.deepEqual(real.counts, { cloned: 2, linked: 0, copied: 0 }, 'a disk that clones does so for every file');
  else assert.deepEqual(real.counts, { cloned: 0, linked: 2, copied: 0 }, 'a disk that cannot clone was asked once, then both files were shared with the previous backup');
  assert.equal(fs.readFileSync(path.join(backup('b7'), 'o1/photo.webp'), 'utf8'), 'PHOTO-BYTES');
  assert.equal(fs.readFileSync(path.join(backup('b7'), 'o2/invoice.png'), 'utf8'), 'invoice');
  assert.notEqual(inode(path.join(backup('b7'), 'o1/photo.webp')), inode(path.join(live, 'o1/photo.webp')));

  console.log(`Backup attachments passed: first backup copies, later backups share unchanged files with the previous one and write only new ones; a reused name is copied; each backup stays complete when an older one is deleted${elsewhere ? '; a previous backup on another volume falls back to copying' : ''}.`);
} finally {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
}
