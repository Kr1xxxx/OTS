const { execFileSync } = require('node:child_process');

// 让系统分配一个当前空闲的端口。以前用 51000 + pid%1000 这类固定区间，
// 并行跑测试时两个测试可能撞到同一个端口，服务端起不来，健康检查超时。
function freePortSync() {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  return Number(execFileSync(process.execPath, ['-e', script], { encoding:'utf8' }));
}

module.exports = { freePortSync };
