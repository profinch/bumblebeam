// bpscan: forensic scan of Beam bulletproofs for traces of the pre-HF6 rangeproof forgery.
//
// Before HF6 (height 3928666) the inner-product argument drew the challenge of
// round i BEFORE exposing L_i,R_i to the oracle (InnerProduct v0). The last
// round's L,R were therefore bound by no challenge: a prover could pick L freely
// and solve R from the final equation, proving a range for any value, including
// a "negative" one (inflation). A careful forgery is indistinguishable from an
// honest proof; this tool looks for the traces a careless one would leave, and
// uses post-HF6 proofs (sound scheme) as a control group.
//
// Data: a COPY of a node database (never the file of a running node).
//  - MW outputs with their bulletproofs: table Txo (ID, Value = serialized Output, SpendHeight).
//    Nodes erase old block bodies but keep every TXO in full unless TxoLo/TxoHi horizons are set.
//  - Shielded outputs: kernels in States.Ethernal.
//  - TXO id -> height: States.Txos (TXO count at the end of the block).

#include "core/block_crypt.h"
#include "core/ecc_native.h"
#include "core/serialization_adapters.h"
#include "utility/serialize.h"
#include "sqlite/sqlite3.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

using namespace beam;

thread_local const beam::Rules* beam::Rules::s_pInstance = nullptr;

namespace {

const Height kHF6 = 3928666;

enum Flag : uint32_t {
	F_BADPT   = 1u << 0,  // a point that doesn't import (not on curve / bad encoding)
	F_ZEROPT  = 1u << 1,  // point at infinity / all-zero encoding
	F_SMALL   = 1u << 2,  // point equals k*Gen for a small k (G, H, J, IPA generators)
	F_LR_EQ   = 1u << 3,  // two LR points of the same proof share X (incl. L_last == +-R_last)
	F_SCALAR  = 1u << 4,  // a proof scalar is < 2^64 (incl. 0), or condensed a == b
	F_DUP     = 1u << 5,  // a point/scalar shared with a proof of a DIFFERENT commitment
	F_REPLAY  = 1u << 6,  // a point/scalar shared only with proofs of the SAME commitment (informational)
};
const int kFlags = 7;
const char* kFlagNames[kFlags] = { "badpt", "zeropt", "small", "lr_eq", "scalar", "dup", "replay" };

std::string FlagsStr(uint32_t f)
{
	std::string s;
	for (int i = 0; i < kFlags; i++)
		if (f & (1u << i))
		{
			if (!s.empty()) s += '|';
			s += kFlagNames[i];
		}
	return s;
}

uint64_t Key64(const ECC::uintBig& x)
{
	uint64_t k;
	memcpy(&k, x.m_pData, sizeof(k));
	return k;
}

uint64_t CommKey(const ECC::Point& p)
{
	return Key64(p.m_X) ^ p.m_Y;
}

std::string Hex(const ECC::Point& p)
{
	char buf[67];
	snprintf(buf, 3, "%02x", p.m_Y);
	for (int i = 0; i < 32; i++)
		snprintf(buf + 2 + i * 2, 3, "%02x", p.m_X.m_pData[i]);
	return buf;
}

struct SmallTable
{
	std::unordered_map<uint64_t, std::string> m_Map;

	void Add(const ECC::Point::Native& base, const std::string& name, uint32_t nMax)
	{
		ECC::Point::Native acc = base;
		for (uint32_t k = 1; k <= nMax; k++)
		{
			ECC::Point p;
			acc.Export(p);
			m_Map.emplace(Key64(p.m_X), name + "*" + std::to_string(k));
			acc += base;
		}
	}

	void Init(uint32_t nMax)
	{
		const ECC::Context& ctx = ECC::Context::get();
		auto add = [&](const ECC::MultiMac::Prepared& prep, const std::string& name, uint32_t n) {
			ECC::Point::Native pt;
			prep.m_Fast.m_pPt[0].Assign(pt, true);
			Add(pt, name, n);
		};

		add(ctx.m_Ipp.G_, "G", nMax);
		add(ctx.m_Ipp.H_, "H", nMax);
		add(ctx.m_Ipp.J_, "J", nMax);
		add(ctx.m_Ipp.m_GenDot_, "GenDot", 256);
		add(ctx.m_Ipp.m_Aux2_, "Aux2", 256);
		for (int i = 0; i < 2; i++)
			for (uint32_t j = 0; j < ECC::InnerProduct::nDim; j++)
				add(ctx.m_Ipp.m_pGen_[i][j], "Gen" + std::to_string(i) + "_" + std::to_string(j), 256);
	}

	const std::string* Find(const ECC::Point& p) const
	{
		auto it = m_Map.find(Key64(p.m_X));
		return (m_Map.end() == it) ? nullptr : &it->second;
	}
};

// proof reference: MW outputs by TXO id, shielded outputs by their sequence number
const uint64_t kShieldedBit = 1ull << 63;

struct Hit
{
	uint32_t m_Flags = 0;
	std::string m_Note;
	void Add(uint32_t f, const std::string& s)
	{
		m_Flags |= f;
		if (m_Note.size() < 300)
			m_Note += s + " ";
	}
};

#pragma pack(push, 1)
struct KeyRec
{
	uint64_t m_Key;
	uint64_t m_Comm;
	uint64_t m_Ref;
	uint8_t m_Field;
	bool operator < (const KeyRec& x) const { return (m_Key != x.m_Key) ? (m_Key < x.m_Key) : (m_Ref < x.m_Ref); }
};
#pragma pack(pop)

const char* kFieldNames[] = { "A", "S", "T1", "T2", "L5", "R5", "TauX", "Mu", "L0", "R0", "L1", "R1", "L2", "R2", "L3", "R3", "L4", "R4" };

struct ShieldedRec
{
	ECC::Point m_Comm;
	Height m_Height;
};

struct Stat
{
	uint64_t m_MwConf = 0;
	uint64_t m_MwPublic = 0;
	uint64_t m_MwNaked = 0;
	uint64_t m_MwUnspent = 0;
	uint64_t m_Shielded = 0;
	uint64_t m_Kernels = 0;
	uint64_t m_Flagged[kFlags] = { 0 };
	uint64_t m_FlaggedAny = 0; // excluding replay-only
};

struct Scanner
{
	SmallTable m_Small;
	std::map<uint64_t, Hit> m_Hits;
	std::vector<ShieldedRec> m_vShielded;
	std::vector<TxoID> m_vTxosEnd; // [h] = TXO count at the end of block h
	Stat m_pStat[2]; // [0] = pre-HF6, [1] = post-HF6 (control)
	bool m_AllRounds = false;

	static const uint32_t s_nBuckets = 64;
	std::string m_sOut;
	std::vector<FILE*> m_vBuckets;

	Height TxoHeight(TxoID id) const
	{
		auto it = std::upper_bound(m_vTxosEnd.begin(), m_vTxosEnd.end(), id);
		return it - m_vTxosEnd.begin(); // ids before the end of block 1 (treasury) -> 1
	}

	void OpenBuckets()
	{
		for (uint32_t i = 0; i < s_nBuckets; i++)
		{
			std::string s = m_sOut + "/keys." + std::to_string(i) + ".bin";
			FILE* f = fopen(s.c_str(), "w+b");
			if (!f)
				throw std::runtime_error("can't create " + s);
			m_vBuckets.push_back(f);
		}
	}

	static bool IsSmallScalar(const ECC::Scalar& s)
	{
		for (int i = 0; i < 24; i++)
			if (s.m_Value.m_pData[i])
				return false;
		return true; // < 2^64, incl. zero
	}

	void CheckPoint(const ECC::Point& p, Hit& r, const char* szField)
	{
		if (p.m_X == Zero)
		{
			r.Add(F_ZEROPT, std::string(szField) + "=0");
			return;
		}

		ECC::Point::Native pt;
		if (!pt.Import(p))
		{
			r.Add(F_BADPT, std::string(szField) + "=bad");
			return;
		}

		if (auto* pName = m_Small.Find(p))
			r.Add(F_SMALL, std::string(szField) + "=" + *pName);
	}

	void OnProof(const ECC::RangeProof::Confidential& bp, const ECC::Point& comm, uint64_t ref)
	{
		Hit r;
		const auto& ip = bp.m_P_Tag;
		const uint32_t nC = ECC::InnerProduct::nCycles;

		CheckPoint(bp.m_Part1.m_A, r, "A");
		CheckPoint(bp.m_Part1.m_S, r, "S");
		CheckPoint(bp.m_Part2.m_T1, r, "T1");
		CheckPoint(bp.m_Part2.m_T2, r, "T2");
		for (uint32_t c = 0; c < nC; c++)
			for (int j = 0; j < 2; j++)
			{
				char sz[8];
				snprintf(sz, sizeof(sz), "%c%u", j ? 'R' : 'L', c);
				CheckPoint(ip.m_pLR[c][j], r, sz);
			}

		// LR points sharing X inside one proof (L_last == +-R_last is the obvious lazy forgery)
		for (uint32_t a = 0; a < nC * 2; a++)
			for (uint32_t b = a + 1; b < nC * 2; b++)
				if (ip.m_pLR[a / 2][a % 2].m_X == ip.m_pLR[b / 2][b % 2].m_X)
					r.Add(F_LR_EQ, "LR" + std::to_string(a) + "~LR" + std::to_string(b));

		const ECC::Scalar* pSc[] = { &bp.m_Part3.m_TauX, &bp.m_Mu, &bp.m_tDot, &ip.m_pCondensed[0], &ip.m_pCondensed[1] };
		const char* pScN[] = { "TauX", "Mu", "tDot", "a", "b" };
		for (int i = 0; i < 5; i++)
			if (IsSmallScalar(*pSc[i]))
				r.Add(F_SCALAR, std::string(pScN[i]) + "=small");
		if (ip.m_pCondensed[0].m_Value == ip.m_pCondensed[1].m_Value)
			r.Add(F_SCALAR, "a==b");

		if (r.m_Flags)
			m_Hits[ref] = std::move(r);

		// keys for the cross-proof duplicate pass, bucketed by key
		uint64_t ck = CommKey(comm);
		auto key = [&](const ECC::uintBig& x, uint8_t f) {
			KeyRec kr{ Key64(x), ck, ref, f };
			fwrite(&kr, sizeof(kr), 1, m_vBuckets[kr.m_Key % s_nBuckets]);
		};
		key(bp.m_Part1.m_A.m_X, 0);
		key(bp.m_Part1.m_S.m_X, 1);
		key(bp.m_Part2.m_T1.m_X, 2);
		key(bp.m_Part2.m_T2.m_X, 3);
		key(ip.m_pLR[nC - 1][0].m_X, 4);
		key(ip.m_pLR[nC - 1][1].m_X, 5);
		key(bp.m_Part3.m_TauX.m_Value, 6);
		key(bp.m_Mu.m_Value, 7);
		if (m_AllRounds)
			for (uint32_t c = 0; c + 1 < nC; c++)
				for (int j = 0; j < 2; j++)
					key(ip.m_pLR[c][j].m_X, static_cast<uint8_t>(8 + c * 2 + j));
	}

	void WalkKernels(const std::vector<TxKernel::Ptr>& v, Height h, uint32_t nDepth)
	{
		Stat& st = m_pStat[h >= kHF6];
		for (const auto& pK : v)
		{
			st.m_Kernels++;
			if (TxKernel::Subtype::ShieldedOutput == pK->get_Subtype())
			{
				const auto& k = Cast::Up<TxKernelShieldedOutput>(*pK);
				st.m_Shielded++;
				uint64_t ref = kShieldedBit | m_vShielded.size();
				m_vShielded.push_back({ k.m_Txo.m_Commitment, h });
				OnProof(k.m_Txo.m_RangeProof, k.m_Txo.m_Commitment, ref);
			}
			if (nDepth < 8)
				WalkKernels(pK->m_vNested, h, nDepth + 1);
		}
	}

	void DupPass()
	{
		for (uint32_t b = 0; b < s_nBuckets; b++)
		{
			FILE* f = m_vBuckets[b];
			fseek(f, 0, SEEK_END);
			size_t n = ftell(f) / sizeof(KeyRec);
			std::vector<KeyRec> v(n);
			fseek(f, 0, SEEK_SET);
			if (n && fread(v.data(), sizeof(KeyRec), n, f) != n)
				throw std::runtime_error("bucket read");
			fclose(f);
			remove((m_sOut + "/keys." + std::to_string(b) + ".bin").c_str());

			std::sort(v.begin(), v.end());
			for (size_t i0 = 0; i0 < v.size(); )
			{
				size_t i1 = i0 + 1;
				while (i1 < v.size() && v[i1].m_Key == v[i0].m_Key)
					i1++;

				if (i1 - i0 > 1)
				{
					bool bSameComm = true;
					for (size_t i = i0 + 1; i < i1; i++)
						if (v[i].m_Comm != v[i0].m_Comm)
							bSameComm = false;

					for (size_t i = i0; i < i1; i++)
					{
						Hit& r = m_Hits[v[i].m_Ref];
						if (bSameComm)
							r.m_Flags |= F_REPLAY;
						else
							r.Add(F_DUP, std::string("dup:") + kFieldNames[v[i].m_Field] + "x" + std::to_string(i1 - i0));
					}
				}
				i0 = i1;
			}
			std::cerr << "dup bucket " << b << ": " << n << " keys, hits " << m_Hits.size() << "\n";
		}
	}
};

void PrintStat(const char* szName, const Stat& s, std::ostream& os, bool bLast)
{
	os << "    \"" << szName << "\": {\"mw_confidential\": " << s.m_MwConf
		<< ", \"mw_public\": " << s.m_MwPublic
		<< ", \"mw_naked\": " << s.m_MwNaked
		<< ", \"mw_confidential_unspent\": " << s.m_MwUnspent
		<< ", \"shielded_outputs\": " << s.m_Shielded
		<< ", \"kernels\": " << s.m_Kernels
		<< ", \"flagged_any\": " << s.m_FlaggedAny
		<< ", \"flagged\": {";
	for (int i = 0; i < kFlags; i++)
		os << (i ? ", " : "") << "\"" << kFlagNames[i] << "\": " << s.m_Flagged[i];
	os << "}}" << (bLast ? "" : ",") << "\n";
}

int Usage()
{
	std::cerr << "usage: bpscan <node.db copy> <out dir> [--to=<height>] [--small=<k>] [--all-rounds] [--check]\n";
	return 2;
}

bool ReadTxo(sqlite3* pDb, TxoID id, Output& outp, Height& hSpend)
{
	sqlite3_stmt* p = nullptr;
	sqlite3_prepare_v2(pDb, "SELECT Value, SpendHeight FROM Txo WHERE ID=?", -1, &p, nullptr);
	sqlite3_bind_int64(p, 1, id);
	bool bOk = false;
	if (SQLITE_ROW == sqlite3_step(p))
	{
		Deserializer der;
		der.reset(sqlite3_column_blob(p, 0), sqlite3_column_bytes(p, 0));
		try {
			der & outp;
			bOk = true;
		} catch (const std::exception&) {}
		hSpend = (SQLITE_NULL == sqlite3_column_type(p, 1)) ? MaxHeight : sqlite3_column_int64(p, 1);
	}
	sqlite3_finalize(p);
	return bOk;
}

} // namespace

int main(int argc, char* argv[])
{
	if (argc < 3)
		return Usage();

	std::string sDb = argv[1], sOut = argv[2];
	Height hTo = MaxHeight;
	uint32_t nSmall = 1u << 16;
	bool bAllRounds = false, bCheck = false;
	for (int i = 3; i < argc; i++)
	{
		std::string a = argv[i];
		if (!a.compare(0, 5, "--to="))
			hTo = std::stoull(a.substr(5));
		else if (!a.compare(0, 8, "--small="))
			nSmall = std::stoul(a.substr(8));
		else if (a == "--all-rounds")
			bAllRounds = true;
		else if (a == "--check")
			bCheck = true;
		else
			return Usage();
	}

	ECC::InitializeContext();

	Rules rules; // mainnet by default
	rules.SetNetworkParams();
	rules.UpdateChecksum();
	Rules::Scope scopeRules(rules);
	if (rules.pForks[6].m_Height != kHF6)
	{
		std::cerr << "unexpected HF6 height " << rules.pForks[6].m_Height << " (not mainnet rules?)\n";
		return 1;
	}

	sqlite3* pDb = nullptr;
	std::string sUri = "file:" + sDb + "?mode=ro&immutable=1";
	if (SQLITE_OK != sqlite3_open_v2(sUri.c_str(), &pDb, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nullptr))
	{
		std::cerr << "open failed: " << sqlite3_errmsg(pDb) << "\n";
		return 1;
	}

	if (bCheck)
	{
		// structural check of the copy (it may have been taken from a live file)
		std::cerr << "PRAGMA quick_check...\n";
		sqlite3_stmt* p = nullptr;
		sqlite3_prepare_v2(pDb, "PRAGMA quick_check(50)", -1, &p, nullptr);
		int n = 0;
		while (SQLITE_ROW == sqlite3_step(p))
		{
			std::cout << sqlite3_column_text(p, 0) << "\n";
			n++;
		}
		sqlite3_finalize(p);
		sqlite3_close(pDb);
		return (1 == n) ? 0 : 1;
	}

	Scanner sc;
	sc.m_AllRounds = bAllRounds;
	sc.m_sOut = sOut;
	sc.OpenBuckets();
	sc.m_Small.Init(nSmall);
	std::cerr << "small-multiple table: " << sc.m_Small.m_Map.size() << " points\n";

	// 1. states: TXO boundaries per height + kernels (shielded outputs)
	Height hLast = 0;
	uint64_t nNoKernels = 0, nGaps = 0, nErrStates = 0;
	{
		sqlite3_stmt* p = nullptr;
		sqlite3_prepare_v2(pDb, "SELECT Height, Txos, Ethernal FROM States WHERE (Flags & 4) != 0 AND Height <= ? ORDER BY Height", -1, &p, nullptr);
		sqlite3_bind_int64(p, 1, static_cast<sqlite3_int64>(std::min<Height>(hTo, INT64_MAX)));
		sc.m_vTxosEnd.push_back(0); // h=0
		int rc;
		while (SQLITE_ROW == (rc = sqlite3_step(p)))
		{
			Height h = sqlite3_column_int64(p, 0);
			if (h != hLast + 1)
				nGaps++;
			hLast = h;
			sc.m_vTxosEnd.resize(h + 1, sc.m_vTxosEnd.back());
			sc.m_vTxosEnd[h] = sqlite3_column_int64(p, 1);

			const void* pE = sqlite3_column_blob(p, 2);
			if (!pE)
			{
				nNoKernels++;
				continue;
			}
			try {
				TxVectors::Eternal txe;
				Deserializer der;
				der.reset(pE, sqlite3_column_bytes(p, 2));
				der & txe;
				sc.WalkKernels(txe.m_vKernels, h, 0);
			} catch (const std::exception& e) {
				if (nErrStates++ < 20)
					std::cerr << "kernels at " << h << ": " << e.what() << "\n";
			}
			if (!(h % 500000))
				std::cerr << "states " << h << ", shielded " << sc.m_vShielded.size() << "\n";
		}
		if (SQLITE_DONE != rc)
		{
			std::cerr << "states step: " << sqlite3_errmsg(pDb) << "\n";
			nErrStates++;
		}
		sqlite3_finalize(p);
	}
	// height 0 has no row; treat the treasury (ids below the end of block 1) as height 1
	TxoID nTxos = sc.m_vTxosEnd.back();
	std::cerr << "states done: tip " << hLast << ", txos " << nTxos << ", shielded " << sc.m_vShielded.size() << "\n";

	// 2. TXOs in chunks, so a damaged page loses one chunk only (reported)
	std::ofstream unsp(sOut + "/unspent_pre_hf6.csv");
	unsp << "txo_id,height,commitment\n";
	std::vector<std::pair<TxoID, TxoID>> vBadChunks;
	uint64_t nRows = 0, nErrTxo = 0, nMissing = 0;
	const TxoID nChunk = 100000;
	{
		sqlite3_stmt* p = nullptr;
		sqlite3_prepare_v2(pDb, "SELECT ID, Value, SpendHeight FROM Txo WHERE ID >= ? AND ID < ? ORDER BY ID", -1, &p, nullptr);
		for (TxoID id0 = 0; id0 < nTxos; id0 += nChunk)
		{
			TxoID id1 = std::min(id0 + nChunk, nTxos);
			sqlite3_reset(p);
			sqlite3_bind_int64(p, 1, id0);
			sqlite3_bind_int64(p, 2, id1);
			TxoID idExp = id0;
			int rc;
			while (SQLITE_ROW == (rc = sqlite3_step(p)))
			{
				TxoID id = sqlite3_column_int64(p, 0);
				nMissing += id - idExp;
				idExp = id + 1;
				nRows++;

				Height h = sc.TxoHeight(id);
				Stat& st = sc.m_pStat[h >= kHF6];
				bool bSpent = (SQLITE_NULL != sqlite3_column_type(p, 2));

				Output outp;
				try {
					Deserializer der;
					der.reset(sqlite3_column_blob(p, 1), sqlite3_column_bytes(p, 1));
					der & outp;
				} catch (const std::exception& e) {
					if (nErrTxo++ < 20)
						std::cerr << "txo " << id << ": " << e.what() << "\n";
					continue;
				}

				if (outp.m_pConfidential)
				{
					st.m_MwConf++;
					if (!bSpent)
					{
						st.m_MwUnspent++;
						if (h < kHF6)
							unsp << id << "," << h << "," << Hex(outp.m_Commitment) << "\n";
					}
					sc.OnProof(*outp.m_pConfidential, outp.m_Commitment, id);
				}
				else if (outp.m_pPublic)
					st.m_MwPublic++;
				else
					st.m_MwNaked++;
			}
			if (SQLITE_DONE != rc)
			{
				std::cerr << "txo chunk [" << id0 << "," << id1 << "): " << sqlite3_errmsg(pDb) << "\n";
				vBadChunks.emplace_back(id0, id1);
			}
			else
				nMissing += id1 - idExp;

			if (!(id0 % 2000000))
				std::cerr << "txo " << id0 << " / " << nTxos << ", hits " << sc.m_Hits.size() << "\n";
		}
		sqlite3_finalize(p);
	}

	std::cerr << "dup pass...\n";
	sc.DupPass();

	// 3. report
	std::ofstream csv(sOut + "/flagged.csv");
	csv << "period,kind,ref,height,commitment,spend_height,flags,note\n";
	uint64_t nReplayOnly = 0;
	for (const auto& [ref, r] : sc.m_Hits)
	{
		bool bShielded = !!(ref & kShieldedBit);
		ECC::Point comm;
		Height h = 0, hSpend = MaxHeight;
		if (bShielded)
		{
			const auto& s = sc.m_vShielded[ref & ~kShieldedBit];
			comm = s.m_Comm;
			h = s.m_Height;
		}
		else
		{
			Output outp;
			h = sc.TxoHeight(ref);
			if (ReadTxo(pDb, ref, outp, hSpend))
				comm = outp.m_Commitment;
			else
				ZeroObject(comm);
		}

		Stat& st = sc.m_pStat[h >= kHF6];
		for (int f = 0; f < kFlags; f++)
			if (r.m_Flags & (1u << f))
				st.m_Flagged[f]++;

		if (!(r.m_Flags & ~F_REPLAY))
		{
			nReplayOnly++;
			continue;
		}
		st.m_FlaggedAny++;

		csv << (h >= kHF6 ? "post" : "pre") << "," << (bShielded ? "shielded" : "mw") << ","
			<< (ref & ~kShieldedBit) << "," << h << "," << Hex(comm) << ","
			<< (bShielded ? std::string("n/a") : (MaxHeight == hSpend ? std::string("unspent") : std::to_string(hSpend))) << ","
			<< FlagsStr(r.m_Flags) << ",\"" << r.m_Note << "\"\n";
	}
	sqlite3_close(pDb);

	std::ostringstream os;
	os << "{\n  \"hf6_height\": " << kHF6 << ",\n  \"tip\": " << hLast
		<< ",\n  \"txos_total\": " << nTxos << ",\n  \"txo_rows_read\": " << nRows
		<< ",\n  \"txo_ids_missing\": " << nMissing << ",\n  \"txo_decode_errors\": " << nErrTxo
		<< ",\n  \"txo_bad_chunks\": [";
	for (size_t i = 0; i < vBadChunks.size(); i++)
		os << (i ? ", " : "") << "[" << vBadChunks[i].first << ", " << vBadChunks[i].second << "]";
	os << "],\n  \"states_without_kernels\": " << nNoKernels << ",\n  \"height_gaps\": " << nGaps
		<< ",\n  \"state_errors\": " << nErrStates << ",\n  \"small_table\": " << sc.m_Small.m_Map.size()
		<< ",\n  \"all_rounds_dup\": " << (bAllRounds ? "true" : "false")
		<< ",\n  \"replay_only\": " << nReplayOnly
		<< ",\n  \"periods\": {\n";
	PrintStat("pre_hf6", sc.m_pStat[0], os, false);
	PrintStat("post_hf6", sc.m_pStat[1], os, true);
	os << "  }\n}\n";

	std::ofstream(sOut + "/summary.json") << os.str();
	std::cout << os.str();
	return 0;
}
