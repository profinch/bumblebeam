// The vault: every secret of the extension in one record, encrypted with the wallet password.
//   PBKDF2-SHA256 (600 000 rounds, 16-byte salt) -> AES-256-GCM (12-byte IV), WebCrypto only.
// What it holds (see offscreen.js): the wallets, each with its seed phrase if known, its Beam database
// password and its Ethereum phrase or key. Stored in chrome.storage.local as base64 fields; the key is
// non-extractable and lives only in the host's memory while the wallet is unlocked.
'use strict';

const Vault = (() => {
  const ITER = 600000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // a fresh salt and key for a password: the vault is sealed with it from now on
  async function keyFor(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return { key: await derive(password, salt, ITER), salt: b64(salt), iter: ITER };
  }

  async function seal(k, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.key, enc.encode(JSON.stringify(data))));
    return { v: 1, kdf: 'pbkdf2-sha256', salt: k.salt, iter: k.iter, iv: b64(iv), ct: b64(ct) };
  }

  // -> { data, k } or throws 'wrong password' (AES-GCM fails to authenticate)
  async function open(record, password) {
    if (!record || record.v !== 1) throw new Error('no vault');
    const k = { key: await derive(password, unb64(record.salt), record.iter), salt: record.salt, iter: record.iter };
    let pt;
    try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, k.key, unb64(record.ct)); }
    catch { throw new Error('wrong password'); }
    return { data: JSON.parse(dec.decode(pt)), k };
  }

  const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

  return { keyFor, seal, open, randomHex, b64, unb64 };
})();
