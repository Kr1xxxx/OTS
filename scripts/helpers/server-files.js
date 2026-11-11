// The server's own files are every .js directly in mac-app/: the build copies exactly these into the
// app, the release check compares them, and tests that stand up a bundle-shaped folder copy them.
// One rule instead of a list in each of those places.
const fs = require('fs');
const path = require('path');

const serverDir = path.resolve(__dirname, '..', '..', 'mac-app');

function serverFiles() {
  return fs.readdirSync(serverDir).filter(name => name.endsWith('.js')).sort();
}

function copyServerFiles(target) {
  for (const file of serverFiles()) fs.copyFileSync(path.join(serverDir, file), path.join(target, file));
}

module.exports = { serverDir, serverFiles, copyServerFiles };
