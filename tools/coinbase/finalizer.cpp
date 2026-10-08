// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// bb-finalizer: the pool's block finalizer. Logs in to the pool's own node as the owner of its mining
// wallet and answers every block template with a coinbase: the pairs the pool server chose for its miners,
// plus one output of the mining wallet for the rest. Follows the chain and tells the pool server which
// blocks and kernels are in it, so the server knows which pairs were paid and which of its blocks stand.
//
// Keys: the mining wallet's seed phrase (a wallet of its own, holding only the pool's share; the node runs
// with its owner key). The miners' keys are never here: a pair is made and signed by its miner.
//
//   bb-finalizer --node 127.0.0.1:10000 --pool 127.0.0.1:3480 --seed_file /etc/bumblebeam/mining-wallet.seed
//
// Node rules (--network, --consensus, --Fork1 ...) are taken like beam-node takes them, so the finalizer can
// run against a test chain.

#include "coinbase.h"

#include "core/fly_client.h"
#include "core/proto.h"
#include "core/serialization_adapters.h"
#include "nlohmann/json.hpp"
#include "utility/cli/options.h"
#include "utility/hex.h"
#include "utility/io/tcpstream.h"
#include "utility/io/timer.h"
#include "utility/logger.h"

#include <chrono>
#include <deque>
#include <fstream>
#include <functional>
#include <map>
#include <sstream>

using namespace beam;
using namespace bb::coinbase;
using json = nlohmann::json;

thread_local const beam::Rules* beam::Rules::s_pInstance = nullptr;

namespace {

const char* g_Version = "bb-finalizer 0.1";

std::string HashHex(const Merkle::Hash& hv)
{
	return to_hex(hv.m_pData, hv.nBytes);
}

std::string PointHex(const ECC::Point& pt)
{
	Serializer ser;
	ser & pt;
	auto [p, n] = ser.buffer();
	return to_hex(p, n);
}

// Line-delimited JSON over TCP to the pool server. Requests both ways carry an "id"; notifications don't.
// Notifications that can't be sent are queued and sent after a reconnect (bounded), because the pool
// server must not miss a block that paid pairs.
struct PoolLink
{
	io::Reactor& m_Reactor;
	io::Address m_Addr;
	io::TcpStream::Ptr m_pStream;
	std::string m_Buf;
	uint64_t m_NextId = 1;
	bool m_Connecting = false;
	std::chrono::steady_clock::time_point m_NextConnect = std::chrono::steady_clock::now();

	struct Req
	{
		std::function<void(const json*)> m_Cb; // null = timeout or disconnect
		std::chrono::steady_clock::time_point m_Deadline;
	};
	std::map<uint64_t, Req> m_Reqs;
	std::deque<std::string> m_Queue;
	static const size_t s_MaxQueue = 5000;

	std::function<void(const json&)> m_OnRequest;   // requests from the pool (verify)
	std::function<void()> m_OnConnected;             // to send hello
	io::Timer::Ptr m_pTimer;

	PoolLink(io::Reactor& r, const io::Address& a) :m_Reactor(r), m_Addr(a)
	{
		m_pTimer = io::Timer::create(r);
		m_pTimer->start(200, true, [this]() { OnTimer(); });
	}

	bool IsConnected() const { return m_pStream != nullptr; }

	void OnTimer()
	{
		auto now = std::chrono::steady_clock::now();
		if (!m_pStream && !m_Connecting && (now >= m_NextConnect))
			Connect();

		std::vector<std::function<void(const json*)>> vExpired;
		for (auto it = m_Reqs.begin(); m_Reqs.end() != it; )
		{
			if (now >= it->second.m_Deadline)
			{
				vExpired.push_back(std::move(it->second.m_Cb));
				it = m_Reqs.erase(it);
			}
			else
				++it;
		}
		for (auto& cb : vExpired)
			cb(nullptr);
	}

	void Connect()
	{
		m_Connecting = true;
		m_NextConnect = std::chrono::steady_clock::now() + std::chrono::seconds(2);
		auto res = m_Reactor.tcp_connect(m_Addr, 1, [this](uint64_t, io::TcpStream::Ptr&& pStream, io::ErrorCode ec) {
			m_Connecting = false;
			if (ec || !pStream)
			{
				BEAM_LOG_WARNING() << "pool link: connect to " << m_Addr.str() << " failed: " << io::error_str(ec);
				return;
			}
			m_pStream = std::move(pStream);
			m_Buf.clear();
			m_pStream->enable_read([this](io::ErrorCode ec, void* data, size_t size) { return OnRead(ec, data, size); });
			BEAM_LOG_INFO() << "pool link: connected to " << m_Addr.str();
			if (m_OnConnected)
				m_OnConnected();
			while (!m_Queue.empty() && m_pStream)
			{
				std::string s = std::move(m_Queue.front());
				m_Queue.pop_front();
				Write(s);
			}
		}, 5000);
		if (!res)
		{
			m_Connecting = false;
			BEAM_LOG_WARNING() << "pool link: tcp_connect: " << io::error_str(res.error());
		}
	}

	void Drop(const char* szWhy)
	{
		BEAM_LOG_WARNING() << "pool link: " << szWhy;
		m_pStream.reset();
		m_Buf.clear();
		auto reqs = std::move(m_Reqs);
		m_Reqs.clear();
		for (auto& [id, r] : reqs)
			r.m_Cb(nullptr);
	}

	bool OnRead(io::ErrorCode ec, void* data, size_t size)
	{
		if (ec)
		{
			Drop(io::error_str(ec));
			return false;
		}
		m_Buf.append(static_cast<const char*>(data), size);
		if (m_Buf.size() > (1u << 22))
		{
			Drop("line too long");
			return false;
		}
		size_t pos;
		while ((pos = m_Buf.find('\n')) != std::string::npos)
		{
			std::string line = m_Buf.substr(0, pos);
			m_Buf.erase(0, pos + 1);
			if (line.empty())
				continue;
			OnLine(line);
		}
		return true;
	}

	void OnLine(const std::string& line)
	{
		json j = json::parse(line, nullptr, false);
		if (!j.is_object())
		{
			BEAM_LOG_WARNING() << "pool link: not a JSON object: " << line.substr(0, 80);
			return;
		}
		if (j.count("method"))
		{
			if (m_OnRequest)
				m_OnRequest(j);
			return;
		}
		if (j.count("id") && j["id"].is_number_unsigned())
		{
			auto it = m_Reqs.find(j["id"].get<uint64_t>());
			if (m_Reqs.end() != it)
			{
				auto cb = std::move(it->second.m_Cb);
				m_Reqs.erase(it);
				cb(&j);
			}
		}
	}

	void Write(const std::string& s)
	{
		if (!m_pStream)
			return;
		auto res = m_pStream->write(s.data(), s.size());
		if (!res)
			Drop(io::error_str(res.error()));
	}

	void Send(const json& j)
	{
		Write(j.dump() + "\n");
	}

	// Answer to a request from the pool
	void Respond(const json& req, json res)
	{
		res["id"] = req["id"];
		Send(res);
	}

	void Request(json j, std::function<void(const json*)> cb, uint32_t timeoutMs)
	{
		if (!m_pStream)
		{
			cb(nullptr);
			return;
		}
		uint64_t id = m_NextId++;
		j["id"] = id;
		m_Reqs[id] = Req{ std::move(cb), std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs) };
		Send(j);
	}

	void Notify(const json& j)
	{
		std::string s = j.dump() + "\n";
		if (m_pStream)
			Write(s);
		else
		{
			if (m_Queue.size() >= s_MaxQueue)
				m_Queue.pop_front();
			m_Queue.push_back(std::move(s));
		}
	}
};

struct Settings
{
	io::Address m_NodeAddr;
	io::Address m_PoolAddr;
	Key::IKdf::Ptr m_pMaster;   // the mining wallet
	Key::IKdf::Ptr m_pCoin;     // its miner key: export_miner_key --subkey=m_SubIdx
	Key::Index m_SubIdx = 0;
	uint32_t m_PoolTimeoutMs = 3000;
	Height m_Lookback = 200;    // blocks scanned back from the tip on a first start
};

// The node side: owner login, block finalization, and following the chain.
struct NodeLink
	:public proto::NodeConnection
{
	const Settings& m_S;
	PoolLink& m_Pool;
	io::Timer::Ptr m_pTimer;

	Block::SystemState::Full m_Tip;
	bool m_HaveTip = false;

	// chain follow: hashes of scanned heights, the last scanned height, requests in flight
	std::map<Height, Merkle::Hash> m_Hashes;
	Height m_hScanned = 0;
	Height m_hScannedFromPool = 0;
	bool m_HdrsPending = false;
	bool m_BodiesPending = false;
	Height m_hBodiesTop = 0;

	std::unique_ptr<proto::GetBlockFinalization> m_pPending; // waits for the chain scan
	uint64_t m_FinSeq = 0;
	uint32_t m_Finalizations = 0;

	// the pool server's hello tells where it stopped scanning; wait for it a little before choosing a start
	bool m_HelloDone = false;
	io::Timer::Ptr m_pHelloTimer;

	// pairs offered by the pool server are checked against the chain before the block is built: a kernel
	// already there would make the node refuse the whole coinbase
	struct Check
	{
		Height m_Height;
		Amount m_Total;
		uint64_t m_Seq;
		std::vector<Pair> m_vPairs;
		std::vector<bool> m_vInChain;
		size_t m_Next = 0;
		std::string m_Note;
	};
	std::unique_ptr<Check> m_pCheck;
	bool m_Busy = false; // an answer is being prepared (pool request, kernel check); the next template waits

	NodeLink(const Settings& s, PoolLink& p) :m_S(s), m_Pool(p)
	{
		m_pTimer = io::Timer::create(io::Reactor::get_Current());
	}

	void Start()
	{
		BEAM_LOG_INFO() << "node: connecting to " << m_S.m_NodeAddr.str();
		Connect(m_S.m_NodeAddr);
		if (!m_HelloDone && !m_pHelloTimer)
		{
			m_pHelloTimer = io::Timer::create(io::Reactor::get_Current());
			m_pHelloTimer->start(15000, false, [this]() {
				if (!m_HelloDone)
				{
					BEAM_LOG_WARNING() << "pool link: no hello within 15 s, scanning from the tip minus " << m_S.m_Lookback;
					OnHello(0);
				}
			});
		}
	}

	// The pool server's answer to hello (or giving up on it): now the first scan height can be chosen.
	void OnHello(Height hScannedByPool)
	{
		if (!m_HelloDone)
		{
			m_HelloDone = true;
			m_hScannedFromPool = hScannedByPool;
		}
		if (m_HaveTip && !m_hScanned)
			ChooseStart();
	}

	void ChooseStart()
	{
		Height h = m_Tip.get_Height();
		Height h0 = (h > m_S.m_Lookback) ? (h - m_S.m_Lookback) : 0;
		m_hScanned = std::max(h0, m_hScannedFromPool);
		BEAM_LOG_INFO() << "node: tip " << h << ", scanning the chain from " << (m_hScanned + 1);
		SyncHeaders();
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
		{
			// the node finalizes only with its owner: prove we hold the mining wallet's key
			ProveKdfObscured(*m_S.m_pMaster, proto::IDType::Owner);
			BEAM_LOG_INFO() << "node: logged in as the mining wallet's owner";
		}
	}

	void OnDisconnect(const DisconnectReason& dr) override
	{
		std::ostringstream os;
		os << dr;
		BEAM_LOG_WARNING() << "node: disconnected (" << os.str() << "), reconnecting";
		Reset();
		m_HaveTip = false;
		m_pPending.reset();
		m_pCheck.reset();
		m_Busy = false;
		m_HdrsPending = false;
		m_BodiesPending = false;
		m_pTimer->start(1000, false, [this]() { Start(); });
	}

	// ---- chain follow ----

	void OnMsg(proto::NewTip&& msg) override
	{
		m_Tip = msg.m_Description;
		m_HaveTip = true;
		if (!m_hScanned)
		{
			// first start: from where the pool server left off (its hello), or a little back from the tip
			if (!m_HelloDone)
				return; // the hello or its timeout calls ChooseStart
			ChooseStart();
			return;
		}
		SyncHeaders();
	}

	void SyncHeaders()
	{
		if (!m_HaveTip || m_HdrsPending || m_BodiesPending)
			return;
		Height h = m_Tip.get_Height();
		if (h < m_hScanned)
		{
			// the chain is shorter than what we scanned: a rollback happened, rescan from there
			Rollback(h);
		}
		if (h == m_hScanned)
		{
			// same height: still ours?
			Merkle::Hash hv;
			m_Tip.get_Hash(hv);
			auto it = m_Hashes.find(h);
			if ((m_Hashes.end() == it) || (it->second == hv))
			{
				FinalizeIfReady();
				return;
			}
			Rollback(h - 1);
		}

		// headers from the last known one (to check it still stands) up to the tip
		proto::GetHdrPack msg;
		m_Tip.get_ID(msg.m_Top);
		Height nWant = h - m_hScanned + 1;
		msg.m_Count = static_cast<uint32_t>(std::min<Height>(nWant, 512));
		Send(msg);
		m_HdrsPending = true;
	}

	void Rollback(Height hKeep)
	{
		BEAM_LOG_WARNING() << "node: chain reorganized, back to height " << hKeep;
		m_Hashes.erase(m_Hashes.upper_bound(hKeep), m_Hashes.end());
		m_hScanned = hKeep;
		m_Pool.Notify({ { "method", "rollback" }, { "height", hKeep + 1 } });
	}

	void OnMsg(proto::HdrPack&& msg) override
	{
		m_HdrsPending = false;
		proto::FlyClient::Data::DecodedHdrPack ex;
		if (!ex.DecodeAndCheck(msg) || ex.m_vStates.empty())
		{
			BEAM_LOG_WARNING() << "node: bad header pack";
			return;
		}

		// ascending; the first one is a height we may already know
		json jHdrs = json::array();
		for (const auto& s : ex.m_vStates)
		{
			Height h = s.get_Height();
			Merkle::Hash hv;
			s.get_Hash(hv);
			auto it = m_Hashes.find(h);
			if (m_Hashes.end() != it)
			{
				if (it->second == hv)
					continue;
				// a known height with another hash: everything from here on is new
				Rollback(h - 1);
			}
			else if (h <= m_hScanned)
			{
				// we never saw this height (first start): just record it
			}
			m_Hashes[h] = hv;
			jHdrs.push_back({ { "height", h }, { "hash", HashHex(hv) } });
		}
		if (!jHdrs.empty())
			m_Pool.Notify({ { "method", "headers" }, { "tip", m_Tip.get_Height() }, { "headers", jHdrs } });

		// forget old hashes
		while (m_Hashes.size() > 4096)
			m_Hashes.erase(m_Hashes.begin());

		const auto& first = ex.m_vStates.front();
		if (first.get_Height() > m_hScanned + 1)
		{
			// the pack didn't reach back to what we know (a long gap, or a reorg deeper than the pack): the
			// headers below it, down to the last scanned height
			proto::GetHdrPack msg;
			first.get_ID(msg.m_Top);
			msg.m_Count = static_cast<uint32_t>(std::min<Height>(first.get_Height() - m_hScanned, 512));
			Send(msg);
			m_HdrsPending = true;
			return;
		}

		AskBodies();
	}

	void AskBodies()
	{
		if (m_BodiesPending || !m_HaveTip)
			return;
		Height h = m_Tip.get_Height();
		if (h <= m_hScanned)
		{
			FinalizeIfReady();
			return;
		}
		proto::GetBodyPack msg;
		m_Tip.get_ID(msg.m_Top);
		msg.m_FlagP = proto::BodyBuffers::None;
		msg.m_FlagE = proto::BodyBuffers::Full;
		msg.m_CountExtra.v = h - (m_hScanned + 1);
		Send(msg);
		m_BodiesPending = true;
		m_hBodiesTop = h;
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

	void OnMsg(proto::DataMissing&&) override
	{
		// the node has no body for that range (pruned, or it moved on): try again from the tip
		m_BodiesPending = false;
		m_HdrsPending = false;
		SyncHeaders();
	}

	void OnBodies(const std::vector<proto::BodyBuffers>& v)
	{
		m_BodiesPending = false;
		Height h = m_hScanned + 1; // the pack starts right after what we know
		for (const auto& b : v)
		{
			TxVectors::Eternal e;
			try
			{
				Deserializer der;
				der.reset(b.m_Eternal);
				der & e;
			}
			catch (const std::exception&)
			{
				BEAM_LOG_WARNING() << "node: bad block body at " << h;
				SyncHeaders();
				return;
			}

			json jKrn = json::array();
			for (const auto& pKrn : e.m_vKernels)
				jKrn.push_back(HashHex(pKrn->get_ID()));

			auto it = m_Hashes.find(h);
			m_Pool.Notify({ { "method", "mined" }, { "height", h }, { "hash", (m_Hashes.end() != it) ? HashHex(it->second) : std::string() },
				{ "kernels", jKrn } });
			m_hScanned = h++;
		}

		if (m_hScanned < m_hBodiesTop)
			AskBodies();
		else
			SyncHeaders(); // the tip may have moved meanwhile
	}

	// ---- finalization ----

	void OnMsg(proto::GetBlockFinalization&& msg) override
	{
		BEAM_LOG_DEBUG() << "node: finalization asked for height " << msg.m_Height << ", fees " << msg.m_Fees;
		m_pPending = std::make_unique<proto::GetBlockFinalization>(std::move(msg));
		m_FinSeq++;
		FinalizeIfReady();
	}

	void FinalizeIfReady()
	{
		if (!m_pPending || m_Busy)
			return;
		if (m_pPending->m_Height > m_hScanned + 1)
		{
			// pairs the previous block spent must be known first: wait for its kernels
			SyncHeaders();
			return;
		}
		auto pMsg = std::move(m_pPending);
		Answer(*pMsg, m_FinSeq);
	}

	void Answer(const proto::GetBlockFinalization& msg, uint64_t seq)
	{
		const Rules& r = Rules::get();
		Height h = msg.m_Height;
		Amount total = r.get_Emission(h) + msg.m_Fees;
		m_Busy = true;

		if (!r.IsPastFork_<6>(h))
		{
			// before HF6 fees are an explicit UTXO: not supported, the pool takes everything
			SendCoinbase(h, total, std::vector<Pair>(), seq, "before fork 6");
			return;
		}

		m_Pool.Request({ { "method", "coinbase" }, { "height", h }, { "fees", msg.m_Fees }, { "total", total } },
			[this, h, total, seq](const json* pRes) {
				std::vector<Pair> vPairs;
				const char* szNote = "";
				if (!pRes)
					szNote = "pool server did not answer, pool-only coinbase";
				else if (!(*pRes).count("pairs") || !(*pRes)["pairs"].is_array())
					szNote = "pool server answered without pairs";
				else
				{
					for (const auto& jp : (*pRes)["pairs"])
					{
						Pair p;
						if (jp.is_string() && p.FromHex(jp.get<std::string>()))
							vPairs.push_back(std::move(p));
						else
							BEAM_LOG_WARNING() << "pool server sent a pair that doesn't parse";
					}
				}
				StartCheck(h, total, std::move(vPairs), seq, szNote);
			}, m_S.m_PoolTimeoutMs);
	}

	// Asks the node for a proof of every offered kernel (pipelined); the answers come in order.
	void StartCheck(Height h, Amount total, std::vector<Pair>&& vPairs, uint64_t seq, const char* szNote)
	{
		if (vPairs.empty())
		{
			SendCoinbase(h, total, std::vector<Pair>(), seq, szNote);
			return;
		}
		auto pCheck = std::make_unique<Check>();
		pCheck->m_Height = h;
		pCheck->m_Total = total;
		pCheck->m_Seq = seq;
		pCheck->m_vPairs = std::move(vPairs);
		pCheck->m_vInChain.assign(pCheck->m_vPairs.size(), false);
		pCheck->m_Note = szNote;
		for (const auto& p : pCheck->m_vPairs)
		{
			proto::GetProofKernel msg;
			msg.m_ID = p.get_KernelID();
			Send(msg);
		}
		m_pCheck = std::move(pCheck);
	}

	void OnMsg(proto::ProofKernel&& msg) override
	{
		if (!m_pCheck || (m_pCheck->m_Next >= m_pCheck->m_vPairs.size()))
			return;
		Check& c = *m_pCheck;
		c.m_vInChain[c.m_Next++] = !msg.m_Proof.empty();
		if (c.m_Next < c.m_vPairs.size())
			return;

		auto pCheck = std::move(m_pCheck);
		std::vector<Pair> vGood;
		json jSpent = json::array();
		for (size_t i = 0; i < pCheck->m_vPairs.size(); i++)
		{
			if (pCheck->m_vInChain[i])
				jSpent.push_back(HashHex(pCheck->m_vPairs[i].get_KernelID()));
			else
				vGood.push_back(std::move(pCheck->m_vPairs[i]));
		}
		if (!jSpent.empty())
		{
			BEAM_LOG_WARNING() << "node: " << jSpent.size() << " offered pair(s) already have their kernel in the chain, left out and reported";
			m_Pool.Notify({ { "method", "spent" }, { "height", pCheck->m_Height }, { "kernels", jSpent } });
		}
		SendCoinbase(pCheck->m_Height, pCheck->m_Total, vGood, pCheck->m_Seq, pCheck->m_Note.c_str());
	}

	void SendCoinbase(Height h, Amount total, const std::vector<Pair>& vPairs, uint64_t seq, const char* szNote)
	{
		m_Busy = false;
		if (seq != m_FinSeq)
		{
			BEAM_LOG_INFO() << "node: template for " << h << " superseded, not answered";
			FinalizeIfReady();
			return;
		}
		std::vector<size_t> vDropped;
		Transaction::Ptr pTx = BuildCoinbaseTx(vPairs, total, *m_S.m_pCoin, m_S.m_SubIdx, *m_S.m_pMaster, h, vDropped);

		Amount paid = 0;
		json jDropped = json::array();
		for (size_t i = 0; i < vPairs.size(); i++)
		{
			if (std::find(vDropped.begin(), vDropped.end(), i) != vDropped.end())
				jDropped.push_back(HashHex(vPairs[i].get_KernelID()));
			else
				paid += vPairs[i].get_Value();
		}

		proto::BlockFinalization out;
		out.m_Value = pTx;
		Send(out);
		m_Finalizations++;

		BEAM_LOG_INFO() << "node: coinbase for " << h << ": " << (vPairs.size() - vDropped.size()) << " pairs, "
			<< paid << " groth to miners, " << (total - paid) << " to the pool"
			<< (vDropped.empty() ? "" : ", dropped ") << (vDropped.empty() ? "" : std::to_string(vDropped.size()).c_str())
			<< (szNote[0] ? " (" : "") << szNote << (szNote[0] ? ")" : "");

		m_Pool.Notify({ { "method", "built" }, { "height", h }, { "pairs", vPairs.size() - vDropped.size() }, { "paid", paid },
			{ "poolValue", total - paid }, { "dropped", jDropped }, { "note", szNote } });
	}

	// ---- requests from the pool ----

	void OnPoolRequest(const json& req)
	{
		std::string method = req.value("method", "");
		if (method == "verify")
			Verify(req);
		else if (method == "ping")
			m_Pool.Respond(req, { { "ok", true }, { "tip", m_HaveTip ? m_Tip.get_Height() : 0 }, { "scanned", m_hScanned }, { "finalizations", m_Finalizations } });
		else
			m_Pool.Respond(req, { { "ok", false }, { "error", "unknown method" } });
	}

	void Verify(const json& req)
	{
		// a fresh chain has no tip yet: pairs are then checked for block 1
		Height hTip = m_HaveTip ? m_Tip.get_Height() : 0;
		std::string account = req.value("account", "");
		std::string domain = req.value("domain", "");
		uint64_t ts = req.value("ts", 0ull);
		std::string sig = req.value("signature", "");
		std::vector<std::string> vHex;
		if (req.count("pairs") && req["pairs"].is_array())
			for (const auto& j : req["pairs"])
				if (j.is_string())
					vHex.push_back(j.get<std::string>());

		if (!VerifyUpload(domain, account, ts, vHex, sig))
		{
			m_Pool.Respond(req, { { "ok", false }, { "error", "bad signature for this account and upload" } });
			return;
		}

		json jRes = json::array();
		for (const auto& s : vHex)
		{
			Pair p;
			std::string sErr;
			if (!p.FromHex(s))
				jRes.push_back({ { "ok", false }, { "error", "does not parse as output+kernel" } });
			else if (!VerifyPair(p, hTip + 1, sErr))
				jRes.push_back({ { "ok", false }, { "error", sErr } });
			else
				jRes.push_back({ { "ok", true }, { "value", p.get_Value() }, { "kernel", HashHex(p.get_KernelID()) },
					{ "commitment", PointHex(p.m_Output.m_Commitment) }, { "size", p.get_Size() },
					{ "minHeight", p.get_MinHeight() }, { "maxHeight", p.get_MaxHeight() } });
		}
		m_Pool.Respond(req, { { "ok", true }, { "tip", hTip }, { "results", jRes } });
	}
};

} // namespace

int main(int argc, char* argv[])
{
	Rules r;
	Rules::Scope scopeRules(r);

	try
	{
		auto [options, visible] = createOptionsDescription(GENERAL_OPTIONS, "bb-finalizer.cfg");
		po::options_description own("FINALIZER");
		own.add_options()
			("node", po::value<std::string>()->default_value("127.0.0.1:10000"), "the pool's node, host:port of its p2p port")
			("pool", po::value<std::string>()->default_value("127.0.0.1:3480"), "the pool server's coinbase link, host:port")
			("seed_file", po::value<std::string>(), "file with the mining wallet's seed phrase (owner of the node, receives the pool's share)")
			("subkey", po::value<uint32_t>()->default_value(1), "subkey of the mining wallet's miner key (export_miner_key --subkey=N for the node)")
			("pool_timeout_ms", po::value<uint32_t>()->default_value(3000), "how long to wait for the pool server before a pool-only coinbase")
			("lookback", po::value<uint32_t>()->default_value(200), "blocks scanned back from the tip on a first start");
		options.add(own);
		visible.add(own);

		po::variables_map vm = getOptions(argc, argv, options, r);
		if (vm.count(cli::HELP))
		{
			std::cout << visible << std::endl;
			return 0;
		}
		r.UpdateChecksum();

		int logLevel = getLogLevel(cli::LOG_LEVEL, vm, BEAM_LOG_LEVEL_INFO);
		auto logger = Logger::create(logLevel, logLevel);
		BEAM_LOG_INFO() << g_Version << ", rules " << Rules::get().get_SignatureStr();

		Settings s;
		if (!s.m_NodeAddr.resolve(vm["node"].as<std::string>().c_str()))
			throw std::runtime_error("bad --node address");
		if (!s.m_PoolAddr.resolve(vm["pool"].as<std::string>().c_str()))
			throw std::runtime_error("bad --pool address");
		if (!vm.count("seed_file"))
			throw std::runtime_error("--seed_file is required");
		s.m_SubIdx = vm["subkey"].as<uint32_t>();
		s.m_PoolTimeoutMs = vm["pool_timeout_ms"].as<uint32_t>();
		s.m_Lookback = vm["lookback"].as<uint32_t>();

		{
			std::ifstream f(vm["seed_file"].as<std::string>());
			if (!f)
				throw std::runtime_error("cannot read the seed file");
			std::stringstream ss;
			ss << f.rdbuf();
			std::string sErr;
			s.m_pMaster = KdfFromSeedPhrase(ss.str(), sErr);
			if (!s.m_pMaster)
				throw std::runtime_error("seed file: " + sErr);
		}
		s.m_pCoin = MasterKey::get_Child(*s.m_pMaster, s.m_SubIdx);
		BEAM_LOG_INFO() << "mining wallet owner fingerprint " << OwnerFingerprint(*s.m_pMaster) << " (compare with `bb-coinbase keyinfo` of its exported owner key)";

		io::Reactor::Ptr pReactor(io::Reactor::create());
		io::Reactor::Scope scope(*pReactor);
		io::Reactor::GracefulIntHandler gih(*pReactor);

		PoolLink pool(*pReactor, s.m_PoolAddr);
		NodeLink node(s, pool);
		pool.m_OnRequest = [&node](const json& j) { node.OnPoolRequest(j); };
		pool.m_OnConnected = [&pool, &node]() {
			pool.Request({ { "method", "hello" }, { "version", g_Version }, { "tip", node.m_HaveTip ? node.m_Tip.get_Height() : 0 },
				{ "scanned", node.m_hScanned } },
				[&node](const json* pRes) {
					Height h = 0;
					if (pRes && (*pRes).count("scanned") && (*pRes)["scanned"].is_number_unsigned())
						h = (*pRes)["scanned"].get<Height>();
					BEAM_LOG_INFO() << "pool link: hello, pool server scanned up to " << h;
					node.OnHello(h);
				}, 5000);
		};

		node.Start();
		pReactor->run();
		BEAM_LOG_INFO() << "stopped after " << node.m_Finalizations << " finalizations";
	}
	catch (const std::exception& e)
	{
		std::cerr << "bb-finalizer: " << e.what() << std::endl;
		return 1;
	}
	return 0;
}
