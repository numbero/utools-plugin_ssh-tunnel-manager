'use strict';
/**
 * 隧道日志：引擎自行 tee stderr/stdout 到文件。
 * 不用 ssh -E：-E 会在启动早期 freopen 把 stderr 重定向到文件，
 * 密码提示词将写进文件而非管道，导致探测失效。
 * 目录 ~/.utools-ssh-tunnel/logs，尽力 chmod 700；>1MB 截尾保留 256KB。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.utools-ssh-tunnel', 'logs');
const MAX = 1024 * 1024;
const KEEP = 256 * 1024;

let ensured = false;
function ensure() {
  if (ensured) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { fs.chmodSync(path.join(os.homedir(), '.utools-ssh-tunnel'), 0o700); } catch (e) {}
    try { fs.chmodSync(DIR, 0o700); } catch (e) {}
  } catch (e) {}
  ensured = true;
}

function fileFor(id) { return path.join(DIR, String(id) + '.log'); }

const fds = {};
const writeCnt = {};

function open(id) {
  ensure();
  close(id);
  try { fds[id] = fs.openSync(fileFor(id), 'a'); } catch (e) { fds[id] = null; }
}

function write(id, str) {
  ensure();
  if (fds[id] == null) {
    try { fds[id] = fs.openSync(fileFor(id), 'a'); } catch (e) { return; }
  }
  try { fs.writeSync(fds[id], str); } catch (e) { return; }
  writeCnt[id] = (writeCnt[id] || 0) + 1;
  if (writeCnt[id] % 40 === 0) rotate(id);
}

function rotate(id) {
  const fd = fds[id];
  if (fd == null) return;
  try {
    const st = fs.fstatSync(fd);
    if (st.size <= MAX) return;
    const data = fs.readFileSync(fileFor(id));
    const tail = data.slice(Math.max(0, data.length - KEEP));
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, tail, 0, tail.length, 0);
  } catch (e) {}
}

function close(id) {
  if (fds[id] != null) {
    try { fs.closeSync(fds[id]); } catch (e) {}
    fds[id] = null;
  }
}

function tail(id, lines) {
  try {
    const data = fs.readFileSync(fileFor(id), 'utf8');
    const arr = data.split('\n');
    return arr.slice(Math.max(0, arr.length - (lines || 300))).join('\n');
  } catch (e) {
    return '';
  }
}

function clear(id) {
  close(id);
  ensure();
  try { fs.writeFileSync(fileFor(id), ''); } catch (e) {}
}

module.exports = { open, write, close, tail, clear, fileFor, DIR };
