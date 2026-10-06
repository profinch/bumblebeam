// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// bb-pow: command-line access to the BeamHash III checks and the reference solver.
//
//   bb-pow check <input-hex> <nonce-hex> <solution-hex> [packed-difficulty]
//   bb-pow solve <input-hex> <nonce-hex>      all solutions the reference finds, as JSON
//   bb-pow bench <vectors/mainnet_headers.json> [seconds]

#include "bumblebeam/pow.h"
#include "../src/ref.h"
#include "../src/vectors.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace bb;

static int Usage()
{
	fprintf(stderr,
		"usage: bb-pow check <input> <nonce> <solution> [difficulty]\n"
		"       bb-pow solve <input> <nonce>\n"
		"       bb-pow bench <mainnet_headers.json> [seconds]\n");
	return 2;
}

static int Check(int argc, char* argv[])
{
	if (argc < 5)
		return Usage();
	auto in = vec::Hex(argv[2]), nonce = vec::Hex(argv[3]), sol = vec::Hex(argv[4]);
	if (nonce.size() != BB_NONCE_BYTES || sol.size() != BB_BH3_SOLUTION_BYTES)
		return Usage();
	int r = (argc > 5)
		? bb_bh3_check_share(in.data(), in.size(), nonce.data(), sol.data(), (uint32_t) strtoul(argv[5], nullptr, 0))
		: bb_bh3_check(in.data(), in.size(), nonce.data(), sol.data());
	printf("%s\n", bb_result_str(r));
	return r == BB_OK ? 0 : 1;
}

static int Solve(int argc, char* argv[])
{
	if (argc < 4)
		return Usage();
	auto in = vec::Hex(argv[2]), nonce = vec::Hex(argv[3]);
	if (nonce.size() != BB_NONCE_BYTES)
		return Usage();

	auto t0 = std::chrono::steady_clock::now();
	auto sols = ref::SolveAll(in.data(), in.size(), nonce.data());
	double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

	printf("{\"input\": \"%s\", \"nonce\": \"%s\", \"seconds\": %.1f, \"solutions\": [", argv[2], argv[3], dt);
	for (size_t i = 0; i < sols.size(); i++)
		printf("%s\n  {\"solution\": \"%s\"}", i ? "," : "", vec::ToHex(sols[i].data(), sols[i].size()).c_str());
	printf("\n]}\n");
	return 0;
}

static int Bench(int argc, char* argv[])
{
	if (argc < 3)
		return Usage();
	double secs = (argc > 3) ? atof(argv[3]) : 2.0;

	struct V { std::vector<uint8_t> in, nonce, sol; };
	std::vector<V> v;
	for (auto& r : vec::Load(argv[2], "headers"))
		if (r["algo"] == "BeamHashIII")
			v.push_back({ vec::Hex(r["input"]), vec::Hex(r["nonce"]), vec::Hex(r["solution"]) });
	if (v.empty())
		return 1;

	auto run = [&](const char* name, auto fn) {
		size_t n = 0;
		auto t0 = std::chrono::steady_clock::now();
		double dt = 0;
		while (dt < secs)
		{
			for (auto& x : v)
				if (!fn(x))
				{
					fprintf(stderr, "%s rejected a valid vector\n", name);
					exit(1);
				}
			n += v.size();
			dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
		}
		printf("%-10s %10.0f checks/s  (%.2f us each)\n", name, n / dt, dt / n * 1e6);
		return n / dt;
	};

	double a = run("bumblebeam", [](const V& x) { return bb_bh3_check(x.in.data(), x.in.size(), x.nonce.data(), x.sol.data()) == BB_OK; });
	double b = run("reference", [](const V& x) { return ref::Check(x.in.data(), x.in.size(), x.nonce.data(), x.sol.data()); });
	printf("speedup    %.1fx (single thread)\n", a / b);
	return 0;
}

int main(int argc, char* argv[])
{
	std::string m = (argc > 1) ? argv[1] : "";
	try {
		if (m == "check") return Check(argc, argv);
		if (m == "solve") return Solve(argc, argv);
		if (m == "bench") return Bench(argc, argv);
	} catch (const std::exception& e) {
		fprintf(stderr, "error: %s\n", e.what());
		return 1;
	}
	return Usage();
}
