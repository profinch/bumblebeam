// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0

#include "ref.h"

#include "beamHashIII.h"

namespace bb::ref {

namespace {

void Init(BeamHash_III& pow, blake2b_state& st, const uint8_t* input, size_t inputLen, const uint8_t nonce[8])
{
	pow.InitialiseState(st);
	blake2b_update(&st, input, inputLen);
	blake2b_update(&st, nonce, 8);
}

} // namespace

bool Check(const uint8_t* input, size_t inputLen, const uint8_t nonce[8], const uint8_t solution[104])
{
	BeamHash_III pow;
	blake2b_state st;
	Init(pow, st, input, inputLen, nonce);
	return pow.IsValidSolution(st, std::vector<uint8_t>(solution, solution + 104));
}

std::vector<std::vector<uint8_t>> SolveAll(const uint8_t* input, size_t inputLen, const uint8_t nonce[8])
{
	BeamHash_III pow;
	blake2b_state st;
	Init(pow, st, input, inputLen, nonce);

	std::vector<std::vector<uint8_t>> res;
	pow.OptimisedSolve(st,
		[&res](const std::vector<unsigned char>& sol) { res.push_back(sol); return false; },
		[](SolverCancelCheck) { return false; });
	return res;
}

} // namespace bb::ref
