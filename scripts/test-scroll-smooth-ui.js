// 上下滚动顺不顺，守两条（V3.204 起 Mac App 里滚轮一顿一顿的）：
// 1. 一直在跑的动画（infinite）只许动 transform 和 opacity。WebKit 把这两样交给合成层；别的属性（box-shadow、背景……）
//    每一帧都要主线程重画，页面什么都不做时也在画，滚轮排在后面。只在等待时出现的加载骨架和流光例外，见 transientLoaders。
// 2. document / window 上的滚轮监听都是 passive。WebKit 里页面级有一个能拦滚轮的监听，页面上每一下滚轮都要先等主线程；
//    要拦滚轮的（弹窗、菜单到头不传给页面）挂在那个元素自己身上。
// 第 1 条先读样式表（所有状态），再在打开的页面里用 getAnimations() 看工作台（醒着的时钟）和日历（今天）实际在跑的动画。
const assert = require('node:assert/strict');
const { launchBrowser, openBoard, base } = require('./helpers/board-page');
const { html } = require('./helpers/page-source');

const composited = new Set(['transform', 'opacity']);
// Loading placeholders: they run only while the page waits for data or for the AI, then the class goes away.
const transientLoaders = new Map([
  ['uiSweep', 'skeletons and the AI-reading shimmer, only while waiting'],
  ['subsShimmer', 'renewal page skeleton, only while loading']
]);

// --- 1a. stylesheet: every infinite animation names keyframes that touch transform / opacity only.
const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const keyframes = new Map();
for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
  let depth = 1;
  let index = match.index + match[0].length;
  while (depth && index < css.length) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') depth -= 1;
    index += 1;
  }
  const body = css.slice(match.index + match[0].length, index - 1);
  const props = new Set([...body.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:/g)].map(m => m[1]));
  keyframes.set(match[1], new Set([...(keyframes.get(match[1]) || []), ...props]));
}
const infinite = [...css.matchAll(/animation(?:-name)?\s*:\s*([^;}]*)/g)]
  .map(m => m[1])
  .filter(value => /\binfinite\b/.test(value))
  .flatMap(value => value.split(/\s+/).filter(token => keyframes.has(token)));
assert.ok(infinite.length >= 5, `found the infinite animations (${infinite.join(', ')})`);
for (const name of new Set(infinite)) {
  if (transientLoaders.has(name)) continue;
  const props = [...keyframes.get(name)];
  assert.deepEqual(props.filter(prop => !composited.has(prop)), [], `@keyframes ${name} runs forever and animates ${props.join(', ')}`);
}

// --- 2. scripts: wheel listeners on document / window are passive.
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
function callAt(source, start) {
  let depth = 0;
  for (let index = source.indexOf('(', start); index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed call at ${start}`);
}
let pageLevelWheel = 0;
for (const match of scripts.matchAll(/\b(?:document|window|document\.body|document\.documentElement)\.addEventListener\(\s*(?:'wheel'|"wheel"|type\b)/g)) {
  const call = callAt(scripts, match.index);
  // `type` covers ['wheel', ...].forEach(type => window.addEventListener(type, ...)); look at the list in front of it.
  if (/\(\s*type\b/.test(match[0]) && !/'wheel'[^\]]*\]\.forEach\(\s*type\s*=>\s*$/.test(scripts.slice(Math.max(0, match.index - 200), match.index))) continue;
  pageLevelWheel += 1;
  assert.match(call, /passive\s*:\s*true/, `page-level wheel listener that can block scrolling:\n${call.slice(0, 300)}`);
}
assert.ok(pageLevelWheel >= 1, 'found the passive page-level wheel listener (cancelPendingScrollResets)');
assert.doesNotMatch(html, /\sonwheel\s*=/i, 'no inline onwheel handlers');

// --- 1b. the running page: what actually animates forever on the dashboard and the calendar.
const today = new Date();
const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const orders = Array.from({ length:8 }, (_, i) => ({ ...base, id:`s${i}`, num:`S${i}`, client:`Scroll Buyer ${i}`, amount:300 + i, paidAmount:300 + i, orderType:'全款订单', stage:'production', createdAt:todayText, orderMonth:todayText.slice(0, 7), updated:`${todayText} 09:00` }));

const foreverAnimations = page => page.evaluate(() => document.getAnimations()
  .filter(animation => animation.effect?.getComputedTiming().iterations === Infinity)
  .map(animation => ({
    name:animation.animationName || animation.id || '',
    target:`${animation.effect.target?.className || ''}${animation.effect.pseudoElement || ''}`,
    props:[...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame)))]
      .filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))
  })));
const checkForever = (list, where) => {
  for (const animation of list) {
    if (transientLoaders.has(animation.name)) continue;
    assert.deepEqual(animation.props.filter(prop => !composited.has(prop)), [], `${where}: ${animation.name} on ${animation.target} animates ${animation.props.join(', ')}`);
  }
};

(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await openBoard(browser, { orders }, { width:1440, height:900 });
    // The clocks are awake by local time; make every one awake so the test does not depend on the hour.
    await page.evaluate(() => document.querySelectorAll('.world-clock').forEach(clock => clock.classList.add('is-awake')));
    await page.waitForFunction(() => document.getAnimations().some(a => a.animationName === 'uiRing' && a.effect.pseudoElement === '::after'));
    const dashboard = await foreverAnimations(page);
    assert.ok(dashboard.some(a => a.name === 'uiRing' && /world-clock/.test(a.target)), `clock ring runs: ${JSON.stringify(dashboard)}`);
    checkForever(dashboard, 'dashboard');
    // The ring sits on the dot: same size and centre as the dot (the dot is ::before, the ring ::after of the clock).
    const ring = await page.evaluate(() => {
      const clock = document.querySelector('.world-clock.is-awake');
      const dot = getComputedStyle(clock, '::before');
      const after = getComputedStyle(clock, '::after');
      return { dot:[dot.width, dot.height], ring:[after.width, after.height], position:after.position, z:after.zIndex, isolation:getComputedStyle(clock).isolation };
    });
    assert.deepEqual(ring.ring, ring.dot);
    assert.equal(ring.position, 'absolute');
    assert.equal(ring.z, '-1');
    assert.equal(ring.isolation, 'isolate');

    await page.evaluate(() => setPage('calendar'));
    await page.waitForFunction(() => document.getAnimations().some(a => a.animationName === 'uiRingLg'));
    checkForever(await foreverAnimations(page), 'calendar');

    assert.deepEqual(errors, []);
    console.log('scroll smooth: forever animations are transform/opacity only, page-level wheel listeners are passive');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
