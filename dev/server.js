// Local test server. Serves the app and runs the real Code.gs against a fake
// spreadsheet that lives in memory. It answers the way Google does: a POST gets
// a redirect, and the redirect target holds the reply.
//
// In the app's Connect screen, use:
//   Web app address: http://localhost:8787/mock/exec
//   Passcode:        demo-passcode
//
// http://localhost:8787/__dev/offline?on=1 makes it act like there's no signal.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadBackend } = require('./fake-google');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, '..', 'docs');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const backend = loadBackend({ passcode: 'demo-passcode' });
backend.ctx.setup();

const replies = new Map();
let offline = false;

function sendJson(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(text);
}

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/__dev/offline') {
    offline = url.searchParams.get('on') === '1';
    res.end(`offline=${offline}`);
    return;
  }

  if (url.pathname === '/mock/echo') {
    const id = url.searchParams.get('id');
    const reply = replies.get(id);
    replies.delete(id);
    if (!reply) {
      res.writeHead(404).end();
      return;
    }
    sendJson(res, reply);
    return;
  }

  if (url.pathname === '/mock/exec') {
    if (offline) {
      req.socket.destroy();
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, backend.ctx.doGet().getContent());
      return;
    }
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      const id = crypto.randomUUID();
      replies.set(id, backend.ctx.doPost({ postData: { contents: body } }).getContent());
      res.writeHead(302, { Location: `/mock/echo?id=${id}` });
      res.end();
    });
    return;
  }

  serveStatic(url.pathname, res);
}).listen(PORT, () => console.log(`Budget app test server: http://localhost:${PORT}`));
