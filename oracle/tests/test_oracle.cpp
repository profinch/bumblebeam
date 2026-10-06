// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// bumblebeam's BeamHash III checks against three independent sources of truth:
//   1. real mainnet headers, each accepted by the Beam core (vectors/mainnet_headers.json);
//   2. the unchanged core reference verifier, on many mutated solutions (accept/reject must match);
//   3. Difficulty::IsTargetReached decisions from the core (vectors/difficulty.json).
// Plus, when present, full solution sets from the reference solver (vectors/solver_*.json).

#include "bumblebeam/pow.h"
#include "../src/ref.h"
#include "../src/vectors.h"

#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <random>
#include <string>

using namespace bb;

static int g_Checks = 0, g_Failures = 0;

#define CHECK(cond, ...)                                              \
	do {                                                              \
		g_Checks++;                                                   \
		if (!(cond)) {                                                \
			g_Failures++;                                             \
			if (g_Failures <= 20) {                                   \
				fprintf(stderr, "FAIL %s:%d: %s: ", __FILE__, __LINE__, #cond); \
				fprintf(stderr, __VA_ARGS__);                         \
				fprintf(stderr, "\n");                                \
			}                                                         \
		}                                                             \
	} while (0)

struct Header
{
	uint64_t height;
	std::vector<uint8_t> input, nonce, sol;
	uint32_t difficulty;
};

static std::string g_Dir;

static std::vector<Header> LoadHeaders()
{
	std::vector<Header> v;
	for (auto& r : vec::Load(g_Dir + "/mainnet_headers.json", "headers"))
	{
		if (r["algo"] != "BeamHashIII")
			continue;
		CHECK(r["core_valid"] == "true", "vector at %s not accepted by core", r["height"].c_str());
		v.push_back({ std::stoull(r["height"]), vec::Hex(r["input"]), vec::Hex(r["nonce"]), vec::Hex(r["solution"]),
			(uint32_t) std::stoul(r["difficulty"]) });
	}
	return v;
}

static void TestSha256()
{
	// The only input size used is 104 bytes (two-block padding path).
	// Expected: python3 -c "import hashlib;print(hashlib.sha256(bytes(range(104))).hexdigest())"
	uint8_t sol[104];
	for (int i = 0; i < 104; i++)
		sol[i] = (uint8_t) i;
	uint8_t h[32];
	bb_solution_hash(sol, h);
	CHECK(vec::ToHex(h, 32) == "ae8e3d799b1353a39815f90eceebefa265cc448fe39faf2008cb20784cb2df9f", "sha256 %s",
		vec::ToHex(h, 32).c_str());
}

static void TestPacking()
{
	std::mt19937 rng(1);
	for (int t = 0; t < 1000; t++)
	{
		uint32_t a[32], b[32];
		for (auto& x : a)
			x = rng() & ((1U << 25) - 1);
		uint8_t s[100];
		bb_bh3_pack_indices(a, s);
		bb_bh3_unpack_indices(s, b);
		CHECK(!memcmp(a, b, sizeof(a)), "pack/unpack round trip");
	}
}

static void TestMainnet(const std::vector<Header>& hs)
{
	for (auto& h : hs)
	{
		int r = bb_bh3_check(h.input.data(), h.input.size(), h.nonce.data(), h.sol.data());
		CHECK(r == BB_OK, "height %llu: %s", (unsigned long long) h.height, bb_result_str(r));
		r = bb_bh3_check_share(h.input.data(), h.input.size(), h.nonce.data(), h.sol.data(), h.difficulty);
		CHECK(r == BB_OK, "height %llu share: %s", (unsigned long long) h.height, bb_result_str(r));
		CHECK(ref::Check(h.input.data(), h.input.size(), h.nonce.data(), h.sol.data()), "reference rejects %llu",
			(unsigned long long) h.height);

		// A block's solution must not reach a much higher difficulty than its own by accident
		// often; at least check that difficulty is not trivially always reached.
		uint8_t hv[32];
		bb_solution_hash(h.sol.data(), hv);
		CHECK(!bb_difficulty_reached(hv, 0xE7FFFFFF), "max difficulty reached at %llu", (unsigned long long) h.height);
	}
}

// Accept/reject must equal the reference on every mutation. Most mutations are rejected; the
// structured ones target each rule.
static void TestMutations(const std::vector<Header>& hs)
{
	std::mt19937_64 rng(7);
	int nRejected = 0, nSame = 0;

	auto Compare = [&](const Header& h, const std::vector<uint8_t>& in, const std::vector<uint8_t>& nonce,
		const std::vector<uint8_t>& sol, const char* what) {
		bool ours = bb_bh3_check(in.data(), in.size(), nonce.data(), sol.data()) == BB_OK;
		bool theirs = ref::Check(in.data(), in.size(), nonce.data(), sol.data());
		CHECK(ours == theirs, "height %llu, %s: ours=%d reference=%d", (unsigned long long) h.height, what, ours, theirs);
		nSame += ours == theirs;
		nRejected += !theirs;
	};

	for (size_t k = 0; k < hs.size(); k++)
	{
		const Header& h = hs[k];

		// every bit of the solution (bytes 0..103), for a third of the headers; one random bit otherwise
		for (int bit = 0; bit < 104 * 8; bit++)
		{
			if (k % 3 && (bit != (int) (rng() % (104 * 8))))
				continue;
			auto s = h.sol;
			s[bit / 8] ^= (uint8_t) (1 << (bit % 8));
			Compare(h, h.input, h.nonce, s, "solution bit flip");
		}

		// nonce and input bits
		for (int i = 0; i < 4; i++)
		{
			auto n = h.nonce;
			n[rng() % 8] ^= (uint8_t) (1 << (rng() % 8));
			Compare(h, h.input, n, h.sol, "nonce bit flip");
			auto in = h.input;
			in[rng() % 32] ^= (uint8_t) (1 << (rng() % 8));
			Compare(h, in, h.nonce, h.sol, "input bit flip");
		}

		uint32_t idx[32];
		bb_bh3_unpack_indices(h.sol.data(), idx);
		auto Repack = [&](const uint32_t* v) {
			auto s = h.sol;
			bb_bh3_pack_indices(v, s.data());
			return s;
		};

		// swap the two halves of a subtree at every level: breaks the order rule
		for (int level = 0; level < 5; level++)
		{
			uint32_t w = 1U << level, start = (uint32_t) (rng() % (32 / (2 * w))) * 2 * w;
			uint32_t v[32];
			memcpy(v, idx, sizeof(v));
			for (uint32_t j = 0; j < w; j++)
				std::swap(v[start + j], v[start + w + j]);
			auto s = Repack(v);
			Compare(h, h.input, h.nonce, s, "subtree swap");
			int r = bb_bh3_check(h.input.data(), h.input.size(), h.nonce.data(), s.data());
			CHECK(r == BB_ERR_ORDER, "height %llu: subtree swap at level %d gave %s", (unsigned long long) h.height,
				level, bb_result_str(r));
		}

		// a duplicated subtree: both halves the same
		{
			uint32_t v[32];
			memcpy(v, idx, sizeof(v));
			for (uint32_t j = 0; j < 16; j++)
				v[16 + j] = v[j];
			Compare(h, h.input, h.nonce, Repack(v), "duplicated half");
		}

		// a single index replaced by its neighbour's
		{
			uint32_t v[32];
			memcpy(v, idx, sizeof(v));
			uint32_t j = (uint32_t) (rng() % 31);
			v[j + 1] = v[j];
			Compare(h, h.input, h.nonce, Repack(v), "duplicate index");
		}

		// extra nonce changed
		{
			auto s = h.sol;
			s[100 + rng() % 4] ^= 1;
			Compare(h, h.input, h.nonce, s, "extra nonce flip");
		}
	}

	printf("  mutations: %d compared with the reference, %d rejected by it\n", nSame, nRejected);
}

static void TestDifficulty()
{
	int n = 0;
	for (auto& r : vec::Load(g_Dir + "/difficulty.json", "cases"))
	{
		auto hv = vec::Hex(r["hash"]);
		uint32_t packed = (uint32_t) std::stoul(r["difficulty"]);
		bool want = r["reached"] == "true";
		CHECK(!!bb_difficulty_reached(hv.data(), packed) == want, "hash %s difficulty %u: want %d", r["hash"].c_str(),
			packed, want);
		n++;
	}
	printf("  difficulty: %d core decisions\n", n);

	CHECK(bb_difficulty_to_double((24u << 24) | 0) == 16777216.0, "to_double 2^24");
}

static void TestSolverVectors()
{
	DIR* d = opendir(g_Dir.c_str());
	if (!d)
		return;
	int nFiles = 0, nSol = 0;
	while (dirent* e = readdir(d))
	{
		std::string name = e->d_name;
		if (name.rfind("solver_", 0) || name.size() < 5 || name.substr(name.size() - 5) != ".json")
			continue;
		nFiles++;
		std::string path = g_Dir + "/" + name;

		std::vector<vec::Record> top;
		try {
			top = vec::Load(path, "solutions");
		} catch (const std::exception& ex) {
			CHECK(false, "%s: %s", name.c_str(), ex.what());
			continue;
		}
		// input and nonce sit at the top level; read them with a one-object pseudo array
		std::string in, nonce;
		{
			FILE* f = fopen(path.c_str(), "r");
			char buf[256] = { 0 };
			size_t n = fread(buf, 1, sizeof(buf) - 1, f);
			fclose(f);
			std::string s(buf, n);
			auto grab = [&](const char* key) {
				size_t p = s.find(std::string("\"") + key + "\": \"");
				size_t a = s.find('"', p + strlen(key) + 3);
				return s.substr(a + 1, s.find('"', a + 1) - a - 1);
			};
			in = grab("input");
			nonce = grab("nonce");
		}
		auto vin = vec::Hex(in), vnonce = vec::Hex(nonce);
		for (auto& r : top)
		{
			auto sol = vec::Hex(r["solution"]);
			int res = bb_bh3_check(vin.data(), vin.size(), vnonce.data(), sol.data());
			CHECK(res == BB_OK, "%s: %s", name.c_str(), bb_result_str(res));
			nSol++;
		}
	}
	closedir(d);
	printf("  solver vectors: %d files, %d solutions\n", nFiles, nSol);
}

int main(int argc, char* argv[])
{
	g_Dir = (argc > 1) ? argv[1] : "vectors";

	TestSha256();
	TestPacking();
	auto hs = LoadHeaders();
	printf("  mainnet: %zu BeamHash III headers\n", hs.size());
	CHECK(hs.size() >= 100, "too few vectors");
	TestMainnet(hs);
	TestMutations(hs);
	TestDifficulty();
	TestSolverVectors();

	printf("%d checks, %d failures\n", g_Checks, g_Failures);
	return g_Failures ? 1 : 0;
}
