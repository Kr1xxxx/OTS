#!/usr/bin/env node
// Saving from the order detail drawer, compared with the recorded baseline (half 1 of the orders).
// What is recorded and how to regenerate it: scripts/helpers/drawer-save-matrix.js.
const { launchBrowser, openBoard } = require('./helpers/board-page');
const { runMatrix } = require('./helpers/drawer-save-matrix');

runMatrix({ part:1, launchBrowser, openBoard, port:47993 }).catch(error => { console.error(error); process.exitCode = 1; });
