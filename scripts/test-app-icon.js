#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const icon = path.resolve(__dirname, '..', 'mac-app', 'AppIcon-1024.png');
const source = path.resolve(__dirname, '..', 'mac-app', 'AppIcon-Source.png');
const output = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', icon], { encoding: 'utf8' });
const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
const hasAlpha = output.match(/hasAlpha:\s*(\w+)/)?.[1];

assert.equal(width, 1024, 'App icon source must be 1024px wide');
assert.equal(height, 1024, 'App icon source must be 1024px high');
assert.equal(hasAlpha, 'yes', 'App icon source needs transparent corners instead of a solid square');

const visualMetrics = execFileSync('python3', ['-c', `
from PIL import Image, ImageChops, ImageStat
source = Image.open(${JSON.stringify(source)}).convert('RGB')
artwork_size = 922
expected = Image.new('RGB', (1024, 1024), source.getpixel((0, 0)))
expected.paste(source.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS), ((1024 - artwork_size) // 2, (1024 - artwork_size) // 2))
output = Image.open(${JSON.stringify(icon)}).convert('RGB')
box = (128, 128, 896, 896)
diff = ImageChops.difference(expected.crop(box), output.crop(box))
bright = Image.eval(output.convert('L'), lambda p: 255 if p > 90 else 0).getbbox()
margin = min(bright[0], bright[1], 1024 - bright[2], 1024 - bright[3])
print(f'{sum(ImageStat.Stat(diff).mean) / 3} {margin}')
`], { encoding:'utf8' }).trim().split(/\s+/).map(Number);
const [visualDifference, markMargin] = visualMetrics;
assert.ok(visualDifference < 2, `App icon must preserve the scaled original three-ring mark; RGB difference was ${visualDifference.toFixed(2)}`);
assert.ok(markMargin >= 120, `App icon three-ring mark needs breathing room; minimum margin was ${markMargin}px`);

console.log('App icon test passed: original three-ring mark preserved with 1024px transparent rounded corners.');
