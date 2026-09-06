'use strict';
/**
 * ~/.ssh/config 轻量解析器（纯函数，无第三方依赖）。
 * 语法对齐 OpenSSH readconf 的可观察行为：
 *  - 关键字大小写不敏感，值保留原样；分隔支持空白与 '='
 *  - 仅整行 '#' 为注释（不剥离行内 #）
 *  - Host / Match 开新块；首块之前的全局区关键字全部忽略
 *  - 同块重复单值关键字首个生效；IdentityFile 与转发指令累加
 *  - 不支持续行反斜杠；CRLF / BOM / tab 预处理归一
 *  - Include 仅记录不展开（v2.0 不跟进）
 * 畸形行记入 errors（行号+原文），不抛异常、不丢整块。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function validPortStr(s) {
  return /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
}

/** 拆 [bind:]port；bind 支持 IPv6 方括号写法。失败返回 null */
function splitListen(tok) {
  if (!tok) return null;
  if (tok.charAt(0) === '[') {
    const rb = tok.indexOf(']');
    if (rb < 0) return null;
    const rest = tok.slice(rb + 1);
    if (rest.charAt(0) !== ':') return null;
    const p = rest.slice(1);
    if (!validPortStr(p)) return null;
    return { bind: tok.slice(1, rb), port: Number(p) };
  }
  const parts = tok.split(':');
  if (parts.length === 1) {
    if (!validPortStr(parts[0])) return null;
    return { bind: '', port: Number(parts[0]) };
  }
  if (parts.length === 2) {
    if (!validPortStr(parts[1])) return null;
    return { bind: parts[0], port: Number(parts[1]) };
  }
  return null; // 裸多冒号
}

/** 拆转发目标 host:port；host 支持方括号 IPv6。失败返回 null */
function splitTarget(tok) {
  if (!tok) return null;
  if (tok.charAt(0) === '[') {
    const rb = tok.indexOf(']');
    if (rb < 0) return null;
    const rest = tok.slice(rb + 1);
    if (rest.charAt(0) !== ':') return null;
    const p = rest.slice(1);
    if (!validPortStr(p)) return null;
    return { host: tok.slice(1, rb), port: Number(p) };
  }
  const li = tok.lastIndexOf(':');
  if (li < 0) return null;
  const p = tok.slice(li + 1);
  if (!validPortStr(p)) return null;
  return { host: tok.slice(0, li), port: Number(p) };
}

function parseForward(dir, value, line, raw, errors) {
  const tokens = String(value).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) { errors.push({ line: line, text: raw }); return null; }
  const listen = splitListen(tokens[0]);
  if (!listen) { errors.push({ line: line, text: raw }); return null; }
  const f = { dir: dir, bind: listen.bind, port: listen.port, targetHost: '', targetPort: 0, line: line, raw: raw };
  if (dir !== 'D') {
    const tgt = splitTarget(tokens[1]);
    if (!tgt) { errors.push({ line: line, text: raw }); return null; }
    f.targetHost = tgt.host;
    f.targetPort = tgt.port;
  }
  return f;
}

function newBlock(kind, line) {
  return {
    kind: kind, aliases: [], wildcard: false, line: line,
    hostName: '', port: 22, user: '', identityFiles: [], proxyJump: '',
    forwards: [], invalid: false,
    _portSet: false, _userSet: false, _hostSet: false, _jumpSet: false,
  };
}

function finalize(b) {
  const wildcard = (b.aliases || []).some(function (a) { return a.indexOf('*') >= 0 || a.indexOf('?') >= 0; });
  let skipReason = '';
  if (b.kind === 'match') skipReason = 'match';
  else if (wildcard) skipReason = 'wildcard';
  return {
    kind: b.kind, aliases: b.aliases, wildcard: wildcard, line: b.line,
    hostName: b.hostName, port: b.port, user: b.user,
    identityFiles: b.identityFiles, proxyJump: b.proxyJump,
    forwards: b.forwards, hasForward: b.forwards.length > 0,
    skipReason: skipReason,
  };
}

function parse(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const blocks = [];
  const includes = [];
  const errors = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const trimmed = lines[i].replace(/\t/g, ' ').trim();
    if (!trimmed || trimmed.charAt(0) === '#') continue;

    const m = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*)?(.*)$/);
    if (!m) { errors.push({ line: line, text: trimmed }); continue; }
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'include') { includes.push({ path: value, line: line }); continue; }

    if (key === 'host' || key === 'match') {
      const b = newBlock(key === 'host' ? 'host' : 'match', line);
      b.aliases = value ? value.split(/\s+/) : [];
      if (key === 'host' && !b.aliases.length) {
        b.invalid = true; // 裸 Host：记错并跳过该块
        errors.push({ line: line, text: trimmed });
      }
      blocks.push(b);
      cur = b;
      continue;
    }

    if (!cur || cur.invalid) continue; // 全局区 / 已跳过块：忽略

    switch (key) {
      case 'hostname':
        if (!cur._hostSet) { cur._hostSet = true; cur.hostName = value; }
        break;
      case 'port':
        if (!cur._portSet) {
          cur._portSet = true;
          if (validPortStr(value)) cur.port = Number(value);
          else errors.push({ line: line, text: trimmed });
        }
        break;
      case 'user':
        if (!cur._userSet) { cur._userSet = true; cur.user = value; }
        break;
      case 'identityfile':
        cur.identityFiles.push(value);
        break;
      case 'proxyjump':
        if (!cur._jumpSet) { cur._jumpSet = true; cur.proxyJump = value; }
        break;
      case 'localforward': {
        const f = parseForward('L', value, line, trimmed, errors);
        if (f) cur.forwards.push(f);
        break;
      }
      case 'remoteforward': {
        const f = parseForward('R', value, line, trimmed, errors);
        if (f) cur.forwards.push(f);
        break;
      }
      case 'dynamicforward': {
        const f = parseForward('D', value, line, trimmed, errors);
        if (f) cur.forwards.push(f);
        break;
      }
      default:
        break; // 其余关键字 v2.0 不消费
    }
  }

  return {
    entries: blocks.filter(function (b) { return !b.invalid; }).map(finalize),
    includes: includes,
    errors: errors,
  };
}

/** 当前系统用户名：config 未写 User 时的导入缺省 */
function defaultUser() {
  try { return (os.userInfo() || {}).username || ''; } catch (e) { return ''; }
}

function readAndParse(p) {
  const file = p || defaultConfigPath();
  try {
    const text = fs.readFileSync(file, 'utf8');
    const result = parse(text);
    result.defaultUser = defaultUser();
    return { ok: true, path: file, result: result };
  } catch (e) {
    const msg = (e && e.code === 'ENOENT') ? '文件不存在' : '读取失败';
    return { ok: false, path: file, error: msg + '：' + file };
  }
}

module.exports = { parse, readAndParse, defaultConfigPath };
