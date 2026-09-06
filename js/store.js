'use strict';
/*
 * 页面层单一数据源与领域逻辑。
 * 页面层独占 utools API（db / 事件 / 动态指令 / 对话框）与持久化；
 * ssh 进程一切经 window.api（preload 引擎层）。
 */
(function () {
  // 惰性代理：window.utools 的注入可能晚于页面脚本解析，所有访问在调用期转发
  var U = new Proxy({}, {
    get: function (_, k) { return window.utools[k]; },
    set: function (_, k, v) { window.utools[k] = v; return true; },
  });
  var util = STM.util;
  var SECRET_PREFIX = 'stm_secret_';

  var S = Vue.reactive({
    env: { checked: false, sshMissing: false, sshVersion: '' },
    view: 'list',            // list | form | log
    query: '',
    tunnels: [],
    states: {},              // id -> {status,pid,startedAt,lastError,errorKind,adopted}
    expanded: {},
    now: Date.now(),
    form: null,
    formMode: 'new',
    formErrors: [],
    formWarnings: [],
    log: null,               // {id,name,content,timer}
    toasts: [],
    confirm: { open: false, title: '', message: '', yesText: '确认', danger: false, onYes: null },
    menuFor: null,
    themeMode: 'dark',   // auto | light | dark（默认深色）
    importDlg: null,     // {path,loading,error,items[],allChecked,skipped{wildcard[],match[],noForward},includes[],errors[]}
    search: { query: '', caseSensitive: false, results: null, loading: false, scanned: 0, elapsedMs: 0 },
  });

  /* ================= db ================= */
  function putDoc(doc) {
    var cur = U.db.get(doc._id);
    var d = util.clone(doc);
    if (cur && cur._rev) d._rev = cur._rev;
    return U.db.put(d);
  }
  function setRuntime(id, pid, startedAt) {
    var cur = U.db.get(id);
    if (cur) { cur.runtime = { pid: pid, startedAt: startedAt }; putDoc(cur); }
    var local = S.tunnels.find(function (t) { return t._id === id; });
    if (local) local.runtime = { pid: pid, startedAt: startedAt };
  }
  function clearRuntime(id) {
    var cur = U.db.get(id);
    if (cur && cur.runtime) { delete cur.runtime; putDoc(cur); }
    var local = S.tunnels.find(function (t) { return t._id === id; });
    if (local) delete local.runtime;
  }

  /* ================= 秘密 ================= */
  function readSecrets(id) {
    try {
      var raw = U.dbCryptoStorage.getItem(SECRET_PREFIX + id);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function writeSecrets(id, patch) {
    var next = readSecrets(id);
    if (patch.password) next.password = patch.password;
    if (patch.passphrase) next.passphrase = patch.passphrase;
    U.dbCryptoStorage.setItem(SECRET_PREFIX + id, JSON.stringify(next));
  }
  function clearPassword(id) {
    var next = readSecrets(id);
    delete next.password;
    U.dbCryptoStorage.setItem(SECRET_PREFIX + id, JSON.stringify(next));
    var cur = U.db.get(id);
    if (cur && cur.auth) { cur.auth.hasPassword = false; putDoc(cur); }
    var local = S.tunnels.find(function (t) { return t._id === id; });
    if (local && local.auth) local.auth.hasPassword = false;
    toast('已清除保存的密码');
  }

  /* ================= 载入 / 状态 ================= */
  function st(t) { return S.states[t._id] || { status: 'stopped' }; }

  async function loadTunnels() {
    var docs = U.db.allDocs('tunnel_') || [];
    docs.sort(function (a, b) {
      return ((a.order || 0) - (b.order || 0)) || ((a.createdAt || 0) - (b.createdAt || 0));
    });
    S.tunnels = docs;
    for (var i = 0; i < S.tunnels.length; i++) {
      var t = S.tunnels[i];
      if (t.runtime && t.runtime.pid) {
        var r = await window.api.adopt(t._id, util.clone(t), t.runtime);
        if (r.alive) {
          S.states[t._id] = { status: 'running', pid: t.runtime.pid, startedAt: t.runtime.startedAt, adopted: true };
        } else {
          clearRuntime(t._id);
          if (!S.states[t._id]) S.states[t._id] = { status: 'stopped' };
        }
      } else if (!S.states[t._id]) {
        S.states[t._id] = { status: 'stopped' };
      }
    }
  }

  function applyState(evt) {
    var prev = S.states[evt.id] || {};
    S.states[evt.id] = Object.assign({}, prev, evt);
    if (evt.status === 'running' && evt.pid) setRuntime(evt.id, evt.pid, evt.startedAt);
    else if (evt.status === 'stopped' || evt.status === 'error') clearRuntime(evt.id);
  }

  /* ================= 启停 ================= */
  async function startTunnel(t) {
    var enabled = (t.rules || []).filter(function (r) { return r.enabled; });
    if (!enabled.length) { toast('没有启用的转发规则，无法启动', 'red'); return; }
    S.states[t._id] = Object.assign({}, S.states[t._id], { status: 'starting', lastError: null });
    var res = await window.api.start(util.clone(t), readSecrets(t._id));
    if (!res.ok) {
      S.states[t._id] = Object.assign({}, S.states[t._id], { status: 'error', lastError: res.error, errorKind: 'precheck' });
      toast(res.error, 'red');
    }
  }
  async function stopTunnel(t) { await window.api.stop(t._id); }
  function startAll() {
    S.tunnels.filter(function (t) { var s = st(t).status; return s === 'stopped' || s === 'error'; })
      .forEach(function (t) { startTunnel(t); });
  }
  function stopAll() {
    S.tunnels.filter(function (t) { var s = st(t).status; return s === 'running' || s === 'starting'; })
      .forEach(function (t) { stopTunnel(t); });
  }

  /* ================= 视图 ================= */
  function setView(v) {
    S.view = v;
    var heights = { list: 560, form: 660, log: 600, search: 600 };
    try { U.setExpendHeight(heights[v] || 560); } catch (e) {}
  }
  function toggleExpand(id) { S.expanded[id] = !S.expanded[id]; S.menuFor = null; }
  function toggleRule(t, rule, en) {
    rule.enabled = en;
    var cur = U.db.get(t._id);
    if (cur) {
      var r = (cur.rules || []).find(function (x) { return x.id === rule.id; });
      if (r) { r.enabled = en; putDoc(cur); }
    }
    toast(en ? '已启用规则，重启隧道后生效' : '已停用规则，重启隧道后生效');
  }

  /* ================= 表单 ================= */
  function blankRule() { return { type: 'L', enabled: true, localPort: '', remoteHost: '127.0.0.1', remotePort: '', bindAll: false }; }

  function openForm(t) {
    S.formMode = t ? 'edit' : 'new';
    S.formErrors = [];
    S.formWarnings = [];
    var o = (t && t.options) || {};
    var a = (t && t.auth) || {};
    S.form = {
      id: t ? t._id : null,
      name: t ? t.name : '',
      host: t ? t.host : '',
      port: t ? (t.port || 22) : 22,
      user: t ? t.user : '',
      authMethod: a.method || 'key',
      keyPath: a.keyPath || '~/.ssh/id_ed25519',
      hasPassword: !!a.hasPassword,
      hasPassphrase: !!a.hasPassphrase,
      password: '',
      passphrase: '',
      proxyJump: o.proxyJump || '',
      localBindHost: o.localBindHost || '127.0.0.1',
      serverAliveInterval: o.serverAliveInterval || 30,
      connectTimeout: o.connectTimeout || 15,
      strictHostKeyChecking: o.strictHostKeyChecking || 'accept-new',
      autoReconnect: o.autoReconnect !== false,
      useUserSshConfig: !!o.useUserSshConfig,
      advOpen: false,
      rules: t && t.rules && t.rules.length ? util.clone(t.rules) : [blankRule()],
    };
    setView('form');
  }

  function addRuleRow() { S.form.rules.push(blankRule()); }
  function removeRuleRow(i) { S.form.rules.splice(i, 1); }

  function chooseKey() {
    var paths = U.showOpenDialog({ properties: ['openFile'], title: '选择私钥文件' });
    if (paths && paths.length) S.form.keyPath = paths[0];
  }

  function maxOrder() {
    return S.tunnels.reduce(function (m, t) { return Math.max(m, t.order || 0); }, 0);
  }

  function validateForm(f) {
    var errs = [];
    var warns = [];
    if (!f.name || !f.name.trim()) errs.push('请填写隧道名称');
    if (!f.host || !f.host.trim()) errs.push('请填写主机地址');
    if (!f.user || !f.user.trim()) errs.push('请填写用户名');
    if (!util.validPort(f.port)) errs.push('SSH 端口无效（1–65535）');
    if (f.authMethod === 'key' && (!f.keyPath || !f.keyPath.trim())) errs.push('请填写私钥路径');
    if (!f.rules.length) errs.push('至少需要一条转发规则');
    var comboSeen = {};
    f.rules.forEach(function (r, i) {
      var n = i + 1;
      if (!util.validPort(r.localPort)) { errs.push('规则 ' + n + '：' + (r.type === 'R' ? '远端监听端口' : '本地端口') + '无效'); }
      if (r.type !== 'D') {
        if (!r.remoteHost || !String(r.remoteHost).trim()) errs.push('规则 ' + n + '：缺少目标主机');
        if (!util.validPort(r.remotePort)) errs.push('规则 ' + n + '：目标端口无效');
      }
      var k = r.type + ':' + r.localPort;
      if (comboSeen[k]) errs.push('规则 ' + n + '：与规则 ' + comboSeen[k] + ' 重复（同类型同端口）');
      else comboSeen[k] = n;
    });
    // 跨隧道本地端口（L/D）提示
    var mine = {};
    f.rules.forEach(function (r) { if (r.type !== 'R') mine[String(r.localPort)] = true; });
    S.tunnels.forEach(function (t) {
      if (f.id && t._id === f.id) return;
      (t.rules || []).forEach(function (r) {
        if (r.type !== 'R' && r.enabled && mine[String(r.localPort)]) {
          warns.push('本地端口 ' + r.localPort + ' 也被隧道「' + t.name + '」使用，同时启动会冲突');
        }
      });
    });
    return { errs: errs, warns: warns };
  }

  function saveForm() {
    var f = S.form;
    var v = validateForm(f);
    S.formErrors = v.errs;
    S.formWarnings = v.warns;
    if (v.errs.length) { toast('表单有 ' + v.errs.length + ' 处错误，请修正', 'red'); return; }

    var id = f.id || util.uid();
    var old = f.id ? U.db.get(f.id) : null;
    var doc = old ? util.clone(old) : { _id: id, type: 'tunnel', createdAt: Date.now(), order: maxOrder() + 1 };
    doc.name = f.name.trim();
    doc.host = f.host.trim();
    doc.port = Number(f.port);
    doc.user = f.user.trim();
    doc.auth = {
      method: f.authMethod,
      keyPath: f.authMethod === 'key' ? f.keyPath.trim() : '',
      hasPassword: false,
      hasPassphrase: false,
    };
    doc.options = {
      proxyJump: String(f.proxyJump || '').trim(),
      localBindHost: String(f.localBindHost || '127.0.0.1').trim() || '127.0.0.1',
      serverAliveInterval: Number(f.serverAliveInterval) || 30,
      connectTimeout: Number(f.connectTimeout) || 15,
      strictHostKeyChecking: f.strictHostKeyChecking,
      autoReconnect: !!f.autoReconnect,
      useUserSshConfig: !!f.useUserSshConfig,
    };
    doc.rules = f.rules.map(function (r, i) {
      return {
        id: (old && old.rules && old.rules[i] && old.rules[i].id) || ('r' + (i + 1) + '_' + Date.now().toString(36)),
        type: r.type,
        enabled: !!r.enabled,
        localPort: Number(r.localPort),
        remoteHost: r.type !== 'D' ? String(r.remoteHost).trim() : '',
        remotePort: r.type !== 'D' ? Number(r.remotePort) : 0,
        // 白名单式重组：bindAll 不显式带上会在编辑保存时静默丢失
        bindAll: r.type === 'R' ? !!r.bindAll : false,
      };
    });
    doc.updatedAt = Date.now();
    putDoc(doc);

    if (f.authMethod === 'password' && f.password) writeSecrets(id, { password: f.password });
    if (f.authMethod === 'key' && f.passphrase) writeSecrets(id, { passphrase: f.passphrase });
    var sec = readSecrets(id);
    doc.auth.hasPassword = !!sec.password;
    doc.auth.hasPassphrase = !!sec.passphrase;
    putDoc(doc);

    var idx = S.tunnels.findIndex(function (t) { return t._id === id; });
    if (idx >= 0) S.tunnels.splice(idx, 1, doc); else S.tunnels.push(doc);
    STM.features.syncFeatures();

    var s = st(doc).status;
    toast('已保存「' + doc.name + '」' + ((s === 'running' || s === 'starting') ? '，更改需重启隧道生效' : ''));
    setView('list');
  }

  /* ================= 删除 / 复制 / 排序 ================= */
  function requestDelete(t) {
    STM.fn.confirmAsk({
      title: '删除隧道',
      message: '确定删除「' + t.name + '」？运行中的进程将一并停止，保存的密码将被清除。',
      yesText: '删除',
      danger: true,
      onYes: function () { doDelete(t); },
    });
  }
  async function doDelete(t) {
    var s = st(t).status;
    if (s === 'running' || s === 'starting') await window.api.stop(t._id);
    U.db.remove(t._id);
    U.dbCryptoStorage.removeItem(SECRET_PREFIX + t._id);
    try { U.removeFeature('start_' + t._id); U.removeFeature('stop_' + t._id); } catch (e) {}
    var i = S.tunnels.findIndex(function (x) { return x._id === t._id; });
    if (i >= 0) S.tunnels.splice(i, 1);
    delete S.states[t._id];
    toast('已删除「' + t.name + '」');
  }

  function duplicateTunnel(t) {
    S.menuFor = null;
    var doc = util.clone(t);
    doc._id = util.uid();
    doc.name = t.name + ' 副本';
    doc.order = maxOrder() + 1;
    doc.createdAt = Date.now();
    delete doc._rev;
    delete doc.runtime;
    putDoc(doc);
    var sec = readSecrets(t._id);
    if (sec.password || sec.passphrase) writeSecrets(doc._id, sec);
    S.tunnels.push(doc);
    S.states[doc._id] = { status: 'stopped' };
    STM.features.syncFeatures();
    toast('已复制为「' + doc.name + '」');
  }

  function moveTunnel(t, dir) {
    S.menuFor = null;
    var i = S.tunnels.findIndex(function (x) { return x._id === t._id; });
    var j = i + dir;
    if (j < 0 || j >= S.tunnels.length) return;
    var tmp = S.tunnels[i];
    S.tunnels[i] = S.tunnels[j];
    S.tunnels[j] = tmp;
    S.tunnels.forEach(function (x, k) { x.order = k; putDoc(x); });
  }

  /* ================= 日志 ================= */
  // origin 记录进入前视图：检索页跳日志后「返回」仍回检索页；已删隧道的遗留日志也可看
  function openLogFor(id, name, origin) {
    if (S.log && S.log.timer) clearInterval(S.log.timer);
    S.log = { id: id, name: name, content: '', timer: null, origin: origin || S.view };
    setView('log');
    refreshLog();
    S.log.timer = setInterval(refreshLog, 2000);
  }
  function openLog(t) { openLogFor(t._id, t.name, S.view); }
  function refreshLog() {
    if (!S.log) return;
    window.api.logTail(S.log.id, 400).then(function (c) { if (S.log) S.log.content = c; });
  }
  function closeLog() {
    if (S.log && S.log.timer) clearInterval(S.log.timer);
    var back = (S.log && S.log.origin) || 'list';
    S.log = null;
    setView(back === 'log' ? 'list' : back);
  }
  async function clearLog() {
    if (!S.log) return;
    await window.api.logClear(S.log.id);
    refreshLog();
    toast('日志已清空');
  }

  /* ================= 导入 / 导出 ================= */
  function exportConfig() {
    var data = {
      app: 'utools-ssh-tunnel-manager',
      version: 1,
      exportedAt: new Date().toISOString(),
      tunnels: S.tunnels.map(function (t) {
        var d = util.clone(t);
        delete d._rev;
        delete d.runtime;
        return d;
      }),
    };
    var p = U.showSaveDialog({ defaultPath: 'ssh-tunnels.json', title: '导出隧道配置' });
    if (!p) return;
    window.api.writeFile(p, JSON.stringify(data, null, 2)).then(function () { toast('已导出 ' + data.tunnels.length + ' 条隧道（不含密码）'); });
  }
  function importConfig() {
    var paths = U.showOpenDialog({ properties: ['openFile'], title: '导入隧道配置 JSON' });
    if (!paths || !paths.length) return;
    window.api.readFile(paths[0]).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { toast('文件不是合法 JSON', 'red'); return; }
      var list = Array.isArray(data) ? data : data.tunnels;
      if (!Array.isArray(list) || !list.length) { toast('文件中没有隧道数据', 'red'); return; }
      var n = 0;
      list.forEach(function (t) {
        if (!t || !t.host || !t.user) return;
        var doc = util.clone(t);
        doc._id = util.uid();
        doc.order = maxOrder() + 1 + n;
        doc.createdAt = Date.now();
        delete doc._rev;
        delete doc.runtime;
        if (doc.auth) { doc.auth.hasPassword = false; doc.auth.hasPassphrase = false; }
        putDoc(doc);
        S.tunnels.push(doc);
        S.states[doc._id] = { status: 'stopped' };
        n++;
      });
      STM.features.syncFeatures();
      toast('已导入 ' + n + ' 条隧道（密码需重新填写）');
    });
  }

  /* ================= ~/.ssh/config 导入 ================= */
  // 解析结果 entry → 标准隧道文档草稿（与 saveForm 产物同构）
  function draftFromEntry(e, defUser) {
    var rules = (e.forwards || []).map(function (f) {
      return {
        id: 'f' + f.line,
        type: f.dir,
        enabled: true,
        localPort: f.port,
        remoteHost: f.dir !== 'D' ? f.targetHost : '',
        remotePort: f.dir !== 'D' ? f.targetPort : 0,
        bindAll: f.dir === 'R' ? (f.bind === '0.0.0.0' || f.bind === '*') : false,
      };
    });
    // L/D 带一致的非回环 bind → 提升为 localBindHost
    var binds = {};
    (e.forwards || []).forEach(function (f) {
      if (f.dir !== 'R' && f.bind && f.bind !== '127.0.0.1' && f.bind !== 'localhost') binds[f.bind] = true;
    });
    var bindKeys = Object.keys(binds);
    var doc = {
      _id: util.uid(),
      type: 'tunnel',
      name: e.aliases[0] || ('host-' + e.line),
      host: e.hostName || e.aliases[0] || '',
      port: e.port || 22,
      user: e.user || defUser || '',
      auth: e.identityFiles.length
        ? { method: 'key', keyPath: e.identityFiles[0], hasPassword: false, hasPassphrase: false }
        : { method: 'agent', hasPassword: false, hasPassphrase: false },
      options: {
        proxyJump: e.proxyJump || '',
        localBindHost: bindKeys.length === 1 ? bindKeys[0] : '127.0.0.1',
        serverAliveInterval: 30,
        connectTimeout: 15,
        strictHostKeyChecking: 'accept-new',
        autoReconnect: true,
        useUserSshConfig: false,
      },
      rules: rules,
      createdAt: Date.now(),
    };
    return doc;
  }

  function tagsOf(doc) {
    var tags = doc.rules.map(function (r) {
      if (r.type === 'D') return { cls: 'D', text: 'D ' + r.localPort };
      if (r.type === 'R') return { cls: 'R', text: 'R :' + r.localPort + (r.bindAll ? ' · LAN' : '') };
      return { cls: 'L', text: 'L ' + r.localPort };
    });
    tags.push({ cls: 'j', text: doc.auth.method === 'key' ? '密钥' : 'agent' });
    if (doc.options.proxyJump) tags.push({ cls: 'j', text: '-J ' + doc.options.proxyJump });
    return tags;
  }

  function openSshImport() {
    if (!window.api || typeof window.api.parseSshConfig !== 'function') {
      toast('当前环境不支持解析 ssh_config（请重载插件）', 'red');
      return;
    }
    S.importDlg = {
      path: '', loading: true, error: '', items: [], allChecked: true,
      skipped: { wildcard: [], match: [], noForward: 0 }, includes: [], errors: [],
    };
    window.api.parseSshConfig().then(function (res) {
      if (!S.importDlg) return;
      var d = S.importDlg;
      d.loading = false;
      if (!res || !res.ok) { d.error = (res && res.error) || '解析失败'; return; }
      d.path = res.path;
      d.includes = res.result.includes || [];
      d.errors = res.result.errors || [];
      var defUser = res.result.defaultUser || '';
      var portSeen = {};
      var items = [];
      (res.result.entries || []).forEach(function (e) {
        if (e.kind === 'match') { d.skipped.match.push(e.aliases.join(' ')); return; }
        if (e.skipReason === 'wildcard') { d.skipped.wildcard.push(e.aliases.join(' ')); return; }
        if (!e.hasForward) { d.skipped.noForward++; return; }
        var doc = draftFromEntry(e, defUser);
        var badges = [];
        var dup = S.tunnels.some(function (t) {
          return t.host === doc.host && Number(t.port) === Number(doc.port) && t.user === doc.user;
        });
        if (dup) badges.push({ cls: 'warn', text: '疑似已存在' });
        var conflict = doc.rules.some(function (r) {
          if (r.type === 'R') return false;
          if (portSeen[String(r.localPort)]) return true;
          portSeen[String(r.localPort)] = true;
          return false;
        });
        if (conflict) badges.push({ cls: 'warn', text: '端口冲突' });
        items.push({
          checked: true,
          doc: doc,
          conn: (doc.user ? doc.user + '@' : '') + doc.host + ':' + doc.port,
          tags: tagsOf(doc),
          badges: badges,
          line: e.line,
        });
      });
      d.items = items;
      // 私钥可读性异步标注（不阻断勾选）
      items.forEach(function (it) {
        if (it.doc.auth.method !== 'key' || !window.api.checkKey) return;
        window.api.checkKey(it.doc.auth.keyPath).then(function (kr) {
          if (kr && !kr.ok) it.badges.push({ cls: 'err', text: '私钥缺失' });
        });
      });
    });
  }
  function closeImportDlg() { S.importDlg = null; }
  function toggleImportItem(it) {
    it.checked = !it.checked;
    S.importDlg.allChecked = S.importDlg.items.every(function (x) { return x.checked; });
  }
  function toggleImportAll(v) {
    S.importDlg.items.forEach(function (x) { x.checked = v; });
    S.importDlg.allChecked = v;
  }
  function doSshImport() {
    var d = S.importDlg;
    if (!d) return;
    var sel = d.items.filter(function (i) { return i.checked; });
    if (!sel.length) { toast('未勾选任何草稿', 'red'); return; }
    var n = 0;
    sel.forEach(function (it) {
      var doc = util.clone(it.doc);
      doc.order = maxOrder() + 1 + n;
      doc.createdAt = Date.now();
      doc.rules = doc.rules.map(function (r, i) {
        r.id = 'r' + (i + 1) + '_' + Date.now().toString(36);
        return r;
      });
      delete doc._rev;
      putDoc(doc);
      S.tunnels.push(doc);
      S.states[doc._id] = { status: 'stopped' };
      n++;
    });
    STM.features.syncFeatures();
    S.importDlg = null;
    toast('已从 ssh_config 导入 ' + n + ' 条隧道（秘密请在编辑表单补填）');
  }

  /* ================= 日志全文检索 ================= */
  function tunnelNameById(id) {
    var t = S.tunnels.find(function (x) { return x._id === id; });
    return t ? t.name : '（隧道已删除）';
  }
  function openSearch() { setView('search'); }
  function closeSearch() { setView('list'); }
  function doSearch() {
    if (!window.api || typeof window.api.logSearch !== 'function') {
      toast('当前环境不支持日志检索（请重载插件）', 'red');
      return;
    }
    var q = (S.search.query || '').trim();
    if (!q) return;
    S.search.loading = true;
    window.api.logSearch(q, { caseSensitive: S.search.caseSensitive, context: 1 }).then(function (res) {
      S.search.loading = false;
      S.search.results = res || { keyword: q, scanned: 0, elapsedMs: 0, files: [] };
      S.search.scanned = S.search.results.scanned || 0;
      S.search.elapsedMs = S.search.results.elapsedMs || 0;
    });
  }
  function jumpToLogFromSearch(id) { openLogFor(id, tunnelNameById(id), 'search'); }

  /* ================= toast / confirm ================= */
  function toast(msg, kind) {
    var t = { id: Math.random().toString(36).slice(2), msg: msg, kind: kind || '' };
    S.toasts.push(t);
    setTimeout(function () {
      var i = S.toasts.indexOf(t);
      if (i >= 0) S.toasts.splice(i, 1);
    }, 2600);
  }
  function confirmAsk(o) {
    S.confirm = { open: true, title: o.title || '确认', message: o.message || '', yesText: o.yesText || '确认', danger: !!o.danger, onYes: o.onYes || null };
  }
  function confirmYes() { var cb = S.confirm.onYes; S.confirm.open = false; if (cb) cb(); }
  function confirmNo() { S.confirm.open = false; }

  /* ================= 主题 ================= */
  function resolvedDark() {
    if (S.themeMode === 'auto') {
      try { return !!window.utools.isDarkColors(); } catch (e) { return false; }
    }
    return S.themeMode === 'dark';
  }
  function loadThemeMode() {
    try { S.themeMode = U.dbStorage.getItem('stm_theme') || 'dark'; } catch (e) { S.themeMode = 'dark'; }
  }
  function setThemeMode(m) {
    S.themeMode = m;
    try { U.dbStorage.setItem('stm_theme', m); } catch (e) {}
    if (STM.fn.applyTheme) STM.fn.applyTheme();
    STM.features.syncFeatures(); // 图标随主题重注册
  }

  /* ================= 展示辅助 ================= */
  function statusText(s) {
    if (s.status === 'running') return '运行中';
    if (s.status === 'connecting' || s.status === 'starting') return '连接中';
    if (s.status === 'error') return '错误';
    return '已停止';
  }
  function uptime(t) {
    var s = st(t);
    if (s.status !== 'running' || !s.startedAt) return '';
    return util.fmtUptime(S.now - s.startedAt);
  }
  function enabledCount(t) {
    return (t.rules || []).filter(function (r) { return r.enabled; }).length;
  }
  function ruleMapText(r) {
    if (r.type === 'D') return r.localPort + '（SOCKS5）';
    if (r.type === 'R') return '远端 :' + r.localPort + ' → ' + r.remoteHost + ':' + r.remotePort + (r.bindAll ? ' · LAN' : '');
    return r.localPort + ' → ' + r.remoteHost + ':' + r.remotePort;
  }

  STM.store = S;
  STM.fn = {
    loadTunnels: loadTunnels, applyState: applyState, st: st,
    startTunnel: startTunnel, stopTunnel: stopTunnel, startAll: startAll, stopAll: stopAll,
    setView: setView, toggleExpand: toggleExpand, toggleRule: toggleRule,
    openForm: openForm, saveForm: saveForm, addRuleRow: addRuleRow, removeRuleRow: removeRuleRow, chooseKey: chooseKey,
    requestDelete: requestDelete, duplicateTunnel: duplicateTunnel, moveTunnel: moveTunnel,
    clearPassword: clearPassword,
    openLog: openLog, openLogFor: openLogFor, closeLog: closeLog, refreshLog: refreshLog, clearLog: clearLog,
    exportConfig: exportConfig, importConfig: importConfig,
    openSshImport: openSshImport, closeImportDlg: closeImportDlg,
    toggleImportItem: toggleImportItem, toggleImportAll: toggleImportAll, doSshImport: doSshImport,
    openSearch: openSearch, closeSearch: closeSearch, doSearch: doSearch,
    jumpToLogFromSearch: jumpToLogFromSearch, tunnelNameById: tunnelNameById,
    toast: toast, confirmAsk: confirmAsk, confirmYes: confirmYes, confirmNo: confirmNo,
    statusText: statusText, uptime: uptime, enabledCount: enabledCount, ruleMapText: ruleMapText,
    resolvedDark: resolvedDark, loadThemeMode: loadThemeMode, setThemeMode: setThemeMode,
  };
})();
