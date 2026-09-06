'use strict';
/* 小工具。兼容 Chromium 91（不用 replaceAll/at/structuredClone 等）。 */
window.STM = window.STM || {};
STM.util = {
  uid: function () {
    return 'tunnel_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  },
  validPort: function (n) {
    n = Number(n);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  },
  clone: function (o) { return JSON.parse(JSON.stringify(o)); },
  escapeHtml: function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  },
  fmtUptime: function (ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return '刚刚';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60);
    return h + ' 小时 ' + (m % 60) + ' 分';
  },
};
