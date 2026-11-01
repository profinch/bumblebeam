#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#define ADDR_SCRIPT_MAX 42
// the output script (scriptPubKey) that pays a Bitcoin address: P2PKH, P2SH (base58check), P2WPKH, P2WSH, P2TR and other
// witness versions (bech32 / bech32m). Checksums, network prefix and lengths are checked. Returns its length, 0 = not an address
int addr_script(const char *addr, uint8_t out[ADDR_SCRIPT_MAX]);
// a whole coinbase transaction (coinb1 + extranonces + coinb2, no witness data): the percentage of its output value that
// goes to script, -1 when it does not parse. A solo pool pays (nearly) all of it to the miner's address
int addr_coinbase_share(const uint8_t *tx, size_t n, const uint8_t *script, int slen);
