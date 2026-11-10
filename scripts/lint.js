#!/usr/bin/env node
// Lints the JavaScript sources, including every inline <script> of trade-order-system.html
// (extracted with their original line numbers so reports point at the HTML file).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const htmlFile = path.join(root, 'trade-order-system.html');
const extracted = path.join(root, '.lint', 'trade-order-system.js');

// Every inline script, each at its own line and column, the rest of the file blanked out.
// All of them share the page's global scope, so they are linted as one script.
// (V3.112 added a one-line script above the main one and the lint, which took the first
// <script> only, silently stopped checking the 24,000-line main script.)
function extractInlineScripts(html) {
  const blocks = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    if (/\bsrc\s*=/.test(match[1])) throw new Error('trade-order-system.html loads an external script; the lint only knows inline ones');
    const start = match.index + match[0].indexOf('>') + 1;
    blocks.push({ start, end: start + match[2].length });
  }
  if (!blocks.length) throw new Error('trade-order-system.html has no inline <script>');
  let source = '';
  let cursor = 0;
  for (const block of blocks) {
    source += html.slice(cursor, block.start).replace(/[^\n]/g, ' ') + html.slice(block.start, block.end);
    cursor = block.end;
  }
  return { source, count: blocks.length, bytes: blocks.reduce((sum, block) => sum + block.end - block.start, 0) };
}

async function main() {
  const { ESLint } = require('eslint');
  const scripts = extractInlineScripts(fs.readFileSync(htmlFile, 'utf8'));
  fs.mkdirSync(path.dirname(extracted), { recursive: true });
  fs.writeFileSync(extracted, scripts.source);

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
  else console.log(`Lint passed (${scripts.count} inline scripts, ${Math.round(scripts.bytes / 1024)} KB of page script).`);
}

module.exports = { extractInlineScripts };

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
