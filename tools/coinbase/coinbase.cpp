// Copyright 2026 profinch
// SPDX-License-Identifier: Apache-2.0

#include "coinbase.h"

#include "core/block_rw.h"
#include "core/serialization_adapters.h"
#include "mnemonic/mnemonic.h"
#include "utility/hex.h"
#include "utility/serialize.h"

#include <algorithm>
#include <sstream>

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

Height Pair::get_MaxHeight() const
{
	return m_pKernel->get_EffectiveHeightRange().m_Max;
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

bool VerifyPair(const Pair& p, Height hBlock, std::string& sErr)
{
	const Height hScheme = hBlock;
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
	if (!krn.get_EffectiveHeightRange().IsInRange(hBlock))
		return sErr = "the kernel is not valid at the next block", false;

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

namespace {

void AddPairToTx(Transaction& tx, const Pair& p)
{
	// Output has no copy constructor
	Serializer ser;
	ser & p.m_Output;
	auto pOut = std::make_unique<Output>();
	Deserializer der;
	der.reset(ser.buffer().first, ser.buffer().second);
	der & *pOut;
	tx.m_vOutputs.push_back(std::move(pOut));

	TxKernel::Ptr pKrn;
	p.m_pKernel->Clone(pKrn);
	tx.m_vKernels.push_back(std::move(pKrn));
}

} // namespace

Transaction::Ptr BuildCoinbaseTx(const Allocator& a, const Coinbase& cb, Key::IKdf& poolCoin, Key::Index poolSubIdx,
	Key::IPKdf& poolTag, Height h)
{
	auto pTx = std::make_shared<Transaction>();
	pTx->m_Offset = Zero;

	for (const auto& paid : cb.m_vPaid)
	{
		const auto& s = a.m_Stock.at(paid.m_Miner);
		for (size_t i : paid.m_vPairs)
			AddPairToTx(*pTx, s.m_vPairs[i]);
	}

	if (cb.m_PoolValue)
		AddPairToTx(*pTx, MakePair(poolCoin, poolSubIdx, poolTag, cb.m_PoolValue, h, h, h));

	pTx->Normalize();
	return pTx;
}

Transaction::Ptr BuildCoinbaseTx(const std::vector<Pair>& vPairs, Amount total, Key::IKdf& poolCoin,
	Key::Index poolSubIdx, Key::IPKdf& poolTag, Height h, std::vector<size_t>& vDropped)
{
	auto pTx = std::make_shared<Transaction>();
	pTx->m_Offset = Zero;
	vDropped.clear();

	Amount left = total;
	for (size_t i = 0; i < vPairs.size(); i++)
	{
		const Pair& p = vPairs[i];
		std::string sErr;
		// h is the height being mined: the pair must be valid in that block
		if ((p.get_Value() > left) || !VerifyPair(p, h, sErr))
		{
			vDropped.push_back(i);
			continue;
		}
		left -= p.get_Value();
		AddPairToTx(*pTx, p);
	}

	if (left)
		AddPairToTx(*pTx, MakePair(poolCoin, poolSubIdx, poolTag, left, h, h, h));

	pTx->Normalize();
	return pTx;
}

// ---- Keys ----

Key::IKdf::Ptr KdfFromSeedPhrase(const std::string& phrase, std::string& sErr)
{
	WordList words;
	std::istringstream is(phrase);
	std::string w;
	while (is >> w)
	{
		// beam-wallet prints and accepts the phrase with semicolons as well as spaces
		std::string part;
		std::istringstream ws(w);
		while (std::getline(ws, part, ';'))
			if (!part.empty())
				words.push_back(part);
	}
	if (words.size() != 12)
		return sErr = "a seed phrase has 12 words", nullptr;
	if (!isValidMnemonic(words))
		return sErr = "not a valid seed phrase", nullptr;

	std::vector<uint8_t> buf = decodeMnemonic(words);
	ECC::NoLeak<ECC::uintBig> seed;
	ECC::Hash::Processor() << Blob(buf.data(), static_cast<uint32_t>(buf.size())) >> seed.V;

	Key::IKdf::Ptr pKdf;
	ECC::HKdf::Create(pKdf, seed.V);
	return pKdf;
}

Key::IKdf::Ptr ImportMinerKey(const std::string& s, const std::string& pass)
{
	KeyString ks;
	ks.SetPassword(Blob(pass.data(), static_cast<uint32_t>(pass.size())));
	ks.m_sRes = s;
	auto pKdf = std::make_shared<ECC::HKdf>();
	if (!ks.Import(*pKdf))
		return nullptr;
	return pKdf;
}

Key::IPKdf::Ptr ImportOwnerKey(const std::string& s, const std::string& pass)
{
	KeyString ks;
	ks.SetPassword(Blob(pass.data(), static_cast<uint32_t>(pass.size())));
	ks.m_sRes = s;
	auto pKdf = std::make_shared<ECC::HKdfPub>();
	if (!ks.Import(*pKdf))
		return nullptr;
	return pKdf;
}

std::string OwnerFingerprint(Key::IPKdf& kdf)
{
	uint32_t n = kdf.ExportP(nullptr);
	std::vector<uint8_t> buf(n);
	kdf.ExportP(buf.data());
	ECC::Hash::Value hv;
	ECC::Hash::Processor() << Blob(buf.data(), n) >> hv;
	return to_hex(hv.m_pData, 8);
}

// ---- Identity ----

Identity Identity::Derive(Key::IKdf& minerKey)
{
	Identity id;
	ECC::Hash::Value hv;
	ECC::Hash::Processor() << "bumblebeam-coinbase-identity" >> hv;
	minerKey.DeriveKey(id.m_sk, hv);
	ECC::Point::Native pt = ECC::Context::get().G * id.m_sk;
	id.m_pk = pt;
	return id;
}

std::string AccountFromPk(const ECC::Point& pk)
{
	Serializer ser;
	ser & pk;
	auto [p, n] = ser.buffer();
	return "cb:" + to_hex(p, n);
}

std::string Identity::get_Account() const
{
	return AccountFromPk(m_pk);
}

bool ParseAccount(const std::string& s, ECC::Point::Native& pk)
{
	if ((s.size() != 3 + 66) || (s.compare(0, 3, "cb:") != 0))
		return false;
	bool bHex = false;
	std::vector<uint8_t> buf = from_hex(s.substr(3), &bHex);
	if (!bHex || (buf.size() != 33))
		return false;
	try
	{
		ECC::Point pt;
		Deserializer der;
		der.reset(buf);
		der & pt;
		return pk.ImportNnz(pt);
	}
	catch (const std::exception&)
	{
		return false;
	}
}

ECC::Hash::Value UploadHash(const ECC::Point& pk, uint64_t ts, const std::vector<std::string>& vPairsHex)
{
	ECC::Hash::Processor hp;
	hp << "bumblebeam-coinbase-upload" << pk << ts << static_cast<uint64_t>(vPairsHex.size());
	for (const auto& s : vPairsHex)
		hp << s;
	ECC::Hash::Value hv;
	hp >> hv;
	return hv;
}

std::string SignUpload(const Identity& id, uint64_t ts, const std::vector<std::string>& vPairsHex)
{
	ECC::Signature sig;
	sig.Sign(UploadHash(id.m_pk, ts, vPairsHex), id.m_sk);
	Serializer ser;
	ser & sig;
	auto [p, n] = ser.buffer();
	return to_hex(p, n);
}

bool VerifyUpload(const std::string& account, uint64_t ts, const std::vector<std::string>& vPairsHex,
	const std::string& sigHex)
{
	ECC::Point::Native pk;
	if (!ParseAccount(account, pk))
		return false;

	bool bHex = false;
	std::vector<uint8_t> buf = from_hex(sigHex, &bHex);
	if (!bHex || buf.empty())
		return false;

	ECC::Signature sig;
	try
	{
		Deserializer der;
		der.reset(buf);
		der & sig;
		if (der.bytes_left())
			return false;
	}
	catch (const std::exception&)
	{
		return false;
	}

	ECC::Point pkPacked;
	pk.Export(pkPacked);
	return sig.IsValid(UploadHash(pkPacked, ts, vPairsHex), pk);
}

} // namespace bb::coinbase
