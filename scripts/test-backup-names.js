#!/usr/bin/env node
// Backup file names and which backups are kept (mac-app/backup-names.js), and what a restore would
// change (mac-app/state-diff.js). Both work on names and plain data, so they are tested without a server.
const assert = require('node:assert/strict');
const { backupReasons, parseBackupName, isOtsBackupFile, backupsToRotate } = require('../mac-app/backup-names');
const { payloadCounts, diffStateData } = require('../mac-app/state-diff');

const pad = n => String(n).padStart(2, '0');
// A fixed "now" in local time, as the names are: nothing here reads the clock.
const now = new Date(2026, 5, 30, 12, 0, 0).getTime();
const hour = 60 * 60 * 1000;
const day = 24 * hour;
function nameAt(time, { tag = 'abc123', reason = '', extension = 'sqlite' } = {}) {
  const d = new Date(time);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `trade-order-data-${stamp}${tag ? `-${tag}` : ''}${reason ? `-before-${reason}` : ''}.${extension}`;
}

// Names.
const parsed = parseBackupName('trade-order-data-20260630-113000-abc123-before-import-2.sqlite');
assert.deepEqual({ ...parsed, at:new Date(parsed.at).getHours() }, { name:'trade-order-data-20260630-113000-abc123-before-import-2.sqlite', at:11, tag:'abc123', reason:'import' });
assert.equal(parseBackupName('trade-order-data-20260630-113000.sqlite').tag, '', 'old backups carry no database id');
for (const reason of backupReasons) assert.equal(parseBackupName(nameAt(now, { reason })).reason, reason);
for (const foreign of ['notes.sqlite', 'trade-order-data.sqlite', 'trade-order-data-20260630-113000-before-holiday.sqlite', 'trade-order-data-20260630-113000.sqlite-wal', 'x-trade-order-data-20260630-113000.sqlite']) {
  assert.equal(isOtsBackupFile(foreign), false, `${foreign} is not one of ours`);
  assert.equal(parseBackupName(foreign), null);
}
assert.equal(isOtsBackupFile(nameAt(now, { extension:'json' })), true);
assert.equal(isOtsBackupFile(nameAt(now, { extension:'json' }), 'sqlite'), false);

// Regular backups: everything from the last 48 hours, then the newest of each day for 30 days, then the
// newest of each week for 12 weeks. (More than 30 in total, so the "newest 30" rule alone does not explain it.)
const lastTwoDays = Array.from({ length:40 }, (_, i) => nameAt(now - (i + 1) * hour));
const daily = [];
for (let age = 3; age < 30; age += 1) daily.push(nameAt(now - age * day), nameAt(now - age * day - 3 * hour));
const weekly = Array.from({ length:53 }, (_, i) => nameAt(now - (31 + i) * day));
const ancient = [nameAt(now - 90 * day), nameAt(now - 200 * day)];
const removed = new Set(backupsToRotate([...lastTwoDays, ...daily, ...weekly, ...ancient], { now, tag:'abc123' }));
lastTwoDays.forEach(name => assert.equal(removed.has(name), false, `${name} is under 48 hours old`));
for (let i = 0; i < daily.length; i += 2) {
  assert.equal(removed.has(daily[i]), false, 'the newest backup of a day is kept for 30 days');
  assert.equal(removed.has(daily[i + 1]), true, 'an older backup of the same day goes');
}
const keptWeekly = weekly.filter(name => !removed.has(name));
assert.ok(keptWeekly.length >= 7 && keptWeekly.length <= 9, `one backup a week is kept between 30 and 84 days, got ${keptWeekly.length}`);
ancient.forEach(name => assert.equal(removed.has(name), true, 'nothing regular is kept past 12 weeks'));

// With few backups the newest 30 stay, however old.
const few = Array.from({ length:30 }, (_, i) => nameAt(now - (200 + i) * day));
assert.deepEqual(backupsToRotate(few, { now, tag:'abc123' }), []);

// Snapshots taken before an operation: 90 days, and the newest 20 whatever their age.
const snapshots = Array.from({ length:25 }, (_, i) => nameAt(now - (100 + i) * day, { reason:'change' }));
const recentSnapshot = nameAt(now - 80 * day, { reason:'restore' });
const snapshotRemoved = backupsToRotate([...snapshots, recentSnapshot], { now, tag:'abc123' });
assert.deepEqual(snapshotRemoved.sort(), snapshots.slice(19).sort(), 'the newest 20 snapshots stay, older ones past 90 days go');

// Another Mac's backups in the same folder, other files and .json exports are never listed for removal;
// backups from before the id existed count as this Mac's.
const mixed = [
  ...Array.from({ length:35 }, (_, i) => nameAt(now - (200 + i) * day, { tag:'ffffff' })),
  ...Array.from({ length:35 }, (_, i) => nameAt(now - (300 + i) * day, { tag:'' })),
  nameAt(now - 400 * day, { extension:'json' }),
  'holiday-photos.sqlite'
];
const mixedRemoved = backupsToRotate(mixed, { now, tag:'abc123' });
assert.equal(mixedRemoved.length, 5);
assert.ok(mixedRemoved.every(name => parseBackupName(name).tag === ''), 'only this Mac\'s backups are rotated');

// What a restore would change.
const order = (id, extra = {}) => ({ id, num:`PI-${id}`, client:'Customer A', amount:100, ...extra });
const current = {
  orders:[order('1'), order('2'), order('3', { feishuNotification:{ sentAt:'x' } }), ...Array.from({ length:10 }, (_, i) => order(`gone-${i}`))],
  trashOrders:[order('4')],
  deletedOrders:[],
  customers:{ 'Customer A':{ country:'US' }, 'Customer B':{ country:'UK' }, 'Customer C':{} }
};
const next = {
  orders:[order('1'), order('2', { amount:150 }), order('3'), order('4'), order('5')],
  trashOrders:[],
  deletedOrders:[],
  customers:{ 'Customer A':{ country:'US' }, 'Customer B':{ country:'FR' }, 'Customer D':{} }
};
assert.deepEqual(payloadCounts(current), { orders:13, trashOrders:1, deletedOrders:0, customers:3 });
const diff = diffStateData(current, next);
assert.equal(diff.orders.added, 1);
assert.equal(diff.orders.changed, 2, 'an edited order and one that moved out of the trash; a Feishu delivery mark alone is no change');
assert.equal(diff.orders.removed, 10);
assert.deepEqual(diff.orders.removedNums, Array.from({ length:8 }, (_, i) => `PI-gone-${i}`), 'the first eight order numbers that would disappear');
assert.deepEqual(diff.customers, { added:1, changed:1, removed:1, removedNames:['Customer C'] });
assert.deepEqual(diffStateData({}, {}), { orders:{ added:0, changed:0, removed:0, removedNums:[] }, customers:{ added:0, changed:0, removed:0, removedNames:[] } });
// A backup from before customers had ids: the two id fields alone are not a change the user would see.
const withIds = { orders:[{ ...order('1'), customerId:'made-up-id-1' }], trashOrders:[], deletedOrders:[], customers:{ 'Customer A':{ country:'US', id:'made-up-id-1' } } };
const withoutIds = { orders:[order('1')], trashOrders:[], deletedOrders:[], customers:{ 'Customer A':{ country:'US' } } };
assert.deepEqual(diffStateData(withIds, withoutIds), { orders:{ added:0, changed:0, removed:0, removedNums:[] }, customers:{ added:0, changed:0, removed:0, removedNames:[] } });

console.log('Backup names passed: naming, tiered retention, snapshots, other machines left alone; restore preview counts.');
