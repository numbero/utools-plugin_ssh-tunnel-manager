'use strict';
/** 端口工具：占用预检（试绑）与就绪探活（试连）。兼容 Node 14。 */
const net = require('net');

/** 尝试绑定端口判断是否空闲 */
function checkFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    srv.once('error', (err) => done({ port: port, host: host, free: false, code: err.code }));
    srv.listen({ port: port, host: host }, () => {
      srv.close(() => done({ port: port, host: host, free: true }));
    });
    setTimeout(() => { try { srv.close(); } catch (e) {} done({ port: port, host: host, free: false, code: 'ETIMEOUT' }); }, 2000);
  });
}

/** TCP 试连，判断本地转发端口是否已就绪 */
function probe(port, host, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (up) => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) {} resolve(up); } };
    const sock = net.connect({ port: port, host: host, timeout: timeout || 400 });
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function checkMany(specs) {
  const out = [];
  for (const s of specs) out.push(await checkFree(s.port, s.host));
  return out;
}

module.exports = { checkFree, probe, checkMany };
