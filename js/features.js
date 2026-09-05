'use strict';
/*
 * 动态指令：每隧道注册「启动 xx / 停止 xx」两个 feature（mainHide 静默执行）。
 * onPluginEnter 按 code 分发：main / new / start_<id> / stop_<id>。
 */
(function () {
  var U = new Proxy({}, { get: function (_, k) { return window.utools[k]; } });
  var S = STM.store;
  var fn = STM.fn;

  // 图标随主题：解析为深色时注册深色版，否则浅色版（默认浅）
  function iconFor() {
    return fn.resolvedDark() ? 'assets/ssh-tunnel-dark.svg' : 'assets/ssh-tunnel-light.svg';
  }

  function desired(t) {
    var icon = iconFor();
    return [
      { code: 'start_' + t._id, explain: '启动隧道「' + t.name + '」', cmds: ['启动 ' + t.name, 'start ' + t.name], icon: icon, mainHide: true },
      { code: 'stop_' + t._id, explain: '停止隧道「' + t.name + '」', cmds: ['停止 ' + t.name, 'stop ' + t.name], icon: icon, mainHide: true },
    ];
  }

  function syncFeatures() {
    try {
      var have = U.getFeatures() || [];
      var dyn = have.filter(function (f) {
        return f && typeof f.code === 'string' && (f.code.indexOf('start_') === 0 || f.code.indexOf('stop_') === 0);
      }).map(function (f) { return f.code; });
      var want = [];
      S.tunnels.forEach(function (t) { desired(t).forEach(function (f) { want.push(f); }); });
      var wantSet = {};
      want.forEach(function (f) { wantSet[f.code] = true; });
      dyn.forEach(function (c) { if (!wantSet[c]) U.removeFeature(c); });
      want.forEach(function (f) { U.setFeature(f); });
    } catch (e) { /* 平台异常不阻塞主流程 */ }
  }

  async function silentToggle(id, wantStart) {
    var t = S.tunnels.find(function (x) { return x._id === id; });
    if (!t) {
      try { U.showNotification('隧道不存在（可能已删除）'); } catch (e) {}
      try { U.outPlugin(); } catch (e) {}
      return;
    }
    var status = (S.states[id] || {}).status;
    if (wantStart) {
      if (status === 'running') U.showNotification('「' + t.name + '」已在运行');
      else if (status === 'starting') U.showNotification('「' + t.name + '」正在连接');
      else { await fn.startTunnel(t); U.showNotification('已启动「' + t.name + '」'); }
    } else {
      if (status === 'running' || status === 'starting') { await fn.stopTunnel(t); U.showNotification('已停止「' + t.name + '」'); }
      else U.showNotification('「' + t.name + '」未在运行');
    }
    try { U.outPlugin(); } catch (e) {}
  }

  function handleEnter(arg) {
    if (fn.applyTheme) fn.applyTheme();
    var code = arg && arg.code;
    if (code === 'new') { fn.openForm(null); return; }
    if (typeof code === 'string' && code.indexOf('start_') === 0) { silentToggle(code.slice(6), true); return; }
    if (typeof code === 'string' && code.indexOf('stop_') === 0) { silentToggle(code.slice(6), false); return; }
    fn.setView('list');
    syncFeatures();
  }

  STM.features = { syncFeatures: syncFeatures, handleEnter: handleEnter, silentToggle: silentToggle };
})();
