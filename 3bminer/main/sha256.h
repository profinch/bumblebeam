#pragma once
#include <stdint.h>
#include <stddef.h>
void sha256_compress(uint32_t st[8], const uint32_t w16[16]);
void sha256_raw(const uint8_t *data, size_t len, uint8_t out[32]);
void sha256d_raw(const uint8_t *data, size_t len, uint8_t out[32]);
extern const uint32_t SHA256_IV[8];
