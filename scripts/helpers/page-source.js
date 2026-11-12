// The page's source for tests that run one of its functions in `vm`: the HTML as it ships, and
// extractFunction(name), which returns the function's complete source (from `function name(` or
// `async function name(` up to the first closing brace after which the slice compiles on its own).
// The test then runs what the page runs; nothing is added to the page for a test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePath = path.join(__dirname, '..', '..', 'trade-order-system.html');
const html = fs.readFileSync(pagePath, 'utf8');

// source: another text to search (another file's source); defaults to the page.
// optional: return '' instead of throwing when the page has no such function.
function extractFunction(name, { source = html, optional = false } = {}) {
  const escaped = name.replace(/[$]/g, '\\$');
  const start = source.search(new RegExp(`(?<![\\w$])(?:async )?function ${escaped}\\(`));
  if (start < 0) {
    if (optional) return '';
    throw new Error(`Missing production function: ${name}`);
  }
  for (let index = source.indexOf('{', start); index >= 0 && index < source.length; index += 1) {
    if (source[index] !== '}') continue;
    const candidate = source.slice(start, index + 1);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (_) {
      // Not the closing brace of the function yet: keep scanning.
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}

module.exports = { pagePath, html, extractFunction };
