// 顶栏四个时钟：当地 1:00–7:59 照旧，其他时间加 is-awake（亮绿点）。时间用固定的假时钟，不依赖今天。
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html, extractFunction } = require('./helpers/page-source');

const awakeSource = extractFunction('worldClockAwake');
const context = vm.createContext({});
vm.runInContext(awakeSource, context);
for (const [time, awake] of [['00:00', true], ['00:59', true], ['01:00', false], ['04:30', false], ['07:59', false], ['08:00', true], ['14:30', true], ['23:59', true], ['24:10', true]]) {
  assert.equal(context.worldClockAwake(time), awake, time);
}

// renderWorldClocks 跑在一个最小的假 DOM 上：北京 22:30（UTC 14:30）时美西 06:30、澳洲 01:30 在睡，美东、伦敦醒着。
const defsMatch = html.match(/const worldClockDefs = \[[\s\S]*?\];/);
assert.ok(defsMatch, 'worldClockDefs');
const fixed = Date.UTC(2026, 10, 20, 14, 30);
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } }
function fakeStrip() {
  const strip = { clocks:[], set innerHTML(markup) {
    strip.clocks = [...markup.matchAll(/<span class="world-clock"><span>([^<]*)<\/span><strong><\/strong><\/span>/g)].map(m => {
      const classes = new Set(['world-clock']);
      const strong = { textContent:'' };
      return { label:m[1], strong, classes, querySelector:() => strong, classList:{ toggle:(name, on) => (on ? classes.add(name) : classes.delete(name)) } };
    });
    strip.builds += 1;
  }, builds:0, querySelectorAll:() => strip.clocks };
  return strip;
}
const strip = fakeStrip();
const page = vm.createContext({ Date:FixedDate, Intl, document:{ getElementById:id => (id === 'worldClockStrip' ? strip : null) } });
vm.runInContext([defsMatch[0], extractFunction('zoneTime'), awakeSource, extractFunction('renderWorldClocks'), 'this.renderWorldClocks = renderWorldClocks;'].join('\n'), page);
page.renderWorldClocks();
const seen = strip.clocks.map(c => `${c.label} ${c.strong.textContent} ${c.classes.has('is-awake') ? 'awake' : 'asleep'}`);
assert.deepEqual(seen, ['美西 06:30 asleep', '美东 09:30 awake', '伦敦 14:30 awake', '澳洲 01:30 asleep']);
// 每分钟刷新只改字和状态，不重建元素（重建会让呼吸动画每分钟从头跳一下）。
page.renderWorldClocks();
assert.equal(strip.builds, 1);

// 绿点的样式在上层（html[data-theme]），用的是现有的绿色令牌。
// 呼吸圈是 ::after，只动 transform / opacity（scripts/test-scroll-smooth-ui.js 守着）。
assert.match(html, /html\[data-theme\] \.world-clock\.is-awake::before \{[^}]*background:var\(--s-green\)/);
assert.match(html, /html\[data-theme\] \.world-clock\.is-awake::after \{[^}]*animation:uiRing /);
assert.match(html, /@keyframes uiRing \{/);
console.log('world clock awake: ok');
