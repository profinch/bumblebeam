// The pages with live numbers, written here before they are sent (a crawler without JavaScript, an AI agent and
// every visitor's first paint get the numbers). nginx sends /, /pool, /bench, /proof and /puzzle/<n> to GET
// /api/page/<name>; this takes that page's own HTML from puzzle-web (PUZZLE_WEB_URL/_tpl/<file>: always the release
// the site serves, never a copy that could go stale), fills each <!--ssr:id-->…<!--/ssr--> with render.js's markup
// (the page script draws the same, so nothing changes when it runs) from the data in memory, and sends it on. When it
// cannot (the template out of reach, the data not read yet), it answers 503 and nginx sends the page as it is, with
// its loaders.
'use strict';

const TPL_FRESH = 60000, TPL_KEEP = 3600000, PAGE_FRESH = 10000;

// o: { R: render.js, webUrl, parts(name, arg) -> { text, html, head? } | null (null: no such page) }
function createPages(o) {
  const R = o.R, web = String(o.webUrl || '').replace(/\/$/, '');
  const tpls = new Map(), pages = new Map();

  // the template, read again every minute; the last good one serves for an hour if puzzle-web does not answer
  async function template(file) {
    const t = tpls.get(file);
    if (t && Date.now() - t.at < TPL_FRESH) return t.html;
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 2000);
      let r;
      try { r = await fetch(web + '/_tpl/' + file, { signal: ctl.signal }); } finally { clearTimeout(timer); }
      if (!r.ok) throw new Error(file + ': ' + r.status);
      const html = await r.text();
      if (!html.includes('<!--ssr:')) throw new Error(file + ': no marks in it');
      tpls.set(file, { at: Date.now(), html });
      return html;
    } catch (e) {
      if (t && Date.now() - t.at < TPL_KEEP) return t.html;
      throw e;
    }
  }
  // every mark filled from v (text escaped, html as it is); a mark with nothing for it keeps the page's own content
  function fill(html, v) {
    html = html.replace(/<!--ssr:([a-z0-9-]+)-->([\s\S]*?)<!--\/ssr-->/g, (m, id, stub) => (v.html[id] != null ? v.html[id] : v.text[id] != null ? R.esc(v.text[id]) : stub));
    if (v.head) {
      const h = v.head, e = R.esc;
      html = html.replace(/<title>[^<]*<\/title>/, '<title>' + e(h.title) + '</title>')
        .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="' + e(h.description) + '">')
        .replace(/<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + e(h.ogTitle) + '">')
        .replace(/<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + e(h.description) + '">');
    }
    return html;
  }
  const FILES = { index: 'index.html', pool: 'pool.html', bench: 'bench.html', proof: 'proof.html', puzzle: 'puzzle.html' };
  // name: index | pool | bench | proof | puzzle; arg: the puzzle's number. -> [status, html | null]
  async function page(name, arg) {
    const key = name + '/' + (arg || ''), c = pages.get(key);
    if (c && Date.now() - c.at < PAGE_FRESH) return [200, c.html];
    const v = o.parts(name, arg);
    if (!v) return [404, null];
    let tpl;
    try { tpl = await template(FILES[name]); } catch (e) { console.error('pages: ' + e.message); return [503, null]; }
    const html = fill(tpl, v);
    if (pages.size > 400) pages.clear();
    pages.set(key, { at: Date.now(), html });
    return [200, html];
  }
  // GET /api/page/<name>[/<n>]: true when it answered
  async function handle(req, res, url) {
    const m = url.pathname.match(/^\/api\/page\/(index|pool|bench|proof|puzzle\/(\d{1,3}))$/);
    if (!m) return false;
    const name = m[2] ? 'puzzle' : m[1], n = m[2] ? Number(m[2]) : 0;
    const [code, html] = await page(name, n);
    // nginx adds the site's own headers (cache, policy); an error page is nginx's to choose
    res.writeHead(code, { 'content-type': code === 200 ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(code === 200 && req.method !== 'HEAD' ? html : code === 200 ? undefined : String(code));
    return true;
  }
  return { handle, page, fill };
}

module.exports = { createPages };
