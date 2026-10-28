// nerdSHA256plus by Bitmaker (NerdMiner v2, MIT), based on Blockstream Jade shaLib. Used as-is for the core-1 software hasher.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_attr.h"
struct nerdSHA256_context { uint8_t buffer[64]; uint32_t digest[8]; };
void nerd_mids(uint32_t* digest, const uint8_t* dataIn);
bool nerd_sha256d(struct nerdSHA256_context* midstate, const uint8_t* dataIn, uint8_t* doubleHash);
void nerd_sha256_bake(const uint32_t* digest, const uint8_t* dataIn, uint32_t* bake);
bool nerd_sha256d_baked(const uint32_t* digest, const uint8_t* dataIn, const uint32_t* bake, uint8_t* doubleHash);
void ByteReverseWords(uint32_t* out, const uint32_t* in, uint32_t byteCount);
