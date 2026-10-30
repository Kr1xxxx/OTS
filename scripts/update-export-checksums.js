#!/usr/bin/env node
// Rewrites EXPORT_CHECKSUMS.sha256 for every file in SOURCE_MANIFEST.txt except itself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = fs.readFileSync(path.join(root, 'SOURCE_MANIFEST.txt'), 'utf8')
  .split('\n').filter(Boolean).filter(file => file !== 'EXPORT_CHECKSUMS.sha256');
const missing = files.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) throw new Error(`Manifest lists missing files: ${missing.join(', ')}`);
const lines = files.map(file => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}  ${file}`);
fs.writeFileSync(path.join(root, 'EXPORT_CHECKSUMS.sha256'), `${lines.join('\n')}\n`);
console.log(`Updated checksums for ${files.length} files.`);
