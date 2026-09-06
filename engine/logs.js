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

/** 全部日志文件清单（mtime 倒序），供跨隧道检索 */
function listFiles() {
  ensure();
  try {
    const names = fs.readdirSync(DIR).filter(function (n) { return n.slice(-4) === '.log'; });
    const out = names.map(function (n) {
      const file = path.join(DIR, n);
      let st = null;
      try { st = fs.statSync(file); } catch (e) {}
      return { id: n.slice(0, -4), file: file, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    });
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
  } catch (e) {
    return [];
  }
}

/**
 * 跨隧道全文检索。不用 RegExp（免关键词转义注入）；
 * rotate 已保证单文件 ≤1MB，maxFiles/maxHitsPerFile 双上限兜底。
 * 返回 {keyword, scanned, elapsedMs, files:[{id,file,truncated,hits:[{lineNo,text,before,after}]}]}
 */
function search(keyword, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const empty = { keyword: keyword || '', scanned: 0, elapsedMs: 0, files: [] };
  if (!keyword) return empty;
  const caseSensitive = o.caseSensitive === true;
  const context = o.context == null ? 1 : Math.max(0, Number(o.context) || 0);
  const maxHits = o.maxHitsPerFile == null ? 50 : Math.max(1, Number(o.maxHitsPerFile) || 1);
  const maxFiles = o.maxFiles == null ? 100 : Math.max(1, Number(o.maxFiles) || 1);

  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  const all = listFiles().slice(0, maxFiles);
  const files = [];
  let scanned = 0;

  for (let i = 0; i < all.length; i++) {
    const item = all[i];
    let data;
    try { data = fs.readFileSync(item.file, 'utf8'); } catch (e) { continue; }
    scanned++;
    const arr = data.split('\n');
    const hits = [];
    let truncated = false;
    for (let li = 0; li < arr.length; li++) {
      const hay = caseSensitive ? arr[li] : arr[li].toLowerCase();
      if (hay.indexOf(needle) < 0) continue;
      const before = [];
      const after = [];
      for (let c = 1; c <= context; c++) {
        if (li - c >= 0) before.push(arr[li - c]);
        if (li + c < arr.length) after.push(arr[li + c]);
      }
      hits.push({ lineNo: li + 1, text: arr[li].slice(0, 400), before: before, after: after });
      if (hits.length >= maxHits) { truncated = true; break; }
    }
    if (hits.length) files.push({ id: item.id, file: item.file, truncated: truncated, hits: hits });
  }

  return { keyword: keyword, scanned: scanned, elapsedMs: Date.now() - t0, files: files };
}

module.exports = { open, write, close, tail, clear, fileFor, listFiles, search, DIR };
