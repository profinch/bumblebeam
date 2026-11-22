/* A request that carries a found key, or anything signed with one, sealed for our server alone: nothing between the
   page and the API (Cloudflare, which ends the site's TLS; a proxy; a log of request bodies) can read it.
   ECDH on P-256 between a fresh key of the page's, made for this one request, and the server's published key
   (TRANSPORT_PUB); HKDF-SHA256 over the shared secret gives one AES-256-GCM key for the request and one for the
   answer, the request's path bound in as associated data (a sealed body cannot be replayed to another endpoint).
   The server's answer to a sealed request comes back sealed the same way; its refusals ({ error }) stay plain.
   What it does not stop: whoever can change the page's own scripts (they are served through the same path).
   WebCrypto only, so one copy runs in the browser and in Node (api/finds.js). A classic script. Exposes BBSeal. */
(function (root) {
  'use strict';
  // the public half of POOL_TRANSPORT_KEY (uncompressed P-256 point): api/server.js does not start with another key
  var TRANSPORT_PUB = '042ecd9a89e7c560fe99cb8115556137f1269e7b9f2749f2a17bbd7785614cb9dd26903eea456bea0c4c76b3166ac3bb16299f78511049fe4acbe875294a1c176e';
  var CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  var enc = new TextEncoder(), dec = new TextDecoder();
  function subtle() { if (!root.crypto || !root.crypto.subtle) throw new Error('this browser cannot seal a request (no WebCrypto: the page must be on https)'); return root.crypto.subtle; }
  function unhex(h) { var o = new Uint8Array(h.length / 2); for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
  function b64(bytes) { bytes = new Uint8Array(bytes); var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(s) { var t = atob(String(s)), o = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) o[i] = t.charCodeAt(i); return o; }

  // the two AES keys of one exchange, from the ECDH secret
  async function keys(shared, path) {
    var base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    function one(way) {
      return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('bumblebeam-puzzle seal 1|' + way + '|' + path) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    return { request: await one('request'), answer: await one('answer') };
  }
  async function lock(key, path, obj) {
    var iv = root.crypto.getRandomValues(new Uint8Array(12));
    var data = await subtle().encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(path) }, key, enc.encode(JSON.stringify(obj)));
    return { seal: 1, iv: b64(iv), data: b64(data) };
  }
  async function unlock(key, path, box) {
    if (!box || box.seal !== 1) throw new Error('not sealed');
    var plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(path) }, key, unb64(box.data));
    return JSON.parse(dec.decode(plain));
  }

  // the page: { body (to send as JSON), open(answer) -> the answer's object }; pub: TRANSPORT_PUB unless given
  async function seal(path, obj, pub) {
    var server = await subtle().importKey('raw', unhex(pub || BBSeal.TRANSPORT_PUB), CURVE, false, []);
    var mine = await subtle().generateKey(CURVE, false, ['deriveBits']);
    var shared = await subtle().deriveBits({ name: 'ECDH', public: server }, mine.privateKey, 256);
    var k = await keys(shared, path);
    var body = await lock(k.request, path, obj);
    body.epk = b64(await subtle().exportKey('raw', mine.publicKey));
    return { body: body, open: function (answer) { return unlock(k.answer, path, answer); } };
  }
  // the server: its private key as a CryptoKey (importPrivate); { body, reply(obj) -> the sealed answer }
  async function open(priv, path, body) {
    if (!body || body.seal !== 1 || typeof body.epk !== 'string') throw new Error('not sealed');
    var theirs = await subtle().importKey('raw', unb64(body.epk), CURVE, false, []);
    var shared = await subtle().deriveBits({ name: 'ECDH', public: theirs }, priv, 256);
    var k = await keys(shared, path);
    return { body: await unlock(k.request, path, body), reply: function (obj) { return lock(k.answer, path, obj); } };
  }
  // d (64 hex) and its public point (65 bytes, hex) -> the private CryptoKey for open()
  function importPrivate(dHex, pubHex) {
    var url = function (b) { return b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }, p = unhex(pubHex);
    return subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', d: url(unhex(dHex)), x: url(p.slice(1, 33)), y: url(p.slice(33)), ext: false }, CURVE, false, ['deriveBits']);
  }

  var BBSeal = { TRANSPORT_PUB: TRANSPORT_PUB, seal: seal, open: open, importPrivate: importPrivate };
  root.BBSeal = BBSeal;
  if (typeof module !== 'undefined' && module.exports) module.exports = BBSeal;
})(typeof self !== 'undefined' ? self : globalThis);
