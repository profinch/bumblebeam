// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// Thin wrapper over the unchanged Beam core reference (third_party/beam). Used only by tests and
// tools as the oracle; the product code uses bumblebeam/pow.h.

#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace bb::ref {

// BeamHash_III::IsValidSolution after Block::PoW::Helper::Reset(input, nonce).
bool Check(const uint8_t* input, size_t inputLen, const uint8_t nonce[8], const uint8_t solution[104]);

// BeamHash_III::OptimisedSolve for (input, nonce) with extra nonce 0, reporting every solution it
// finds (not only the first). Slow: minutes and ~10 GB per call.
std::vector<std::vector<uint8_t>> SolveAll(const uint8_t* input, size_t inputLen, const uint8_t nonce[8]);

} // namespace bb::ref
