'use strict';
/* Vue 应用装配：根组件数据 = store，方法 = 领域函数 + 模板辅助。 */
(function () {
  var S = STM.store;
  var fn = STM.fn;

  var app = Vue.createApp({
    data: function () { return { S: S }; },
    computed: {
      filtered: function () {
        var q = (S.query || '').trim().toLowerCase();
        if (!q) return S.tunnels;
        return S.tunnels.filter(function (t) {
          return (t.name || '').toLowerCase().indexOf(q) !== -1 ||
                 (t.host || '').toLowerCase().indexOf(q) !== -1;
        });
      },
      counts: function () {
        var c = { running: 0, stopped: 0, error: 0, connecting: 0 };
        S.tunnels.forEach(function (t) {
          var s = (S.states[t._id] || {}).status || 'stopped';
          if (s === 'running') c.running++;
          else if (s === 'starting') c.connecting++;
          else if (s === 'error') c.error++;
          else c.stopped++;
        });
        return c;
      },
      formTitle: function () {
        return S.formMode === 'edit' ? '编辑「' + (S.form ? S.form.name : '') + '」' : '新建隧道';
      },
    },
    methods: Object.assign({}, fn, {
      st: fn.st,
      typeLabel: function (tp) { return { L: '本地', R: '反向', D: 'SOCKS' }[tp] || tp; },
      setAuthMethod: function (m) { if (S.form) S.form.authMethod = m; },
      toggleAdv: function () { if (S.form) S.form.advOpen = !S.form.advOpen; },
      closeMenu: function () { S.menuFor = null; },
    }),
  });

  // 日志视图自动滚到底部
  app.directive('scrollbottom', {
    updated: function (el) { el.scrollTop = el.scrollHeight; },
  });

  STM.mount = function () { return app.mount('#app'); };
})();
