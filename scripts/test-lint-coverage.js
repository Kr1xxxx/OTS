#!/usr/bin/env node
// The lint must see the whole page script. From V3.112 to V3.143 it took only the first
// inline <script> (a one-liner added above the main one) and reported a clean pass while
// 24,000 lines went unchecked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractInlineScripts } = require('./lint');

const html = fs.readFileSync(path.join(__dirname, '..', 'trade-order-system.html'), 'utf8');
const { source, count, bytes } = extractInlineScripts(html);

// Same line and column for every character, so reports point at the HTML file.
assert.equal(source.split('\n').length, html.slice(0, html.lastIndexOf('</script>')).split('\n').length);
const renderAt = html.indexOf('\nfunction render() {');
assert.ok(renderAt > 0, 'the page script defines render()');
assert.equal(source.indexOf('\nfunction render() {'), renderAt, 'render() sits at the same offset in the extracted script');
assert.ok(bytes > html.length / 3, `only ${bytes} bytes of script were extracted from a ${html.length}-byte page`);

// Nothing outside the scripts leaks in, and nothing inside them is lost.
const scriptText = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.equal(count, scriptText.length);
assert.equal(source.replace(/\s+/g, ''), scriptText.join('').replace(/\s+/g, ''));

// Two scripts on one page, markup between them: both kept, the markup blanked.
const page = '<p>x</p><script>a()</script>\n<b>y</b><script type="module">\nb()\n</script>';
const sample = extractInlineScripts(page);
assert.equal(sample.count, 2);
assert.equal(sample.source.indexOf('a()'), page.indexOf('a()'));
assert.equal(sample.source.indexOf('b()'), page.indexOf('b()'));
assert.equal(sample.source.replace(/ /g, ''), 'a()\n\nb()\n');
assert.throws(() => extractInlineScripts('<script src="x.js"></script>'), /external script/);
assert.throws(() => extractInlineScripts('<p>no script</p>'), /no inline/);

console.log('Lint coverage test passed.');
