'use strict';
/*
 * v2.0 引擎层冒烟测试（纯 Node）：node test/smoke-v2.js
 * 覆盖：ssh-config 解析 18 边界 / ruleToArgs bindAll / logs.listFiles+search。
 * 注意：纯 Node 定时器有 unref，测不出渲染进程差异——uTools 内验证不可省。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sshConfig = require('../engine/ssh-config');
const sshArgs = require('../engine/ssh-args');
const logs = require('../engine/logs');

let pass = 0;
function ok(name, fn) {
  fn();
  pass++;
  console.log('  ✓ ' + name);
}

/* ================= 1. fixture 解析（行号见 test/fixtures/ssh-config-sample.txt） ================= */
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ssh-config-sample.txt'), 'utf8');
const r = sshConfig.parse(fixture);
const E = r.entries;

console.log('ssh-config 解析：');
ok('9 个块 / 5 个含转发 / includes 1 / errors 4', function () {
  assert.strictEqual(E.length, 9);
  assert.strictEqual(E.filter(function (e) { return e.hasForward; }).length, 5);
  assert.deepStrictEqual(r.includes, [{ path: '~/.ssh/conf.d/work', line: 30 }]);
  assert.deepStrictEqual(r.errors.map(function (e) { return e.line; }), [39, 41, 42, 44]);
});
ok('通配符块整体跳过（Host *、dev-*）', function () {
  assert.strictEqual(E[0].wildcard, true);
  assert.strictEqual(E[0].skipReason, 'wildcard');
  assert.deepStrictEqual(E[0].aliases, ['*']);
  assert.strictEqual(E[3].skipReason, 'wildcard');
  assert.deepStrictEqual(E[3].aliases, ['dev-*']);
});
ok('Match 块 skipReason=match', function () {
  assert.strictEqual(E[4].kind, 'match');
  assert.strictEqual(E[4].skipReason, 'match');
});
ok('bastion 全字段（HostName/Port/User/IdentityFile×2/ProxyJump/行号）', function () {
  const b = E[1];
  assert.strictEqual(b.line, 8);
  assert.strictEqual(b.hostName, 'bastion.corp.com');
  assert.strictEqual(b.port, 2222);
  assert.strictEqual(b.user, 'deploy');
  assert.deepStrictEqual(b.identityFiles, ['~/.ssh/id_work', '~/.ssh/id_work_backup']);
  assert.strictEqual(b.proxyJump, 'jump1.corp.com');
  assert.deepStrictEqual(b.aliases, ['bastion', 'bastion.corp.com']);
});
ok('转发三类型映射（L / R bind=0.0.0.0 / D）', function () {
  const f = E[1].forwards;
  assert.strictEqual(f.length, 3);
  assert.deepStrictEqual([f[0].dir, f[0].bind, f[0].port, f[0].targetHost, f[0].targetPort], ['L', '', 18080, '127.0.0.1', 8000]);
  assert.deepStrictEqual([f[1].dir, f[1].bind, f[1].port, f[1].targetHost, f[1].targetPort], ['R', '0.0.0.0', 9000, '127.0.0.1', 9000]);
  assert.deepStrictEqual([f[2].dir, f[2].bind, f[2].port, f[2].targetHost], ['D', '', 11080, '']);
});
ok('小写关键字 / D 带 bind / ProxyJump（gpu-box）', function () {
  const g = E[2];
  assert.strictEqual(g.hostName, '10.0.3.21');
  assert.strictEqual(g.port, 22);
  assert.strictEqual(g.user, '');
  assert.strictEqual(g.proxyJump, 'bastion');
  assert.deepStrictEqual([g.forwards[0].dir, g.forwards[0].bind, g.forwards[0].port], ['D', '127.0.0.1', 11081]);
});
ok('Port=2222 等号分隔 / 同块重复 HostName 首个生效（web-dev）', function () {
  const w = E[5];
  assert.strictEqual(w.port, 2222);
  assert.strictEqual(w.hostName, 'web-dev.internal');
  assert.deepStrictEqual([w.forwards[0].dir, w.forwards[0].port, w.forwards[0].targetHost, w.forwards[0].targetPort], ['L', 8080, '127.0.0.1', 80]);
});
ok('IPv6 方括号 bind 与 target（broken 仅该行存活）', function () {
  const br = E[6];
  assert.strictEqual(br.forwards.length, 1);
  const f = br.forwards[0];
  assert.deepStrictEqual([f.dir, f.bind, f.port, f.targetHost, f.targetPort], ['L', '::1', 8081, '::1', 80]);
});
ok('畸形行记 errors 不丢整块（缺 target / 端口越界 / 端口非数字）', function () {
  const lines = r.errors.map(function (e) { return e.line; });
  assert.ok(lines.indexOf(39) >= 0 && lines.indexOf(41) >= 0 && lines.indexOf(42) >= 0);
  assert.strictEqual(E[6].forwards.length, 1); // broken 块仍在
});
ok('裸 Host 记错并跳块（L44，User nobody 不泄漏到别块）', function () {
  assert.ok(r.errors.some(function (e) { return e.line === 44; }));
  assert.ok(!E.some(function (e) { return e.user === 'nobody'; }));
});
ok('同名 Host 块 ×2 不合并', function () {
  const dups = E.filter(function (e) { return e.aliases.length === 1 && e.aliases[0] === 'dup'; });
  assert.strictEqual(dups.length, 2);
  assert.strictEqual(dups[0].user, 'a');
  assert.strictEqual(dups[1].user, 'b');
  assert.strictEqual(dups[1].forwards.length, 1);
});
ok('全局区关键字忽略（ForwardAgent 不进任何 entry）', function () {
  assert.ok(!E.some(function (e) { return e.line === 1; }));
});

/* ================= 2. 归一化：CRLF / BOM / tab ================= */
console.log('归一化：');
ok('BOM + CRLF + tab 混排', function () {
  const t = '\uFEFFHost crlf\r\n\thostName\tcrlf.example.com\r\n\tLocalForward\t9001\t127.0.0.1:90\r\n';
  const p = sshConfig.parse(t);
  assert.strictEqual(p.entries.length, 1);
  assert.strictEqual(p.entries[0].hostName, 'crlf.example.com');
  assert.strictEqual(p.entries[0].forwards[0].port, 9001);
});
ok('空文本 / 全注释', function () {
  assert.deepStrictEqual(sshConfig.parse('').entries, []);
  assert.deepStrictEqual(sshConfig.parse('# a\n#b\n').entries, []);
  assert.deepStrictEqual(sshConfig.parse('').errors, []);
});

/* ================= 3. ruleToArgs / buildArgs：bindAll ================= */
console.log('ssh-args bindAll：');
const rRule = { type: 'R', enabled: true, localPort: 9000, remoteHost: '127.0.0.1', remotePort: 9000 };
ok('缺省回落 127.0.0.1（v1 兼容）', function () {
  assert.deepStrictEqual(sshArgs.ruleToArgs(rRule, '127.0.0.1'), ['-R', '127.0.0.1:9000:127.0.0.1:9000']);
});
ok('bindAll:true → 0.0.0.0', function () {
  const r2 = Object.assign({}, rRule, { bindAll: true });
  assert.deepStrictEqual(sshArgs.ruleToArgs(r2, '127.0.0.1'), ['-R', '0.0.0.0:9000:127.0.0.1:9000']);
});
ok('bindAll 不影响 L/D 的 bindHost', function () {
  const l = { type: 'L', enabled: true, localPort: 80, remoteHost: '10.0.0.2', remotePort: 80, bindAll: true };
  assert.deepStrictEqual(sshArgs.ruleToArgs(l, '127.0.0.1'), ['-L', '127.0.0.1:80:10.0.0.2:80']);
});
ok('buildArgs 全链路：0.0.0.0 与 UTM_TUNNEL 标记共存', function () {
  const tunnel = {
    _id: 'tunnel_smoke', host: 'h', port: 22, user: 'u',
    auth: { method: 'agent' }, options: {},
    rules: [Object.assign({}, rRule, { bindAll: true })],
  };
  const args = sshArgs.buildArgs(tunnel);
  assert.ok(args.indexOf('-R') >= 0);
  assert.ok(args.indexOf('0.0.0.0:9000:127.0.0.1:9000') >= 0);
  assert.ok(args.indexOf('SetEnv=UTM_TUNNEL=tunnel_smoke') >= 0);
});

/* ================= 4. logs.listFiles / search ================= */
console.log('logs 检索：');
const ID_A = 'tunnel_smoke_a';
const ID_B = 'tunnel_smoke_b';
const TOK = 'smk_denied_xyz';
try {
  fs.mkdirSync(logs.DIR, { recursive: true });
  fs.writeFileSync(path.join(logs.DIR, ID_A + '.log'), [
    'line1 hello',
    'line2 Permission ' + TOK + ', please try again.',
    'line3 bye',
    'line4 upper SMK_DENIED_XYZ here',
    'line5 tail',
  ].join('\n'));
  fs.writeFileSync(path.join(logs.DIR, ID_B + '.log'), 'alpha\nbeta ' + TOK + '\ngamma\n');

  ok('listFiles 含两个 smoke 文件（mtime 倒序）', function () {
    const ids = logs.listFiles().map(function (f) { return f.id; });
    assert.ok(ids.indexOf(ID_A) >= 0 && ids.indexOf(ID_B) >= 0);
  });
  ok('search 大小写不敏感 + 行号 + 上下文', function () {
    const s = logs.search(TOK);
    const fa = s.files.filter(function (f) { return f.id === ID_A; })[0];
    assert.ok(fa);
    assert.strictEqual(fa.hits.length, 2);
    assert.strictEqual(fa.hits[0].lineNo, 2);
    assert.deepStrictEqual(fa.hits[0].before, ['line1 hello']);
    assert.deepStrictEqual(fa.hits[0].after, ['line3 bye']);
    assert.strictEqual(fa.hits[1].lineNo, 4);
    const fb = s.files.filter(function (f) { return f.id === ID_B; })[0];
    assert.strictEqual(fb.hits[0].lineNo, 2);
  });
  ok('caseSensitive 生效', function () {
    const s = logs.search(TOK, { caseSensitive: true });
    const fa = s.files.filter(function (f) { return f.id === ID_A; })[0];
    assert.ok(fa);
    assert.strictEqual(fa.hits.length, 1);
    assert.strictEqual(fa.hits[0].lineNo, 2);
  });
  ok('maxHitsPerFile 截断标记', function () {
    const s = logs.search(TOK, { maxHitsPerFile: 1 });
    const fa = s.files.filter(function (f) { return f.id === ID_A; })[0];
    assert.strictEqual(fa.hits.length, 1);
    assert.strictEqual(fa.truncated, true);
  });
  ok('空关键词返回空结果 / 正则特殊字符免转义', function () {
    assert.deepStrictEqual(logs.search('').files, []);
    const s = logs.search('a.c(d)e[f]'); // 若误用 RegExp 会报错或误命中
    assert.strictEqual(s.files.filter(function (f) { return f.id === ID_A || f.id === ID_B; }).length, 0);
  });
} finally {
  [ID_A, ID_B].forEach(function (id) {
    try { fs.unlinkSync(path.join(logs.DIR, id + '.log')); } catch (e) {}
  });
}

console.log('\n全部通过：' + pass + ' 项');
