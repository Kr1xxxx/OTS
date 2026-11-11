// A customer has a fixed id from the day the profile is created (`id` in the profile), and each order of that
// customer carries it as `customerId`. The name is still the key wherever it was: the customers table,
// `order.client`, the WhatsApp chats. The id says who is who when a name changes: the same id under another
// name is a rename, and nothing has to be guessed from "one name gone, one name new".
//
// The page gives new customers their id before it saves. What is here is the server's part: giving ids to data
// that has none yet (a database from before this, a restored backup, the first import from the JSON file), and
// reading renames out of a save.
const crypto = require('node:crypto');

const orderBuckets = ['orders', 'trashOrders', 'deletedOrders'];
const validCustomerId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value);
function newCustomerId() {
  return `c${crypto.randomBytes(9).toString('hex')}`;
}
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Gives every profile without a usable id one, and every order of a customer with a profile that customer's id.
// It only adds the two fields: no other value is touched, and an order whose customer has no profile is left alone.
// Changes `data` in place and returns how many profiles and orders it wrote to.
function fillCustomerIds(data, { newId = newCustomerId } = {}) {
  const customers = isRecord(data?.customers) ? data.customers : {};
  const used = new Set();
  let profiles = 0;
  // Profiles that already have an id keep it; a second profile with the same id is the one that gets a new one.
  Object.keys(customers).sort().forEach(name => {
    const id = isRecord(customers[name]) ? customers[name].id : '';
    if (validCustomerId(id) && !used.has(id)) used.add(id);
    else if (isRecord(customers[name])) delete customers[name].id;
  });
  Object.keys(customers).sort().forEach(name => {
    if (!isRecord(customers[name]) || validCustomerId(customers[name].id)) return;
    let id = newId();
    while (used.has(id)) id = newId();
    used.add(id);
    customers[name].id = id;
    profiles += 1;
  });
  let orders = 0;
  orderBuckets.forEach(bucket => (Array.isArray(data?.[bucket]) ? data[bucket] : []).forEach(order => {
    if (!isRecord(order) || !Object.hasOwn(customers, String(order.client || ''))) return;
    const id = customers[order.client]?.id;
    if (!validCustomerId(id) || order.customerId === id) return;
    order.customerId = id;
    orders += 1;
  }));
  return { profiles, orders };
}

// The same for a database, row by row, inside the caller's transaction. Returns the same counts.
function fillCustomerIdsInDatabase(db, options = {}) {
  const customerRows = db.prepare('SELECT name, data_json FROM customers').all();
  const orderRows = db.prepare('SELECT id, data_json FROM orders').all();
  const customers = {};
  customerRows.forEach(row => { Object.defineProperty(customers, row.name, { value:JSON.parse(row.data_json), enumerable:true, writable:true, configurable:true }); });
  const orders = orderRows.map(row => JSON.parse(row.data_json));
  const counts = fillCustomerIds({ customers, orders }, options);
  if (!counts.profiles && !counts.orders) return counts;
  const customerUpdate = db.prepare('UPDATE customers SET data_json = ? WHERE name = ?');
  customerRows.forEach(row => {
    const json = JSON.stringify(customers[row.name]);
    if (json !== row.data_json) customerUpdate.run(json, row.name);
  });
  const orderUpdate = db.prepare('UPDATE orders SET data_json = ? WHERE id = ?');
  orderRows.forEach((row, index) => {
    const json = JSON.stringify(orders[index]);
    if (json !== row.data_json) orderUpdate.run(json, row.id);
  });
  return counts;
}

// Whether a database still has a profile without an id, or an order that does not carry its customer's id.
function databaseNeedsCustomerIds(db) {
  const customers = {};
  db.prepare('SELECT name, data_json FROM customers').all().forEach(row => {
    Object.defineProperty(customers, row.name, { value:JSON.parse(row.data_json), enumerable:true, writable:true, configurable:true });
  });
  const orders = db.prepare('SELECT data_json FROM orders').all().map(row => JSON.parse(row.data_json));
  const counts = fillCustomerIds({ customers, orders });
  return counts.profiles > 0 || counts.orders > 0;
}

// The one-time fill for a database from before ids. `backup` runs first and has to answer { ok:true }; without
// that nothing is changed. Profiles and orders are then written in one transaction together with whatever
// `insideTransaction` does (the server raises its revision there): all of it lands, or none.
function addCustomerIdsOnce(db, { backup = null, insideTransaction = () => {}, newId } = {}) {
  if (!databaseNeedsCustomerIds(db)) return { ok:true, profiles:0, orders:0 };
  if (backup) {
    const saved = backup();
    if (!saved?.ok) return { ok:false, message:saved?.message || 'the backup was not made' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const counts = fillCustomerIdsInDatabase(db, newId ? { newId } : {});
    insideTransaction();
    db.exec('COMMIT');
    return { ok:true, ...counts };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* nothing was open */ }
    throw error;
  }
}

// The renames in a save: an id that was stored under one name and arrives under another.
// `stored` is the profiles in the database by name, `arriving` the profiles of the save by name.
//
// An id that appears twice on either side says nothing and is left out. So is a rename whose old name is still
// there with an id the database has never seen: that is what importing an older copy of the same data looks like
// (the old name comes back beside the current one), and the chats belong to the current one.
function customerRenamesById(stored = {}, arriving = {}) {
  const namesById = profiles => {
    const byId = new Map();
    const twice = new Set();
    Object.keys(profiles).forEach(name => {
      const id = isRecord(profiles[name]) ? profiles[name].id : '';
      if (!validCustomerId(id)) return;
      if (byId.has(id)) twice.add(id);
      else byId.set(id, name);
    });
    twice.forEach(id => byId.delete(id));
    return byId;
  };
  const before = namesById(stored);
  const after = namesById(arriving);
  const renames = [];
  after.forEach((to, id) => {
    const from = before.get(id);
    if (!from || from === to) return;
    const takenBy = Object.hasOwn(arriving, from) && isRecord(arriving[from]) ? arriving[from].id : '';
    const oldNameIsFree = !Object.hasOwn(arriving, from);
    const oldNameWentToAnotherStoredCustomer = validCustomerId(takenBy) && takenBy !== id && before.has(takenBy);
    if (oldNameIsFree || oldNameWentToAnotherStoredCustomer) renames.push({ from, to });
  });
  return renames;
}

module.exports = { validCustomerId, newCustomerId, fillCustomerIds, addCustomerIdsOnce, customerRenamesById };
