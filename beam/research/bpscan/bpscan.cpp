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
	// X then Y, the way the Beam explorer prints a commitment
	char buf[67];
	for (int i = 0; i < 32; i++)
		snprintf(buf + i * 2, 3, "%02x", p.m_X.m_pData[i]);
	snprintf(buf + 64, 3, "%02x", p.m_Y);
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

	// same-commitment replays: which fields each proof shares with another proof of its commitment
	struct ReplayRef
	{
		uint64_t m_Comm;
		uint32_t m_Fields;
	};
	std::unordered_map<uint64_t, ReplayRef> m_Replay; // by proof ref

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
						{
							r.m_Flags |= F_REPLAY;
							ReplayRef& rr = m_Replay.emplace(v[i].m_Ref, ReplayRef{ v[i].m_Comm, 0 }).first->second;
							rr.m_Fields |= 1u << v[i].m_Field;
						}
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

std::string FieldsStr(uint32_t m)
{
	std::string s;
	for (uint32_t i = 0; i < sizeof(kFieldNames) / sizeof(kFieldNames[0]); i++)
		if (m & (1u << i))
		{
			if (!s.empty()) s += '|';
			s += kFieldNames[i];
		}
	return s;
}

int Usage()
{
	std::cerr << "usage: bpscan <node.db copy> <out dir> [--to=<height>] [--small=<k>] [--all-rounds] [--check]\n"
		"       bpscan --selftest <out dir>\n";
	return 2;
}

// Positive control: every detector must fire on a proof built to trip it, and stay silent on an honest one.
int SelfTest(const std::string& sOut)
{
	Scanner sc;
	sc.m_AllRounds = true;
	sc.m_sOut = sOut;
	sc.OpenBuckets();
	sc.m_Small.Init(1u << 16);

	struct Coin
	{
		ECC::Scalar::Native m_Sk;
		ECC::Point::Native m_CommN;
		ECC::Point m_Comm;
		ECC::RangeProof::Params::Create m_Cp;

		Coin(uint32_t n, Amount v)
		{
			ECC::Oracle o;
			o << "bpscan.selftest" << n;
			o >> m_Sk;
			o >> m_Cp.m_Seed.V;
			m_Cp.m_Value = v;
			m_CommN = ECC::Commitment(m_Sk, v);
			m_CommN.Export(m_Comm);
		}

		void Prove(ECC::RangeProof::Confidential& bp, uint32_t iVersion) const
		{
			ECC::Oracle o;
			o << m_Comm;
			bp.Create(m_Sk, m_Cp, iVersion, o);
		}

		bool IsValid(const ECC::RangeProof::Confidential& bp, uint32_t iVersion) const
		{
			ECC::Oracle o;
			o << m_Comm;
			return bp.IsValid(m_CommN, iVersion, o);
		}
	};

	int nFail = 0;
	auto report = [&](const char* szName, bool bOk, const std::string& sInfo) {
		std::cout << (bOk ? "ok    " : "FAIL  ") << szName << (sInfo.empty() ? "" : "  [") << sInfo << (sInfo.empty() ? "" : "]") << "\n";
		if (!bOk)
			nFail++;
	};

	uint64_t ref = 0;
	auto flags = [&](const ECC::RangeProof::Confidential& bp, const ECC::Point& comm) {
		sc.OnProof(bp, comm, ++ref);
		auto it = sc.m_Hits.find(ref);
		return (sc.m_Hits.end() == it) ? 0u : it->second.m_Flags;
	};
	auto expect = [&](const char* szName, const ECC::RangeProof::Confidential& bp, const ECC::Point& comm, uint32_t fExp) {
		uint32_t f = flags(bp, comm);
		report(szName, f == fExp, FlagsStr(f));
	};

	const uint32_t nLast = ECC::InnerProduct::nCycles - 1;
	Coin c1(1, 100500);
	ECC::RangeProof::Confidential bp0;
	c1.Prove(bp0, 0);

	// the two transcript versions do not accept each other's proofs
	report("honest v0 proof valid as v0", c1.IsValid(bp0, 0), "");
	report("honest v0 proof invalid as v1", !c1.IsValid(bp0, 1), "");
	{
		ECC::RangeProof::Confidential bp1;
		c1.Prove(bp1, 1);
		report("honest v1 proof valid as v1", c1.IsValid(bp1, 1), "");
		report("honest v1 proof invalid as v0", !c1.IsValid(bp1, 0), "");
		expect("honest v1 proof: no flags", bp1, c1.m_Comm, 0);
	}
	expect("honest v0 proof: no flags", bp0, c1.m_Comm, 0);

	{
		auto bp = bp0;
		bp.m_P_Tag.m_pLR[nLast][0].m_X = Zero;
		expect("zeropt: L_last = 0", bp, c1.m_Comm, F_ZEROPT);
	}
	{
		auto bp = bp0;
		memset(bp.m_Part1.m_S.m_X.m_pData, 0xff, ECC::nBytes);
		expect("badpt: S off the curve", bp, c1.m_Comm, F_BADPT);
	}
	{
		auto bp = bp0;
		ECC::Scalar::Native k;
		k = 7U;
		ECC::Point::Native pt = ECC::Context::get().G * k;
		pt.Export(bp.m_P_Tag.m_pLR[nLast][0]);
		expect("small: L_last = 7*G", bp, c1.m_Comm, F_SMALL);

		bp = bp0;
		pt = -pt;
		pt.Export(bp.m_P_Tag.m_pLR[2][1]);
		expect("small: R_2 = -7*G", bp, c1.m_Comm, F_SMALL);

		bp = bp0;
		pt = ECC::Context::get().H * Amount(65536);
		pt.Export(bp.m_Part2.m_T1);
		expect("small: T1 = 65536*H", bp, c1.m_Comm, F_SMALL);
	}
	{
		auto bp = bp0;
		bp.m_P_Tag.m_pLR[nLast][1] = bp.m_P_Tag.m_pLR[nLast][0];
		bp.m_P_Tag.m_pLR[nLast][1].m_Y ^= 1;
		expect("lr_eq: R_last = -L_last", bp, c1.m_Comm, F_LR_EQ);
	}
	{
		auto bp = bp0;
		bp.m_Part3.m_TauX.m_Value = 5U;
		expect("scalar: TauX = 5", bp, c1.m_Comm, F_SCALAR);

		bp = bp0;
		bp.m_P_Tag.m_pCondensed[1] = bp.m_P_Tag.m_pCondensed[0];
		expect("scalar: a = b", bp, c1.m_Comm, F_SCALAR);
	}

	// cross-proof pass
	Coin c2(2, 7), c3(3, 8), c4(4, 9), c5(5, 10), c6(6, 11);
	ECC::RangeProof::Confidential bp2, bp3, bp4, bp5, bp6a, bp6b;
	c2.Prove(bp2, 0);
	c3.Prove(bp3, 0);
	c4.Prove(bp4, 0);
	c5.Prove(bp5, 0);
	c6.Prove(bp6a, 0);
	c6.Prove(bp6b, 0); // the same coin proven twice, the way a wallet re-creates an output

	bp3.m_P_Tag.m_pLR[nLast][0] = bp2.m_P_Tag.m_pLR[nLast][0]; // one L_last under two commitments
	bp5.m_P_Tag.m_pLR[0][1] = bp4.m_P_Tag.m_pLR[0][1]; // one early-round R under two commitments (--all-rounds)

	uint64_t r2 = ref + 1, r3 = ref + 2, r4 = ref + 3, r5 = ref + 4, r6a = ref + 5, r6b = ref + 6;
	flags(bp2, c2.m_Comm);
	flags(bp3, c3.m_Comm);
	flags(bp4, c4.m_Comm);
	flags(bp5, c5.m_Comm);
	flags(bp6a, c6.m_Comm);
	flags(bp6b, c6.m_Comm);
	sc.DupPass();

	auto got = [&](uint64_t r) {
		auto it = sc.m_Hits.find(r);
		return (sc.m_Hits.end() == it) ? 0u : it->second.m_Flags;
	};
	report("dup: shared L_last, different commitments", (F_DUP == got(r2)) && (F_DUP == got(r3)), FlagsStr(got(r2)) + " " + FlagsStr(got(r3)));
	report("dup: shared early-round R, different commitments", (F_DUP == got(r4)) && (F_DUP == got(r5)), FlagsStr(got(r4)) + " " + FlagsStr(got(r5)));
	report("replay: one coin proven twice", (F_REPLAY == got(r6a)) && (F_REPLAY == got(r6b)), FlagsStr(got(r6a)) + " " + FlagsStr(got(r6b)));
	{
		auto it = sc.m_Replay.find(r6a);
		std::string s = (sc.m_Replay.end() == it) ? std::string() : FieldsStr(it->second.m_Fields);
		// a wallet derives A and S from the coin alone, the rest takes fresh randomness
		report("replay: an honest re-creation shares A and S only", s == "A|S", s);
	}

	std::cout << (nFail ? "SELFTEST FAILED" : "selftest passed") << "\n";
	return nFail ? 1 : 0;
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

	if (!strcmp(argv[1], "--selftest"))
	{
		ECC::InitializeContext();
		return SelfTest(argv[2]);
	}

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

	// same-commitment replays, one row per commitment
	struct ReplayGroup
	{
		uint64_t m_Proofs = 0;
		uint32_t m_Fields = 0;
		uint64_t m_RefMin = static_cast<uint64_t>(-1);
		uint64_t m_RefMax = 0;
	};
	std::map<uint64_t, ReplayGroup> mapReplay; // by commitment key
	std::map<uint32_t, uint64_t> mapReplayFields; // fields shared -> proofs
	for (const auto& [ref, rr] : sc.m_Replay)
	{
		ReplayGroup& g = mapReplay[rr.m_Comm];
		g.m_Proofs++;
		g.m_Fields |= rr.m_Fields;
		g.m_RefMin = std::min(g.m_RefMin, ref);
		g.m_RefMax = std::max(g.m_RefMax, ref);
		mapReplayFields[rr.m_Fields]++;
	}
	{
		std::ofstream rep(sOut + "/replay.csv");
		rep << "kind,commitment,proofs,shared_fields,first_height,last_height\n";
		for (const auto& [ck, g] : mapReplay)
		{
			bool bShielded = !!(g.m_RefMin & kShieldedBit);
			ECC::Point comm;
			Height h0, h1;
			if (bShielded)
			{
				comm = sc.m_vShielded[g.m_RefMin & ~kShieldedBit].m_Comm;
				h0 = sc.m_vShielded[g.m_RefMin & ~kShieldedBit].m_Height;
				h1 = sc.m_vShielded[g.m_RefMax & ~kShieldedBit].m_Height;
			}
			else
			{
				Output outp;
				Height hSpend;
				if (ReadTxo(pDb, g.m_RefMin, outp, hSpend))
					comm = outp.m_Commitment;
				else
					ZeroObject(comm);
				h0 = sc.TxoHeight(g.m_RefMin);
				h1 = sc.TxoHeight(g.m_RefMax);
			}
			rep << (bShielded ? "shielded" : "mw") << "," << Hex(comm) << "," << g.m_Proofs << "," << FieldsStr(g.m_Fields) << "," << h0 << "," << h1 << "\n";
		}
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
		<< ",\n  \"replay_commitments\": " << mapReplay.size()
		<< ",\n  \"replay_by_shared_fields\": {";
	{
		bool bFirst = true;
		for (const auto& [m, n] : mapReplayFields)
		{
			os << (bFirst ? "" : ", ") << "\"" << FieldsStr(m) << "\": " << n;
			bFirst = false;
		}
	}
	os << "}"
		<< ",\n  \"periods\": {\n";
	PrintStat("pre_hf6", sc.m_pStat[0], os, false);
	PrintStat("post_hf6", sc.m_pStat[1], os, true);
	os << "  }\n}\n";

	std::ofstream(sOut + "/summary.json") << os.str();
	std::cout << os.str();
	return 0;
}
