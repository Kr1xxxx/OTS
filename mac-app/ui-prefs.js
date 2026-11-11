// Preferences of the page that must outlive its address: theme, accent, the notification list.
//
// The page keeps them in localStorage, which belongs to the origin, and the port is part of the origin.
// When the Mac app has to start the server on another port, the page starts with nothing. This is the
// copy that stays with the data folder: the page sends every change here, and the server puts the lot
// into the page it serves, so the page has them before its first line runs.
//
// The server does not interpret the values. A value of null means "removed on purpose" and is kept, so a
// page that still holds an old value for that key drops it instead of sending it back.
const fs = require('fs');
const { httpError } = require('./http-error');
const { atomicWrite, readJson } = require('./file-store');

const maxKeys = 32;
const maxValueLength = 256 * 1024;
const keyPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pageMarker = '<meta name="ots-prefs" content="">';

function validEntry(key, value) {
  return keyPattern.test(key) && (value === null || (typeof value === 'string' && value.length <= maxValueLength));
}

// The served page with the preferences in its ots-prefs meta tag. A page without the tag is left alone.
function pageWithPrefs(html, prefs) {
  const content = JSON.stringify(prefs).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return html.replace(pageMarker, () => `<meta name="ots-prefs" content="${content}">`);
}

function createUiPrefs({ file }) {
  function read() {
    if (!fs.existsSync(file)) return {};
    try {
      const raw = readJson(file);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter(([key, value]) => validEntry(key, value)).slice(0, maxKeys));
    } catch (_) {
      return {};
    }
  }

  // changes: { key: 'text' } stores a value, { key: null } records that it was removed.
  function write(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw httpError(400, 'set 必须是对象');
    const next = read();
    for (const [key, value] of Object.entries(changes)) {
      if (!keyPattern.test(key)) throw httpError(400, `偏好名称不对：${String(key).slice(0, 40)}`);
      if (value !== null && typeof value !== 'string') throw httpError(400, `${key} 必须是文字`);
      if (value !== null && value.length > maxValueLength) throw httpError(400, `${key} 太长了`);
      next[key] = value;
    }
    if (Object.keys(next).length > maxKeys) throw httpError(400, '偏好太多了');
    atomicWrite(file, JSON.stringify(next));
    return next;
  }

  return { read, write };
}

module.exports = { createUiPrefs, pageWithPrefs, pageMarker };
