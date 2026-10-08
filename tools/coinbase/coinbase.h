// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0
//
// Non-custodial coinbase for a Beam pool: the miners' own outputs in the block's coinbase.
//
// A miner makes a stock of coinbase "pairs" in advance: an output for a fixed amount and a kernel that
// cancels the output's blinding factor. Each pair balances by itself, so the pool can put any set of pairs
// into a coinbase without knowing the miner's key, and so without being able to spend them. The outputs
// are made with the miner key from `beam-wallet export_miner_key` and tagged with the wallet's owner key,
// exactly like the coinbase of a node that mines for that wallet, so the miner's wallet finds them.
//
// Amounts come from a ladder of powers of two, so that a few pairs add up to any share of a block. What
// a block can't pay to a miner in pairs, and the pool's fee and the transaction fees, go to one output
// of the pool's own.

#pragma once

#include "core/block_crypt.h"

#include <map>
#include <string>
#include <vector>

namespace bb::coinbase {

using namespace beam;

struct Pair
{
	Output m_Output;
	TxKernel::Ptr m_pKernel; // always a TxKernelStd

	Amount get_Value() const { return m_Output.m_pPublic ? m_Output.m_pPublic->m_Value : 0; }
	const Merkle::Hash& get_KernelID() const { return m_pKernel->get_ID(); }

	std::string ToHex() const;
	bool FromHex(const std::string&);
	size_t get_Size() const; // serialized, as in a block
};

// The miner's side. coin = the miner key (child of the wallet's master key for subIdx), tag = the
// wallet's owner key. idx must be unique per pair: it is the coin's index in the wallet.
Pair MakePair(Key::IKdf& coin, Key::Index subIdx, Key::IPKdf& tag, Amount value, uint64_t idx, Height hScheme,
	Height hMinKernel = 0);

// The pool's side, before a pair is accepted into the stock: everything that can be checked without the chain.
// Whether its kernel is already in the chain is checked by the node when it finalizes the block.
bool VerifyPair(const Pair&, Height hScheme, std::string& sErr);

// Powers of two from 2^shift groth: shift 20 is ~0.0105 BEAM, and 12 steps from it reach ~43 BEAM.
struct Ladder
{
	uint32_t m_Shift = 20;
	uint32_t m_Steps = 12;

	Amount get_Unit() const { return Amount(1) << m_Shift; }
	Amount get_Step(uint32_t i) const { return get_Unit() << i; }
	bool IsStep(Amount) const;
	std::vector<Amount> Split(Amount) const; // the steps that make up the amount, rounded down to the unit
};

// One block's coinbase: which pairs it carries, and the pool's own output for the rest.
struct Coinbase
{
	struct Paid
	{
		std::string m_Miner;
		Amount m_Owed = 0;
		Amount m_Paid = 0;
		std::vector<size_t> m_vPairs; // indexes into the miner's stock
	};

	std::vector<Paid> m_vPaid;
	Amount m_Total = 0; // emission + fees, as consensus requires
	Amount m_PoolValue = 0;
	size_t m_Size = 0;
};

// Picks pairs for each miner's owed amount, largest first, within the size limit, and never more
// than the total. Pairs in m_Used are skipped.
struct Allocator
{
	struct Stock
	{
		std::vector<Pair> m_vPairs;
		std::vector<bool> m_vUsed;
	};

	std::map<std::string, Stock> m_Stock; // miner -> pairs
	size_t m_MaxSize = 64 * 1024;

	Coinbase Allocate(const std::map<std::string, Amount>& owed, Amount total) const;
};

// The pool's side, when the node asks for the coinbase: the chosen pairs plus the pool's output and
// kernel for the rest. poolCoin and poolTag are the pool wallet's keys, as for Block::Builder.
Transaction::Ptr BuildCoinbaseTx(const Allocator&, const Coinbase&, Key::IKdf& poolCoin, Key::Index poolSubIdx,
	Key::IPKdf& poolTag, Height h);

} // namespace bb::coinbase
