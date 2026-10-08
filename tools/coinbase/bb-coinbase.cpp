// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// bb-coinbase: the miner's tool for coinbase payouts. Keeps the wallet's exported miner key and owner key
// (as beam-wallet exports them, encrypted with the wallet's password), derives the account the miner logs
// in with, makes the stock of coinbase pairs and uploads it to the pool. The wallet's seed never leaves the
// wallet; the pool only ever sees outputs it cannot spend.
//
//   beam-wallet export_miner_key --subkey=1      (the string after "Secret subkey 1:")
//   beam-wallet export_owner_key                 (the string after "Owner Viewer key:")
//   bb-coinbase init --miner_key <...> --owner_key <...> --subkey 1
//   bb-coinbase identity                          -> cb:02..., the stratum login (add .worker)
//   bb-coinbase top-up --pool https://pool.bumblebeam.org
//   bb-coinbase status --pool https://pool.bumblebeam.org
//
// Pairs expire about 30 days after they are made (kernel lifespan), so run top-up now and then, e.g. daily
// from cron. Uploads need curl.

#include "coinbase.h"

#include "nlohmann/json.hpp"
#include "utility/cli/options.h"
#include "utility/hex.h"
#include "utility/logger.h"

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>

using namespace beam;
using namespace bb::coinbase;
using json = nlohmann::json;

thread_local const beam::Rules* beam::Rules::s_pInstance = nullptr;

namespace {

struct Cfg
{
	std::string m_Path;
	std::string m_MinerKey;
	std::string m_OwnerKey;
	uint32_t m_SubIdx = 0;
	uint64_t m_NextIdx = 0;

	void Load()
	{
		std::ifstream f(m_Path);
		if (!f)
			throw std::runtime_error("no config at " + m_Path + ": run `bb-coinbase init` first");
		json j = json::parse(f);
		m_MinerKey = j.value("miner_key", "");
		m_OwnerKey = j.value("owner_key", "");
		m_SubIdx = j.value("subkey", 0u);
		m_NextIdx = j.value("next_idx", 0ull);
		if (m_MinerKey.empty() || m_OwnerKey.empty())
			throw std::runtime_error("config has no keys");
	}

	void Save() const
	{
		json j = { { "miner_key", m_MinerKey }, { "owner_key", m_OwnerKey }, { "subkey", m_SubIdx }, { "next_idx", m_NextIdx } };
		std::string tmp = m_Path + ".tmp";
		{
			std::ofstream f(tmp, std::ios::trunc);
			if (!f)
				throw std::runtime_error("cannot write " + tmp);
			f << j.dump(2) << "\n";
		}
		chmod(tmp.c_str(), 0600);
		if (rename(tmp.c_str(), m_Path.c_str()))
			throw std::runtime_error("cannot write " + m_Path);
	}
};

std::string ReadPassword(const po::variables_map& vm)
{
	if (vm.count("pass"))
		return vm["pass"].as<std::string>();
	if (const char* p = getenv("BB_PASS"))
		return p;
	const char* p = getpass("Wallet password: ");
	return p ? p : "";
}

struct Keys
{
	Key::IKdf::Ptr m_pMiner;
	Key::IPKdf::Ptr m_pOwner;
	Identity m_Id;
};

Keys OpenKeys(const Cfg& cfg, const std::string& pass)
{
	Keys k;
	k.m_pMiner = ImportMinerKey(cfg.m_MinerKey, pass);
	if (!k.m_pMiner)
		throw std::runtime_error("the miner key does not decrypt with this password");
	k.m_pOwner = ImportOwnerKey(cfg.m_OwnerKey, pass);
	if (!k.m_pOwner)
		throw std::runtime_error("the owner key does not decrypt with this password");
	k.m_Id = Identity::Derive(*k.m_pMiner);
	return k;
}

bool SafeUrl(const std::string& s)
{
	if (s.empty() || (s.size() > 500))
		return false;
	for (char c : s)
		if (!isalnum(static_cast<unsigned char>(c)) && !strchr(":/._-?=&%~", c))
			return false;
	return true;
}

// curl does the HTTP (TLS, proxies, redirects as the user has them configured)
json Http(const std::string& method, const std::string& url, const std::string& body)
{
	if (!SafeUrl(url))
		throw std::runtime_error("the pool URL has unexpected characters");

	std::string tmp;
	std::string cmd = "curl -sS --max-time 60 -X " + method + " -H 'Content-Type: application/json' -H 'Accept: application/json' ";
	if (!body.empty())
	{
		char name[] = "/tmp/bb-coinbase-XXXXXX";
		int fd = mkstemp(name);
		if (fd < 0)
			throw std::runtime_error("cannot create a temp file");
		if (write(fd, body.data(), body.size()) != static_cast<ssize_t>(body.size()))
		{
			close(fd);
			throw std::runtime_error("cannot write the temp file");
		}
		close(fd);
		tmp = name;
		cmd += "--data-binary @" + tmp + " ";
	}
	cmd += "'" + url + "'";

	std::string out;
	FILE* f = popen(cmd.c_str(), "r");
	if (!f)
		throw std::runtime_error("cannot run curl");
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		out.append(buf, n);
	int rc = pclose(f);
	if (!tmp.empty())
		unlink(tmp.c_str());
	if (rc)
		throw std::runtime_error("curl failed (" + std::to_string(rc) + "): " + out.substr(0, 200));

	json j = json::parse(out, nullptr, false);
	if (j.is_discarded())
		throw std::runtime_error("the pool did not answer with JSON: " + out.substr(0, 200));
	return j;
}

std::string Beam(Amount v)
{
	char buf[64];
	snprintf(buf, sizeof(buf), "%llu.%08llu", (unsigned long long) (v / Rules::Coin), (unsigned long long) (v % Rules::Coin));
	return buf;
}

int Init(const po::variables_map& vm, Cfg& cfg)
{
	if (!vm.count("miner_key") || !vm.count("owner_key"))
		throw std::runtime_error("init needs --miner_key and --owner_key (see beam-wallet export_miner_key / export_owner_key)");
	cfg.m_MinerKey = vm["miner_key"].as<std::string>();
	cfg.m_OwnerKey = vm["owner_key"].as<std::string>();
	cfg.m_SubIdx = vm["subkey"].as<uint32_t>();
	cfg.m_NextIdx = 0;

	std::string pass = ReadPassword(vm);
	Keys k = OpenKeys(cfg, pass); // checks the password and the keys
	cfg.Save();
	std::cout << "keys saved to " << cfg.m_Path << " (encrypted as exported)\n"
		<< "account: " << k.m_Id.get_Account() << "\n"
		<< "mine with this account as the login, e.g. " << k.m_Id.get_Account() << ".rig1\n";
	return 0;
}

int Identity_(const po::variables_map& vm, Cfg& cfg)
{
	cfg.Load();
	Keys k = OpenKeys(cfg, ReadPassword(vm));
	std::cout << k.m_Id.get_Account() << "\n";
	return 0;
}

int Status(const po::variables_map& vm, Cfg& cfg)
{
	cfg.Load();
	Keys k = OpenKeys(cfg, ReadPassword(vm));
	std::string pool = vm["pool"].as<std::string>();
	json info = Http("GET", pool + "/api/coinbase", "");
	json m = Http("GET", pool + "/api/miners/" + k.m_Id.get_Account(), "");

	std::cout << "account:   " << k.m_Id.get_Account() << "\n";
	std::cout << "pool:      coinbase payouts " << (info.value("enabled", false) ? "enabled" : "DISABLED") << ", height "
		<< info.value("height", 0ull) << "\n";
	std::cout << "hashrate:  " << m.value("hashrate", 0.0) << " sol/s\n";
	std::cout << "balance:   " << Beam(m.value("balance", 0ll) < 0 ? 0 : m.value("balance", 0ll)) << " BEAM unpaid, "
		<< Beam(m.value("immature", 0ll)) << " immature, " << Beam(m.value("paid", 0ll)) << " paid\n";
	if (m.count("coinbase"))
	{
		const json& cb = m["coinbase"];
		std::cout << "stock:     " << cb.value("stockPairs", 0ull) << " pairs worth " << Beam(cb.value("stockValue", 0ull)) << " BEAM";
		if (cb.count("stock") && cb["stock"].is_array())
		{
			std::cout << " (";
			bool first = true;
			for (const auto& s : cb["stock"])
			{
				std::cout << (first ? "" : ", ") << s.value("count", 0ull) << "x" << Beam(s.value("value", 0ull));
				first = false;
			}
			std::cout << ")";
		}
		std::cout << "\n";
		std::cout << "paid out:  " << cb.value("minedPairs", 0ull) << " pairs in " << cb.value("blocks", 0ull) << " blocks, "
			<< Beam(cb.value("minedValue", 0ull)) << " BEAM; expired " << cb.value("expiredPairs", 0ull) << "\n";
		if (cb.count("expiresAt") && cb["expiresAt"].is_number())
			std::cout << "the earliest pair expires at height " << cb["expiresAt"].get<uint64_t>() << "\n";
	}
	return 0;
}

int TopUp(const po::variables_map& vm, Cfg& cfg)
{
	cfg.Load();
	Keys k = OpenKeys(cfg, ReadPassword(vm));
	std::string pool = vm["pool"].as<std::string>();
	uint32_t perStep = vm["per_step"].as<uint32_t>();
	uint32_t stepsMax = vm["steps_max"].as<uint32_t>();

	json info = Http("GET", pool + "/api/coinbase", "");
	if (!info.value("enabled", false))
		throw std::runtime_error("this pool does not pay in the coinbase");
	if (!info.count("height"))
		throw std::runtime_error("the pool does not know the chain height yet, try later");
	Height h = info.value("height", 0ull);
	Ladder ladder;
	ladder.m_Shift = info["ladder"].value("shift", 20u);
	ladder.m_Steps = info["ladder"].value("steps", 12u);
	uint32_t maxUpload = info.value("maxPairsPerUpload", 256u);
	uint32_t stockMax = info.value("stockMaxPerAccount", 512u);

	json m = Http("GET", pool + "/api/miners/" + k.m_Id.get_Account(), "");
	std::map<Amount, uint32_t> have;
	uint32_t nStock = 0;
	if (m.count("coinbase") && m["coinbase"].count("stock"))
		for (const auto& s : m["coinbase"]["stock"])
		{
			have[s.value("value", 0ull)] = s.value("count", 0u);
			nStock += s.value("count", 0u);
		}

	if (!cfg.m_NextIdx)
		cfg.m_NextIdx = static_cast<uint64_t>(time(nullptr)) << 20; // never collides with heights or an earlier run

	std::vector<std::string> vHex;
	Amount worth = 0;
	uint32_t steps = std::min(ladder.m_Steps, stepsMax);
	// small steps first: they are what the rounding needs most
	for (uint32_t i = 0; (i < steps) && (vHex.size() < maxUpload) && (nStock + vHex.size() < stockMax); i++)
	{
		Amount v = ladder.get_Step(i);
		for (uint32_t n = have[v]; (n < perStep) && (vHex.size() < maxUpload) && (nStock + vHex.size() < stockMax); n++)
		{
			Pair p = MakePair(*k.m_pMiner, cfg.m_SubIdx, *k.m_pOwner, v, cfg.m_NextIdx++, h + 1, h + 1);
			vHex.push_back(p.ToHex());
			worth += v;
		}
	}
	cfg.Save(); // indexes are never reused, whatever happens next

	if (vHex.empty())
	{
		std::cout << "stock is full: " << nStock << " pairs, nothing to upload\n";
		return 0;
	}

	uint64_t ts = static_cast<uint64_t>(time(nullptr));
	json body = { { "account", k.m_Id.get_Account() }, { "ts", ts }, { "pairs", vHex }, { "signature", SignUpload(k.m_Id, ts, vHex) } };
	json res = Http("POST", pool + "/api/coinbase/pairs", body.dump());
	if (res.count("error"))
		throw std::runtime_error("pool refused the upload: " + res["error"].get<std::string>());

	uint32_t accepted = res.value("accepted", 0u);
	std::cout << "uploaded " << vHex.size() << " pairs worth " << Beam(worth) << " BEAM: " << accepted << " accepted";
	if (res.count("rejected") && res["rejected"].is_array() && !res["rejected"].empty())
	{
		std::cout << ", " << res["rejected"].size() << " rejected:\n";
		for (const auto& r : res["rejected"])
			std::cout << "  #" << r.value("index", 0u) << ": " << r.value("error", "") << "\n";
	}
	else
		std::cout << "\n";
	std::cout << "stock now " << res.value("stockPairs", 0u) << " pairs; pairs made today are valid until about height "
		<< res.value("validUntil", 0ull) << "\n";
	return 0;
}

// Fingerprints of exported keys, to compare with what the finalizer derives from a seed.
int KeyInfo(const po::variables_map& vm)
{
	std::string pass = ReadPassword(vm);
	if (vm.count("owner_key"))
	{
		auto p = ImportOwnerKey(vm["owner_key"].as<std::string>(), pass);
		if (!p)
			throw std::runtime_error("the owner key does not decrypt with this password");
		std::cout << "owner fingerprint: " << OwnerFingerprint(*p) << "\n";
	}
	if (vm.count("miner_key"))
	{
		auto p = ImportMinerKey(vm["miner_key"].as<std::string>(), pass);
		if (!p)
			throw std::runtime_error("the miner key does not decrypt with this password");
		std::cout << "account for this miner key: " << Identity::Derive(*p).get_Account() << "\n";
	}
	return 0;
}

// Pairs to a file, without a pool: for tests and for uploading by hand.
int Make(const po::variables_map& vm, Cfg& cfg)
{
	cfg.Load();
	Keys k = OpenKeys(cfg, ReadPassword(vm));
	Height h = vm["height"].as<uint64_t>();
	uint32_t count = vm["count"].as<uint32_t>();
	Amount value = vm["value"].as<uint64_t>();
	if (!h || !count || !value)
		throw std::runtime_error("make needs --height, --count and --value (groth)");
	if (!cfg.m_NextIdx)
		cfg.m_NextIdx = static_cast<uint64_t>(time(nullptr)) << 20;

	std::vector<std::string> vHex;
	for (uint32_t n = 0; n < count; n++)
		vHex.push_back(MakePair(*k.m_pMiner, cfg.m_SubIdx, *k.m_pOwner, value, cfg.m_NextIdx++, h + 1, h + 1).ToHex());
	cfg.Save();

	uint64_t ts = static_cast<uint64_t>(time(nullptr));
	json body = { { "account", k.m_Id.get_Account() }, { "ts", ts }, { "pairs", vHex }, { "signature", SignUpload(k.m_Id, ts, vHex) } };
	std::cout << body.dump() << "\n";
	return 0;
}

} // namespace

int main(int argc, char* argv[])
{
	Rules r;
	Rules::Scope scopeRules(r);

	try
	{
		auto [options, visible] = createOptionsDescription(GENERAL_OPTIONS, "bb-coinbase.cfg");
		po::options_description own("COINBASE");
		std::string home = getenv("HOME") ? getenv("HOME") : ".";
		own.add_options()
			("config", po::value<std::string>()->default_value(home + "/.bb-coinbase.json"), "where the exported keys are kept")
			("miner_key", po::value<std::string>(), "init: the string from `beam-wallet export_miner_key --subkey=N`")
			("owner_key", po::value<std::string>(), "init: the string from `beam-wallet export_owner_key`")
			("subkey", po::value<uint32_t>()->default_value(1), "init: the N of export_miner_key")
			("pass", po::value<std::string>(), "wallet password (or BB_PASS in the environment, or a prompt)")
			("pool", po::value<std::string>()->default_value("https://pool.bumblebeam.org"), "the pool's web address")
			("per_step", po::value<uint32_t>()->default_value(3), "top-up: unused pairs to keep per ladder step")
			("steps_max", po::value<uint32_t>()->default_value(12), "top-up: make pairs for this many steps from the smallest")
			("height", po::value<uint64_t>()->default_value(0), "make: current chain height")
			("count", po::value<uint32_t>()->default_value(0), "make: how many pairs")
			("value", po::value<uint64_t>()->default_value(0), "make: value of each pair, groth");
		options.add(own);
		visible.add(own);

		po::options_description hidden;
		hidden.add_options()("command", po::value<std::vector<std::string>>(), "command");
		options.add(hidden);

		po::positional_options_description pos;
		pos.add("command", -1);

		po::variables_map vm;
		po::store(po::command_line_parser(argc, argv).options(options).positional(pos).allow_unregistered().run(), vm);
		po::notify(vm);
		getRulesOptions(vm, r);
		r.UpdateChecksum();

		std::vector<std::string> cmds;
		if (vm.count("command"))
			cmds = vm["command"].as<std::vector<std::string>>();
		if (vm.count(cli::HELP) || cmds.empty())
		{
			std::cout << "bb-coinbase <init|identity|top-up|status|make|keyinfo> [options]\n\n" << visible << std::endl;
			return cmds.empty() ? 1 : 0;
		}

		auto logger = Logger::create(BEAM_LOG_LEVEL_WARNING, BEAM_LOG_LEVEL_WARNING);

		Cfg cfg;
		cfg.m_Path = vm["config"].as<std::string>();

		const std::string& cmd = cmds[0];
		if (cmd == "init")
			return Init(vm, cfg);
		if (cmd == "identity")
			return Identity_(vm, cfg);
		if (cmd == "top-up")
			return TopUp(vm, cfg);
		if (cmd == "status")
			return Status(vm, cfg);
		if (cmd == "make")
			return Make(vm, cfg);
		if (cmd == "keyinfo")
			return KeyInfo(vm);
		throw std::runtime_error("unknown command " + cmd);
	}
	catch (const std::exception& e)
	{
		std::cerr << "bb-coinbase: " << e.what() << std::endl;
		return 1;
	}
}
