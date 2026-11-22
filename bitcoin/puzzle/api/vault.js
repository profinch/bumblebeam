// The vault's secrets on disk (finds.js): a found key, and anything signed with it that is not public yet (a signed
// claim shows the public key, and a 70-bit key falls to anyone within minutes of that). One file per puzzle address
// in DATA_DIR/vault/, readable by the API's own user only (0600 in a 0700 directory), each sealed with AES-256-GCM
// under POOL_VAULT_KEY, which is not on the server's disk (the .env of the deploy, kept elsewhere too): a copy of the
// data directory, a backup or a stray read gives nothing without it. The address is bound into each file (associated
// data), so a file renamed to another address does not open. The database keeps only that a key is in the vault and
// what is public about it.
//
// What it does not stop: root on the host (it can read the process's memory and its environment), and anyone who
// has the server's .env as well as its disk.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADDR = /^(1[1-9A-HJ-NP-Za-km-z]{24,34}|3[1-9A-HJ-NP-Za-km-z]{24,34}|bc1[02-9ac-hj-np-z]{11,71})$/;

// key: 32 bytes
function createVault(dir, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('vault: the key must be 32 bytes');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = (addr) => { if (!ADDR.test(String(addr))) throw new Error('vault: not an address'); return path.join(dir, addr + '.key'); };
  const aad = (addr) => Buffer.from('bumblebeam-puzzle vault|' + addr);

  function seal(addr, obj) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(aad(addr));
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
  }
  function unseal(addr, text) {
    const f = JSON.parse(text);
    if (f.v !== 1) throw new Error('vault: a file of another version');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(aad(addr));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
  }
  // written whole or not at all: a temporary file, flushed to the disk, then renamed over the old one
  function put(addr, obj) {
    const f = file(addr), tmp = f + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, seal(addr, obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
    try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (_) { /* not every system syncs a directory */ }
  }
  // null when there is no file; a file that does not open (another key, changed, renamed) is an error, never null
  function get(addr) {
    let text;
    try { text = fs.readFileSync(file(addr), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return unseal(addr, text); } catch (e) { throw new Error('vault: ' + addr + '.key does not open with POOL_VAULT_KEY (' + e.message + ')'); }
  }
  function update(addr, patch) {
    const o = get(addr);
    if (!o) return null;
    Object.assign(o, patch);
    put(addr, o);
    return o;
  }
  return { put, get, update, dir };
}

module.exports = { createVault };
