'use strict';
/**
 * 引擎入口：组装 engine/*，挂 window.api 给页面层。
 * 分层铁律：本层只管 ssh 进程与本机 I/O，不触碰任何 utools API、不做持久化。
 * 秘密流向：dbCryptoStorage(页面) → 页面内存 → api.start(tunnel, secrets) → 子进程 stdin；
 * 不进 argv / env / 日志。
 */
const fs = require('fs');
const manager = require('./engine/manager');
const logs = require('./engine/logs');
const ports = require('./engine/ports');
const spawner = require('./engine/spawner');
const agent = require('./engine/agent');
const sshConfig = require('./engine/ssh-config');

// 某些 uTools 版本的 preload 上下文可能无 window：兜底到 globalThis，避免静默崩
const win = (typeof window !== 'undefined') ? window : globalThis;

win.api = {
  env: () => manager.env(),
  start: (tunnel, secrets) => manager.start(tunnel, secrets),
  stop: (id) => manager.stop(id),
  adopt: (id, tunnel, info) => manager.adopt(id, tunnel, info),
  statuses: () => Promise.resolve(manager.statuses()),
  onState: (cb) => manager.onState(cb),

  checkLocalPorts: (specs) => ports.checkMany(specs),
  checkKey: (p) => spawner.checkKey(p),
  checkAgent: (override) => agent.check(override),

  logTail: (id, n) => Promise.resolve(logs.tail(id, n)),
  logClear: (id) => Promise.resolve(logs.clear(id)),
  logFiles: () => Promise.resolve(logs.listFiles()),
  logSearch: (kw, opts) => Promise.resolve(logs.search(kw, opts)),

  parseSshConfig: (p) => Promise.resolve(sshConfig.readAndParse(p)),

  writeFile: (p, text) => fs.promises.writeFile(p, text, 'utf8'),
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
};
