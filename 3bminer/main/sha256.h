#pragma once
#include <stdint.h>
#include <stddef.h>
void sha256_compress(uint32_t st[8], const uint32_t w16[16]);
void sha256_raw(const uint8_t *data, size_t len, uint8_t out[32]);
void sha256d_raw(const uint8_t *data, size_t len, uint8_t out[32]);
extern const uint32_t SHA256_IV[8];
// word 7 of the digest of one block hashed from the IV (the second hash of sha256d), 3 rounds short: enough for a hit test
uint32_t sha256_h7(const uint32_t w16[16]);
// sha256d of a header for many nonces: digest word 7 only (the hit test), the job's constant part done once
typedef struct { uint32_t mid[8], w[3], st3[8], w16, w17; } sha256d_pre_t;
void sha256d_prep(sha256d_pre_t *p, const uint32_t mid[8], const uint32_t w3[3]);
uint32_t sha256d_h7(const sha256d_pre_t *p, uint32_t nonce);
