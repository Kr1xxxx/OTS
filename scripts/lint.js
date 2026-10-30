#!/usr/bin/env node
// Lints the JavaScript sources, including the inline <script> of trade-order-system.html
// (extracted with its original line numbers so reports point at the HTML file).
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const root = path.resolve(__dirname, '..');
const htmlFile = path.join(root, 'trade-order-system.html');
const extracted = path.join(root, '.lint', 'trade-order-system.js');

(async () => {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) throw new Error('trade-order-system.html has no inline <script>');
  const before = html.slice(0, start + '<script>'.length);
  const leadingLines = before.split('\n').length - 1;
  const lastLine = before.slice(before.lastIndexOf('\n') + 1);
  fs.mkdirSync(path.dirname(extracted), { recursive: true });
  fs.writeFileSync(extracted, '\n'.repeat(leadingLines) + ' '.repeat(lastLine.length) + html.slice(start + '<script>'.length, end));

  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(['mac-app', 'scripts', 'chrome-extension', 'eslint.config.js', extracted]);
  for (const result of results) {
    if (result.filePath === extracted) result.filePath = htmlFile;
  }
  const formatter = await eslint.loadFormatter('stylish');
  const output = formatter.format(results);
  if (output) console.log(output);
  const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
  if (errors) process.exitCode = 1;
  else console.log('Lint passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
