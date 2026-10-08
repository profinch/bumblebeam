// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// coinbase_test: the non-custodial coinbase end to end, in one process, on a FakePoW chain with every
// fork active (fees go into the coinbase, as on mainnet since HF6).
//
//   pool node ──finalization── finalizer (pool wallet + three miners' pair stocks)
//       │
//   miner's node (stock settings: validates every block, serves the miner's wallet) ── miner's wallet
//
// The pool node mines with --mine_online_foreign. The finalizer pays three miners in the coinbase with
// their own pairs, the pool's fee and the remainder go to the pool's output. Checked on the way:
//   - the miner's own node accepts every block (consensus, without the patch's option),
//   - the miner's wallet finds its coinbase outputs through ordinary UTXO events, and spends one,
//   - the pool's key recognizes none of the miners' outputs,
//   - a pair whose kernel is already in the chain makes the node drop the finalizer and mine on its own,
//   - without --mine_online_foreign the stock node refuses the miners' outputs, and mines on its own.

#include "coinbase.h"

#include "core/serialization_adapters.h"
#include "core/treasury.h"
#include "node/node.h"
#include "utility/io/timer.h"
#include "utility/logger.h"

#include <chrono>
#include <cstdio>
#include <functional>
#include <set>
#include <sstream>
#include <stdexcept>

using namespace beam;
using namespace bb::coinbase;

// Each executable that links the Beam core defines this (see explorer/explorer_node.cpp).
thread_local const beam::Rules* beam::Rules::s_pInstance = nullptr;

namespace {

int g_Failed = 0;

#define CHECK(x) \
	do { if (!(x)) { printf("FAILED %s:%d: %s\n", __FILE__, __LINE__, #x); g_Failed++; } } while (0)

// For setup steps the test can't go on without
#define VERIFY(x) \
	do { if (!(x)) throw std::runtime_error(std::string("setup failed: ") + #x); } while (0)

const uint16_t g_PortPool = 25213;
const uint16_t g_PortMiner = 25214;
const Amount g_TxFee = 10'900'000;

Key::IKdf::Ptr NewKdf()
{
	ECC::NoLeak<ECC::uintBig> seed;
	ECC::GenRandom(seed.V);
	Key::IKdf::Ptr p;
	ECC::HKdf::Create(p, seed.V);
	return p;
}

// What `beam-wallet export_miner_key --subkey=N` exports
Key::IKdf::Ptr ChildKdf(Key::IKdf& master, Key::Index iSubkey)
{
	return MasterKey::get_Child(master, iSubkey);
}

io::Address Local(uint16_t port)
{
	io::Address a;
	a.resolve("127.0.0.1");
	a.port(port);
	return a;
}

struct Miner
{
	std::string m_Name;
	Key::IKdf::Ptr m_pMaster;     // the wallet's seed
	Key::Index m_SubIdx;
	Key::IKdf::Ptr m_pMinerKey;   // export_miner_key --subkey=m_SubIdx
	double m_Weight;              // its share of the PPLNS window
	uint64_t m_NextIdx = 1;
};

ByteBuffer BuildTreasury(Rules& r, Key::IKdf& kdf)
{
	PeerID pid;
	ECC::Scalar::Native sk;
	Treasury::get_ID(kdf, pid, sk);

	Treasury tres;
	Treasury::Parameters pars;
	pars.m_Bursts = 1;
	pars.m_MaturityStep = 4;
	Treasury::Entry* pE = tres.CreatePlan(pid, r.Emission.Value0 / 5, pars);

	pE->m_pResponse.reset(new Treasury::Response);
	uint64_t nIndex = 1;
	VERIFY(pE->m_pResponse->Create(pE->m_Request, kdf, nIndex));

	Treasury::Data data;
	data.m_sCustomMsg = "coinbase test";
	tres.Build(data);

	Serializer ser;
	ser & data;
	ByteBuffer buf;
	ser.swap_buf(buf);
	ECC::Hash::Processor() << Blob(buf) >> r.TreasuryChecksum;
	return buf;
}

// The pool's side of the node: answers GetBlockFinalization with the coinbase, and follows the chain
// to know which pairs are spent.
struct Finalizer
	:public proto::NodeConnection
{
	Key::IKdf::Ptr m_pPool;       // the pool wallet's seed
	Key::IKdf::Ptr m_pPoolCoin;   // its miner key, subkey 0
	std::vector<Miner>* m_pMiners = nullptr;
	Ladder m_Ladder;
	Allocator m_Alloc;
	double m_Fee = 0.005;

	Height m_hScanned = 0;        // kernels of blocks up to here are known
	bool m_BodiesPending = false;
	Block::SystemState::Full m_Tip;
	std::unique_ptr<proto::GetBlockFinalization> m_pPending;

	std::map<Merkle::Hash, std::pair<std::string, Amount>> m_PairByKernel;
	std::map<std::string, Amount> m_PaidOnChain;
	std::map<std::string, uint32_t> m_PairsOnChain;
	std::set<Height> m_HeightsWithPairs;

	NodeProcessor* m_pDbg = nullptr; // diagnostics only: the pool node's chain
	uint32_t m_Answered = 0;
	uint32_t m_Disconnects = 0;
	size_t m_MaxPairs = 0;
	io::Timer::Ptr m_pTimer;

	void Start()
	{
		Connect(Local(g_PortPool));
	}

	void OnConnectedSecure() override
	{
		SendLogin();
	}

	void SetupLogin(proto::Login& msg) override
	{
		msg.m_Flags |= proto::LoginFlags::MiningFinalization;
	}

	void OnMsg(proto::Authentication&& msg) override
	{
		proto::NodeConnection::OnMsg(std::move(msg));
		if (proto::IDType::Node == msg.m_IDType)
			ProveKdfObscured(*m_pPool, proto::IDType::Owner); // the node finalizes with its owner only
	}

	void OnDisconnect(const DisconnectReason& dr) override
	{
		m_Disconnects++;
		std::ostringstream os;
		os << dr;
		printf("  finalizer: dropped by the node (%s), reconnecting\n", os.str().c_str());

		Reset();
		m_pPending.reset();
		m_BodiesPending = false;

		if (!m_pTimer)
			m_pTimer = io::Timer::create(io::Reactor::get_Current());
		m_pTimer->start(100, false, [this]() { Start(); });
	}

	void OnMsg(proto::NewTip&& msg) override
	{
		m_Tip = msg.m_Description;
		AskBodies();
	}

	void AskBodies()
	{
		Height h = m_Tip.get_Height();
		if (m_BodiesPending || (h <= m_hScanned))
			return;

		proto::GetBodyPack msg;
		m_Tip.get_ID(msg.m_Top);
		msg.m_FlagP = proto::BodyBuffers::None;
		msg.m_FlagE = proto::BodyBuffers::Full;
		msg.m_CountExtra.v = h - m_hScanned - 1;
		Send(msg);
		m_BodiesPending = true;
	}

	void OnMsg(proto::Body&& msg) override
	{
		std::vector<proto::BodyBuffers> v;
		v.push_back(std::move(msg.m_Body));
		OnBodies(v);
	}

	void OnMsg(proto::BodyPack&& msg) override
	{
		OnBodies(msg.m_Bodies);
	}

	void OnBodies(const std::vector<proto::BodyBuffers>& v)
	{
		m_BodiesPending = false;
		Height h = m_hScanned + 1; // the pack starts right after what we know
		for (const auto& b : v)
		{
			TxVectors::Eternal e;
			Deserializer der;
			der.reset(b.m_Eternal);
			der & e;

			for (const auto& pKrn : e.m_vKernels)
			{
				auto it = m_PairByKernel.find(pKrn->get_ID());
				if (m_PairByKernel.end() == it)
					continue;
				m_PaidOnChain[it->second.first] += it->second.second;
				m_PairsOnChain[it->second.first]++;
				m_HeightsWithPairs.insert(h);
				MarkUsed(pKrn->get_ID());
			}

			m_hScanned = h++;
		}

		Replenish();
		AskBodies();

		if (m_pPending && (m_pPending->m_Height <= m_hScanned + 1))
		{
			auto pMsg = std::move(m_pPending);
			Answer(*pMsg);
		}
	}

	void MarkUsed(const Merkle::Hash& id)
	{
		for (auto& [name, s] : m_Alloc.m_Stock)
			for (size_t i = 0; i < s.m_vPairs.size(); i++)
				if (s.m_vPairs[i].get_KernelID() == id)
					s.m_vUsed[i] = true;
	}

	// Each miner keeps two unused pairs of every step (the miner's tool tops up the stock after blocks).
	void Replenish()
	{
		for (auto& m : *m_pMiners)
		{
			auto& s = m_Alloc.m_Stock[m.m_Name];
			for (uint32_t i = 0; i < m_Ladder.m_Steps; i++)
			{
				Amount v = m_Ladder.get_Step(i);
				uint32_t n = 0;
				for (size_t j = 0; j < s.m_vPairs.size(); j++)
					if (!s.m_vUsed[j] && (s.m_vPairs[j].get_Value() == v))
						n++;

				for (; n < 2; n++)
					AddPair(m, MakePair(*m.m_pMinerKey, m.m_SubIdx, *m.m_pMaster, v, m.m_NextIdx++, m_Tip.get_Height() + 1));
			}
		}
	}

	void AddPair(Miner& m, Pair&& p)
	{
		std::string sErr;
		VERIFY(VerifyPair(p, m_Tip.get_Height() + 1, sErr));
		m_PairByKernel[p.get_KernelID()] = { m.m_Name, p.get_Value() };

		auto& s = m_Alloc.m_Stock[m.m_Name];
		s.m_vPairs.push_back(std::move(p));
		s.m_vUsed.push_back(false);
	}

	void OnMsg(proto::GetBlockFinalization&& msg) override
	{
		if (msg.m_Height > m_hScanned + 1)
		{
			// Don't pay with pairs that the previous block may have spent: wait for its kernels.
			m_pPending = std::make_unique<proto::GetBlockFinalization>(std::move(msg));
			AskBodies();
			return;
		}

		Answer(msg);
	}

	void Answer(const proto::GetBlockFinalization& msg)
	{
		const Rules& r = Rules::get();
		VERIFY(r.IsPastFork_<6>(msg.m_Height)); // fees go into the coinbase

		Amount total = r.get_Emission(msg.m_Height) + msg.m_Fees;

		std::map<std::string, Amount> owed;
		for (const auto& m : *m_pMiners)
			owed[m.m_Name] = static_cast<Amount>(static_cast<double>(total) * m.m_Weight * (1. - m_Fee));

		Coinbase cb = m_Alloc.Allocate(owed, total);
		Transaction::Ptr pTx = BuildCoinbaseTx(m_Alloc, cb, *m_pPoolCoin, 0, *m_pPool, msg.m_Height);
		m_MaxPairs = std::max(m_MaxPairs, pTx->m_vOutputs.size() - (cb.m_PoolValue ? 1 : 0));

		if (m_pDbg)
		{
			uint32_t nInChain = 0;
			for (const auto& pKrn : pTx->m_vKernels)
				if (m_pDbg->get_DB().FindKernel(pKrn->get_ID()))
					nInChain++;
			printf("  dbg: h=%llu fees=%llu scanned=%llu outputs=%zu kernels in chain=%u\n", (unsigned long long) msg.m_Height,
				(unsigned long long) msg.m_Fees, (unsigned long long) m_hScanned, pTx->m_vOutputs.size(), nInChain);
		}

		proto::BlockFinalization out;
		out.m_Value = std::move(pTx);
		Send(out);
		m_Answered++;
	}
};

// The miner's wallet, on the miner's own node: finds its coins through UTXO events and spends one.
struct MinerWallet
	:public proto::NodeConnection
{
	Miner* m_pMiner = nullptr;
	Block::SystemState::Full m_Tip;
	Height m_hEvts = 1;
	bool m_EvtsPending = false;

	struct Coin
	{
		CoinID m_Cid;
		Height m_Maturity;
		bool m_Spent = false;
	};
	std::map<ECC::Point, Coin> m_Coins;

	Merkle::Hash m_SpendKernel = Zero;
	bool m_SpendAccepted = false;

	void OnConnectedSecure() override
	{
		SendLogin();
	}

	void OnMsg(proto::Authentication&& msg) override
	{
		proto::NodeConnection::OnMsg(std::move(msg));
		if (proto::IDType::Node == msg.m_IDType)
			ProveKdfObscured(*m_pMiner->m_pMaster, proto::IDType::Owner);
	}

	void OnDisconnect(const DisconnectReason& dr) override
	{
		std::ostringstream os;
		os << dr;
		printf("FAILED: the wallet was disconnected: %s\n", os.str().c_str());
		g_Failed++;
		io::Reactor::get_Current().stop();
	}

	void OnMsg(proto::NewTip&& msg) override
	{
		m_Tip = msg.m_Description;
		AskEvents();
	}

	void AskEvents()
	{
		if (m_EvtsPending || (m_hEvts > m_Tip.get_Height()))
			return;

		proto::GetEvents msg;
		msg.m_HeightMin = m_hEvts;
		Send(msg);
		m_EvtsPending = true;
	}

	void OnMsg(proto::Events&& msg) override
	{
		m_EvtsPending = false;

		struct Parser :public proto::Event::IGroupParser
		{
			MinerWallet& m_This;
			Parser(MinerWallet& x) :m_This(x) {}

			void OnEventType(proto::Event::Utxo& evt) override
			{
				// The wallet derives the coin's key from its seed, as it would to spend it.
				ECC::Scalar::Native sk;
				ECC::Point comm;
				CoinID::Worker(evt.m_Cid).Create(sk, comm, *m_This.get_CoinKdf(evt.m_Cid));
				CHECK(comm == evt.m_Commitment);

				if (proto::Event::Flags::Add & evt.m_Flags)
					m_This.m_Coins[evt.m_Commitment] = { evt.m_Cid, evt.m_Maturity };
				else
					m_This.m_Coins[evt.m_Commitment].m_Spent = true;
			}
		} p(*this);

		uint32_t nCount = p.Proceed(msg.m_Events);
		m_hEvts = 1 + ((nCount < proto::Event::s_Max) ? m_Tip.get_Height() : p.m_Height);
		AskEvents();
	}

	Key::IKdf::Ptr get_CoinKdf(const CoinID& cid)
	{
		Key::Index iChild;
		if (cid.get_ChildKdfIndex(iChild))
			return ChildKdf(*m_pMiner->m_pMaster, iChild);
		return m_pMiner->m_pMaster;
	}

	const Coin* FindMatureCoinbase() const
	{
		for (const auto& [comm, c] : m_Coins)
			if (!c.m_Spent && (Key::Type::Coinbase == c.m_Cid.m_Type) && (c.m_Maturity <= m_Tip.get_Height()) &&
				(c.m_Cid.m_Value > g_TxFee))
				return &c;
		return nullptr;
	}

	// A plain transaction: the coinbase in, a regular output of the same wallet out, minus the fee.
	bool Spend()
	{
		const Coin* pCoin = FindMatureCoinbase();
		if (!pCoin)
			return false;

		Height h = m_Tip.get_Height();
		auto pTx = std::make_shared<Transaction>();
		ECC::Scalar::Native offset = Zero, sk;

		auto pInp = std::make_unique<Input>();
		CoinID::Worker(pCoin->m_Cid).Create(sk, pInp->m_Commitment, *get_CoinKdf(pCoin->m_Cid));
		pTx->m_vInputs.push_back(std::move(pInp));
		offset += sk;

		CoinID cidOut(pCoin->m_Cid.m_Value - g_TxFee, m_pMiner->m_NextIdx++, Key::Type::Regular, 0);
		auto pOut = std::make_unique<Output>();
		pOut->Create(h + 1, sk, *get_CoinKdf(cidOut), cidOut, *m_pMiner->m_pMaster);
		pTx->m_vOutputs.push_back(std::move(pOut));
		offset += -sk;

		auto pKrn = std::make_unique<TxKernelStd>();
		pKrn->m_Fee = g_TxFee;
		pKrn->m_Height.m_Min = h + 1;
		pKrn->m_Height.m_Max = h + 30;
		sk.GenRandomNnz();
		pKrn->Sign(sk);
		m_SpendKernel = pKrn->get_ID();
		pTx->m_vKernels.push_back(std::move(pKrn));
		offset += -sk;

		pTx->m_Offset = offset;
		pTx->Normalize();

		proto::NewTransaction msg;
		msg.m_Transaction = std::move(pTx);
		msg.m_Fluff = true;
		Send(msg);

		printf("  wallet %s: spends its coinbase of %.8f BEAM at height %llu\n", m_pMiner->m_Name.c_str(),
			double(pCoin->m_Cid.m_Value) / Rules::Coin, (unsigned long long) h);
		return true;
	}

	void OnMsg(proto::Status&& msg) override
	{
		m_SpendAccepted = (proto::TxStatus::Ok == msg.m_Value);
		if (!m_SpendAccepted)
			printf("  wallet: transaction refused: %u %s\n", msg.m_Value, msg.m_ExtraInfo.c_str());
	}
};

void TestPairs()
{
	printf("Pairs...\n");

	auto pMaster = NewKdf();
	auto pMinerKey = ChildKdf(*pMaster, 7);
	Height h = 10;

	Pair p = MakePair(*pMinerKey, 7, *pMaster, Rules::Coin * 3, 1, h);
	std::string sErr;
	CHECK(VerifyPair(p, h, sErr));
	printf("  one pair: %zu bytes (output %zu, kernel %zu)\n", p.get_Size(),
		[&p]() { SerializerSizeCounter c; c & p.m_Output; return (size_t) c.m_Counter.m_Value; }(),
		[&p]() { SerializerSizeCounter c; c & p.m_pKernel; return (size_t) c.m_Counter.m_Value; }());

	Pair q;
	CHECK(q.FromHex(p.ToHex()));
	CHECK(VerifyPair(q, h, sErr));
	CHECK(q.get_KernelID() == p.get_KernelID());
	CHECK(!q.FromHex(p.ToHex() + "00"));
	CHECK(!q.FromHex("zz"));

	// The miner's wallet recognizes the output and derives the same key from its seed. The pool's doesn't.
	CoinID cid;
	CHECK(p.m_Output.Recover(h, *pMaster, cid));
	CHECK((cid.m_Value == Rules::Coin * 3) && (Key::Type::Coinbase == cid.m_Type) && (cid.get_Subkey() == 7));
	CHECK(p.m_Output.VerifyRecovered(*ChildKdf(*pMaster, 7), cid));
	CHECK(!p.m_Output.Recover(h, *NewKdf(), cid));

	// A changed value breaks the output's signature.
	CHECK(q.FromHex(p.ToHex()));
	q.m_Output.m_pPublic->m_Value++;
	CHECK(!VerifyPair(q, h, sErr));

	// Another pair's kernel doesn't balance this output.
	Pair p2 = MakePair(*pMinerKey, 7, *pMaster, Rules::Coin * 3, 2, h);
	CHECK(q.FromHex(p.ToHex()));
	p2.m_pKernel->Clone(q.m_pKernel);
	CHECK(!VerifyPair(q, h, sErr) && (sErr == "the kernel does not balance the output"));

	// A kernel with a fee would take value from the block.
	CHECK(q.FromHex(p.ToHex()));
	Cast::Up<TxKernelStd>(*q.m_pKernel).m_Fee = 1;
	CHECK(!VerifyPair(q, h, sErr));

	// Not a coinbase: it would not count towards the block reward.
	Output o;
	ECC::Scalar::Native sk;
	o.Create(h, sk, *pMinerKey, CoinID(Rules::Coin, 3, Key::Type::Regular, 7), *pMaster, Output::OpCode::Public);
	CHECK(q.FromHex(p.ToHex()));
	q.m_Output = std::move(o);
	CHECK(!VerifyPair(q, h, sErr));

	Ladder l;
	CHECK(l.IsStep(l.get_Unit()) && l.IsStep(l.get_Step(l.m_Steps - 1)) && !l.IsStep(l.get_Unit() * 3));
	Amount a = Rules::Coin * 24 + 87'500'000;
	Amount sum = 0;
	for (Amount v : l.Split(a))
		sum += v;
	CHECK((sum <= a) && (a - sum < l.get_Unit()));
	printf("  24.875 BEAM is %zu pairs, %llu groth short\n", l.Split(a).size(), (unsigned long long) (a - sum));
}

void TestChain()
{
	printf("Chain...\n");

	io::Reactor::Ptr pReactor(io::Reactor::create());
	io::Reactor::Scope scope(*pReactor);

	auto pTreasuryKdf = NewKdf();
	ByteBuffer treasury = BuildTreasury(Cast::NotConst(Rules::get()), *pTreasuryKdf);
	Cast::NotConst(Rules::get()).UpdateChecksum();

	std::vector<Miner> vMiners;
	for (auto [name, w] : { std::pair<const char*, double>{ "m1", 0.5 }, { "m2", 0.3 }, { "m3", 0.2 } })
	{
		Miner m;
		m.m_Name = name;
		m.m_pMaster = NewKdf();
		m.m_SubIdx = 3;
		m.m_pMinerKey = ChildKdf(*m.m_pMaster, m.m_SubIdx);
		m.m_Weight = w;
		vMiners.push_back(std::move(m));
	}

	auto pPool = NewKdf();

	// The pool's node: mines, gets its coinbase from the finalizer.
	Node nodePool;
	nodePool.m_Cfg.m_sPathLocal = "coinbase_test_pool.db";
	nodePool.m_Cfg.m_Listen.port(g_PortPool);
	nodePool.m_Cfg.m_Listen.ip(INADDR_ANY);
	nodePool.m_Cfg.m_Treasury = treasury;
	nodePool.m_Cfg.m_MiningThreads = 1;
	nodePool.m_Cfg.m_TestMode.m_FakePowSolveTime_ms = 150;
	nodePool.m_Cfg.m_MiningFinalization.m_ForeignOutputs = true;
	nodePool.m_Cfg.m_MiningFinalization.m_Reserve = 64 * 1024;
	nodePool.m_Keys.SetSingleKey(pPool);

	// The miner's node, with stock settings: it validates every block the pool mines.
	Node nodeMiner;
	nodeMiner.m_Cfg.m_sPathLocal = "coinbase_test_miner.db";
	nodeMiner.m_Cfg.m_Listen.port(g_PortMiner);
	nodeMiner.m_Cfg.m_Listen.ip(INADDR_ANY);
	nodeMiner.m_Cfg.m_Treasury = treasury;
	nodeMiner.m_Cfg.m_Connect.push_back(Local(g_PortPool));
	nodeMiner.m_Keys.SetSingleKey(vMiners[0].m_pMaster); // m1's wallet seed: the node finds its coins

	DeleteFile(nodePool.m_Cfg.m_sPathLocal.c_str());
	DeleteFile(nodeMiner.m_Cfg.m_sPathLocal.c_str());

	nodePool.Initialize();
	nodeMiner.Initialize();

	Finalizer fin;
	fin.m_pPool = pPool;
	fin.m_pPoolCoin = ChildKdf(*pPool, 0);
	fin.m_pMiners = &vMiners;
	if (getenv("CB_DEBUG"))
		fin.m_pDbg = &nodePool.get_Processor();
	fin.m_Ladder.m_Steps = 14; // the test chain pays 80 BEAM a block
	fin.Replenish();
	fin.Start();

	MinerWallet wallet;
	wallet.m_pMiner = &vMiners[0];
	wallet.Connect(Local(g_PortMiner));

	enum struct Phase { Pairs, StalePair, Spend, NoForeign, Done } phase = Phase::Pairs;
	Height hPhase = 0;
	uint32_t nDisconnects0 = 0;
	std::set<Height> setFallback;
	Merkle::Hash hvStale = Zero;
	uint32_t nStaleDrops = 0;
	Height hNoForeign = 0;
	bool bSpent = false;
	Height hSpendMined = 0;

	auto pTimer = io::Timer::create(*pReactor);
	auto t0 = std::chrono::steady_clock::now();

	std::function<void()> fnTick;
	fnTick = [&]() {
		Height h = nodePool.get_Processor().m_Cursor.m_hh.m_Height;
		Height hMiner = nodeMiner.get_Processor().m_Cursor.m_hh.m_Height;

		if (std::chrono::steady_clock::now() - t0 > std::chrono::seconds(180))
		{
			printf("FAILED: timeout in phase %d at height %llu\n", (int) phase, (unsigned long long) h);
			g_Failed++;
			pReactor->stop();
			return;
		}

		switch (phase)
		{
		case Phase::Pairs:
			if (h >= 8)
			{
				// m3 gives the pool a pair that is already in the chain (say it was mined elsewhere).
				auto& s = fin.m_Alloc.m_Stock["m3"];
				for (size_t i = 0; i < s.m_vPairs.size(); i++)
					if (s.m_vUsed[i])
					{
						Pair p;
						VERIFY(p.FromHex(s.m_vPairs[i].ToHex()));
						hvStale = p.get_KernelID();
						for (size_t j = 0; j < s.m_vPairs.size(); j++)
							s.m_vUsed[j] = true;
						s.m_vPairs.push_back(std::move(p));
						s.m_vUsed.push_back(false);
						break;
					}

				nDisconnects0 = fin.m_Disconnects;
				hPhase = h;
				phase = Phase::StalePair;
				printf("  height %llu: m3's stock now holds only a pair already in the chain\n", (unsigned long long) h);
			}
			break;

		case Phase::StalePair:
			if (fin.m_Disconnects > nDisconnects0)
			{
				// The pool's intake check would have refused that pair. Back to a fresh stock.
				auto& s = fin.m_Alloc.m_Stock["m3"];
				for (size_t i = 0; i < s.m_vPairs.size(); i++)
					if (s.m_vPairs[i].get_KernelID() == hvStale)
						s.m_vUsed[i] = true;
				fin.Replenish();
				nStaleDrops = fin.m_Disconnects - nDisconnects0;
				phase = Phase::Spend;
				hPhase = h;
			}
			break;

		case Phase::Spend:
			if (!bSpent && (hMiner == h))
				bSpent = wallet.Spend();

			if (bSpent && !hSpendMined)
			{
				hSpendMined = nodeMiner.get_Processor().get_DB().FindKernel(wallet.m_SpendKernel);
				if (hSpendMined)
					printf("  height %llu: the wallet's transaction is mined\n", (unsigned long long) hSpendMined);
			}

			if (hSpendMined && (h >= hSpendMined + 2))
			{
				nodePool.m_Cfg.m_MiningFinalization.m_ForeignOutputs = false;
				nDisconnects0 = fin.m_Disconnects;
				phase = Phase::NoForeign;
				hPhase = hNoForeign = h;
				printf("  height %llu: the pool's node drops --mine_online_foreign\n", (unsigned long long) h);
			}
			break;

		case Phase::NoForeign:
			if ((fin.m_Disconnects > nDisconnects0) && (h >= hPhase + 3) && (hMiner == h))
			{
				phase = Phase::Done;
				pReactor->stop();
				return;
			}
			break;

		default:
			break;
		}

		pTimer->start(50, false, [&fnTick]() { fnTick(); });
	};

	pTimer->start(50, false, [&fnTick]() { fnTick(); });
	pReactor->run();

	Height hTip = nodePool.get_Processor().m_Cursor.m_hh.m_Height;
	printf("  pool node at %llu, miner's node at %llu, finalizations %u, finalizer dropped %u times\n",
		(unsigned long long) hTip, (unsigned long long) nodeMiner.get_Processor().m_Cursor.m_hh.m_Height,
		fin.m_Answered, fin.m_Disconnects);

	CHECK(Phase::Done == phase);
	CHECK(nodeMiner.get_Processor().m_Cursor.m_hh.m_Hash == nodePool.get_Processor().m_Cursor.m_hh.m_Hash);
	CHECK(1 == nStaleDrops);
	CHECK(fin.m_Disconnects > nDisconnects0); // the stock node refused the miners' outputs
	CHECK(wallet.m_SpendAccepted && hSpendMined);

	// Every coinbase output in the chain, as the miner's node has it: whose is it?
	struct Walker :public NodeProcessor::ITxoWalker
	{
		std::vector<Miner>* m_pMiners;
		Key::IKdf::Ptr m_pPool;
		std::map<std::string, Amount> m_Value;
		std::map<std::string, uint32_t> m_Count;
		std::map<Height, std::set<std::string>> m_Owners; // per block
		uint32_t m_Unknown = 0;
		uint32_t m_Twice = 0;

		bool OnTxo(const NodeDB::WalkerTxo& wlk, Height hCreate) override
		{
			return ITxoWalker::OnTxo(wlk, hCreate);
		}

		bool OnTxo(const NodeDB::WalkerTxo&, Height hCreate, Output& outp) override
		{
			if (!outp.m_Coinbase || !hCreate)
				return true;

			std::vector<std::string> v;
			CoinID cid;
			for (const auto& m : *m_pMiners)
				if (outp.Recover(hCreate, *m.m_pMaster, cid))
					v.push_back(m.m_Name);
			if (outp.Recover(hCreate, *m_pPool, cid))
				v.push_back("pool");

			if (v.empty())
				m_Unknown++;
			else
			{
				if (v.size() > 1)
					m_Twice++;
				m_Value[v[0]] += cid.m_Value;
				m_Count[v[0]]++;
				m_Owners[hCreate].insert(v[0]);
			}
			return true;
		}
	} wlk;
	wlk.m_pMiners = &vMiners;
	wlk.m_pPool = pPool;
	nodeMiner.get_Processor().EnumTxos(wlk);

	CHECK(!wlk.m_Unknown && !wlk.m_Twice);

	uint32_t nPoolOnly = 0;
	for (const auto& [h, owners] : wlk.m_Owners)
	{
		bool bPoolOnly = (1 == owners.size()) && owners.count("pool");
		if (bPoolOnly)
			nPoolOnly++;
		// The block after the switch may come from a template finalized before it.
		if (h >= hNoForeign + 2)
			CHECK(bPoolOnly);
	}

	printf("  blocks with miners' pairs: %zu, with the pool's coinbase only: %u (of %llu)\n",
		fin.m_HeightsWithPairs.size(), nPoolOnly, (unsigned long long) hTip);
	printf("  most pairs in one coinbase: %zu\n", fin.m_MaxPairs);

	for (const auto& m : vMiners)
	{
		printf("  %s: %u outputs, %.8f BEAM in the chain\n", m.m_Name.c_str(), wlk.m_Count[m.m_Name],
			double(wlk.m_Value[m.m_Name]) / Rules::Coin);
		CHECK(wlk.m_Value[m.m_Name] == fin.m_PaidOnChain[m.m_Name]);
		CHECK(wlk.m_Count[m.m_Name] == fin.m_PairsOnChain[m.m_Name]);
		CHECK(wlk.m_Count[m.m_Name] > 0);
	}
	printf("  pool: %u outputs, %.8f BEAM\n", wlk.m_Count["pool"], double(wlk.m_Value["pool"]) / Rules::Coin);

	CHECK(fin.m_HeightsWithPairs.size() + nPoolOnly == hTip); // every block paid the miners, or the node mined on its own
	CHECK(fin.m_HeightsWithPairs.size() >= 10);

	// The wallet found every m1 output through the node's events.
	uint32_t nWalletCoinbase = 0;
	Amount valWallet = 0;
	for (const auto& [comm, c] : wallet.m_Coins)
		if (Key::Type::Coinbase == c.m_Cid.m_Type)
		{
			nWalletCoinbase++;
			valWallet += c.m_Cid.m_Value;
		}
	printf("  m1's wallet: %u coinbase coins, %.8f BEAM, one spent\n", nWalletCoinbase, double(valWallet) / Rules::Coin);
	CHECK(nWalletCoinbase == wlk.m_Count["m1"]);
	CHECK(valWallet == wlk.m_Value["m1"]);
}

} // namespace

int main()
{
	auto logger = Logger::create(BEAM_LOG_LEVEL_WARNING, BEAM_LOG_LEVEL_WARNING);

	Rules r;
	Rules::Scope scopeRules(r);
	r.m_Consensus = Rules::Consensus::FakePoW;
	r.Maturity.Coinbase = 3;
	r.MaxRollback = 10;
	r.SetForksFrom(1, 1);
	r.UpdateChecksum();

	ECC::PseudoRandomGenerator prg;
	ECC::PseudoRandomGenerator::Scope scopePrg(&prg);

	try
	{
		TestPairs();
		TestChain();
	}
	catch (const std::exception& e)
	{
		printf("FAILED: %s\n", e.what());
		g_Failed++;
	}

	printf(g_Failed ? "%d check(s) failed\n" : "all checks passed\n", g_Failed);
	return g_Failed ? 1 : 0;
}
