// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0

#include "coinbase.h"

#include "core/serialization_adapters.h"
#include "utility/hex.h"
#include "utility/serialize.h"

#include <algorithm>

namespace bb::coinbase {

std::string Pair::ToHex() const
{
	Serializer ser;
	ser & m_Output & m_pKernel;
	auto [p, n] = ser.buffer();
	return to_hex(p, n);
}

bool Pair::FromHex(const std::string& s)
{
	bool bHex = false;
	std::vector<uint8_t> buf = from_hex(s, &bHex);
	if (!bHex || buf.empty())
		return false;

	try
	{
		Deserializer der;
		der.reset(buf);
		der & m_Output & m_pKernel;
		if (der.bytes_left())
			return false;
	}
	catch (const std::exception&)
	{
		return false;
	}

	return m_pKernel && (TxKernel::Subtype::Std == m_pKernel->get_Subtype());
}

size_t Pair::get_Size() const
{
	SerializerSizeCounter ssc;
	ssc & m_Output & m_pKernel;
	return ssc.m_Counter.m_Value;
}

Pair MakePair(Key::IKdf& coin, Key::Index subIdx, Key::IPKdf& tag, Amount value, uint64_t idx, Height hScheme,
	Height hMinKernel)
{
	Pair p;
	p.m_Output.m_Coinbase = true;

	ECC::Scalar::Native sk;
	p.m_Output.Create(hScheme, sk, coin, CoinID(value, idx, Key::Type::Coinbase, subIdx), tag);

	auto pKrn = std::make_unique<TxKernelStd>();
	pKrn->m_Height.m_Min = hMinKernel;
	pKrn->m_Height.m_Max = MaxHeight;

	// Outputs + kernels + offset = inputs, so the kernel's excess is minus the output's blinding factor,
	// and the pair needs no offset.
	sk = -sk;
	pKrn->Sign(sk);

	p.m_pKernel = std::move(pKrn);
	return p;
}

bool VerifyPair(const Pair& p, Height hScheme, std::string& sErr)
{
	const Output& o = p.m_Output;
	if (!o.m_Coinbase)
		return sErr = "not a coinbase output", false;
	if (!o.m_pPublic || o.m_pConfidential || o.m_pAsset)
		return sErr = "the output must have a public value and no asset", false;
	if (o.m_Incubation)
		return sErr = "the output is time-locked", false;
	if (!o.m_pPublic->m_Value)
		return sErr = "zero value", false;

	ECC::Point::Native comm;
	if (!o.IsValid(hScheme, comm))
		return sErr = "invalid output", false;

	if (!p.m_pKernel || (TxKernel::Subtype::Std != p.m_pKernel->get_Subtype()))
		return sErr = "the kernel must be a standard one", false;

	const auto& krn = Cast::Up<TxKernelStd>(*p.m_pKernel);
	if (krn.m_Fee || krn.m_pHashLock || krn.m_pRelativeLock || krn.m_CanEmbed || !krn.m_vNested.empty())
		return sErr = "the kernel must have no fee, locks or nested kernels", false;
	if (!krn.get_EffectiveHeightRange().IsInRange(hScheme + 1))
		return sErr = "the kernel is not valid at the next height", false;

	ECC::Point::Native exc(Zero);
	try
	{
		krn.TestValid(hScheme, exc);
	}
	catch (const std::exception&)
	{
		return sErr = "invalid kernel signature", false;
	}

	// The pair must balance by itself: commitment + excess = value*H.
	ECC::Point::Native vH(Zero);
	AmountBig::AddTo(vH, AmountBig::Number(o.m_pPublic->m_Value));
	vH = -vH;
	comm += exc;
	comm += vH;
	if (!(comm == Zero))
		return sErr = "the kernel does not balance the output", false;

	return true;
}

bool Ladder::IsStep(Amount v) const
{
	return (v >= get_Unit()) && (v <= get_Step(m_Steps - 1)) && !(v & (v - 1));
}

std::vector<Amount> Ladder::Split(Amount v) const
{
	std::vector<Amount> res;
	for (uint32_t i = m_Steps; i--; )
		while (v >= get_Step(i))
		{
			res.push_back(get_Step(i));
			v -= get_Step(i);
		}
	return res;
}

Coinbase Allocator::Allocate(const std::map<std::string, Amount>& owed, Amount total) const
{
	Coinbase cb;
	cb.m_Total = total;

	// Room for the pool's own pair, whatever is left.
	const size_t nPoolPair = 400;
	size_t nSize = nPoolPair;
	Amount left = total;

	std::vector<std::pair<Amount, std::string>> vOrder;
	for (const auto& [miner, val] : owed)
		vOrder.emplace_back(val, miner);
	std::sort(vOrder.rbegin(), vOrder.rend());

	for (const auto& [val, miner] : vOrder)
	{
		Coinbase::Paid paid;
		paid.m_Miner = miner;
		paid.m_Owed = val;

		auto it = m_Stock.find(miner);
		if (m_Stock.end() != it)
		{
			const Stock& s = it->second;

			std::vector<size_t> vIdx;
			for (size_t i = 0; i < s.m_vPairs.size(); i++)
				if (!s.m_vUsed[i])
					vIdx.push_back(i);
			std::stable_sort(vIdx.begin(), vIdx.end(), [&s](size_t a, size_t b) {
				return s.m_vPairs[a].get_Value() > s.m_vPairs[b].get_Value();
			});

			// Largest first: with powers of two this pays as much as the stock allows.
			for (size_t i : vIdx)
			{
				const Pair& p = s.m_vPairs[i];
				Amount v = p.get_Value();
				size_t n = p.get_Size();
				if ((paid.m_Paid + v > val) || (v > left) || (nSize + n > m_MaxSize))
					continue;

				paid.m_Paid += v;
				left -= v;
				nSize += n;
				paid.m_vPairs.push_back(i);
			}
		}

		cb.m_vPaid.push_back(std::move(paid));
	}

	cb.m_PoolValue = left;
	cb.m_Size = nSize;
	return cb;
}

Transaction::Ptr BuildCoinbaseTx(const Allocator& a, const Coinbase& cb, Key::IKdf& poolCoin, Key::Index poolSubIdx,
	Key::IPKdf& poolTag, Height h)
{
	auto pTx = std::make_shared<Transaction>();
	pTx->m_Offset = Zero;

	auto fnAdd = [&pTx](const Pair& p) {
		// Output has no copy constructor
		Serializer ser;
		ser & p.m_Output;
		auto pOut = std::make_unique<Output>();
		Deserializer der;
		der.reset(ser.buffer().first, ser.buffer().second);
		der & *pOut;
		pTx->m_vOutputs.push_back(std::move(pOut));

		TxKernel::Ptr pKrn;
		p.m_pKernel->Clone(pKrn);
		pTx->m_vKernels.push_back(std::move(pKrn));
	};

	for (const auto& paid : cb.m_vPaid)
	{
		const auto& s = a.m_Stock.at(paid.m_Miner);
		for (size_t i : paid.m_vPairs)
			fnAdd(s.m_vPairs[i]);
	}

	if (cb.m_PoolValue)
		fnAdd(MakePair(poolCoin, poolSubIdx, poolTag, cb.m_PoolValue, h, h, h));

	pTx->Normalize();
	return pTx;
}

} // namespace bb::coinbase
