// BumbleBeam Wallet engine: watches the Beam engine's WebSockets (loaded before Beam's wasm client, which
// opens them). Beam's client does not say when its node goes away; this does: the host learns when the
// connection to the node opens and closes, and when anything was last sent or received, for its keepalive
// and for switching to another node. Nothing is changed in what is sent.
'use strict';

(() => {
  const Native = window.WebSocket;
  const ws = { open: 0, lastSend: 0, lastRecv: 0, lastOpen: 0, lastClose: 0, sent: 0, recv: 0, tell: () => {} };
  window.__bbWs = ws;
  class Watched extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      // only a socket that opened counts: Beam's client also tries nodes that never answer over WebSocket
      // (eu-nodes / us-nodes.mainnet.beam.mw:8100 speak plain TCP), and their failures are not a lost node
      let opened = false;
      this.addEventListener('open', () => { opened = true; ws.open++; ws.lastOpen = Date.now(); ws.tell('open', url); });
      this.addEventListener('close', () => { if (!opened) return; opened = false; if (ws.open > 0) ws.open--; ws.lastClose = Date.now(); ws.tell('close', url); });
      this.addEventListener('message', (m) => { ws.lastRecv = Date.now(); ws.recv += (m.data && (m.data.byteLength || m.data.size || m.data.length)) || 0; });
    }
    send(data) { ws.lastSend = Date.now(); ws.sent += (data && (data.byteLength || data.size || data.length)) || 0; return super.send(data); }
  }
  window.WebSocket = Watched;
})();
