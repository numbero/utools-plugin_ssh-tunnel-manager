'use strict';
/** ssh stderr 日志标记表：错误分类 + 认证成功识别。 */

const AUTH_OK_RE = /Authenticated to |Authentication succeeded/i;

const TABLE = [
  { re: /Permission denied/i, kind: 'auth', msg: '认证失败：密码或密钥不正确（Permission denied）' },
  { re: /No supported authentication methods/i, kind: 'auth', msg: '认证失败：服务器不接受当前认证方式' },
  { re: /incorrect passphrase/i, kind: 'auth', msg: '私钥 passphrase 不正确' },
  { re: /REMOTE HOST IDENTIFICATION HAS CHANGED/i, kind: 'hostkey', msg: '主机密钥已变化（安全保护）。确认安全后执行 ssh-keygen -R <host> 清除旧记录' },
  { re: /Host key verification failed/i, kind: 'hostkey', msg: '主机密钥校验失败' },
  { re: /Could not resolve hostname/i, kind: 'dns', msg: '无法解析主机名（DNS）' },
  { re: /Connection timed out|timed out/i, kind: 'network', msg: '连接超时：请检查网络与主机可达性' },
  { re: /Connection refused/i, kind: 'network', msg: '连接被拒绝：请检查主机、端口与 sshd 是否运行' },
  { re: /Network is unreachable|No route to host/i, kind: 'network', msg: '网络不可达' },
  { re: /bind: Address already in use|Address already in use/i, kind: 'localport', msg: '本地端口已被占用，可执行 lsof -nP -iTCP:<port> 查看占用进程' },
  { re: /remote port forwarding failed for listen port/i, kind: 'remoteport', msg: '远端端口被占用或不允许监听（反向转发建立失败）' },
  { re: /Identity file .* not accessible|no such identity/i, kind: 'key', msg: '私钥文件不存在或不可读' },
  { re: /Permissions .* too open/i, kind: 'key', msg: '私钥文件权限过宽，建议 chmod 600' },
  { re: /Too many authentication failures/i, kind: 'key', msg: '尝试的密钥过多被服务器拒绝' },
  { re: /Load key[^\n]*invalid/i, kind: 'key', msg: '私钥加载失败（格式或 passphrase 问题）' },
  { re: /Bad configuration option/i, kind: 'other', msg: 'ssh 参数配置错误' },
];

function classify(text) {
  for (let i = 0; i < TABLE.length; i++) {
    if (TABLE[i].re.test(text)) return { kind: TABLE[i].kind, message: TABLE[i].msg };
  }
  return { kind: 'other', message: '连接失败，请查看日志了解详情' };
}

module.exports = { classify, AUTH_OK_RE, TABLE };
