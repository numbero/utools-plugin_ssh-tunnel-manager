'use strict';
/* 引导：等待环境就绪 → 装环境（或模拟）→ 主题/事件注册/初始化。 */
(function () {
  var S = STM.store;
  var fn = STM.fn;

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', fn.resolvedDark() ? 'dark' : 'light');
  }
  fn.applyTheme = applyTheme;

  STM.waitReady(function () {
    STM.ensureEnv();
    var U = window.utools;

    // 引擎状态推送 → store
    window.api.onState(function (evt) { fn.applyState(evt); });

    // uTools 进入事件分发（动态指令 / 静态指令）
    try { U.onPluginEnter(function (arg) { STM.features.handleEnter(arg); }); } catch (e) {}

    // 主题：载入用户选择 → 应用；「跟随」时实时响应系统外观变化
    fn.loadThemeMode();
    applyTheme();
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var l = function () {
        if (S.themeMode === 'auto') { applyTheme(); STM.features.syncFeatures(); }
      };
      if (mq.addEventListener) mq.addEventListener('change', l); else mq.addListener(l);
    } catch (e) {}

    // 运行时长展示定时器
    setInterval(function () { S.now = Date.now(); }, 1000);

    (async function init() {
      STM.mount();
      await fn.loadTunnels();
      STM.features.syncFeatures();
      var env = await window.api.env();
      S.env = { checked: true, sshMissing: !!env.sshMissing, sshVersion: env.sshVersion || '' };
    })();
  });
})();
