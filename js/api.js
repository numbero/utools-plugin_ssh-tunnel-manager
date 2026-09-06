'use strict';
/*
 * 环境兼容层（延迟判定）：
 * - 真实 uTools 环境：preload.js 挂 window.api（先于页面脚本执行），window.utools 由宿主
 *   注入，但注入时机可能晚于页面脚本解析。因此解析期不做任何判定，由 main.js 在
 *   waitReady 之后调用 ensureEnv()：真实环境齐备则原样使用，缺失才装模拟。
 * - 普通浏览器预览：两者皆无 → 装内存版 utools 与模拟 api，UI 可完整交互。
 */
(function () {
  window.STM = window.STM || {};

  function mkKV() {
    var m = {};
    return {
      setItem: function (k, v) { m[k] = String(v); },
      getItem: function (k) { return k in m ? m[k] : null; },
      removeItem: function (k) { delete m[k]; },
    };
  }
  function mkDb() {
    var m = {};
    return {
      get: function (id) { return id in m ? JSON.parse(JSON.stringify(m[id])) : null; },
      put: function (doc) {
        var rev = 'r' + Math.random().toString(36).slice(2, 8);
        m[doc._id] = JSON.parse(JSON.stringify(doc));
        m[doc._id]._rev = rev;
        return { ok: true, id: doc._id, rev: rev };
      },
      remove: function (d) { var id = typeof d === 'string' ? d : d._id; delete m[id]; return { ok: true }; },
      allDocs: function (prefix) {
        var out = [];
        for (var k in m) { if (!prefix || k.indexOf(prefix) === 0) out.push(JSON.parse(JSON.stringify(m[k]))); }
        return out;
      },
    };
  }

  function installUtoolsShim() {
    var enterCbs = [];
    var featStore = [];
    window.utools = {
      db: mkDb(),
      dbStorage: mkKV(),
      dbCryptoStorage: mkKV(),
      getFeatures: function () { return featStore.slice(); },
      setFeature: function (f) {
        featStore = featStore.filter(function (x) { return x.code !== f.code; });
        featStore.push(f);
        return true;
      },
      removeFeature: function (code) { featStore = featStore.filter(function (x) { return x.code !== code; }); return true; },
      showNotification: function (b) { console.log('[notify]', b); },
      onPluginEnter: function (cb) { enterCbs.push(cb); },
      onPluginOut: function () {},
      isDarkColors: function () { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; },
      setExpendHeight: function () {},
      showOpenDialog: function () { console.log('[preview] showOpenDialog 不可用'); return null; },
      showSaveDialog: function () { console.log('[preview] showSaveDialog 不可用'); return null; },
      outPlugin: function () {},
      hideMainWindow: function () {},
    };
    window.__triggerEnter = function (code) { enterCbs.forEach(function (cb) { cb({ code: code, type: 'text' }); }); };
  }

  function installApiShim() {
    var stateCb = null;
    window.api = {
      env: function () { return Promise.resolve({ platform: 'browser', sshVersion: 'OpenSSH（浏览器预览模拟）', sshMissing: false }); },
      onState: function (cb) { stateCb = cb; },
      start: function (t) {
        setTimeout(function () { if (stateCb) stateCb({ id: t._id, status: 'starting', lastError: null }); }, 0);
        setTimeout(function () { if (stateCb) stateCb({ id: t._id, status: 'running', pid: 424242, startedAt: Date.now() }); }, 1300);
        return Promise.resolve({ ok: true, pid: 424242 });
      },
      stop: function (id) {
        setTimeout(function () { if (stateCb) stateCb({ id: id, status: 'stopped', pid: null, startedAt: null, lastError: null }); }, 200);
        return Promise.resolve({ ok: true });
      },
      adopt: function () { return Promise.resolve({ alive: false }); },
      statuses: function () { return Promise.resolve({}); },
      checkLocalPorts: function (specs) { return Promise.resolve((specs || []).map(function (s) { return { port: s.port, host: s.host, free: true }; })); },
      checkKey: function () { return Promise.resolve({ ok: true }); },
      checkAgent: function () { return Promise.resolve({ ok: true, sock: '/tmp/preview-agent', identities: 2 }); },
      logTail: function () { return Promise.resolve(''); },
      logClear: function () { return Promise.resolve(); },
      logFiles: function () { return Promise.resolve([]); },
      logSearch: function (kw) {
        return Promise.resolve({
          keyword: kw, scanned: 2, elapsedMs: 3,
          files: [{
            id: 'tunnel_preview', file: '~/.utools-ssh-tunnel/logs/tunnel_preview.log', truncated: false,
            hits: [{
              lineNo: 12,
              text: "debug1: Permission " + kw + ", please try again.",
              before: ['debug1: Next authentication method: password'],
              after: ['debug1: Authentications that can continue: publickey,password'],
            }],
          }],
        });
      },
      parseSshConfig: function () {
        return Promise.resolve({
          ok: true, path: '~/.ssh/config',
          result: {
            defaultUser: 'preview',
            entries: [
              { kind: 'host', aliases: ['bastion'], wildcard: false, line: 3, hostName: 'bastion.corp.com', port: 2222, user: 'deploy',
                identityFiles: ['~/.ssh/id_work'], proxyJump: '',
                forwards: [
                  { dir: 'R', bind: '0.0.0.0', port: 9000, targetHost: '127.0.0.1', targetPort: 9000, line: 8, raw: '' },
                  { dir: 'L', bind: '', port: 18080, targetHost: '127.0.0.1', targetPort: 8000, line: 9, raw: '' },
                ],
                hasForward: true, skipReason: '' },
              { kind: 'host', aliases: ['gpu-box'], wildcard: false, line: 12, hostName: '10.0.3.21', port: 22, user: '',
                identityFiles: [], proxyJump: 'bastion',
                forwards: [{ dir: 'D', bind: '', port: 11080, targetHost: '', targetPort: 0, line: 15, raw: '' }],
                hasForward: true, skipReason: '' },
              { kind: 'host', aliases: ['*'], wildcard: true, line: 20, hostName: '', port: 22, user: '',
                identityFiles: [], proxyJump: '', forwards: [], hasForward: false, skipReason: 'wildcard' },
              { kind: 'match', aliases: ['host', 'x'], wildcard: false, line: 24, hostName: '', port: 22, user: '',
                identityFiles: [], proxyJump: '', forwards: [], hasForward: false, skipReason: 'match' },
              { kind: 'host', aliases: ['plain'], wildcard: false, line: 27, hostName: 'plain.local', port: 22, user: 'u',
                identityFiles: [], proxyJump: '', forwards: [], hasForward: false, skipReason: '' },
            ],
            includes: [{ path: '~/.ssh/conf.d/work', line: 30 }],
            errors: [{ line: 33, text: 'LocalForward 8080' }],
          },
        });
      },
      writeFile: function () { return Promise.resolve(); },
      readFile: function () { return Promise.resolve('{"app":"utools-ssh-tunnel-manager","version":1,"tunnels":[]}'); },
    };
  }

  /**
   * 等待真实环境就绪：
   * - window.api 存在（preload 已跑 ⇒ 在 uTools 内）→ 等 window.utools 注入（最多 2.5s）；
   * - window.api 不存在（普通浏览器）→ 不等待，直接装模拟。
   */
  // 宿主可能只注入裸全局 utools：归一到 window.utools
  function normalize() {
    if (!window.utools) {
      try {
        if (typeof utools !== 'undefined') window.utools = utools;
      } catch (e) {}
    }
  }

  function waitReady(cb) {
    normalize();
    if (!window.api) return cb();
    var t0 = Date.now();
    (function poll() {
      normalize();
      if (window.utools || Date.now() - t0 > 2500) return cb();
      setTimeout(poll, 60);
    })();
  }

  function ensureEnv() {
    normalize();
    var real = !!window.utools && !!window.api;
    if (!window.utools) installUtoolsShim();
    if (!window.api) installApiShim();
    window.STM.browserPreview = !real;
  }

  window.STM.waitReady = waitReady;
  window.STM.ensureEnv = ensureEnv;
})();
