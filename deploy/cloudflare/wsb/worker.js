// wsb.bumblebeam.org: a WebSocket door to Beam nodes for browser wallets (the BumbleBeam Wallet extension),
// run by Cloudflare, not by our server. A browser can only open WebSockets; a Beam node speaks its protocol
// over TCP. For each wallet connection this Worker opens a TCP connection to the first node of NODES that
// answers and passes the bytes both ways, unchanged.
//
// It is the wallet's backup door: the main one, wss.bumblebeam.org, goes through our server to our node,
// so when the server is down this one still reaches BeamMW's public nodes. Only the listed nodes, never an
// address the client names (an open "TCP from anywhere to anywhere" would be used for other traffic), and
// only extension pages, as on the main door.
import { connect } from 'cloudflare:sockets';

// Nodes checked to serve a light wallet at the chain's tip (2026-11-05, a wallet through each): BeamMW's
// public ones that eu-nodes / us-nodes.mainnet.beam.mw resolve to, and sunpool's. Left out: 5.161.134.203
// (stuck before HF6), 5.161.156.185/186 (behind when last seen). Each wallet connection tries them in a
// random order; the wallet itself moves on when its node's last block is over 10 minutes old (a node that
// answers but lags). bumblebeam's own node comes last.
const PUBLIC = [
  { hostname: '188.245.67.32', port: 8100 }, { hostname: '188.245.67.33', port: 8100 },
  { hostname: '188.245.67.34', port: 8100 }, { hostname: '188.245.67.35', port: 8100 },
  { hostname: '5.161.152.212', port: 8100 },
  { hostname: '195.201.121.246', port: 10000 },          // earth.sunpool.top
];
const OURS = { hostname: 'stratum.bumblebeam.org', port: 10000 };
const CONNECT_MS = 5000;

function order() {
  const a = PUBLIC.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return [...a, OURS];
}

async function openNode() {
  for (const n of order()) {
    const s = connect(n);
    try {
      await Promise.race([s.opened, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CONNECT_MS))]);
      return { s, n };
    } catch { try { s.close(); } catch {} }
  }
  return null;
}

export default {
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('A Beam node door for browser wallets: WebSocket only.\n', { status: 426 });
    if (!/^chrome-extension:\/\//.test(req.headers.get('Origin') || '')) return new Response('Forbidden\n', { status: 403 });
    if (new URL(req.url).pathname !== '/') return new Response('Not found\n', { status: 404 });

    const node = await openNode();
    if (!node) return new Response('No Beam node answers\n', { status: 502 });
    const { s } = node;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const writer = s.writable.getWriter();
    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      try { server.close(1000, 'closed'); } catch {}
      try { writer.close(); } catch {}
      try { s.close(); } catch {}
    };

    // wallet -> node, in order. A binary message arrives as an ArrayBuffer or, depending on the runtime's
    // compatibility settings, as a Blob (read as an empty array, it sent nothing: 2026-11-05); text never
    // comes from Beam's wallet but is passed on as bytes.
    let chain = Promise.resolve();
    server.addEventListener('message', (e) => {
      const m = e.data;
      chain = chain.then(async () => {
        const d = typeof m === 'string' ? new TextEncoder().encode(m)
          : m instanceof ArrayBuffer ? new Uint8Array(m)
          : ArrayBuffer.isView(m) ? new Uint8Array(m.buffer, m.byteOffset, m.byteLength)
          : new Uint8Array(await m.arrayBuffer());
        await writer.write(d);
      }).catch(close);
    });
    server.addEventListener('close', close);
    server.addEventListener('error', close);

    // node -> wallet
    (async () => {
      const reader = s.readable.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          server.send(value);
        }
      } catch {}
      close();
    })();

    return new Response(null, { status: 101, webSocket: client });
  },
};
