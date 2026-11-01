#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
// the bytes a Bitcoin address puts into an output script: the witness program (bech32/bech32m: 20 or 32 bytes)
// or the hash160 (base58 P2PKH/P2SH: 20 bytes). Returns the length, 0 if the address does not parse.
int addr_program(const char *addr, uint8_t out[40]);
// true if the program occurs in buf: a solo pool pays the block reward straight to the miner's address
bool addr_in(const uint8_t *buf, size_t n, const uint8_t *prog, int plen);
