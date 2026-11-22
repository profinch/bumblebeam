// What a crawler without JavaScript gets (a search engine's first pass, the AI crawlers): robots.txt leaves the JSON
// API open and names the sitemap, every page in the sitemap answers with its own canonical address, a link preview
// (Open Graph, Twitter) and valid structured data, a searcher's page is kept out of results, /learn/ is /learn, no
// <sup> in the text (a crawler reads 2<sup>70</sup> as 270), and every link in llms.txt answers. The live numbers are
// in the HTML itself (api/pages.js writes them in): the 160 puzzles, the tiles, a page for each puzzle with its own
// title and canonical; with the API down the pages still come, as they are. Against the real API and tests/serve.js
// (nginx's routes and headers). Run: node bitcoin/puzzle/tests/seo.js
'use strict';
const fs = require('fs');
const path = require('path');
const { stack } = require('./stack.js');
const { serve } = require('./serve.js');
const { ok, eq, done, FINDER, PZ } = require('./engine.js');

const SITE = 'https://puzzle.bumblebeam.org';
const WEB = path.join(__dirname, '..', 'web');

(async () => {
  const st = await stack();
  const get = (p) => fetch(st.base + p, { redirect: 'manual' });
  try {
    console.log('robots.txt');
    const robots = await (await get('/robots.txt')).text();
    const dis = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
    // a robots.txt path rule: a prefix, * for any characters
    const blocked = (p) => dis.some((d) => new RegExp('^' + d.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*')).test(p));
    ok(/^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots), 'every crawler, every page');
    ok(['/api/puzzles', '/api/puzzles/71', '/api/events', '/api/pool', '/api/bench', '/api/pool/finds'].every((p) => !blocked(p)), 'the API the pages are filled from is open (a renderer needs it)');
    ok(['/api/go/address/x', '/api/pool/live', '/api/pool/me?addr=x', '/api/puzzles/71/utxos', '/api/fees', '/api/address/x'].every(blocked), 'redirects, the event stream, one searcher\'s numbers and the node\'s own answers are not');
    ok(/^Sitemap: https:\/\/puzzle\.bumblebeam\.org\/sitemap\.xml$/m.test(robots), 'it names the sitemap');

    console.log('the sitemap\'s pages');
    const sm = await get('/sitemap.xml');
    const locs = [...(await sm.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    ok(sm.status === 200 && locs.length === 167 && locs.filter((l) => /\/puzzle\/\d+$/.test(l)).length === 160, 'sitemap.xml: the 7 pages and the 160 puzzles\' own', locs.length);
    const titles = new Set();
    for (const loc of locs) {
      const p = loc.slice(SITE.length) || '/', r = await get(p), html = await r.text();
      const head = html.slice(0, html.indexOf('</head>'));
      const canon = [...head.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);
      const og = (k) => (head.match(new RegExp('<meta property="og:' + k + '" content="([^"]*)">')) || [])[1];
      ok(r.status === 200 && canon.length === 1 && canon[0] === loc, p + ': 200, one canonical: itself', canon);
      titles.add((head.match(/<title>([^<]*)<\/title>/) || [])[1]);
      ok(!/<!--ssr:/.test(html), p + ': every live number written in (no mark left)');
      // a puzzle's balance on the explorer is linked from its own page only; everywhere else a puzzle leads there
      const toExplorer = (html.match(/href="\/api\/go\/address\//g) || []).length;
      if (/^\/puzzle\//.test(p)) ok(/id="pz-bal"><a href="\/api\/go\/address\//.test(html) && /id="pz-intro"><a href="\/api\/go\/address\/[^"]+"[^>]*>Puzzle #\d+<\/a>/.test(html), p + ': "Puzzle #N" in its text and the balance now, linked to the explorer');
      else eq(toExplorer, 0, p + ': no link to a puzzle address on the explorer (they lead to /puzzle/<n>)');
      ok(og('url') === loc && og('title') && og('description') && og('image') === SITE + '/og.jpg' && /<meta name="twitter:card" content="summary_large_image">/.test(head), p + ': a link preview (Open Graph, Twitter)');
      ok(!/noindex/.test(head) && !r.headers.get('x-robots-tag'), p + ': indexable');
      const lds = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      let good = true;
      for (const t of lds) { try { const j = JSON.parse(t); if (j['@context'] !== 'https://schema.org') good = false; } catch (_) { good = false; } }
      ok(good, p + ': structured data that parses (' + lds.length + ' block(s))');
      const text = html.replace(/<script[\s\S]*?<\/script>/g, '');
      ok(!/<sup>/.test(text), p + ': no <sup> in the text (2⁷⁰, not 2<sup>70</sup>)');
    }
    eq(titles.size, 167, 'every page has its own title');
    const home = await (await get('/')).text();
    ok((home.match(/<tr class="is-(open|solved)/g) || []).length === 160 && home.includes(PZ.address(71)) && home.includes(PZ.address(160)), '/: all 160 puzzles in the HTML, with their addresses');
    ok(/id="t-count">\d+\/160</.test(home) && /id="t-open">[\d.]+ BTC</.test(home), '/: the tiles\' numbers in the HTML, no loader');
    ok(/<a href="\/puzzle\/71"/.test(home), '/: the puzzles link to their own pages');
    const pz = await (await get('/puzzle/71')).text();
    ok(/<h1[^>]*>Bitcoin Puzzle #71</.test(pz) && pz.includes(PZ.address(71)) && /0x400000000000000000/.test(pz) && /BreadcrumbList/.test(pz), '/puzzle/71: its title, address, range and breadcrumbs in the HTML');
    eq((await get('/puzzle/161')).status, 404, '/puzzle/161: no such puzzle, a 404');
    eq((await get('/puzzle/0')).status, 404, '/puzzle/0 too');
    ok(/id="b-table"><tr>/.test(await (await get('/bench')).text()), '/bench: the table in the HTML');
    ok(/"@type":"Dataset"/.test(home) && /"contentUrl":"https:\/\/puzzle\.bumblebeam\.org\/api\/puzzles"/.test(home), '/: a Dataset with the JSON as its download');
    ok(/1000 BTC puzzle/.test(home), '/: the other name people search for (the 1000 BTC puzzle)');

    console.log('pages kept out of results, one address per page');
    for (const p of ['/pool/' + FINDER]) {
      const r = await get(p), html = await r.text();
      ok(r.status === 200 && r.headers.get('x-robots-tag') === 'noindex' && /<meta name="robots" content="noindex">/.test(html) && !/rel="canonical"/.test(html), p + ': noindex (header and tag), no canonical');
    }
    let r = await get('/learn/');
    ok(r.status === 301 && r.headers.get('location') === '/learn', '/learn/ → 301 /learn', r.headers.get('location'));
    r = await get('/pool/?ref=' + FINDER);
    ok(r.status === 301 && r.headers.get('location') === '/pool?ref=' + FINDER, '... the query kept');
    eq((await get('/pool')).headers.get('x-robots-tag'), null, '/pool itself: indexable');

    console.log('the link preview\'s picture, llms.txt');
    const jpg = fs.readFileSync(path.join(WEB, 'og.jpg'));
    let w = 0, h = 0;
    for (let i = 2; i < jpg.length;) { const m = jpg[i + 1], len = jpg.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) { h = jpg.readUInt16BE(i + 5); w = jpg.readUInt16BE(i + 7); break; } i += 2 + len; }
    ok(w === 1200 && h === 630 && jpg.length < 300000, 'og.jpg: 1200 × 630, ' + Math.round(jpg.length / 1024) + ' KB');
    const llms = await (await get('/llms.txt')).text();
    const links = [...new Set([...llms.matchAll(/\]\((https:\/\/puzzle\.bumblebeam\.org[^)]*)\)/g)].map((m) => m[1]))];
    const bad = [];
    for (const l of links) { const p = l.slice(SITE.length) || '/'; const x = await get(p); if (x.status !== 200 || blocked(p)) bad.push(p + ' ' + x.status); }
    ok(links.length >= 15 && !bad.length, 'llms.txt: its ' + links.length + ' links on the site all answer, none of them closed by robots.txt', bad);

    console.log('the API down: the pages as they are');
    const dead = await serve(0, 1), base2 = 'http://127.0.0.1:' + dead.address().port;
    for (const p of ['/', '/pool', '/bench', '/proof']) {
      const x = await fetch(base2 + p), t = await x.text();
      ok(x.status === 200 && /bb-wait|…/.test(t) && /rel="canonical"/.test(t), p + ': 200, the page with its loaders');
    }
    const x = await fetch(base2 + '/puzzle/71');
    ok(x.status === 503 && /id="pz-intro"/.test(await x.text()), '/puzzle/71: its page with a 503 (a crawler comes back later; a visitor\'s page fills itself)');
    dead.close();
  } catch (e) {
    ok(false, 'the test ran: ' + (e && e.stack));
  } finally { await st.stop(); }
  done();
})();
