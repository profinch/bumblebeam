// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// hdrdump: dev-only tool. Pulls real block headers from a Beam node and writes them as BeamHash III
// test vectors, each checked by the Beam core itself. Also writes difficulty vectors from the core's
// Difficulty::IsTargetReached. Built against a Beam core build tree (see build.sh). It is not part of
// the product; it produces the ground truth the product is tested against.
//
//   hdrdump headers <node:port> <h0>:<count> [<h0>:<count> ...] > vectors/mainnet_headers.json
//   hdrdump difficulty <count> > vectors/difficulty.json

#include "core/proto.h"
#include "core/fly_client.h"
#include "utility/io/reactor.h"
#include "utility/io/timer.h"
#include "utility/logger.h"

#include <cstdio>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <vector>

using namespace beam;

// Each executable that links the Beam core defines this (see explorer/explorer_node.cpp).
thread_local const beam::Rules* beam::Rules::s_pInstance = nullptr;

namespace {

std::string Hex(const void* p, size_t n)
{
	static const char s[] = "0123456789abcdef";
	std::string r;
	r.reserve(n * 2);
	for (size_t i = 0; i < n; i++)
	{
		uint8_t x = ((const uint8_t*) p)[i];
		r += s[x >> 4];
		r += s[x & 15];
	}
	return r;
}

struct Dumper : public proto::NodeConnection
{
	std::vector<HeightRange> m_Ranges;
	size_t m_iRange = 0;
	bool m_First = true;
	bool m_Failed = false;
	uint32_t m_Written = 0;

	void Next()
	{
		if (m_iRange == m_Ranges.size())
		{
			io::Reactor::get_Current().stop();
			return;
		}
		proto::EnumHdrs msg;
		msg.m_Height = m_Ranges[m_iRange];
		Send(msg);
	}

	void OnConnectedSecure() override
	{
		SendLogin();
		Next();
	}

	void OnMsg(proto::HdrPack&& msg) override
	{
		proto::FlyClient::Data::DecodedHdrPack d;
		if (!d.DecodeAndCheck(msg) || d.m_vStates.empty())
		{
			std::cerr << "range " << m_iRange << ": core rejected the pack or it is empty\n";
			m_Failed = true;
			io::Reactor::get_Current().stop();
			return;
		}

		const HeightRange& hrAsked = m_Ranges[m_iRange];
		Height hExpect = hrAsked.m_Min - (hrAsked.m_Max - hrAsked.m_Min);
		for (const auto& s : d.m_vStates)
		{
			if (s.get_Height() != hExpect++)
			{
				std::cerr << "unexpected height " << s.get_Height() << "\n";
				m_Failed = true;
			}
			Merkle::Hash hvPoW, hvBlock;
			s.get_HashForPoW(hvPoW);
			s.get_Hash(hvBlock);
			bool bValid = s.m_PoW.IsValid(hvPoW.m_pData, hvPoW.nBytes, s.get_Height());

			const char* szAlgo = Rules::get().IsPastFork_<2>(s.get_Height()) ? "BeamHashIII"
				: Rules::get().IsPastFork_<1>(s.get_Height()) ? "BeamHashII" : "BeamHashI";

			printf("%s\n  {\"height\": %llu, \"algo\": \"%s\", \"input\": \"%s\", \"nonce\": \"%s\", \"difficulty\": %u, "
				"\"solution\": \"%s\", \"block_hash\": \"%s\", \"core_valid\": %s}",
				m_First ? "" : ",",
				(unsigned long long) s.get_Height(),
				szAlgo,
				Hex(hvPoW.m_pData, hvPoW.nBytes).c_str(),
				Hex(s.m_PoW.m_Nonce.m_pData, s.m_PoW.m_Nonce.nBytes).c_str(),
				s.m_PoW.m_Difficulty.m_Packed,
				Hex(s.m_PoW.m_Indices.data(), s.m_PoW.m_Indices.size()).c_str(),
				Hex(hvBlock.m_pData, hvBlock.nBytes).c_str(),
				bValid ? "true" : "false");
			m_First = false;
			m_Written++;
			if (!bValid)
				m_Failed = true;
		}

		m_iRange++;
		Next();
	}

	void OnMsg(proto::DataMissing&&) override
	{
		std::cerr << "range " << m_iRange << ": node has no data\n";
		m_Failed = true;
		io::Reactor::get_Current().stop();
	}

	void OnDisconnect(const DisconnectReason& r) override
	{
		std::cerr << "disconnected: " << r << "\n";
		m_Failed = true;
		io::Reactor::get_Current().stop();
	}
};

int DumpHeaders(int argc, char* argv[])
{
	if (argc < 4)
		return 2;

	io::Reactor::Ptr pReactor = io::Reactor::create();
	io::Reactor::Scope scope(*pReactor);

	Dumper d;
	for (int i = 3; i < argc; i++)
	{
		unsigned long long h0 = 0, n = 0;
		if (sscanf(argv[i], "%llu:%llu", &h0, &n) != 2 || !n)
			return 2;
		// The node answers EnumHdrs{Min, Max} with the (Max - Min + 1) headers that END at Min
		// (Node::Peer::OnMsg(EnumHdrs) walks backwards from Min). Ask for [h0, h0 + n - 1] that way.
		HeightRange hr;
		hr.m_Min = h0 + n - 1;
		hr.m_Max = hr.m_Min + n - 1;
		d.m_Ranges.push_back(hr);
	}

	io::Address addr;
	if (!addr.resolve(argv[2]))
	{
		std::cerr << "cannot resolve " << argv[2] << "\n";
		return 1;
	}

	io::Timer::Ptr pTimeout = io::Timer::create(*pReactor);
	pTimeout->start(120000, false, [&d]() {
		std::cerr << "timeout\n";
		d.m_Failed = true;
		io::Reactor::get_Current().stop();
	});

	std::string sRules = Rules::get().get_SignatureStr();
	for (char& c : sRules)
		if (c == '\n' || c == '\t')
			c = ' ';
	printf("{\"source\": \"%s\", \"rules\": \"%s\", \"headers\": [", argv[2], sRules.c_str());
	d.Connect(addr);
	pReactor->run();
	printf("\n]}\n");

	std::cerr << d.m_Written << " headers written\n";
	return d.m_Failed ? 1 : 0;
}

// Random 256-bit hashes against random packed difficulties, plus the exact boundary around each
// difficulty's target (target-1, target, target+1), all decided by the core.
int DumpDifficulty(int argc, char* argv[])
{
	uint32_t nCount = (argc > 2) ? (uint32_t) std::stoul(argv[2]) : 1000;
	std::mt19937_64 rng(20261006);

	printf("{\"cases\": [");
	bool bFirst = true;
	auto Emit = [&](const ECC::Hash::Value& hv, uint32_t nPacked) {
		Difficulty d(nPacked);
		printf("%s\n  {\"hash\": \"%s\", \"difficulty\": %u, \"reached\": %s}", bFirst ? "" : ",",
			Hex(hv.m_pData, hv.nBytes).c_str(), nPacked, d.IsTargetReached(hv) ? "true" : "false");
		bFirst = false;
	};

	for (uint32_t i = 0; i < nCount; i++)
	{
		// Orders that matter on mainnet and around it, plus the extremes.
		uint32_t nOrder = (i % 10 == 0) ? (uint32_t) (rng() % (Difficulty::s_MaxOrder + 1)) : (uint32_t) (10 + rng() % 30);
		uint32_t nPacked = (nOrder << Difficulty::s_MantissaBits) | (uint32_t) (rng() & ((1U << Difficulty::s_MantissaBits) - 1));

		ECC::Hash::Value hv;
		for (uint32_t j = 0; j < hv.nBytes; j += 8)
		{
			uint64_t x = rng();
			memcpy(hv.m_pData + j, &x, 8);
		}
		// Scale the random hash so about half the cases pass.
		uint32_t nShift = nOrder + (uint32_t) (rng() % 3);
		for (uint32_t b = 0; b < nShift && b < 256; b++)
			hv.m_pData[b / 8] &= ~(uint8_t) (0x80 >> (b % 8));
		Emit(hv, nPacked);

		ECC::Hash::Value trg;
		if (Difficulty(nPacked).get_Target(trg))
		{
			Emit(trg, nPacked);
			ECC::Hash::Value t2 = trg;
			t2.Inc();
			Emit(t2, nPacked);
			t2 = trg;
			t2.Negate(); t2.Inc(); t2.Negate(); // trg - 1
			Emit(t2, nPacked);
		}
	}
	printf("\n]}\n");
	return 0;
}

} // namespace

int main(int argc, char* argv[])
{
	Rules r; // mainnet by default
	Rules::Scope scopeRules(r);
	r.UpdateChecksum();

	std::string sMode = (argc > 1) ? argv[1] : "";
	if (sMode == "headers")
		return DumpHeaders(argc, argv);
	if (sMode == "difficulty")
		return DumpDifficulty(argc, argv);

	std::cerr << "usage: hdrdump headers <node:port> <h0>:<count> ... | hdrdump difficulty <count>\n";
	return 2;
}
