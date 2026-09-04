'use strict';
/**
 * 密码 / passphrase 提示词探测状态机。
 *
 * 原理链（写进注释备查）：
 *  1. spawn 时 detached:true → setsid → 子进程无控制终端，ssh 打不开 /dev/tty；
 *  2. stdin 是 pipe（非 tty），OpenSSH read_passphrase 走 RP_ALLOW_STDIN 分支：
 *     提示词写 stderr、密码从 stdin 读取 → 可探测、可写入。
 * 策略：滚动缓冲（尾部 1KB，处理跨 chunk 切断），行尾锚定防误报。
 * 每次命中后清空缓冲，允许后续出现第二种提示（passphrase → password）。
 */

const PASSPHRASE_RE = /enter passphrase for key [^\n]*:\s*$/i;
const PASSWORD_RE = /(?:^|\n)[^\n]*password:\s*$/i;

class PromptDetector {
  constructor(onPrompt) {
    this.buf = '';
    this.onPrompt = onPrompt;
  }
  feed(text) {
    this.buf = (this.buf + text).slice(-1024);
    if (PASSPHRASE_RE.test(this.buf)) {
      this.buf = '';
      this.onPrompt('passphrase');
      return;
    }
    if (PASSWORD_RE.test(this.buf)) {
      this.buf = '';
      this.onPrompt('password');
    }
  }
}

module.exports = { PromptDetector };
