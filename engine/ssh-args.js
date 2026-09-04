'use strict';
/**
 * ssh 命令行参数拼装（纯函数）。
 * 规则字段约定：
 *  - type L（本地转发）: localPort=本机监听端口, remoteHost/remotePort=目标（服务器视角可达）
 *  - type R（反向转发）: localPort=服务器监听端口, remoteHost/remotePort=目标（客户端视角，默认指向本机）
 *  - type D（动态SOCKS）: localPort=本机 SOCKS 端口
 */
const os = require('os');
const path = require('path');

function expand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.indexOf('~/') === 0) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ruleToArgs(rule, bindHost) {
  const lp = Number(rule.localPort);
  if (rule.type === 'L') {
    return ['-L', bindHost + ':' + lp + ':' + rule.remoteHost + ':' + Number(rule.remotePort)];
  }
  if (rule.type === 'R') {
    // 服务器侧仅绑定回环，避免意外暴露公网；如需 0.0.0.0 由远端 GatewayPorts 控制
    return ['-R', '127.0.0.1:' + lp + ':' + rule.remoteHost + ':' + Number(rule.remotePort)];
  }
  if (rule.type === 'D') {
    return ['-D', bindHost + ':' + lp];
  }
  return [];
}

function buildArgs(tunnel) {
  const o = tunnel.options || {};
  const auth = tunnel.auth || {};
  const args = ['-N', '-T'];

  // DEBUG1：状态机/错误分类依赖日志标记；不泄露密码内容
  args.push('-o', 'LogLevel=DEBUG1');
  // 转发绑定失败立即退出（本地端口冲突 / -R 远端口占用 都能被感知）
  args.push('-o', 'ExitOnForwardFailure=yes');
  args.push('-o', 'ServerAliveInterval=' + (o.serverAliveInterval || 30));
  args.push('-o', 'ServerAliveCountMax=' + (o.serverAliveCountMax || 3));
  args.push('-o', 'ConnectTimeout=' + (o.connectTimeout || 15));
  args.push('-o', 'StrictHostKeyChecking=' + (o.strictHostKeyChecking || 'accept-new'));
  // 密码只允许尝试一次：错误即失败，状态机确定、不循环
  args.push('-o', 'NumberOfPasswordPrompts=1');
  // 默认屏蔽用户/系统 ssh_config，行为可预期；可配置关闭
  if (!o.useUserSshConfig) args.push('-F', '/dev/null');

  if (auth.method === 'key' && auth.keyPath) {
    args.push('-o', 'IdentitiesOnly=yes');
    args.push('-i', expand(auth.keyPath));
  }
  if (auth.method === 'password') {
    // 密码认证时禁用公钥，避免 agent 中其它钥匙抢先尝试导致 too many failures
    args.push('-o', 'PubkeyAuthentication=no');
  }
  if (tunnel.port && Number(tunnel.port) !== 22) args.push('-p', String(Number(tunnel.port)));
  if (o.proxyJump) args.push('-J', o.proxyJump);

  // 身份标记：出现在 ps argv 中，用于 PID 复用防御（接管/kill 前校验）
  args.push('-o', 'SetEnv=UTM_TUNNEL=' + tunnel._id);

  const bindHost = o.localBindHost || '127.0.0.1';
  (tunnel.rules || []).forEach((r) => {
    if (!r.enabled) return;
    ruleToArgs(r, bindHost).forEach((a) => args.push(a));
  });

  args.push(tunnel.user + '@' + tunnel.host);
  return args;
}

/** 启用规则中需要本机监听的端口（L/D），用于预检与就绪判定 */
function enabledLocalPorts(tunnel) {
  const bindHost = (tunnel.options || {}).localBindHost || '127.0.0.1';
  return (tunnel.rules || [])
    .filter((r) => r.enabled && (r.type === 'L' || r.type === 'D'))
    .map((r) => ({ port: Number(r.localPort), host: bindHost }));
}

module.exports = { buildArgs, expand, enabledLocalPorts, ruleToArgs };
