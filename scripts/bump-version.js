#!/usr/bin/env node
// Usage: npm run bump-version -- 3.90
// Updates every place check-project/check-release compare against VERSION.
// Merging the change to main publishes a GitHub Release that installed apps update to.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const next = process.argv[2];
const current = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+$/.test(next || '')) throw new Error('Usage: npm run bump-version -- <major.minor>, e.g. 3.90');
const [curMajor, curMinor] = current.split('.').map(Number);
const [major, minor] = next.split('.').map(Number);
if (major < curMajor || (major === curMajor && minor <= curMinor)) {
  throw new Error(`New version ${next} must be greater than ${current} (compare minor numerically: 3.90 > 3.89).`);
}

function edit(file, transform) {
  const full = path.join(root, file);
  const before = fs.readFileSync(full, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No version found to update in ${file}`);
  fs.writeFileSync(full, after);
}

const escaped = current.replace('.', '\\.');
fs.writeFileSync(path.join(root, 'VERSION'), `${next}\n`);
edit('package.json', text => text.replace(`"version": "${current}.0"`, `"version": "${next}.0"`));
edit('package-lock.json', text => text.replace(new RegExp(`("name": "trade-order-system",\\s*"version": )"${escaped}\\.0"`, 'g'), `$1"${next}.0"`));
edit('trade-order-system.html', text => text
  .replace(`aria-label="V${current}，`, `aria-label="V${next}，`)
  .replace(new RegExp(`(class="app-version"[^>]*>)V${escaped}<`), `$1V${next}<`));
edit('README.md', text => text.replace(`# Order Track System (OTS) V${current}`, `# Order Track System (OTS) V${next}`));
console.log(`Version ${current} → ${next}. Run npm run check, then node scripts/update-export-checksums.js.`);
