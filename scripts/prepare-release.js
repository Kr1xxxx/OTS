#!/usr/bin/env node
// Decides what the release workflow publishes for the commit it was handed, and prepares the tree.
// Pull requests do not carry version numbers. A change that should reach the installed app adds a
// short note under release-notes/next/; this script, run on main after CI has passed, takes the next
// number, stamps it into every file that carries the version, and folds the pending notes into
// release-notes/v<version>.md, which becomes the release text (the app shows its first lines in
// the "发现新版本" dialog before installing).
//
// Usage: node scripts/prepare-release.js --released <yes|no> [--root <dir>]
//   --released: does a GitHub release already exist for the VERSION in this tree?
//
//   VERSION not released yet          → publish it as it is (a version bumped by hand, or a release
//                                       whose build failed after the number was taken); pending notes
//                                       are folded in.
//   VERSION released, notes pending   → take the next minor number and publish.
//   VERSION released, nothing pending → nothing to publish.
//
// Prints one line of JSON: { publish, version, changed }. "changed" means the tree was edited and
// the workflow has to commit it to main before building.
const fs = require('node:fs');
const path = require('node:path');
const { bumpVersion } = require('./bump-version');

const NOTE_LINE_LIMIT = 100;

function pendingNoteFiles(root) {
  const dir = path.join(root, 'release-notes', 'next');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .sort()
    .map(name => path.join(dir, name));
}

// One "- …" line per non-empty line of a note; headings and list markers written by hand are dropped.
function noteLines(text) {
  return String(text).split('\n')
    .map(line => line.trim().replace(/^(?:#+|[-*•])\s*/, '').trim())
    .filter(Boolean);
}

function checkPendingNotes(root) {
  const problems = [];
  for (const file of pendingNoteFiles(root)) {
    const name = path.relative(root, file);
    const lines = noteLines(fs.readFileSync(file, 'utf8'));
    if (!lines.length) problems.push(`${name} is empty`);
    if (lines.length > 3) problems.push(`${name} has ${lines.length} lines; keep it to 3 (the update dialog shows 5 lines in all)`);
    for (const line of lines) {
      if ([...line].length > NOTE_LINE_LIMIT) problems.push(`${name}: a line is longer than ${NOTE_LINE_LIMIT} characters`);
    }
  }
  return problems;
}

function prepareRelease({ root, released }) {
  const current = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+$/.test(current)) throw new Error(`VERSION is not major.minor: ${current}`);
  const pending = pendingNoteFiles(root);
  if (released && !pending.length) return { publish: false, version: current, changed: false };

  const problems = checkPendingNotes(root);
  if (problems.length) throw new Error(`Release notes need fixing:\n${problems.join('\n')}`);

  let version = current;
  if (released) {
    const [major, minor] = current.split('.').map(Number);
    version = `${major}.${minor + 1}`;
    bumpVersion(root, version);
  }
  if (!pending.length) return { publish: true, version, changed: false };

  const target = path.join(root, 'release-notes', `v${version}.md`);
  const earlier = fs.existsSync(target) ? noteLines(fs.readFileSync(target, 'utf8')) : [];
  const lines = [...earlier, ...pending.flatMap(file => noteLines(fs.readFileSync(file, 'utf8')))];
  fs.writeFileSync(target, `${lines.map(line => `- ${line}`).join('\n')}\n`);
  for (const file of pending) fs.rmSync(file);
  return { publish: true, version, changed: true };
}

module.exports = { prepareRelease, checkPendingNotes, pendingNoteFiles, noteLines };

if (require.main === module) {
  const argument = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : '';
  };
  const released = argument('--released');
  if (released !== 'yes' && released !== 'no') throw new Error('Usage: node scripts/prepare-release.js --released <yes|no> [--root <dir>]');
  const root = path.resolve(argument('--root') || path.join(__dirname, '..'));
  console.log(JSON.stringify(prepareRelease({ root, released: released === 'yes' })));
}
