// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// BeamHash III proof-of-work checks, bit-for-bit compatible with the Beam core
// (3rdparty/crypto/beamHashIII_impl.cpp, core/difficulty.cpp, pow/beamHash.cpp).
//
// Plain C ABI so the pool (Rust, via FFI) and the miner host code share one implementation.
// No allocation, no global state, thread-safe.

#ifndef BUMBLEBEAM_POW_H
#define BUMBLEBEAM_POW_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
	BB_BH3_SOLUTION_BYTES = 104, // 32 indices x 25 bits (100 bytes) + 4-byte extra nonce
	BB_BH3_INDICES = 32,
	BB_NONCE_BYTES = 8,
	BB_INPUT_BYTES = 32,         // Block::SystemState::Full::get_HashForPoW, as sent in a stratum job
};

enum bb_result {
	BB_OK = 0,
	BB_ERR_COLLISION = 1,   // a pair does not collide on its 24 bits
	BB_ERR_DUPLICATE = 2,   // an index appears twice
	BB_ERR_ORDER = 3,       // index trees not in canonical order
	BB_ERR_NONZERO = 4,     // the final XOR is not zero
	BB_ERR_DIFFICULTY = 5,  // valid solution, but its hash does not reach the difficulty
	BB_ERR_ARGS = 6,
};

// Structural BeamHash III check of a solution for (input, nonce). Returns BB_OK or the first
// failing rule. The same rules, in the same order, as BeamHash_III::IsValidSolution.
int bb_bh3_check(const uint8_t* input, size_t input_len, const uint8_t nonce[BB_NONCE_BYTES],
	const uint8_t solution[BB_BH3_SOLUTION_BYTES]);

// SHA-256 of the solution, the hash the difficulty is checked against.
void bb_solution_hash(const uint8_t solution[BB_BH3_SOLUTION_BYTES], uint8_t out[32]);

// Difficulty::IsTargetReached for a packed difficulty (8-bit order, 24-bit mantissa).
// hash is big-endian, as ECC::Hash::Value stores it.
int bb_difficulty_reached(const uint8_t hash[32], uint32_t packed);

// The packed difficulty as a number (expected solutions per block found), as the explorer shows it.
double bb_difficulty_to_double(uint32_t packed);

// Full share/block check: structure first, then difficulty. Returns BB_OK, a structural error,
// or BB_ERR_DIFFICULTY.
int bb_bh3_check_share(const uint8_t* input, size_t input_len, const uint8_t nonce[BB_NONCE_BYTES],
	const uint8_t solution[BB_BH3_SOLUTION_BYTES], uint32_t packed_difficulty);

// Solution encoding: 32 indices (25 bits each) <-> the first 100 bytes of a solution.
void bb_bh3_unpack_indices(const uint8_t solution[100], uint32_t indices[BB_BH3_INDICES]);
void bb_bh3_pack_indices(const uint32_t indices[BB_BH3_INDICES], uint8_t solution[100]);

const char* bb_result_str(int r);

#ifdef __cplusplus
}
#endif

#endif
