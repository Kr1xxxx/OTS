#!/usr/bin/env node
// <html> carries data-theme from the first byte. The stylesheet's newer half is written as `html[data-theme] …` and the
// older rules under it are deleted, so a page painted before the main script sets the theme (it runs some 300 ms into
// a start) must already show the finished look: before V3.158 that first frame had an orange 「新建客户」 button and
// unstyled renewal sub-items. Loaded with scripts off, the page must match the booted light page.
const assert = require('node:assert/strict');
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const elements = {
  '「新建客户」按钮': '#topNewCustomerBtn',
  '侧栏续费子项': '.nav-sub-item',
  '侧栏': '.sidebar',
  '页面': 'body'
};
const props = ['color', 'background-color', 'border-top-color', 'border-top-left-radius', 'font-size', 'font-weight', 'padding-top', 'padding-left', 'min-height'];
const read = page => page.evaluate(({ elements, props }) => Object.fromEntries(Object.entries(elements).map(([name, selector]) => {
  const el = document.querySelector(selector);
  if (!el) return [name, null];
  const cs = getComputedStyle(el);
  return [name, Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]))];
})), { elements, props });

(async () => {
  assert.match(html, /<html lang="zh-CN" data-theme="light">/, 'the <html> tag carries data-theme');
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport:{ width:1440, height:920 }, javaScriptEnabled:false });
    const page = await context.newPage();
    await page.route('**/*', route => route.fulfill({ contentType:'text/html', body:html }));
    await page.goto('http://127.0.0.1:47996/trade-order-system.html');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'data-theme is there before any script runs');
    const before = await read(page);
    await context.close();

    const booted = await openBoard(browser, { orders:[] }, { theme:'light', port:47996 });
    const after = await read(booted.page);
    assert.deepEqual(booted.errors, []);
    await booted.context.close();

    for (const name of Object.keys(elements)) {
      assert.ok(before[name] && after[name], `${name} exists`);
      assert.deepEqual(before[name], after[name], `${name} looks the same before the script sets the theme as after`);
    }
    console.log('Static theme attribute test passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
