// Order notifications to the Feishu group, sent through the lark-cli installed on this Mac: the message
// text, finding and running the CLI, turning its failures into something the page can show, and the
// delivery record of each order.
//
// The part that needs the open database, the local Feishu settings and the attachment folder is created
// by the server; the rest are plain functions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { httpError } = require('./http-error');

function localDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function notificationIdempotencyKey(orderId = '') {
  return `trade-order-${crypto.createHash('sha256').update(String(orderId)).digest('hex').slice(0, 32)}`;
}

// 群消息里客户和订单的文字一律当纯文本：转义 Markdown 记号，去掉控制符和方向控制符（U+202E 会把后面的字倒过来）；
// 多行的值（地址、备注）从第二行起缩进两个全角空格，行首的 #、-、+、1.、--- 也换成全角，
// 群里不会出现客户写的标题、列表、分割线、表格，也不会多出一行看起来像字段的「订单金额：…」。
function escapeLarkMarkdown(value = '') {
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replaceAll('\\', '\\\\')
    .replace(/([`*_\[\]])/g, '\\$1')
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replaceAll('~', '～')
    .replaceAll('|', '｜')
    .split('\n')
    .map(line => line.trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '未填写';
  return lines.map((line, index) => {
    if (!index || !line) return line;
    const plain = line
      .replace(/^#{1,6}(?=\s|$)/, marks => '＃'.repeat(marks.length))
      .replace(/^(?:[-=]\s*){2,}$/, rule => rule.replaceAll('-', '－').replaceAll('=', '＝'))
      .replace(/^[-+](?=\s)/, mark => (mark === '-' ? '－' : '＋'))
      .replace(/^(\d{1,9})([.)])(?=\s|$)/, (_, number, mark) => `${number}${mark === '.' ? '．' : '）'}`);
    return `\u3000\u3000${plain}`;
  }).join('\n');
}

function orderNotificationAmount(order = {}) {
  const currency = String(order.currency || 'USD').trim().toUpperCase() || 'USD';
  const amount = Number(order.amount || 0);
  return `${currency} ${Number.isFinite(amount) ? amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`;
}

// 群消息里用到的字段（发出时记下来，之后订单改了这些字段，抽屉里提示「群里是旧信息」）。
function orderNotificationFields({ order, customer }) {
  const text = value => String(value ?? '').trim();
  return {
    client: text(order.client),
    num: text(order.num),
    email: text(customer.email),
    phone: text(customer.phone),
    address: text(customer.address),
    amount: orderNotificationAmount(order),
    paymentChannel: text(order.paymentChannel),
    note: text(order.note)
  };
}

function buildOrderNotificationMarkdown({ order, customer }, imageKeys = [], skippedImages = []) {
  const lines = [
    `**客户名称：** ${escapeLarkMarkdown(order.client)}`,
    `**订单号：** ${escapeLarkMarkdown(order.num)}`,
    `**邮箱：** ${escapeLarkMarkdown(customer.email)}`,
    `**手机号：** ${escapeLarkMarkdown(customer.phone)}`,
    `**收货地址：** ${escapeLarkMarkdown(customer.address)}`,
    '',
    `**订单金额：** ${escapeLarkMarkdown(orderNotificationAmount(order))}`,
    `**付款方式：** ${escapeLarkMarkdown(order.paymentChannel)}`,
    `**订单备注：** ${escapeLarkMarkdown(order.note)}`
  ];
  imageKeys.forEach((item, index) => lines.push('', `![附件 ${item.index || index + 1}](${item.key || item})`));
  if (skippedImages.length) {
    lines.push('', `**未能附上的图片：** ${skippedImages.map(item => `附件 ${item.index}（${item.reason}）`).join('、')}`);
  }
  return lines.join('\n');
}

// 测试可以把超时调短（只能更短），不用真的等 45 秒。
const larkTimeoutMs = Math.min(45000, Math.max(200, Number(process.env.OTS_LARK_TIMEOUT_MS) || 45000));
const larkImageLimitBytes = 10 * 1024 * 1024;
const larkFailureText = {
  config: '还没有配置飞书：到「设置 → 飞书通知」填写后再发送',
  'cli-missing': '这台 Mac 上找不到 lark-cli：先安装 lark-cli，或在「设置 → 飞书通知」里填写它的完整路径',
  'cli-start': 'lark-cli 启动失败：检查「设置 → 飞书通知」里的 lark-cli 路径',
  permission: '飞书机器人缺少权限：到飞书开发者后台给应用开通「以应用身份发消息」（im:message:send_as_bot），有图片时还要开通 im:resource，发布新版本后再重新发送',
  credential: '飞书凭证失效（token 过期或 App Secret 不对）：在终端运行 lark-cli config init 重新配置这个 profile，再重新发送',
  profile: 'lark-cli 里没有设置中填写的 profile：检查 profile 名，或在终端运行 lark-cli config init',
  rate: '飞书限流了：过一两分钟再重新发送',
  network: '连不上飞书（网络断开或代理不通）：联网后再重新发送',
  timeout: '飞书 45 秒内没有回应，消息可能已经发到群里：请先看一眼群，再决定是否重新发送',
  generic: '飞书服务暂时不可用，可稍后重试'
};
const larkRetryableKinds = new Set(['rate', 'network', 'timeout', 'generic']);

function larkFailure(kind, { chatName = '', reason = '' } = {}) {
  let message = larkFailureText[kind] || larkFailureText.generic;
  if (kind === 'chat') message = `机器人不在「${chatName || '目标群'}」里，或群 ID 不对：先把机器人拉进这个群（或在设置里改群 ID），再重新发送`;
  if (kind === 'config' && reason && reason !== '还没有配置飞书') message = `飞书配置有问题：${reason}。到「设置 → 飞书通知」改好后再发送`;
  return httpError(503, message, { larkKind: kind, retryable: larkRetryableKinds.has(kind) });
}

function larkCliCandidates(config = {}) {
  const home = os.homedir();
  const fromEnv = String(process.env.TRADE_LARK_CLI || '').trim();
  if (fromEnv) return [fromEnv];
  // 设置里填了路径：只用它，找不到就明说，不悄悄换成别处的另一个 lark-cli。
  if (config.cliPath) return [config.cliPath];
  const candidates = [
    path.join(home, '.local', 'bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
    path.join(home, '.volta', 'bin', 'lark-cli'),
    path.join(home, '.npm-global', 'bin', 'lark-cli'),
    path.join(home, '.bun', 'bin', 'lark-cli'),
    path.join(home, 'bin', 'lark-cli')
  ];
  // nvm：每个 Node 版本各有一个 bin 目录，新版本优先。
  try {
    const nvmRoot = path.join(String(process.env.NVM_DIR || '').trim() || path.join(home, '.nvm'), 'versions', 'node');
    const versionKey = name => name.replace(/^v/, '').split('.').map(part => Number(part) || 0);
    fs.readdirSync(nvmRoot)
      .sort((a, b) => {
        const left = versionKey(a);
        const right = versionKey(b);
        for (let i = 0; i < 3; i += 1) if ((right[i] || 0) !== (left[i] || 0)) return (right[i] || 0) - (left[i] || 0);
        return 0;
      })
      .forEach(version => candidates.push(path.join(nvmRoot, version, 'bin', 'lark-cli')));
  } catch (_) {}
  return candidates;
}

// npm 装的是 JS 外壳（用这个 Node 跑，App 的 PATH 里不一定有 node）；make install / Volta 是原生程序，直接运行。
function resolveLarkCli(config = {}) {
  const executable = larkCliCandidates(config).find(candidate => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) { return false; }
  });
  if (!executable) return null;
  let real = executable;
  try { real = fs.realpathSync(executable); } catch (_) {}
  let viaNode = /\.[cm]?js$/i.test(real);
  if (!viaNode) {
    let descriptor;
    try {
      descriptor = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const head = Buffer.alloc(256);
      const length = fs.readSync(descriptor, head, 0, head.length, 0);
      const firstLine = head.subarray(0, length).toString('latin1').split('\n')[0];
      viaNode = firstLine.startsWith('#!') && /\bnode\b/.test(firstLine);
    } catch (_) {
      viaNode = false;
    } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (_) {} }
    }
  }
  return viaNode
    ? { command: process.execPath, prefix: [real], kind: 'node', path: executable }
    : { command: executable, prefix: [], kind: 'native', path: executable };
}

// lark-cli 只拿到它用得到的环境变量：本机接口令牌（TRADE_API_TOKEN）、端口、数据目录都不给这个第三方程序。
function larkCliEnv() {
  const keep = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TZ',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'VOLTA_HOME', 'NVM_DIR'];
  const env = {};
  keep.forEach(key => { if (typeof process.env[key] === 'string') env[key] = process.env[key]; });
  Object.keys(process.env).filter(key => /^LARK(SUITE)?_/.test(key)).forEach(key => { env[key] = process.env[key]; });
  env.PATH = [path.dirname(process.execPath), env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(path.delimiter);
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return env;
}

// lark-cli 的约定：成功信封写 stdout，错误信封写 stderr。两边都看，取最后一个 JSON 对象。
function parseLarkCliResult(output = '') {
  const text = String(output || '').trim();
  if (!text) return null;
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

// 把 lark-cli 的错误归成几类。原文（本机路径、密钥、群 ID）不回给页面、不入库，页面只拿到这一类的中文说明。
function classifyLarkFailure(result = null, rawText = '') {
  const error = result && typeof result.error === 'object' && result.error ? result.error : {};
  const code = Number(error.code || result?.code || 0);
  const type = String(error.type || '').toLowerCase();
  const subtype = String(error.subtype || '').toLowerCase();
  const missing = Array.isArray(error.missing_scopes) ? error.missing_scopes.join(' ') : '';
  const text = `${type} ${subtype} ${missing} ${String(error.message || '')} ${String(error.hint || '')} ${String(rawText || '').slice(0, 4000)}`.toLowerCase();
  if ([99991672, 99991679, 99991676].includes(code) || subtype === 'missing_scope' || type === 'permission' || /missing[_ ]scopes?|permission denied|no permission|access denied|scope|权限/.test(text)) return 'permission';
  if ([230002, 230006, 230001, 232010, 232011].includes(code) || /not in (the )?chat|bot is not in|out of the chat|chat (is )?not (found|exist)|invalid chat|不在群|群不存在/.test(text)) return 'chat';
  if (/profile/.test(text) && /not found|unknown|no such|does not exist|not exist|不存在/.test(text)) return 'profile';
  if ([99991661, 99991663, 99991664, 99991665, 99991668, 10014, 10003].includes(code) || type === 'authentication' || type === 'authorization' || /access[_ ]token|tenant[_ ]token|token (is )?(invalid|expired)|credential|app[_ ]?secret|unauthori[sz]ed|invalid app|authentication/.test(text)) return 'credential';
  if ([99991400, 11232, 429].includes(code) || type === 'rate_limit' || /rate.?limit|too many requests|frequency|频率|限流/.test(text)) return 'rate';
  if (type === 'network' || /enotfound|econnrefused|econnreset|etimedout|eai_again|enetunreach|ehostunreach|network|no such host|dial tcp|connection (refused|reset)|i\/o timeout|tls handshake|proxyconnect/.test(text)) return 'network';
  return 'generic';
}

// 用 npm 装的 lark-cli 是 JS 外壳 + 原生程序：只杀外壳的话原生程序会继续把消息发出去，所以整组进程一起结束。
function killLarkProcessTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); return; } catch (_) {}
  try { child.kill('SIGKILL'); } catch (_) {}
}

function convertImageForLark(source, workDir, index) {
  const sips = '/usr/bin/sips';
  if (!workDir || !fs.existsSync(sips)) return '';
  const output = path.join(workDir, `attachment-${index}.jpg`);
  try {
    execFileSync(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '3000', source, '--out', output], { stdio: 'ignore', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } });
    const size = fs.statSync(output).size;
    return size > 0 && size <= larkImageLimitBytes ? output : '';
  } catch (_) {
    return '';
  }
}

// 页面看到的发送状态：数据库那一行 + 本机配置里的群名。发送中超过 2 分钟算没完成（可能已经发出）。
function deliveryPublicFields(row = {}, chatName = '') {
  const stale = row.status === 'sending' && !(Date.now() - Date.parse(row.started_at || row.updated_at || 0) < 2 * 60 * 1000);
  let sentFields = null;
  try { sentFields = row.sent_fields ? JSON.parse(row.sent_fields) : null; } catch (_) {}
  const errorKind = stale ? 'timeout' : String(row.error_kind || '');
  return {
    status: stale ? 'failed' : row.status,
    chatName,
    sentAt: row.sent_at || '',
    messageId: row.message_id || '',
    error: stale ? '上次发送没有完成，消息可能已经发到群里：请先看一眼群，再决定是否重新发送' : (row.last_error || ''),
    errorKind,
    retryable: row.status === 'failed' || stale ? larkRetryableKinds.has(errorKind || 'generic') : false,
    updatedAt: row.updated_at || '',
    ...(sentFields && typeof sentFields === 'object' ? { sentFields } : {})
  };
}

function createFeishuNotifier({ currentDatabase, feishuConfig, attachmentTargetFromUrl, resourcesDir }) {
  function runLarkCli(args, { cwd = resourcesDir, timeoutMs = larkTimeoutMs, config = feishuConfig() } = {}) {
    return new Promise((resolve, reject) => {
      if (!config.configured) {
        reject(larkFailure('config', { reason: config.reason }));
        return;
      }
      const cli = resolveLarkCli(config);
      if (!cli) {
        reject(larkFailure('cli-missing'));
        return;
      }
      let child;
      try {
        child = spawn(cli.command, [...cli.prefix, '--profile', config.profile, ...args, '--as', 'bot'], {
          cwd,
          env: larkCliEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        });
      } catch (_) {
        reject(larkFailure('cli-start'));
        return;
      }
      let stdout = '';
      let stderr = '';
      let finished = false;
      const outputLimit = 1024 * 1024;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        killLarkProcessTree(child);
        reject(larkFailure('timeout'));
      }, timeoutMs);
      const collect = target => chunk => {
        if (target === 'stdout' && stdout.length < outputLimit) stdout += chunk.toString('utf8').slice(0, outputLimit - stdout.length);
        if (target === 'stderr' && stderr.length < outputLimit) stderr += chunk.toString('utf8').slice(0, outputLimit - stderr.length);
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.once('error', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(larkFailure('cli-start'));
      });
      child.once('close', code => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const result = parseLarkCliResult(stdout);
        if (code === 0 && result?.ok) {
          resolve(result.data || {});
          return;
        }
        const failure = (result && result.ok === false ? result : null) || parseLarkCliResult(stderr) || result;
        reject(larkFailure(classifyLarkFailure(failure, `${stderr}\n${failure ? '' : stdout}`), { chatName: config.chatName }));
      });
    });
  }

  const larkImageFormats = /\.(png|jpe?g|webp|gif|bmp)$/i;
  // 发群前把订单图片整理好：飞书收不下的（AVIF / HEIC 等格式、超过 10 MB）先在本机用 sips 转成 JPEG，
  // 转不了就跳过这一张、文字照发，消息末尾写明哪张没附上。以前一张图就让整条消息永远发不出去。
  function prepareNotificationImages(order = {}, workDir = '') {
    const files = [];
    const skipped = [];
    let index = 0;
    for (const item of Array.isArray(order.attachments) ? order.attachments : []) {
      if (!item?.fileUrl || item.fileUrl === item.thumbUrl && !/图片|image/i.test(String(item.type || ''))) continue;
      index += 1;
      let target = '';
      try { target = attachmentTargetFromUrl(item.fileUrl); } catch (_) {}
      let size = 0;
      try { const stat = fs.statSync(target); size = stat.isFile() ? stat.size : 0; } catch (_) {}
      if (!target || !size) {
        skipped.push({ index, reason: '文件不存在' });
        continue;
      }
      const supported = larkImageFormats.test(target);
      if (supported && size <= larkImageLimitBytes) {
        files.push({ file: target, index });
        continue;
      }
      const converted = convertImageForLark(target, workDir, index);
      if (converted) files.push({ file: converted, index });
      else skipped.push({ index, reason: supported ? '超过 10 MB' : '格式不支持' });
    }
    return { files, skipped };
  }

  function readOrderNotificationContext(orderId = '') {
    const id = String(orderId || '').trim();
    if (!id) throw httpError(400, 'orderId is required');
    const row = currentDatabase().prepare("SELECT bucket, data_json FROM orders WHERE id = ?").get(id);
    if (!row || row.bucket !== 'orders') throw httpError(404, '订单不存在');
    const order = JSON.parse(row.data_json);
    if (order.isDraft) throw httpError(409, '草稿订单不能发送群通知');
    const customerRow = currentDatabase().prepare('SELECT data_json FROM customers WHERE name = ?').get(String(order.client || ''));
    const customer = customerRow ? JSON.parse(customerRow.data_json) : {};
    return { order, customer };
  }

  async function uploadLarkImage(file, config) {
    const result = await runLarkCli([
      'im', 'images', 'create',
      '--data', '{"image_type":"message"}',
      '--file', `./${path.basename(file)}`
    ], { cwd: path.dirname(file), timeoutMs: larkTimeoutMs, config });
    if (!String(result.image_key || '').startsWith('img_')) throw larkFailure('generic');
    return result.image_key;
  }

  function deliveryPublicResult(row, extra = {}, chatName = feishuConfig().chatName) {
    const fields = deliveryPublicFields(row, chatName);
    return { ok: fields.status === 'sent', ...fields, ...extra };
  }

  function orderNotificationStatus(orderId = '') {
    const id = String(orderId || '').trim();
    if (!id) throw httpError(400, 'orderId is required');
    const row = currentDatabase().prepare('SELECT * FROM notification_deliveries WHERE order_id = ?').get(id);
    return row ? deliveryPublicResult(row) : { ok: false, status: 'skipped' };
  }

  async function sendOrderNotification(orderId = '') {
    const context = readOrderNotificationContext(orderId);
    const existing = currentDatabase().prepare('SELECT * FROM notification_deliveries WHERE order_id = ?').get(context.order.id);
    const config = feishuConfig();
    if (existing?.status === 'sent') return deliveryPublicResult(existing, { alreadySent: true }, config.chatName);
    if (existing?.status === 'sending' && Date.now() - Date.parse(existing.started_at) < 2 * 60 * 1000) {
      throw httpError(409, '群消息正在发送，请稍候', { publicDetails: { status: 'sending', chatName: config.chatName } });
    }
    if (!config.configured) {
      const failure = larkFailure('config', { reason: config.reason });
      failure.publicDetails = { status: 'failed', error: failure.message, errorKind: 'config', retryable: false, chatName: config.chatName };
      throw failure;
    }
    const startedAt = new Date().toISOString();
    const idempotencyKey = existing?.idempotency_key || notificationIdempotencyKey(context.order.id);
    currentDatabase().prepare(`
      INSERT INTO notification_deliveries(
        order_id, channel, status, idempotency_key, started_at, sent_at, message_id, last_error, updated_at
      ) VALUES(?, 'feishu_group', 'sending', ?, ?, '', '', '', ?)
      ON CONFLICT(order_id) DO UPDATE SET
        status = 'sending', idempotency_key = excluded.idempotency_key,
        started_at = excluded.started_at, last_error = '', error_kind = '', updated_at = excluded.updated_at
    `).run(context.order.id, idempotencyKey, startedAt, startedAt);
    let workDir = '';
    try {
      try { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-feishu-')); } catch (_) {}
      const images = prepareNotificationImages(context.order, workDir);
      const imageKeys = [];
      const skippedImages = [...images.skipped];
      for (const item of images.files) {
        try {
          imageKeys.push({ key: await uploadLarkImage(item.file, config), index: item.index });
        } catch (error) {
          // 飞书拒收某一张图（格式、尺寸）：跳过它，文字照发。权限、凭证、断网、超时这类整条都发不了的照常报错。
          if (error.larkKind !== 'generic') throw error;
          skippedImages.push({ index: item.index, reason: '飞书拒收' });
        }
      }
      skippedImages.sort((a, b) => a.index - b.index);
      const markdown = buildOrderNotificationMarkdown(context, imageKeys, skippedImages);
      const result = await runLarkCli([
        'im', '+messages-send',
        '--chat-id', config.chatId,
        '--markdown', markdown,
        '--idempotency-key', idempotencyKey
      ], { config });
      const sentAt = result.create_time || localDateTime();
      const messageId = String(result.message_id || '');
      currentDatabase().prepare(`
        UPDATE notification_deliveries
        SET status = 'sent', sent_at = ?, message_id = ?, last_error = '', error_kind = '', sent_fields = ?, updated_at = ?
        WHERE order_id = ?
      `).run(sentAt, messageId, JSON.stringify(orderNotificationFields(context)), new Date().toISOString(), context.order.id);
      const row = currentDatabase().prepare('SELECT * FROM notification_deliveries WHERE order_id = ?').get(context.order.id);
      return deliveryPublicResult(row, skippedImages.length ? { skippedImages: skippedImages.length } : {}, config.chatName);
    } catch (error) {
      const kind = error.larkKind || 'generic';
      const safeMessage = error.larkKind ? error.message : larkFailureText.generic;
      currentDatabase().prepare(`
        UPDATE notification_deliveries
        SET status = 'failed', last_error = ?, error_kind = ?, updated_at = ?
        WHERE order_id = ?
      `).run(safeMessage, kind, new Date().toISOString(), context.order.id);
      throw httpError(Number.isInteger(error.status) ? error.status : 503, safeMessage, {
        publicDetails: { status: 'failed', error: safeMessage, errorKind: kind, retryable: larkRetryableKinds.has(kind), chatName: config.chatName }
      });
    } finally {
      if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} }
    }
  }

  // 设置页看到的飞书状态：只说配没配好、为什么，以及群名；profile 和群 ID 不回给页面。
  function publicFeishuStatus() {
    const config = feishuConfig();
    const cli = resolveLarkCli(config);
    let lastSent = null;
    let lastFailed = null;
    try {
      lastSent = currentDatabase() ? currentDatabase().prepare("SELECT sent_at FROM notification_deliveries WHERE status = 'sent' ORDER BY updated_at DESC LIMIT 1").get() || null : null;
      lastFailed = currentDatabase() ? currentDatabase().prepare("SELECT last_error FROM notification_deliveries WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1").get() || null : null;
    } catch (_) {}
    return {
      ok: true,
      configured: config.configured,
      state: config.state,
      reason: config.reason,
      chatName: config.configured ? config.chatName : '',
      profileSaved: !!config.profile,
      chatIdSaved: !!config.chatId,
      cliPath: config.cliPath || '',
      cli: { found: !!cli, kind: cli ? cli.kind : '' },
      lastSentAt: lastSent ? lastSent.sent_at || '' : '',
      lastError: lastFailed ? lastFailed.last_error || '' : ''
    };
  }

  async function sendFeishuTestMessage() {
    const config = feishuConfig();
    if (!config.configured) throw larkFailure('config', { reason: config.reason });
    const result = await runLarkCli([
      'im', '+messages-send',
      '--chat-id', config.chatId,
      '--markdown', `**OTS 测试消息：** 飞书通知已连通（${localDateTime()}）`,
      '--idempotency-key', `trade-order-test-${crypto.randomBytes(12).toString('hex')}`
    ], { config });
    return { ok: true, chatName: config.chatName, sentAt: result.create_time || localDateTime() };
  }

  return { sendOrderNotification, orderNotificationStatus, publicFeishuStatus, sendFeishuTestMessage };
}

module.exports = { createFeishuNotifier, deliveryPublicFields, larkFailureText };
