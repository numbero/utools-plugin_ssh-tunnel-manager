'use strict';
/**
 * 隧道管理器：每隧道状态机、watchdog、自动重连、adopt 接管。
 * 状态：stopped → starting → running / error
 *
 * - starting→running：含 L/D 规则 = 全部本地端口 TCP 探通；纯 R = 日志命中 Authenticated 且存活≥1.5s
 * - →error：进程退出（日志尾部按标记表分类）/ 30s 启动超时
 * - 自动重连：仅网络类失败，退避 2/4/8s ≤3 次；认证失败永不重试
 */
const logs = require('./logs');
const ports = require('./ports');
const markers = require('./markers');
const { PromptDetector } = require('./prompt');
const { buildArgs, enabledLocalPorts } = require('./ssh-args');
const spawner = require('./spawner');
const platform = require('./platform');
const agent = require('./agent');

const entries = new Map(); // id -> entry
let stateCb = null;

function onState(cb) { stateCb = cb; }

function emit(id, patch) {
  const e = entries.get(id);
  if (e) Object.assign(e, patch);
  if (stateCb) {
    try { stateCb(Object.assign({ id: id }, patch)); } catch (err) {}
  }
}

function clearTimers(entry) {
  (entry.timers || []).forEach((t) => {
    try { clearInterval(t); } catch (e) {}
    try { clearTimeout(t); } catch (e) {}
  });
  entry.timers = [];
}

function env() {
  return platform.sshVersion().then((v) => ({
    platform: process.platform,
    sshVersion: v,
    sshMissing: !v,
  }));
}

/** 启动隧道。tunnel 为完整文档；secrets={password?,passphrase?} 仅内存持有 */
async function start(tunnel, secrets) {
  const id = tunnel._id;
  const e0 = entries.get(id);
  if (e0 && (e0.status === 'running' || e0.status === 'starting')) {
    return { ok: false, error: '隧道已在运行或正在连接' };
  }
  const enabled = (tunnel.rules || []).filter((r) => r.enabled);
  if (!enabled.length) return { ok: false, error: '没有启用的转发规则' };

  // 本地端口预检
  const specs = enabledLocalPorts(tunnel);
  for (const s of specs) {
    const r = await ports.checkFree(s.port, s.host);
    if (!r.free) {
      return { ok: false, error: '本地端口 ' + s.port + ' 已被占用（' + s.host + '），可执行 lsof -nP -iTCP:' + s.port + ' 查看占用进程' };
    }
  }

  const entry = {
    id: id, tunnel: tunnel, secrets: secrets || {},
    status: 'starting', pid: null, child: null,
    startedAt: null, lastError: null, errorKind: null,
    retryCount: 0, requested: false, adopted: false,
    timers: [], logBuf: '', authSeen: false, spawnedAt: 0,
  };
  entries.set(id, entry);
  emit(id, { status: 'starting', lastError: null, errorKind: null });
  return spawnEntry(entry);
}

async function spawnEntry(entry) {
  const t = entry.tunnel;
  const args = buildArgs(t);
  const envv = Object.assign({}, process.env);
  if (((t.auth || {}).method) === 'agent') {
    const sock = await agent.resolve(t.options ? t.options.agentSockOverride : null);
    if (sock) envv.SSH_AUTH_SOCK = sock;
  }

  let child;
  try {
    child = spawner.spawnSsh(args, envv);
  } catch (e) {
    emit(entry.id, { status: 'error', errorKind: 'other', lastError: '无法启动 ssh：' + e.message });
    return { ok: false, error: e.message };
  }

  entry.child = child;
  entry.pid = child.pid;
  entry.spawnedAt = Date.now();
  entry.logBuf = '';
  entry.authSeen = false;

  logs.open(entry.id);
  const detector = new PromptDetector((type) => handlePrompt(entry, type));

  child.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    logs.write(entry.id, s);
    entry.logBuf = (entry.logBuf + s).slice(-8192);
    if (markers.AUTH_OK_RE.test(s)) entry.authSeen = true;
    detector.feed(s);
  });
  child.stdout.on('data', (d) => logs.write(entry.id, d.toString('utf8')));
  child.on('error', (err) => {
    failOrRetry(entry, 'other', '无法执行 ssh：' + err.message);
  });
  child.on('exit', (code) => {
    logs.close(entry.id);
    if (entry.requested) { emitStopped(entry, null); return; }
    if (entry.status === 'running' || entry.status === 'starting') {
      const cls = markers.classify(entry.logBuf);
      failOrRetry(entry, cls.kind, cls.message + '（退出码 ' + code + '）');
    }
  });

  startReadyPoll(entry);
  return { ok: true, pid: child.pid };
}

/** 密码 / passphrase 提示命中后的处理 */
function handlePrompt(entry, type) {
  const sec = entry.secrets || {};
  const val = type === 'passphrase' ? sec.passphrase : sec.password;
  if (!val) {
    entry.requested = true;
    if (entry.child) platform.killPid(entry.child.pid);
    emit(entry.id, {
      status: 'error', errorKind: 'auth',
      lastError: type === 'passphrase'
        ? '私钥设有 passphrase：请在编辑中补充后重试'
        : '该隧道需要密码认证：请在编辑中补充密码后重试',
    });
    return;
  }
  try { entry.child.stdin.write(val + '\n'); } catch (e) {}
}

/** 就绪判定轮询 */
function startReadyPoll(entry) {
  const localPorts = enabledLocalPorts(entry.tunnel);
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (entry.status !== 'starting') { clearInterval(iv); return; }
    const check = async () => {
      let ready = false;
      if (localPorts.length) {
        const ups = [];
        for (const p of localPorts) ups.push(await ports.probe(p.port, p.host, 300));
        ready = ups.length > 0 && ups.every(Boolean);
      } else {
        ready = entry.authSeen && (Date.now() - entry.spawnedAt > 1500);
      }
      if (entry.status !== 'starting') return;
      if (ready) {
        clearInterval(iv);
        entry.retryCount = 0;
        const now = Date.now();
        emit(entry.id, { status: 'running', pid: entry.pid, startedAt: now });
        return;
      }
      if (Date.now() - t0 > 30000) {
        clearInterval(iv);
        entry.requested = true;
        if (entry.child) platform.killPid(entry.child.pid);
        emit(entry.id, { status: 'error', errorKind: 'timeout', lastError: '连接超时：30 秒内未建立转发（详见日志）' });
      }
    };
    check();
  }, 300);
  entry.timers.push(iv);
}

function failOrRetry(entry, kind, message) {
  const o = entry.tunnel.options || {};
  const auto = o.autoReconnect !== false;
  if (kind === 'network' && auto && entry.retryCount < 3 && !entry.requested) {
    entry.retryCount += 1;
    const delay = [2000, 4000, 8000][entry.retryCount - 1];
    emit(entry.id, { status: 'starting', lastError: message + ' · ' + (delay / 1000) + ' 秒后自动重连（' + entry.retryCount + '/3）' });
    const t = setTimeout(() => {
      if (!entry.requested && entry.status === 'starting') spawnEntry(entry);
    }, delay);
    entry.timers.push(t);
    return;
  }
  emit(entry.id, { status: 'error', errorKind: kind, lastError: message });
}

function emitStopped(entry, note) {
  clearTimers(entry);
  emit(entry.id, { status: 'stopped', pid: null, startedAt: null, lastError: note || null, errorKind: null });
}

async function stop(id) {
  const entry = entries.get(id);
  if (!entry) return { ok: true };
  entry.requested = true;
  clearTimers(entry);
  if (entry.child) { try { entry.child.stdin.end(); } catch (e) {} }
  if (entry.pid) await platform.killPid(entry.pid);
  logs.close(id);
  emitStopped(entry, null);
  return { ok: true };
}

/**
 * 接管：uTools 重启后凭 db 中的 PID 恢复管理。
 * 校验链：pid 存活 → ps argv 含 UTM_TUNNEL=<id> 与 host → 记为 running（uptime 连续）。
 * 被接管进程无 stderr 管道：无实时日志，但历史日志文件仍可读。
 */
async function adopt(id, tunnel, info) {
  if (!info || !info.pid) return { alive: false };
  const e0 = entries.get(id);
  if (e0 && (e0.status === 'running' || e0.status === 'starting')) {
    return { alive: true, managed: true };
  }
  const ok = await spawner.verifyPid(info.pid, id, tunnel.host);
  if (!ok) return { alive: false };
  const entry = {
    id: id, tunnel: tunnel, secrets: null,
    status: 'running', pid: info.pid, child: null,
    startedAt: info.startedAt || Date.now(),
    lastError: null, errorKind: null, retryCount: 0,
    requested: false, adopted: true, timers: [], logBuf: '', authSeen: false, spawnedAt: 0,
  };
  entries.set(id, entry);
  return { alive: true };
}

/** 内存状态快照 */
function statuses() {
  const out = {};
  entries.forEach((e, id) => {
    out[id] = {
      status: e.status, pid: e.pid, startedAt: e.startedAt,
      lastError: e.lastError, errorKind: e.errorKind, adopted: e.adopted,
    };
  });
  return out;
}

/** watchdog：10s 轮询；running 但进程已死 → stopped（有 child 的由 exit 事件即时处理） */
// 注意：uTools preload 跑在 Electron 渲染进程，setInterval 返回 number（无 .unref()）；
// 纯 Node 环境返回 Timeout。两种环境都要兼容。
const watchdog = setInterval(() => {
  entries.forEach((entry, id) => {
    if (entry.status !== 'running') return;
    if (entry.requested) return;
    if (!entry.pid || !platform.pidAlive(entry.pid)) {
      logs.close(id);
      emit(id, { status: 'stopped', pid: null, startedAt: null, lastError: entry.adopted ? '隧道进程已退出' : null });
    }
  });
}, 10000);
if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();

module.exports = { env, start, stop, adopt, statuses, onState };
