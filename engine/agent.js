'use strict';
/**
 * ssh-agent 解析链。
 * macOS GUI 应用拿不到用户 shell 环境是已知问题，因此按链路解析 SSH_AUTH_SOCK：
 *   设置手工指定 → process.env → launchctl getenv → 用户登录 shell
 * 并以 ssh-add -l 验证 agent 可用。
 */
const { spawn } = require('child_process');
const { IS_MAC } = require('./platform');

function run(cmd, args, env, timeout) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (code, o) => { if (!settled) { settled = true; resolve({ code: code, out: o }); } };
    let c;
    try {
      c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
    } catch (e) {
      return done(-1, '');
    }
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} done(-2, out); }, timeout || 3000);
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', () => {});
    c.on('error', () => { clearTimeout(t); done(-1, out); });
    c.on('exit', (code) => { clearTimeout(t); done(code == null ? 0 : code, out); });
  });
}

async function launchctlSock() {
  if (!IS_MAC) return null;
  const r = await run('launchctl', ['getenv', 'SSH_AUTH_SOCK'], undefined, 2000);
  const v = String(r.out || '').trim().split('\n')[0];
  return v || null;
}

async function shellSock() {
  const sh = process.env.SHELL || '/bin/zsh';
  const r = await run(sh, ['-lc', 'printf %s "$SSH_AUTH_SOCK"'], undefined, 3000);
  const v = String(r.out || '').trim().split('\n').pop();
  return v && v.indexOf('/') === 0 ? v : null;
}

/** 解析 SSH_AUTH_SOCK；override 为设置页手工指定值 */
async function resolve(override) {
  if (override) return override;
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  const a = await launchctlSock();
  if (a) return a;
  const b = await shellSock();
  if (b) return b;
  return null;
}

/** 校验 agent：返回 {ok, sock, identities, error} */
async function check(override) {
  const sock = await resolve(override);
  if (!sock) return { ok: false, sock: null, error: '未探测到 ssh-agent（SSH_AUTH_SOCK 缺失），可先在终端 ssh-add 或手动指定' };
  const env = Object.assign({}, process.env, { SSH_AUTH_SOCK: sock });
  const r = await run('ssh-add', ['-l'], env, 3000);
  if (r.code === 0) {
    const lines = String(r.out).trim().split('\n').filter((l) => l.trim());
    return { ok: true, sock: sock, identities: lines.length };
  }
  if (r.code === 1) return { ok: true, sock: sock, identities: 0, warning: 'agent 已连接但暂无密钥，先 ssh-add 添加' };
  return { ok: false, sock: sock, error: 'ssh-add -l 执行失败，agent 不可用' };
}

module.exports = { resolve, check };
