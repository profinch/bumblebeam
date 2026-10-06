// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// Reader for the flat JSON test vectors in vectors/: an array of objects whose values are strings,
// numbers or booleans. Not a general JSON parser.

#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace bb::vec {

using Record = std::map<std::string, std::string>; // key -> raw value (strings unquoted)

// All objects of the array stored under `arrayKey`.
std::vector<Record> Load(const std::string& path, const std::string& arrayKey);

std::vector<uint8_t> Hex(const std::string& s);
std::string ToHex(const uint8_t* p, size_t n);

} // namespace bb::vec
