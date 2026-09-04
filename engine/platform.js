'use strict';
/**
 * 平台差异封装。macOS 完整实现；Windows 预留桩。
 * 兼容 Node 14。
 */
const fs = require('fs');
const { spawn } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

/** ssh 可执行文件路径。macOS GUI 应用 PATH 极简，优先用绝对路径。 */
function sshPath() {
  if (IS_WIN) return 'ssh';
  if (fs.existsSync('/usr/bin/ssh')) return '/usr/bin/ssh';
  if (fs.existsSync('/usr/local/bin/ssh')) return '/usr/local/bin/ssh';
  return 'ssh';
}

/** 取 ssh 版本字符串；失败返回 null */
function sshVersion() {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let c;
    try {
      c = spawn(sshPath(), ['-V'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return done(null);
    }
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} done(out.trim() || null); }, 3000);
    c.on('error', () => { clearTimeout(t); done(null); });
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; }); // ssh -V 输出在 stderr
    c.on('exit', () => { clearTimeout(t); done(out.trim().split('\n')[0] || null); });
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** ps 命令（用于 PID 复用防御）。Windows 预留 null。 */
function psCommand(pid) {
  if (IS_WIN) return null;
  return { cmd: 'ps', args: ['-ww', '-o', 'command=', '-p', String(pid)] };
}

/** 先 SIGTERM，3 秒未退则 SIGKILL */
function killPid(pid) {
  return new Promise((resolve) => {
    if (!pidAlive(pid)) return resolve(true);
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearInterval(iv); clearTimeout(hard); clearTimeout(giveup); resolve(true); } };
    try { process.kill(pid, 'SIGTERM'); } catch (e) { return resolve(true); }
    const iv = setInterval(() => { if (!pidAlive(pid)) done(); }, 200);
    const hard = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch (e) {} }, 3000);
    const giveup = setTimeout(done, 4000);
  });
}

module.exports = { IS_MAC, IS_WIN, sshPath, sshVersion, pidAlive, psCommand, killPid };
