#!/usr/bin/env node
// 版本号在合并之后才分配：PR 只往 release-notes/next/ 放一条更新说明，发版流程在 main 上取下一个号。
// 这里测 scripts/prepare-release.js 的三种情况，以及发版流程里围绕它的保护。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareRelease, checkPendingNotes, noteLines } = require('./prepare-release');

const repo = path.resolve(__dirname, '..');
const current = fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').trim();
const [major, minor] = current.split('.').map(Number);
const next = `${major}.${minor + 1}`;

// A copy of the files that carry the version, with whatever notes the case needs.
function tree(notes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-release-'));
  for (const file of ['VERSION', 'package.json', 'package-lock.json', 'trade-order-system.html', 'README.md']) {
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'release-notes', 'next'), { recursive: true });
  fs.writeFileSync(path.join(root, 'release-notes', 'next', 'README.md'), '# not a note\n');
  for (const [name, text] of Object.entries(notes)) fs.writeFileSync(path.join(root, 'release-notes', name), text);
  return root;
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const versionOf = root => read(root, 'VERSION').trim();
const pendingIn = root => fs.readdirSync(path.join(root, 'release-notes', 'next')).filter(name => name !== 'README.md');
const roots = [];
const make = notes => { const root = tree(notes); roots.push(root); return root; };

try {
  // 1. Released, nothing waiting: nothing happens.
  {
    const root = make();
    assert.deepEqual(prepareRelease({ root, released: true }), { publish: false, version: current, changed: false });
    assert.equal(versionOf(root), current);
  }

  // 2. Released, notes waiting: next number everywhere, notes folded in file-name order, folder emptied.
  {
    const root = make({ 'next/b-second.md': '- 第二条改动\n', 'next/a-first.md': '# 标题也算一行\n\n* 第一条改动\n' });
    assert.deepEqual(prepareRelease({ root, released: true }), { publish: true, version: next, changed: true });
    assert.equal(versionOf(root), next);
    assert.equal(JSON.parse(read(root, 'package.json')).version, `${next}.0`);
    assert.match(read(root, 'trade-order-system.html'), new RegExp(`class="app-version"[^>]*>V${next.replace('.', '\\.')}<`));
    assert.equal(read(root, `release-notes/v${next}.md`), '- 标题也算一行\n- 第一条改动\n- 第二条改动\n');
    assert.deepEqual(pendingIn(root), [], 'pending notes are consumed');
    assert.ok(fs.existsSync(path.join(root, 'release-notes', 'next', 'README.md')), 'the folder and its README stay');
    // Run again on the same tree, as the workflow would for the commit it just made: the number is
    // taken but not released yet, so it publishes that number and changes nothing.
    assert.deepEqual(prepareRelease({ root, released: false }), { publish: true, version: next, changed: false });
    assert.equal(versionOf(root), next, 'a retry does not take another number');
  }

  // 3. A version bumped by hand (or a release whose build failed): published as it is.
  {
    const root = make();
    assert.deepEqual(prepareRelease({ root, released: false }), { publish: true, version: current, changed: false });
    assert.equal(versionOf(root), current);
  }
  // ...and notes that came with it join that version instead of starting another.
  {
    const root = make({ 'next/late.md': '后来补的一条\n', [`v${current}.md`]: '- 已有的一条\n' });
    assert.deepEqual(prepareRelease({ root, released: false }), { publish: true, version: current, changed: true });
    assert.equal(versionOf(root), current);
    assert.equal(read(root, `release-notes/v${current}.md`), '- 已有的一条\n- 后来补的一条\n');
    assert.deepEqual(pendingIn(root), []);
  }

  // 4. Notes the update dialog could not show stop the release before any number is taken.
  {
    const root = make({ 'next/empty.md': '\n\n', 'next/long.md': `${'长'.repeat(101)}\n`, 'next/many.md': '一\n二\n三\n四\n' });
    const problems = checkPendingNotes(root);
    assert.equal(problems.length, 3, problems.join('; '));
    assert.throws(() => prepareRelease({ root, released: true }), /Release notes need fixing/);
    assert.equal(versionOf(root), current, 'nothing was bumped');
    assert.equal(pendingIn(root).length, 3, 'nothing was consumed');
  }
  assert.deepEqual(noteLines('## 标题\n- 一\n* 二\n\n  三  \n'), ['标题', '一', '二', '三']);
  assert.deepEqual(checkPendingNotes(repo), [], 'the notes waiting in this repository are valid');

  // 5. The command the workflow runs prints one line of JSON.
  {
    const root = make({ 'next/one.md': '一条改动\n' });
    const output = execFileSync(process.execPath, [path.join(__dirname, 'prepare-release.js'), '--released', 'yes', '--root', root], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { publish: true, version: next, changed: true });
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, 'prepare-release.js'), '--root', root], { stdio: 'pipe' }), /Usage/);
  }

  // 6. The workflow around it.
  const yml = read(repo, '.github/workflows/release.yml');
  assert.match(yml, /node scripts\/prepare-release\.js --released "\$RELEASED"/);
  assert.match(yml, /if \[ "\$\(tip\)" != "\$SHA" \]; then[\s\S]{0,200}publish=false/, 'the version commit only goes on top of the commit CI tested');
  assert.match(yml, /git commit -m "Release V\$VERSION"\s*\n\s*if ! git push origin HEAD:refs\/heads\/main; then/, 'pushed to main, never forced');
  assert.doesNotMatch(yml, /push[^\n]*(--force|-f\b)/, 'no force push');
  assert.match(yml, /Could not push the version commit to main\."\s*\n\s*exit 1/, 'a refused push is an error, not a silent skip');
  assert.match(yml, /Release V\[0-9\]\+\\\.\[0-9\]\+\$'; then\s*\n\s*CHECK="\$\(git rev-parse "\$SHA\^"\)"/, 'a manual run on the version commit checks the CI of its parent');
  assert.match(yml, /--notes-file "release-notes\/v\$VERSION\.md"/, 'the release text is the folded notes');
  assert.ok(yml.indexOf('node scripts/check-project.js') < yml.indexOf('git commit -m "Release V$VERSION"'), 'the bumped tree is checked before it is committed');

  // 7. The gate step itself, run under bash against a local "origin" with a stub gh.
  const stepStart = yml.indexOf('      - name: Decide the version and commit it');
  const runStart = yml.indexOf('        run: |\n', stepStart);
  assert.ok(stepStart > 0 && runStart > stepStart);
  const scriptLines = [];
  for (const line of yml.slice(runStart + '        run: |\n'.length).split('\n')) {
    if (line.trim() && !line.startsWith('          ')) break;
    scriptLines.push(line.slice(10));
  }
  const gateScript = scriptLines.join('\n');
  assert.match(gateScript, /^CURRENT=/, 'the step script was extracted');

  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  // A repository like this one (every file, no history) with its own bare origin; `released` is what the stub gh answers.
  function sandbox({ note = '', released = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-gate-'));
    roots.push(dir);
    const work = path.join(dir, 'work');
    for (const file of tracked) {
      if (file.startsWith('release-notes/next/') && !file.endsWith('README.md')) continue;
      if (!fs.existsSync(path.join(repo, file))) continue;
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.copyFileSync(path.join(repo, file), path.join(work, file));
    }
    if (note) fs.writeFileSync(path.join(work, 'release-notes', 'next', 'change.md'), note);
    git(work, 'init', '-q');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    const origin = path.join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', origin);
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const answer = released === true ? 'echo v0.0\nexit 0' : `echo "gh: ${released === false ? 'Not Found (HTTP 404)' : released}" >&2\nexit 1`;
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${answer}\n`, { mode: 0o755 });
    return { dir, work, origin, bin, sha: git(work, 'rev-parse', 'HEAD') };
  }
  function runGate(box) {
    const outputFile = path.join(box.dir, 'output');
    fs.writeFileSync(outputFile, '');
    let status = 0;
    let log;
    try {
      log = execFileSync('bash', ['-e', '-c', gateScript], { cwd: box.work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${box.bin}${path.delimiter}${process.env.PATH}`, SHA: box.sha, GITHUB_OUTPUT: outputFile, GIT_CONFIG_GLOBAL: '/dev/null' } });
    } catch (error) { status = error.status; log = `${error.stdout}${error.stderr}`; }
    const output = Object.fromEntries(fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map(line => line.split('=')));
    return { status, log, output, tip: git(box.origin, 'rev-parse', 'refs/heads/main') };
  }

  // Notes waiting: one commit by the bot on top of the tested commit, on main, and that is what gets built.
  {
    const box = sandbox({ note: '一条用户能看到的改动\n' });
    const result = runGate(box);
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.output, { version: next, sha: result.tip, publish: 'true' });
    assert.notEqual(result.tip, box.sha);
    assert.equal(git(box.origin, 'log', '-1', '--format=%an|%s|%P', result.tip), `github-actions[bot]|Release V${next}|${box.sha}`);
    const changed = git(box.origin, 'diff', '--name-status', box.sha, result.tip).split('\n').sort();
    assert.deepEqual(changed, ['M\tREADME.md', 'M\tVERSION', 'M\tpackage-lock.json', 'M\tpackage.json', 'M\ttrade-order-system.html',
      `A\trelease-notes/v${next}.md`, 'D\trelease-notes/next/change.md'].sort(), 'the version commit touches the version and the notes, nothing else');
    assert.equal(git(box.origin, 'show', `${result.tip}:release-notes/v${next}.md`), '- 一条用户能看到的改动');
  }
  // Nothing waiting: nothing is committed or published.
  {
    const box = sandbox();
    const result = runGate(box);
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.output, { version: current, publish: 'false' });
    assert.equal(result.tip, box.sha);
  }
  // A version nobody has released yet, no notes: published from the tested commit itself.
  {
    const box = sandbox({ released: false });
    const result = runGate(box);
    assert.deepEqual(result.output, { version: current, sha: box.sha, publish: 'true' });
    assert.equal(result.tip, box.sha);
  }
  // main moved on after the tested commit: left to the CI run of the newer commit.
  {
    const box = sandbox({ note: '一条改动\n' });
    const other = path.join(box.dir, 'other');
    git(box.dir, 'clone', '-q', box.origin, other);
    fs.writeFileSync(path.join(other, 'later.txt'), 'later\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'a later merge');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const later = git(other, 'rev-parse', 'HEAD');
    const result = runGate(box);
    assert.equal(result.status, 0, result.log);
    assert.equal(result.output.publish, 'false');
    assert.equal(result.tip, later, 'main is untouched');
    assert.equal(git(box.origin, 'show', `${later}:release-notes/next/change.md`), '一条改动', 'the note is still waiting');
  }
  // GitHub did not answer whether the version is released: stop, rather than guess "not released".
  {
    const box = sandbox({ note: '一条改动\n', released: 'Bad Gateway (HTTP 502)' });
    const result = runGate(box);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /Could not find out whether v[\d.]+ is released: gh: Bad Gateway/);
    assert.deepEqual(result.output, {});
    assert.equal(result.tip, box.sha);
  }
  // The push is refused although main has not moved (a protected branch): an error, not a silent skip.
  {
    const box = sandbox({ note: '一条改动\n' });
    fs.writeFileSync(path.join(box.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
    const result = runGate(box);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /Could not push the version commit to main/);
    assert.notEqual(result.output.publish, 'true');
    assert.equal(result.tip, box.sha);
  }

  console.log('Prepare release passed: nothing to do without notes; notes take the next number and are folded into the release text; a hand-bumped version is published as is; bad notes stop the release; the workflow step, run against a local origin, commits one version commit on top of the tested commit, leaves a moved main alone, and fails loudly when GitHub does not answer or the push is refused.');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
