// How backup files are named, and which of them are kept.
//
// 备份目录可以是用户自己选的文件夹（iCloud、网盘），里面可能有别的 .sqlite / .json：轮转、统计、清理附件只认 OTS 自己起的名字。
// 文件名：trade-order-data-<日期>-<时间>[-<本机数据库 id 前 6 位>][-before-<原因>][-<序号>].sqlite
// - 数据库 id：两台 Mac 把备份目录选到同一个 iCloud 文件夹时，轮转只删自己的，不删对方的（旧备份没有 id，按自己的算）。
// - 「-before-<原因>」：操作前强制生成的快照（合并 / 删除客户 change、导入 import、恢复示例 reset、从备份恢复 restore），
//   安装更新前（update）也强制备份一份。单独保留 90 天（至少最近 20 份），不参与日常轮转。
const backupReasons = ['change', 'import', 'reset', 'restore', 'update'];
const otsBackupFileName = /^trade-order-data-(\d{8})-(\d{6})(?:-([0-9a-f]{6}))?(?:-before-(change|import|reset|restore|update))?(?:-\d+)?\.(?:sqlite|json)$/;
function parseBackupName(name = '') {
  const match = otsBackupFileName.exec(name);
  if (!match) return null;
  const [, day, time, tag = '', reason = ''] = match;
  const at = new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)), Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6))).getTime();
  return { name, at, tag, reason };
}
function isOtsBackupFile(name = '', extension = '') {
  return otsBackupFileName.test(name) && (!extension || name.endsWith(`.${extension}`));
}
function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// 分级保留（以前只留最新 30 份，一小时最多一份，大约只能回到 3 个工作日前）：
// - 日常备份：最新 30 份一定留；另外 48 小时内的全留，30 天内每天留最新一份，12 周内每周留最新一份。
// - 操作前快照（before-*）：90 天内的全留，另外至少留最新 20 份。
// - 只动本机数据库的备份（文件名里的 id 和本机一致，或旧的没有 id 的），别的 Mac 写进同一目录的不动。
const dayMs = 24 * 60 * 60 * 1000;
function backupsToRotate(names, { now = Date.now(), tag = '' } = {}) {
  const own = names.map(parseBackupName).filter(item => item && item.name.endsWith('.sqlite') && (!item.tag || !tag || item.tag === tag))
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keep = new Set();
  const regular = own.filter(item => !item.reason);
  const snapshots = own.filter(item => item.reason);
  regular.slice(0, 30).forEach(item => keep.add(item.name));
  const days = new Set();
  const weeks = new Set();
  regular.forEach(item => {
    const age = now - item.at;
    if (age < 2 * dayMs) { keep.add(item.name); return; }
    const date = new Date(item.at);
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (age < 30 * dayMs) {
      if (!days.has(dayKey)) { days.add(dayKey); keep.add(item.name); }
      return;
    }
    const weekKey = Math.floor((item.at - new Date(2001, 0, 1).getTime()) / (7 * dayMs));
    if (age < 84 * dayMs && !weeks.has(weekKey)) { weeks.add(weekKey); keep.add(item.name); }
  });
  snapshots.forEach((item, index) => { if (index < 20 || now - item.at < 90 * dayMs) keep.add(item.name); });
  return own.filter(item => !keep.has(item.name)).map(item => item.name);
}

module.exports = { backupReasons, parseBackupName, isOtsBackupFile, timestamp, backupsToRotate };
