// 页面里量文字对比度（WCAG）：前景色叠在一层层背景上（半透明的往上找），任意颜色写法（oklch、color-mix）交给 canvas 换成 sRGB。
// 先 `await page.evaluate(contrastHelpers)` 装上 window.__contrast，再用 contrast(page, selector)。
const contrastHelpers = () => {
  window.__rgba = color => {
    const ctx = (window.__ctx ||= Object.assign(document.createElement('canvas'), { width:1, height:1 }).getContext('2d', { willReadFrequently:true }));
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, bottom) => top.slice(0, 3).map((v, i) => v * top[3] + bottom[i] * (1 - top[3])).concat(1);
  window.__background = el => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const color = window.__rgba(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    return layers.reverse().reduce((acc, layer) => over(layer, acc), window.__rgba(getComputedStyle(document.body).backgroundColor));
  };
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  window.__contrast = (el, colorOverride = '') => {
    const bg = window.__background(el);
    const fg = over(window.__rgba(colorOverride || getComputedStyle(el).color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
  };
};
const contrast = (page, selector) => page.evaluate(selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return { ratio:window.__contrast(el), size:parseFloat(getComputedStyle(el).fontSize) };
}, selector);

module.exports = { contrastHelpers, contrast };
