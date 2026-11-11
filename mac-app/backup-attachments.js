// Fills a backup's own attachments folder without writing again what an earlier backup already holds.
//
// Every backup keeps a complete folder of the files its database refers to, so one backup can be
// copied elsewhere or restored on its own. Until V3.145 each backup wrote all of them: free on the
// Mac's own disk (APFS clones), but a full copy per backup, made inside the save request, when the
// backup folder is on another volume (an external disk, a network share).
//
// For each file, the first of these that works:
// 1. clone: same APFS volume. Shares the blocks, yet is an independent file.
// 2. link: a hard link to the same file in the previous backup. Backup copies are never modified
//    (restoring copies them out, deleting a backup only removes its own names), so sharing is safe.
// 3. copy: the first backup on a volume, a new attachment, or a volume without hard links (exFAT).
//
// "The same file" is same size and same modification time: a copy made here carries the time of its
// source, and attachment files are written once and never changed. Times are compared with a
// two-second tolerance because some volumes round them.
const fs = require('fs');

const TIME_TOLERANCE_MS = 2000;

function sameAttachment(kept, source) {
  return Boolean(kept?.isFile()) && kept.size === source.size && Math.abs(kept.mtimeMs - source.mtimeMs) < TIME_TOLERANCE_MS;
}

// previous(relative) → path of that attachment in the previous backup, or '' when there is none.
// clone / link can be switched off (tests; nothing in the app does).
function createAttachmentCopier({ previous = () => '', clone = true, link = true } = {}) {
  const counts = { cloned: 0, linked: 0, copied: 0 };
  let canClone = clone;
  let canLink = link;
  function place(source, target, relative) {
    if (canClone) {
      try {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE_FORCE);
        fs.chmodSync(target, 0o600);
        counts.cloned += 1;
        return 'cloned';
      } catch (_) {
        // Not this volume's ability: do not ask again for every file of this backup.
        canClone = false;
        fs.rmSync(target, { force: true });
      }
    }
    const stat = fs.statSync(source);
    const kept = canLink ? previous(relative) : '';
    if (kept && sameAttachment(fs.statSync(kept, { throwIfNoEntry: false }), stat)) {
      try {
        fs.linkSync(kept, target);
        counts.linked += 1;
        return 'linked';
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EEXIST') canLink = false;
        fs.rmSync(target, { force: true });
      }
    }
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    fs.utimesSync(target, stat.atime, stat.mtime);
    counts.copied += 1;
    return 'copied';
  }
  return { place, counts };
}

module.exports = { createAttachmentCopier, sameAttachment };
