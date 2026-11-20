// Small files of the local server (settings, caches, markers).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Written to a temporary file beside the target and renamed over it: a crash or a full disk leaves the
// old file in place, never half of the new one. The file is readable by the user only.
function atomicWrite(file, text) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw error;
  }
}

// Only the app can initialize a marker on first open. Other database clients require an existing match.
function verifyStorageMarker(file, databaseId, { requireMatch = false } = {}) {
  if (!requireMatch && !fs.existsSync(file)) return;
  const expected = String(readJson(file).databaseId || '');
  if (expected && expected === databaseId) return;
  if (requireMatch || (expected && databaseId)) throw new Error('SQLite database identity does not match the storage marker');
}

module.exports = { readJson, atomicWrite, verifyStorageMarker };
