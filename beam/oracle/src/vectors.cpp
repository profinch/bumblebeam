// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0

#include "vectors.h"

#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace bb::vec {

std::vector<Record> Load(const std::string& path, const std::string& arrayKey)
{
	std::ifstream f(path);
	if (!f)
		throw std::runtime_error("cannot open " + path);
	std::stringstream ss;
	ss << f.rdbuf();
	const std::string s = ss.str();

	size_t pos = s.find("\"" + arrayKey + "\"");
	if (pos == std::string::npos || (pos = s.find('[', pos)) == std::string::npos)
		throw std::runtime_error("no array " + arrayKey + " in " + path);

	std::vector<Record> out;
	while (true)
	{
		size_t open = s.find_first_of("{]", pos);
		if (open == std::string::npos || s[open] == ']')
			break;
		size_t close = s.find('}', open);
		if (close == std::string::npos)
			throw std::runtime_error("unterminated object in " + path);

		Record r;
		size_t p = open + 1;
		while (true)
		{
			size_t k0 = s.find('"', p);
			if (k0 == std::string::npos || k0 > close)
				break;
			size_t k1 = s.find('"', k0 + 1);
			size_t colon = s.find(':', k1);
			size_t v0 = s.find_first_not_of(" \t\r\n", colon + 1);
			std::string val;
			if (s[v0] == '"')
			{
				size_t v1 = s.find('"', v0 + 1);
				val = s.substr(v0 + 1, v1 - v0 - 1);
				p = v1 + 1;
			}
			else
			{
				size_t v1 = s.find_first_of(",}", v0);
				val = s.substr(v0, v1 - v0);
				while (!val.empty() && isspace((unsigned char) val.back()))
					val.pop_back();
				p = v1;
			}
			r[s.substr(k0 + 1, k1 - k0 - 1)] = val;
		}
		out.push_back(std::move(r));
		pos = close + 1;
	}
	return out;
}

std::vector<uint8_t> Hex(const std::string& s)
{
	if (s.size() % 2)
		throw std::runtime_error("odd hex length");
	auto nib = [](char c) -> int {
		if (c >= '0' && c <= '9') return c - '0';
		if (c >= 'a' && c <= 'f') return c - 'a' + 10;
		if (c >= 'A' && c <= 'F') return c - 'A' + 10;
		throw std::runtime_error("bad hex");
	};
	std::vector<uint8_t> v(s.size() / 2);
	for (size_t i = 0; i < v.size(); i++)
		v[i] = (uint8_t) (nib(s[2 * i]) << 4 | nib(s[2 * i + 1]));
	return v;
}

std::string ToHex(const uint8_t* p, size_t n)
{
	static const char d[] = "0123456789abcdef";
	std::string r;
	for (size_t i = 0; i < n; i++)
	{
		r += d[p[i] >> 4];
		r += d[p[i] & 15];
	}
	return r;
}

} // namespace bb::vec
