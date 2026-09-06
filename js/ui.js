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
      importCheckedCount: function () {
        if (!S.importDlg) return 0;
        return S.importDlg.items.filter(function (i) { return i.checked; }).length;
      },
      importSkippedCount: function () {
        if (!S.importDlg) return 0;
        var k = S.importDlg.skipped;
        return k.wildcard.length + k.match.length + k.noForward;
      },
      searchHitTotal: function () {
        var res = S.search.results;
        if (!res) return 0;
        var n = 0;
        (res.files || []).forEach(function (f) { n += f.hits.length; });
        return n;
      },
    },
    methods: Object.assign({}, fn, {
      st: fn.st,
      typeLabel: function (tp) { return { L: '本地', R: '反向', D: 'SOCKS' }[tp] || tp; },
      setAuthMethod: function (m) { if (S.form) S.form.authMethod = m; },
      toggleAdv: function () { if (S.form) S.form.advOpen = !S.form.advOpen; },
      closeMenu: function () { S.menuFor = null; },
      // 检索高亮：先转义再包 <mark>；大小写不敏感时按原文下标分段（规避 replaceAll）
      hl: function (text) {
        var q = (S.search.query || '').trim();
        var esc = STM.util.escapeHtml;
        if (!q) return esc(text);
        if (!S.search.caseSensitive) {
          var low = String(text).toLowerCase();
          var nl = q.toLowerCase();
          var out = '';
          var i = 0;
          for (;;) {
            var p = low.indexOf(nl, i);
            if (p < 0) { out += esc(String(text).slice(i)); break; }
            out += esc(String(text).slice(i, p)) + '<mark>' + esc(String(text).slice(p, p + q.length)) + '</mark>';
            i = p + q.length;
          }
          return out;
        }
        return esc(text).split(esc(q)).join('<mark>' + esc(q) + '</mark>');
      },
    }),
  });

  // 日志视图自动滚到底部
  app.directive('scrollbottom', {
    updated: function (el) { el.scrollTop = el.scrollHeight; },
  });

  STM.mount = function () { return app.mount('#app'); };
})();
