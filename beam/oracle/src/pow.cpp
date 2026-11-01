// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// BeamHash III verification without std::bitset or heap: 448-bit work values are 7 x uint64 limbs
// (limb 0 = lowest bits), and an index tree is a contiguous slice of the 32 solution indices
// (canonical order makes every subtree contiguous). Semantics follow the Beam core reference in
// third_party/beam/beamHashIII_impl.cpp line by line; the comments name the matching reference code.

#include "bumblebeam/pow.h"

#include <cstring>

extern "C" {
#include "blake/ref/blake2.h"
}

namespace {

constexpr uint32_t kWorkBits = 448;
constexpr uint32_t kCollisionBits = 24;
constexpr uint32_t kRounds = 5;
constexpr uint32_t kIndexBits = kCollisionBits + 1; // 25
constexpr int kLimbs = kWorkBits / 64;              // 7

inline uint64_t Rotl(uint64_t x, unsigned b) { return (x << b) | (x >> (64 - b)); }

inline uint64_t Load64LE(const uint8_t* p)
{
	uint64_t x = 0;
	for (int i = 7; i >= 0; i--)
		x = (x << 8) | p[i];
	return x;
}

// sipHash::siphash24 of the reference: the four 64-bit words of prePow are the state as is.
inline uint64_t SipHash24(const uint64_t k[4], uint64_t nonce)
{
	uint64_t v0 = k[0], v1 = k[1], v2 = k[2], v3 = k[3] ^ nonce;
#define BB_SIPROUND                                 \
	do {                                            \
		v0 += v1; v2 += v3;                         \
		v1 = Rotl(v1, 13); v3 = Rotl(v3, 16);       \
		v1 ^= v0; v3 ^= v2;                         \
		v0 = Rotl(v0, 32);                          \
		v2 += v1; v0 += v3;                         \
		v1 = Rotl(v1, 17); v3 = Rotl(v3, 21);       \
		v1 ^= v2; v3 ^= v0;                         \
		v2 = Rotl(v2, 32);                          \
	} while (0)
	BB_SIPROUND; BB_SIPROUND;
	v0 ^= nonce;
	v2 ^= 0xff;
	BB_SIPROUND; BB_SIPROUND; BB_SIPROUND; BB_SIPROUND;
#undef BB_SIPROUND
	return v0 ^ v1 ^ v2 ^ v3;
}

struct Elem
{
	uint64_t w[kLimbs];
	const uint32_t* leaves; // first leaf of this subtree inside the solution's index array
	uint32_t nLeaves;
};

// stepElem::stepElem(prePow, index)
inline void Seed(Elem& e, const uint64_t prePow[4], const uint32_t* pLeaf)
{
	uint32_t base = *pLeaf << 3; // 32-bit, as in the reference: (index << 3) + i
	for (int i = 0; i < kLimbs; i++)
		e.w[i] = SipHash24(prePow, (uint64_t) (base + (uint32_t) i));
	e.leaves = pLeaf;
	e.nLeaves = 1;
}

// stepElem::applyMix(remLen). The work bits above remLen are zero by construction.
inline void ApplyMix(Elem& e, uint32_t remLen)
{
	uint64_t t[8];
	memcpy(t, e.w, sizeof(e.w));
	t[7] = 0;

	uint32_t padNum = ((512 - remLen) + kCollisionBits) / kIndexBits;
	if (padNum > e.nLeaves)
		padNum = e.nLeaves;

	for (uint32_t i = 0; i < padNum; i++)
	{
		uint32_t pos = remLen + i * kIndexBits;
		if (pos >= 512)
			break;
		uint64_t v = e.leaves[i];
		uint32_t limb = pos / 64, off = pos % 64;
		t[limb] |= v << off;
		if (off + kIndexBits > 64 && limb + 1 < 8)
			t[limb + 1] |= v >> (64 - off);
	}

	uint64_t r = 0;
	for (unsigned i = 0; i < 8; i++)
		r += Rotl(t[i], (29 * (i + 1)) & 0x3F);
	e.w[0] = Rotl(r, 24);
}

inline uint32_t CollisionBits(const Elem& e) { return (uint32_t) (e.w[0] & ((1U << kCollisionBits) - 1)); }

// stepElem::stepElem(a, b, remLen): (a ^ b) >> 24, masked to remLen bits; a's leaves come first.
inline void Merge(Elem& out, const Elem& a, const Elem& b, uint32_t remLen)
{
	uint64_t x[kLimbs];
	for (int i = 0; i < kLimbs; i++)
		x[i] = a.w[i] ^ b.w[i];
	for (int i = 0; i < kLimbs; i++)
		out.w[i] = (x[i] >> kCollisionBits) | ((i + 1 < kLimbs) ? (x[i + 1] << (64 - kCollisionBits)) : 0);

	for (int i = 0; i < kLimbs; i++)
	{
		uint32_t lo = (uint32_t) i * 64;
		if (lo >= remLen)
			out.w[i] = 0;
		else if (remLen - lo < 64)
			out.w[i] &= (1ULL << (remLen - lo)) - 1;
	}

	out.leaves = a.leaves;
	out.nLeaves = a.nLeaves + b.nLeaves;
}

inline bool DistinctLeaves(const Elem& a, const Elem& b)
{
	for (uint32_t i = 0; i < a.nLeaves; i++)
		for (uint32_t j = 0; j < b.nLeaves; j++)
			if (a.leaves[i] == b.leaves[j])
				return false;
	return true;
}

void PrePow(const uint8_t* input, size_t inputLen, const uint8_t nonce[8], const uint8_t extraNonce[4], uint64_t out[4])
{
	// BeamHash_III::InitialiseState: Blake2b-256 personalised "Beam-PoW" || 448 || 5 (little-endian).
	blake2b_param param;
	memset(&param, 0, sizeof(param));
	param.digest_length = 32;
	param.fanout = 1;
	param.depth = 1;
	memcpy(param.personal, "Beam-PoW", 8);
	const uint32_t pers[2] = { kWorkBits, kRounds };
	for (int i = 0; i < 2; i++)
		for (int b = 0; b < 4; b++)
			param.personal[8 + i * 4 + b] = (uint8_t) (pers[i] >> (8 * b));

	blake2b_state st;
	blake2b_init_param(&st, &param);
	blake2b_update(&st, input, inputLen); // Block::PoW::Helper::Reset: H(input || nonce ...
	blake2b_update(&st, nonce, 8);
	blake2b_update(&st, extraNonce, 4);   // ... || extra nonce), in IsValidSolution

	uint8_t h[32];
	blake2b_final(&st, h, 32);
	for (int i = 0; i < 4; i++)
		out[i] = Load64LE(h + 8 * i);
}

// ---- SHA-256 (FIPS 180-4), for the difficulty hash ----

const uint32_t kSha[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

inline uint32_t Ror(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }

void Sha256Block(uint32_t s[8], const uint8_t* p)
{
	uint32_t w[64];
	for (int i = 0; i < 16; i++)
		w[i] = ((uint32_t) p[4 * i] << 24) | ((uint32_t) p[4 * i + 1] << 16) | ((uint32_t) p[4 * i + 2] << 8) | p[4 * i + 3];
	for (int i = 16; i < 64; i++)
	{
		uint32_t s0 = Ror(w[i - 15], 7) ^ Ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
		uint32_t s1 = Ror(w[i - 2], 17) ^ Ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
		w[i] = w[i - 16] + s0 + w[i - 7] + s1;
	}
	uint32_t a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
	for (int i = 0; i < 64; i++)
	{
		uint32_t t1 = h + (Ror(e, 6) ^ Ror(e, 11) ^ Ror(e, 25)) + ((e & f) ^ (~e & g)) + kSha[i] + w[i];
		uint32_t t2 = (Ror(a, 2) ^ Ror(a, 13) ^ Ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
		h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
	}
	s[0] += a; s[1] += b; s[2] += c; s[3] += d; s[4] += e; s[5] += f; s[6] += g; s[7] += h;
}

void Sha256(const uint8_t* p, size_t n, uint8_t out[32])
{
	uint32_t s[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
	size_t full = n / 64;
	for (size_t i = 0; i < full; i++)
		Sha256Block(s, p + 64 * i);

	uint8_t tail[128] = { 0 };
	size_t rem = n - full * 64;
	memcpy(tail, p + full * 64, rem);
	tail[rem] = 0x80;
	size_t tailLen = (rem + 9 <= 64) ? 64 : 128;
	uint64_t bits = (uint64_t) n * 8;
	for (int i = 0; i < 8; i++)
		tail[tailLen - 1 - i] = (uint8_t) (bits >> (8 * i));
	for (size_t i = 0; i < tailLen; i += 64)
		Sha256Block(s, tail + i);

	for (int i = 0; i < 8; i++)
		for (int b = 0; b < 4; b++)
			out[4 * i + b] = (uint8_t) (s[i] >> (24 - 8 * b));
}

} // namespace

extern "C" {

// GetIndicesFromMinimal: bytes 0..99 as a little-endian 800-bit stream, 25 bits per index.
void bb_bh3_unpack_indices(const uint8_t solution[100], uint32_t indices[BB_BH3_INDICES])
{
	for (uint32_t i = 0; i < BB_BH3_INDICES; i++)
	{
		uint32_t bit = i * kIndexBits, v = 0;
		for (uint32_t k = 0; k < kIndexBits; k++, bit++)
			v |= (uint32_t) ((solution[bit / 8] >> (bit % 8)) & 1) << k;
		indices[i] = v;
	}
}

void bb_bh3_pack_indices(const uint32_t indices[BB_BH3_INDICES], uint8_t solution[100])
{
	memset(solution, 0, 100);
	for (uint32_t i = 0; i < BB_BH3_INDICES; i++)
	{
		uint32_t bit = i * kIndexBits;
		for (uint32_t k = 0; k < kIndexBits; k++, bit++)
			solution[bit / 8] |= (uint8_t) (((indices[i] >> k) & 1) << (bit % 8));
	}
}

int bb_bh3_check(const uint8_t* input, size_t input_len, const uint8_t nonce[BB_NONCE_BYTES],
	const uint8_t solution[BB_BH3_SOLUTION_BYTES])
{
	if ((!input && input_len) || !nonce || !solution)
		return BB_ERR_ARGS;

	uint64_t prePow[4];
	PrePow(input, input_len, nonce, solution + 100, prePow);

	uint32_t leaves[BB_BH3_INDICES];
	bb_bh3_unpack_indices(solution, leaves);

	Elem x[BB_BH3_INDICES];
	for (uint32_t i = 0; i < BB_BH3_INDICES; i++)
		Seed(x[i], prePow, leaves + i);

	// BeamHash_III::IsValidSolution: pair by pair, level by level, rules in the same order.
	uint32_t n = BB_BH3_INDICES;
	for (uint32_t round = 1; n > 1; round++)
	{
		uint32_t mixLen = kWorkBits - (round - 1) * kCollisionBits;
		if (round == 5)
			mixLen -= 64;

		uint32_t outLen = kWorkBits - round * kCollisionBits;
		if (round == 4)
			outLen -= 64;
		if (round == 5)
			outLen = kCollisionBits;

		for (uint32_t i = 0; i < n; i += 2)
		{
			ApplyMix(x[i], mixLen);
			ApplyMix(x[i + 1], mixLen);

			if (CollisionBits(x[i]) != CollisionBits(x[i + 1]))
				return BB_ERR_COLLISION;
			if (!DistinctLeaves(x[i], x[i + 1]))
				return BB_ERR_DUPLICATE;
			if (!(x[i].leaves[0] < x[i + 1].leaves[0]))
				return BB_ERR_ORDER;

			Merge(x[i / 2], x[i], x[i + 1], outLen);
		}
		n /= 2;
	}

	for (int i = 0; i < kLimbs; i++)
		if (x[0].w[i])
			return BB_ERR_NONZERO;
	return BB_OK;
}

void bb_solution_hash(const uint8_t solution[BB_BH3_SOLUTION_BYTES], uint8_t out[32])
{
	Sha256(solution, BB_BH3_SOLUTION_BYTES, out);
}

// Difficulty::IsTargetReached: hash * mantissa < 2^(256 + 24 - order), with the 25-bit mantissa
// including its implicit leading 1. Packed values above s_Inf = 232 << 24 are invalid.
int bb_difficulty_reached(const uint8_t hash[32], uint32_t packed)
{
	const uint32_t kMantissaBits = 24, kInf = (256 - kMantissaBits) << kMantissaBits;
	if (packed > kInf)
		return 0;

	uint32_t order = packed >> kMantissaBits;
	uint64_t mantissa = (1ULL << kMantissaBits) | (packed & ((1U << kMantissaBits) - 1));

	uint64_t h[4]; // h[0] = least significant
	for (int i = 0; i < 4; i++)
	{
		const uint8_t* p = hash + 32 - 8 * (i + 1);
		uint64_t v = 0;
		for (int b = 0; b < 8; b++)
			v = (v << 8) | p[b];
		h[i] = v;
	}

	// h * mantissa as five 64-bit limbs.
	uint64_t prod[5];
#ifdef __SIZEOF_INT128__
	unsigned __int128 carry = 0;
	for (int i = 0; i < 4; i++)
	{
		unsigned __int128 t = (unsigned __int128) h[i] * mantissa + carry;
		prod[i] = (uint64_t) t;
		carry = t >> 64;
	}
	prod[4] = (uint64_t) carry;
#else
	// No 128-bit type (MSVC): the mantissa is below 2^25, so half-word partial products fit in 64 bits.
	uint64_t carry = 0;
	for (int i = 0; i < 4; i++)
	{
		uint64_t lo = (h[i] & 0xFFFFFFFFULL) * mantissa;
		uint64_t hi = (h[i] >> 32) * mantissa;
		uint64_t low = (lo & 0xFFFFFFFFULL) + (carry & 0xFFFFFFFFULL);
		uint64_t mid = (lo >> 32) + (hi & 0xFFFFFFFFULL) + (carry >> 32) + (low >> 32);
		prod[i] = (low & 0xFFFFFFFFULL) | (mid << 32);
		carry = (hi >> 32) + (mid >> 32);
	}
	prod[4] = carry;
#endif

	uint32_t limit = 256 + kMantissaBits - order; // the product must fit in `limit` bits
	for (int i = 4; i >= 0; i--)
	{
		if (!prod[i])
			continue;
		uint32_t lz;
#if defined(__GNUC__) || defined(__clang__)
		lz = (uint32_t) __builtin_clzll(prod[i]);
#else
		lz = 0;
		for (uint64_t v = prod[i]; !(v & (1ULL << 63)); v <<= 1)
			lz++;
#endif
		uint32_t bitLen = (uint32_t) i * 64 + 64 - lz;
		return bitLen <= limit;
	}
	return 1;
}

double bb_difficulty_to_double(uint32_t packed)
{
	uint32_t order = packed >> 24;
	double m = (double) ((1U << 24) | (packed & 0xFFFFFF));
	double r = m;
	for (int i = 24; i > (int) order; i--)
		r /= 2;
	for (int i = 24; i < (int) order; i++)
		r *= 2;
	return r;
}

int bb_bh3_check_share(const uint8_t* input, size_t input_len, const uint8_t nonce[BB_NONCE_BYTES],
	const uint8_t solution[BB_BH3_SOLUTION_BYTES], uint32_t packed_difficulty)
{
	int r = bb_bh3_check(input, input_len, nonce, solution);
	if (r != BB_OK)
		return r;
	uint8_t hv[32];
	bb_solution_hash(solution, hv);
	return bb_difficulty_reached(hv, packed_difficulty) ? BB_OK : BB_ERR_DIFFICULTY;
}

const char* bb_result_str(int r)
{
	switch (r)
	{
	case BB_OK: return "ok";
	case BB_ERR_COLLISION: return "collision";
	case BB_ERR_DUPLICATE: return "duplicate index";
	case BB_ERR_ORDER: return "index order";
	case BB_ERR_NONZERO: return "nonzero result";
	case BB_ERR_DIFFICULTY: return "difficulty not reached";
	case BB_ERR_ARGS: return "bad arguments";
	default: return "unknown";
	}
}

} // extern "C"
