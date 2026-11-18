// Which old original images were replaced by their compressed copy (user rule 2026-11-18: those go
// right away, from the attachments folder and from every backup's attachments folder).
//
// The page compresses images saved before V3.144 in the background (compressExistingOrderImages): the
// order keeps the attachment, with the same name and time, and points it at a new compressed file. The
// old original is then used only by backups made before that, which kept it for up to twelve weeks.
// An attachment the user deleted, or the images of an order deleted for good, have no such successor
// in the current data and are not matched here: backups keep those as before.
//
// A backup's attachment counts as replaced when all of these hold:
// - it is a local file (/attachments/…) that was never compressed (no compressed / optimized flag);
// - the same order (by id, in any bucket) still exists now and has an attachment with the same name and
//   the same time, marked compressed, pointing at another file.
const orderBuckets = ['orders', 'trashOrders', 'deletedOrders'];

function ordersOf(data = {}) {
  return orderBuckets.flatMap(bucket => (Array.isArray(data?.[bucket]) ? data[bucket] : []));
}
function localUrl(value) {
  return typeof value === 'string' && value.startsWith('/attachments/') ? value : '';
}
function attachmentKey(item) {
  const name = typeof item?.name === 'string' ? item.name : '';
  const time = typeof item?.time === 'string' ? item.time : '';
  return name && time ? `${name}\u0001${time}` : '';
}

// Compressed attachments of the current data: order id → (name + time → attachment).
function compressedSuccessors(currentOrders = []) {
  const byOrder = new Map();
  currentOrders.forEach(order => {
    if (!order || typeof order !== 'object' || order.id === undefined || order.id === null) return;
    (Array.isArray(order.attachments) ? order.attachments : []).forEach(item => {
      const key = attachmentKey(item);
      if (!key || item.compressed !== true || !localUrl(item.fileUrl)) return;
      const id = String(order.id);
      if (!byOrder.has(id)) byOrder.set(id, new Map());
      byOrder.get(id).set(key, item);
    });
  });
  return byOrder;
}

// URLs (fileUrl and thumbUrl) of originals in backupOrders that currentOrders replaced with a compressed copy.
// URLs the current data still uses are never returned.
function replacedOriginalUrls(currentOrders = [], backupOrders = [], successors = compressedSuccessors(currentOrders)) {
  const inUse = new Set();
  currentOrders.forEach(order => (Array.isArray(order?.attachments) ? order.attachments : []).forEach(item => {
    [item?.fileUrl, item?.thumbUrl].forEach(url => { if (localUrl(url)) inUse.add(url); });
  }));
  const urls = new Set();
  backupOrders.forEach(order => {
    if (!order || typeof order !== 'object' || order.id === undefined || order.id === null) return;
    const now = successors.get(String(order.id));
    if (!now) return;
    (Array.isArray(order.attachments) ? order.attachments : []).forEach(item => {
      if (!item || typeof item !== 'object' || item.compressed || item.optimized || !localUrl(item.fileUrl)) return;
      const successor = now.get(attachmentKey(item));
      if (!successor || successor.fileUrl === item.fileUrl) return;
      [item.fileUrl, item.thumbUrl].forEach(url => {
        if (localUrl(url) && !inUse.has(url)) urls.add(url);
      });
    });
  });
  return urls;
}

module.exports = { ordersOf, compressedSuccessors, replacedOriginalUrls };
