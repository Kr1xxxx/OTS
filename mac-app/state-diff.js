// What a restore would change: the current data against the data in a backup.
const orderBuckets = ['orders', 'trashOrders', 'deletedOrders'];

function payloadCounts(data = {}) {
  return {
    orders:(data.orders || []).length,
    trashOrders:(data.trashOrders || []).length,
    deletedOrders:(data.deletedOrders || []).length,
    customers:Object.keys(data.customers || {}).length
  };
}
function orderIndexById(data = {}) {
  const map = new Map();
  orderBuckets.forEach(bucket => (Array.isArray(data[bucket]) ? data[bucket] : []).forEach(order => {
    if (order && order.id) map.set(String(order.id), { bucket, order });
  }));
  return map;
}
// 「当前 → 恢复后」的差别：按订单 id 和客户名比，数出新增、修改、删除，并列出前几个会消失的订单号和客户名。
function diffStateData(current = {}, next = {}) {
  const strip = order => JSON.stringify({ ...order, feishuNotification:undefined });
  const before = orderIndexById(current);
  const after = orderIndexById(next);
  const orders = { added:0, changed:0, removed:0, removedNums:[] };
  after.forEach((item, id) => {
    const prev = before.get(id);
    if (!prev) orders.added += 1;
    else if (prev.bucket !== item.bucket || strip(prev.order) !== strip(item.order)) orders.changed += 1;
  });
  before.forEach((item, id) => {
    if (after.has(id)) return;
    orders.removed += 1;
    if (orders.removedNums.length < 8) orders.removedNums.push(String(item.order.num || id));
  });
  const currentCustomers = current.customers || {};
  const nextCustomers = next.customers || {};
  const customers = { added:0, changed:0, removed:0, removedNames:[] };
  Object.keys(nextCustomers).forEach(name => {
    if (!Object.prototype.hasOwnProperty.call(currentCustomers, name)) customers.added += 1;
    else if (JSON.stringify(currentCustomers[name]) !== JSON.stringify(nextCustomers[name])) customers.changed += 1;
  });
  Object.keys(currentCustomers).forEach(name => {
    if (Object.prototype.hasOwnProperty.call(nextCustomers, name)) return;
    customers.removed += 1;
    if (customers.removedNames.length < 8) customers.removedNames.push(name);
  });
  return { orders, customers };
}

module.exports = { orderBuckets, payloadCounts, diffStateData };
