'use strict';
/**
 * ssh 子进程派生与 PID 校验。
 * detached:true → POSIX setsid 新会话、脱离控制终端；
 * spawn 成功后立即 unref()：uTools 退出后隧道继续存活（常驻后台的核心）。
 * OpenSSH 忽略 SIGPIPE，父进程退出、管道读端关闭后 ssh 写 stderr 遇 EPIPE 不死。
 */
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const platform = require('./platform');
const { expand } = require('./ssh-args');

function spawnSsh(args, env) {
  const child = spawn(platform.sshPath(), args, {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'], // stdin 写密码；stdout/stderr 做 tee + 提示词探测
    cwd: os.homedir(),
    env: env,
    windowsHide: true,
  });
  try { child.unref(); } catch (e) {}
  return child;
}

/**
 * PID 复用防御：进程存活 + ps argv 同时含 UTM_TUNNEL=<id> 与 host，才认为是我们的隧道。
 */
function verifyPid(pid, tunnelId, host) {
  return new Promise((resolve) => {
    if (!platform.pidAlive(pid)) return resolve(false);
    const ps = platform.psCommand(pid);
    if (!ps) return resolve(true); // Windows 预留：仅凭存活
    let out = '';
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    let c;
    try {
      c = spawn(ps.cmd, ps.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return done(false);
    }
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} done(false); }, 3000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', () => {});
    c.on('error', () => { clearTimeout(t); done(false); });
    c.on('exit', () => {
      clearTimeout(t);
      done(out.indexOf('UTM_TUNNEL=' + tunnelId) !== -1 && out.indexOf(host) !== -1);
    });
  });
}

/** 私钥文件预检 */
function checkKey(p) {
  return new Promise((resolve) => {
    if (!p) return resolve({ ok: false, error: '未指定私钥路径' });
    const fp = expand(p);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return resolve({ ok: false, error: '不是文件：' + fp });
      try { fs.accessSync(fp, fs.constants.R_OK); } catch (e) {
        return resolve({ ok: false, error: '私钥不可读：' + fp });
      }
      resolve({ ok: true, path: fp });
    } catch (e) {
      resolve({ ok: false, error: '私钥文件不存在：' + fp });
    }
  });
}

module.exports = { spawnSsh, verifyPid, checkKey };
