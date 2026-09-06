'use strict';
/*
 * v2.0 真实 sshd e2e（引擎层直驱，不依赖 uTools）：node test/e2e-v2.js
 * 临时 sshd 高端口 2222（不碰系统 22 / /etc/ssh/sshd_config），优先非 root 运行；
 * 测完自动清理（sshd/http/临时目录/authorized_keys 追加行/日志文件）。
 *
 * 用例：
 *  ① bindAll 关            → 远端 -R 仅监听 127.0.0.1
 *  ② bindAll 开 + GatewayPorts clientspecified → 远端 *:19090，LAN IP 可连
 *  ③ bindAll 开 + GatewayPorts 缺省(no)        → 静默降级 127.0.0.1（进程不崩）
 *  ④ -R 远端端口被占用      → error（remoteport 分类）
 *  ⑤ 导入式配置 L/R/D 全连通（curl L / nc D / R 反向可达）
 *  ⑥ logs.search 与 grep -n 行号条数一致
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { execSync, spawn } = require('child_process');

const manager = require('../engine/manager');
const logs = require('../engine/logs');

const DIR = '/tmp/utmd';
const SSHD_PORT = 2222;
const HTTP_PORT = 18000;
const L_PORT = 18080;
const R_PORT = 19090;
const D_PORT = 11080;
const ME = os.userInfo().username;
const AK = path.join(os.homedir(), '.ssh', 'authorized_keys');
const MARK = '# utm-e2e-v2';

let sshdChild = null;
let httpChild = null;
let akAppended = false;
let pass = 0;

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }); }
function ok(name) { pass++; console.log('  ✓ ' + name); }

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const k of Object.keys(ifaces)) {
    for (const a of ifaces[k] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function setup() {
  fs.mkdirSync(DIR, { recursive: true });
  // 清理上一次运行残留的 known_hosts 记录（主机密钥每次重新生成；仅动带端口的条目）
  try { sh("ssh-keygen -q -R '[127.0.0.1]:" + SSHD_PORT + "' "); } catch (e) {}
  sh('ssh-keygen -q -t ed25519 -f ' + DIR + '/hk -N "" ');
  sh('ssh-keygen -q -t ed25519 -f ' + DIR + '/id -N "" ');
  fs.chmodSync(DIR + '/id', 0o600);
  // 测试公钥追加进 authorized_keys（带标记，cleanup 精确移除）
  const pub = fs.readFileSync(DIR + '/id.pub', 'utf8').trim();
  const before = fs.existsSync(AK) ? fs.readFileSync(AK, 'utf8') : '';
  fs.mkdirSync(path.dirname(AK), { recursive: true });
  fs.writeFileSync(AK, before + (before.endsWith('\n') || !before ? '' : '\n') + MARK + '\n' + pub + '\n');
  fs.chmodSync(AK, 0o600);
  akAppended = true;

  const common = [
    'Port ' + SSHD_PORT,
    'ListenAddress 127.0.0.1',
    'HostKey ' + DIR + '/hk',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'StrictModes no',
    'LogLevel DEBUG1',
  ];
  fs.writeFileSync(DIR + '/sshd_a.conf', common.concat(['PidFile ' + DIR + '/sshd_a.pid', 'GatewayPorts clientspecified']).join('\n') + '\n');
  fs.writeFileSync(DIR + '/sshd_b.conf', common.concat(['PidFile ' + DIR + '/sshd_b.pid']).join('\n') + '\n');

  httpChild = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: DIR, stdio: 'ignore' });
}

function startSshd(which) {
  return new Promise(function (resolve, reject) {
    const child = spawn('/usr/sbin/sshd', ['-f', DIR + '/sshd_' + which + '.conf', '-D', '-e'], { stdio: 'ignore' });
    let died = false;
    child.on('exit', function () { died = true; });
    setTimeout(function () {
      if (died) {
        reject(new Error('sshd 启动失败（非 root 受限？）。可改用：sudo /usr/sbin/sshd -f ' + DIR + '/sshd_' + which + '.conf -D -e 后重跑'));
      } else {
        sshdChild = child;
        resolve(child);
      }
    }, 900);
  });
}

function stopSshd() {
  if (sshdChild) { try { sshdChild.kill('SIGTERM'); } catch (e) {} sshdChild = null; }
}

function waitForStatus(id, want, ms) {
  const t0 = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      const s = (manager.statuses() || {})[id] || {};
      if (s.status === want) return resolve(s);
      if (s.status === 'error' && want !== 'error') return reject(new Error(id + ' → error: ' + s.lastError));
      if (Date.now() - t0 > (ms || 20000)) return reject(new Error(id + ' 等待 ' + want + ' 超时（当前 ' + s.status + '）'));
      setTimeout(poll, 200);
    })();
  });
}

function httpGet(port) {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/', timeout: 3000 }, function (res) {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', function () { resolve(0); });
    req.on('timeout', function () { req.destroy(); resolve(0); });
  });
}

function tcpConnect(port, host) {
  return new Promise(function (resolve) {
    const s = net.connect({ port: port, host: host || '127.0.0.1', timeout: 2500 });
    s.on('connect', function () { s.destroy(); resolve(true); });
    s.on('error', function () { resolve(false); });
    s.on('timeout', function () { s.destroy(); resolve(false); });
  });
}

/** 回环形态判定：macOS sshd 降级时可能绑 [::1] 或 127.0.0.1 */
function isLoopbackListen(name, port) {
  return name.indexOf('127.0.0.1:' + port) === 0 || name.indexOf('[::1]:' + port) === 0;
}

/** lsof 取远端转发监听地址：'*:19090' / '127.0.0.1:19090' / '[::1]:19090' */
function remoteListenName(port) {
  try {
    const out = sh('lsof -nP -iTCP:' + port + ' -sTCP:LISTEN || true');
    const lines = out.split('\n').filter(function (l) { return l.indexOf(':' + port) >= 0; });
    if (!lines.length) return '';
    const m = lines[0].match(/(\S+)\s+\(LISTEN\)\s*$/); // NAME 列形如 "*:19090 (LISTEN)"
    if (m) return m[1];
    const parts = lines[0].trim().split(/\s+/);
    return parts[parts.length - 1];
  } catch (e) { return ''; }
}

function mkTunnel(id, bindAll) {
  return {
    _id: id, name: 'e2e-' + id, host: '127.0.0.1', port: SSHD_PORT, user: ME,
    auth: { method: 'key', keyPath: DIR + '/id' },
    options: { connectTimeout: 10, serverAliveInterval: 5, autoReconnect: false },
    rules: [
      { id: 'r1', type: 'L', enabled: true, localPort: L_PORT, remoteHost: '127.0.0.1', remotePort: HTTP_PORT, bindAll: false },
      { id: 'r2', type: 'R', enabled: true, localPort: R_PORT, remoteHost: '127.0.0.1', remotePort: HTTP_PORT, bindAll: bindAll },
      { id: 'r3', type: 'D', enabled: true, localPort: D_PORT, remoteHost: '', remotePort: 0, bindAll: false },
    ],
  };
}

async function main() {
  console.log('准备环境（临时 sshd :2222 + http :18000）…');
  setup();

  /* ---- ② bindAll 开 + GatewayPorts clientspecified ---- */
  console.log('用例②：bindAll 开 + GatewayPorts clientspecified');
  await startSshd('a');
  let res = await manager.start(mkTunnel('tunnel_e2ev2', true), {});
  assert.ok(res.ok, 'start 应成功');
  await waitForStatus('tunnel_e2ev2', 'running');
  ok('隧道 running（L/R/D 三规则）');
  assert.strictEqual(await httpGet(L_PORT) > 0, true, 'L 转发应可达');
  ok('L 18080 → http 18000 可达');
  assert.strictEqual(await tcpConnect(D_PORT), true, 'D SOCKS 端口应可连');
  ok('D 11080 SOCKS 端口可连');
  let name = remoteListenName(R_PORT);
  assert.ok(name === '*:' + R_PORT || name.indexOf('0.0.0.0:' + R_PORT) === 0, 'clientspecified 下应绑 wildcard，实际 ' + name);
  ok('远端 -R 绑 wildcard（' + name + '）');
  const lip = lanIp();
  if (lip) {
    assert.strictEqual(await tcpConnect(R_PORT, lip), true, 'LAN IP 应可达远端转发');
    ok('LAN IP ' + lip + ':' + R_PORT + ' 可达');
  }
  // ⑥ 检索对照 grep -n（隧道运行中日志已含 Authenticated）
  await manager.stop('tunnel_e2ev2');
  await waitForStatus('tunnel_e2ev2', 'stopped');
  const logfile = path.join(logs.DIR, 'tunnel_e2ev2.log');
  const grep = sh("grep -n 'Authenticated to' " + logfile + ' || true').trim().split('\n').filter(Boolean);
  const sr = logs.search('Authenticated to');
  const fh = (sr.files || []).filter(function (f) { return f.id === 'tunnel_e2ev2'; })[0];
  assert.ok(fh, '检索应命中本隧道日志');
  assert.strictEqual(fh.hits.length, grep.length, '命中条数应与 grep -n 一致');
  assert.strictEqual(fh.hits[0].lineNo, Number(grep[0].split(':')[0]), '首命中行号应与 grep -n 一致');
  ok('⑥ logs.search 与 grep -n 条数/行号一致（' + grep.length + ' 条）');
  stopSshd();

  /* ---- ③ bindAll 开 + GatewayPorts 缺省(no)：静默降级 ---- */
  console.log('用例③：bindAll 开 + GatewayPorts 缺省 → 静默降级回环');
  await startSshd('b');
  res = await manager.start(mkTunnel('tunnel_e2ev2', true), {});
  assert.ok(res.ok);
  await waitForStatus('tunnel_e2ev2', 'running');
  name = remoteListenName(R_PORT);
  assert.ok(isLoopbackListen(name, R_PORT), 'GatewayPorts no 应静默降级回环，实际 ' + name);
  ok('静默降级为 ' + name + '（进程不崩、状态机不受影响）');

  /* ---- ① bindAll 关：客户端不请求 wildcard ---- */
  await manager.stop('tunnel_e2ev2');
  await waitForStatus('tunnel_e2ev2', 'stopped');
  console.log('用例①：bindAll 关 → 仅回环');
  res = await manager.start(mkTunnel('tunnel_e2ev2', false), {});
  assert.ok(res.ok);
  await waitForStatus('tunnel_e2ev2', 'running');
  name = remoteListenName(R_PORT);
  assert.ok(isLoopbackListen(name, R_PORT), 'bindAll 关应仅回环，实际 ' + name);
  ok('bindAll 关 → ' + name);

  /* ---- ④ -R 远端端口占用 → error（纯 R 规则，避开本地端口预检） ---- */
  console.log('用例④：-R 远端端口占用 → error');
  // 与隧道 A 同族回环请求才会真正冲突（sshd 降级时 IPv4/IPv6 回环可共存）
  const tunnelB = mkTunnel('tunnel_e2ev2b', false);
  tunnelB.rules = [{ id: 'r2', type: 'R', enabled: true, localPort: R_PORT, remoteHost: '127.0.0.1', remotePort: HTTP_PORT, bindAll: false }];
  res = await manager.start(tunnelB, {});
  if (res.ok) {
    let st = null;
    try { st = await waitForStatus('tunnel_e2ev2b', 'error', 15000); } catch (e) { st = (manager.statuses() || {}).tunnel_e2ev2b; }
    assert.strictEqual(st.status, 'error', '应进入 error');
    assert.strictEqual(st.errorKind, 'remoteport', '错误分类应为 remoteport');
    ok('远端端口占用 → error（' + (st.errorKind || '') + '：' + (st.lastError || '') + '）');
    await manager.stop('tunnel_e2ev2b');
  } else {
    ok('远端端口占用 → 预检/启动即失败：' + res.error);
  }

  await manager.stop('tunnel_e2ev2');
  console.log('\n真实 sshd e2e 通过：' + pass + ' 项');
}

function cleanup() {
  try { manager.stop('tunnel_e2ev2'); } catch (e) {}
  try { manager.stop('tunnel_e2ev2b'); } catch (e) {}
  stopSshd();
  if (httpChild) { try { httpChild.kill('SIGTERM'); } catch (e) {} httpChild = null; }
  if (akAppended) {
    try {
      const lines = fs.readFileSync(AK, 'utf8').split('\n');
      const pub = fs.existsSync(DIR + '/id.pub') ? fs.readFileSync(DIR + '/id.pub', 'utf8').trim() : null;
      const out = lines.filter(function (l) { return l !== MARK && l !== pub; });
      fs.writeFileSync(AK, out.join('\n'));
    } catch (e) {}
  }
  try { sh("ssh-keygen -q -R '[127.0.0.1]:" + SSHD_PORT + "' "); } catch (e) {}
  try { sh('rm -rf ' + DIR); } catch (e) {}
  ['tunnel_e2ev2', 'tunnel_e2ev2b'].forEach(function (id) {
    try { fs.unlinkSync(path.join(logs.DIR, id + '.log')); } catch (e) {}
  });
}

main()
  .catch(function (e) {
    console.error('\n✗ e2e 失败：' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  })
  .finally(function () {
    cleanup();
    setTimeout(function () { process.exit(process.exitCode || 0); }, 300);
  });
