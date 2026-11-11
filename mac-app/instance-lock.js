const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 单实例锁：同一个数据目录只允许一个服务进程（DMG 里再开一份、两个 App 同时开时，两份服务轮流写同一个库，保存永远冲突）。
// - 锁文件记 pid；持有者已经不在（或不是本服务）→ 过期锁，接管；
// - 持有者的父进程已经没了（App 被强制退出或崩溃后留下的孤儿服务，还占着端口和数据库）→ 先结束它，再接管；
// - 持有者好好地挂在另一个 App 下 → 不启动，退出码 75，Mac 壳据此提示「另一个窗口正在使用」而不是换端口重试。
const instanceLockExitCode = 75;
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function processInfo(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding:'utf8', stdio:['ignore', 'pipe', 'ignore'], timeout:3000 }).trim();
    const match = /^(\d+)\s+(.*)$/s.exec(out);
    return match ? { ppid:Number(match[1]), command:match[2] } : null;
  } catch (_) { return null; }
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function createInstanceLock({ supportDir, port }) {
  const instanceLockFile = path.join(supportDir, 'server.lock');
  function acquireInstanceLock() {
    fs.mkdirSync(supportDir, { recursive:true });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const fd = fs.openSync(instanceLockFile, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid:process.pid, ppid:process.ppid, port, startedAt:new Date().toISOString() }));
        fs.closeSync(fd);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(instanceLockFile, 'utf8')); } catch (_) {}
      const pid = Number(holder?.pid);
      const info = Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid) ? processInfo(pid) : null;
      if (!info || !/server\.js/.test(info.command)) {
        // 新写的锁可能还没写完：读不出内容时稍等再看，别把正在启动的那一份当成过期锁。
        if (!holder && attempt === 0) { sleepSync(200); continue; }
        fs.rmSync(instanceLockFile, { force:true });
        continue;
      }
      // 孤儿：父进程没了，被系统改挂到 launchd（或容器里的收养进程）下，父进程号已经不是上锁时那个。
      if (info.ppid === 1 || (Number(holder?.ppid) > 0 && info.ppid !== Number(holder.ppid))) {
        console.error(`Stopping orphaned server ${pid} that still holds ${supportDir}`);
        try { process.kill(pid, 'SIGTERM'); } catch (_) {}
        for (let i = 0; i < 60 && processAlive(pid); i += 1) sleepSync(100);
        if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} sleepSync(200); }
        fs.rmSync(instanceLockFile, { force:true });
        continue;
      }
      break;
    }
    console.error(`另一个外贸订单跟进系统正在使用这份数据（${supportDir}）。请先退出另一个窗口，再打开这个。`);
    process.exit(instanceLockExitCode);
  }
  function releaseInstanceLock() {
    try {
      const holder = JSON.parse(fs.readFileSync(instanceLockFile, 'utf8'));
      if (holder.pid === process.pid) fs.rmSync(instanceLockFile, { force:true });
    } catch (_) {}
  }

  return { acquireInstanceLock, releaseInstanceLock };
}

module.exports = { createInstanceLock };
