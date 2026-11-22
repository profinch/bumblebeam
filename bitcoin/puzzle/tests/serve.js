// The site as nginx serves it (deploy/docker/containers/puzzle-web/default.conf: the page routes, ui/ beside it),
// with /api/ passed to a local API, for the browser tests. Usage: node serve.js <port> <api port>
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const WEB = path.join(ROOT, 'bitcoin', 'puzzle', 'web');
// the security headers nginx sends with the site (default.conf), read from there so the tests run under the same policy
const CONF = fs.readFileSync(path.join(ROOT, 'deploy', 'docker', 'containers', 'puzzle-web', 'default.conf'), 'utf8');
const HEADERS = {};
for (const m of CONF.matchAll(/^ {4}add_header (Content-Security-Policy|X-Content-Type-Options|Referrer-Policy) "([^"]+)" always;$/gm)) HEADERS[m[1]] = m[2];
if (!HEADERS['Content-Security-Policy']) throw new Error('serve.js: no Content-Security-Policy in default.conf');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'text/xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

// apiPort: the API's port, or a function that gives it (the stack starts the site first: the API reads its pages here)
// host: where it listens (127.0.0.1 unless given: the local preview listens on every interface)
function serve(port, apiPort, host) {
  const api = () => (typeof apiPort === 'function' ? apiPort() : apiPort);
  const srv = http.createServer((q, s) => {
    const u = q.url.split('?')[0];
    if (u.startsWith('/api/')) {
      const p = http.request({ host: '127.0.0.1', port: api(), path: q.url, method: q.method, headers: { 'content-type': q.headers['content-type'] || 'application/json' } }, (r) => { s.writeHead(r.statusCode, r.headers); r.pipe(s); });
      p.on('error', () => { s.writeHead(502); s.end('{"error":"the API is down"}'); });
      q.pipe(p);
      return;
    }
    // one address per page, as nginx: /learn/ is /learn
    if (/^\/.+\/$/.test(u)) { s.writeHead(301, { location: u.slice(0, -1) + q.url.slice(u.length) }); s.end(); return; }
    // a searcher's page is kept out of search results (nginx: X-Robots-Tag from the $puzzle_robots map)
    const robots = /^\/(pool|_tpl)\//.test(u) ? { 'x-robots-tag': 'noindex' } : {};
    // the pages with live numbers, as nginx: written in by the API (/api/page/...), the page as it is when it cannot
    // (an unknown puzzle: the 404; a puzzle without the API: its page with a 503)
    let m;
    const ssr = u === '/' ? ['/api/page/index', 'index.html'] : (m = u.match(/^\/(pool|bench|proof)$/)) ? ['/api/page/' + m[1], m[1] + '.html']
      : (m = u.match(/^\/puzzle\/([1-9][0-9]{0,2})$/)) ? ['/api/page/puzzle/' + m[1], 'puzzle.html'] : null;
    if (ssr) {
      const page = (code) => fs.readFile(path.join(WEB, ssr[1]), (e, b) => { s.writeHead(code, Object.assign({ 'content-type': 'text/html', 'cache-control': 'no-cache' }, HEADERS, robots)); s.end(b); });
      const r0 = http.get({ host: '127.0.0.1', port: api(), path: ssr[0], timeout: 4000 }, (r) => {
        const parts = []; r.on('data', (c) => parts.push(c));
        r.on('end', () => {
          if (r.statusCode === 200) { s.writeHead(200, Object.assign({ 'content-type': 'text/html', 'cache-control': 'no-cache' }, HEADERS, robots)); s.end(Buffer.concat(parts)); return; }
          if (r.statusCode === 404) return fs.readFile(path.join(WEB, '404.html'), (e2, b2) => { s.writeHead(404, Object.assign({ 'content-type': 'text/html' }, HEADERS)); s.end(b2); });
          page(ssr[1] === 'puzzle.html' ? 503 : 200);
        });
      });
      r0.on('timeout', () => r0.destroy(new Error('timeout')));
      r0.on('error', () => page(ssr[1] === 'puzzle.html' ? 503 : 200));
      return;
    }
    if (u === '/puzzle.html') { s.writeHead(301, { location: '/' }); s.end(); return; }
    let f;
    if (u.startsWith('/ui/')) f = path.join(ROOT, u);
    else if (u.startsWith('/_tpl/')) f = path.join(WEB, u.slice(5));
    else if (u === '/') f = path.join(WEB, 'index.html');
    else if (/^\/(pool|play|learn|bench|rules|proof)$/.test(u)) f = path.join(WEB, u + '.html');
    else if (/^\/pool\/[A-Za-z0-9]{25,90}$/.test(u)) f = path.join(WEB, 'searcher.html');
    else f = path.join(WEB, u);
    if (!f.startsWith(ROOT)) { s.writeHead(403); s.end(); return; }
    fs.readFile(f, (e, b) => {
      if (e) return fs.readFile(path.join(WEB, '404.html'), (e2, b2) => { s.writeHead(404, Object.assign({ 'content-type': 'text/html' }, HEADERS)); s.end(b2 || 'not found'); });
      s.writeHead(200, Object.assign({ 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }, HEADERS, robots));
      s.end(b);
    });
  });
  return new Promise((ok) => srv.listen(port, host || '127.0.0.1', () => ok(srv)));
}

if (require.main === module) serve(Number(process.argv[2] || 18181), Number(process.argv[3] || 18180), process.argv[4]).then(() => console.log('serving on', process.argv[2] || 18181));
module.exports = { serve };
