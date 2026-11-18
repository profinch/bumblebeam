// This file is a part of RCKangaroo software
// (c) 2024, RetiredCoder (RC)
// License: GPLv3, see "LICENSE.TXT" file
// https://github.com/RetiredC


#include <iostream>
#include <vector>

#include "cuda_runtime.h"
#include "cuda.h"

#include "defs.h"
#include "utils.h"
#include "GpuKang.h"
#include <signal.h>


EcJMP EcJumps1[JMP_CNT];
EcJMP EcJumps2[JMP_CNT];
EcJMP EcJumps3[JMP_CNT];

RCGpuKang* GpuKangs[MAX_GPU_CNT];
int GpuCnt;
volatile long ThrCnt;
volatile bool gSolved;

EcInt Int_HalfRange;
EcPoint Pnt_HalfRange;
EcPoint Pnt_NegHalfRange;
EcInt Int_TameOffset;
Ec ec;

CriticalSection csAddPoints;
u8* pPntList;
u8* pPntList2;
volatile int PntIndex;
TFastBase db;
EcPoint gPntToSolve;
EcInt gPrivKey;

volatile u64 TotalOps;
u32 TotalSolved;
u32 gTotalErrors;
u64 PntTotalOps;
// bb: persistence (-db), periodic save (-save), merge of other DP files (-merge), Ctrl-C safe stop
char gDbFileName[1024];
int gSaveMin = 10;
char gMergeFiles[16][1024];
int gMergeCnt = 0;
volatile bool gStopReq = false;
u64 gJumpsHash = 0;
static void OnSigInt(int) { gStopReq = true; }
int gBlocksLimit = 0; // bb: -blocks N limits GPU blocks (fewer kangaroos; for K benchmarks and shared GPUs)
int gLayout = 1;      // bb: -layout 0|1 herd start layout
bool IsBench;

u32 gDP;
u32 gRange;
EcInt gStart;
bool gStartSet;
EcPoint gPubKey;
u8 gGPUs_Mask[MAX_GPU_CNT];
char gTamesFileName[1024];
double gMax;
bool gGenMode; //tames generation mode
bool gIsOpsLimit;

#pragma pack(push, 1)
struct DBRec
{
	u8 x[12];
	u8 d[22];
	u8 type; //0 - tame, 1 - wild1, 2 - wild2
};
#pragma pack(pop)

void InitGpus()
{
	GpuCnt = 0;
	int gcnt = 0;
	cudaGetDeviceCount(&gcnt);
	if (gcnt > MAX_GPU_CNT)
		gcnt = MAX_GPU_CNT;

//	gcnt = 1; //dbg
	if (!gcnt)
		return;

	int drv, rt;
	cudaRuntimeGetVersion(&rt);
	cudaDriverGetVersion(&drv);
	char drvver[100];
	sprintf(drvver, "%d.%d/%d.%d", drv / 1000, (drv % 100) / 10, rt / 1000, (rt % 100) / 10);

	printf("CUDA devices: %d, CUDA driver/runtime: %s\r\n", gcnt, drvver);
	cudaError_t cudaStatus;
	for (int i = 0; i < gcnt; i++)
	{
		cudaStatus = cudaSetDevice(i);
		if (cudaStatus != cudaSuccess)
		{
			printf("cudaSetDevice for gpu %d failed!\r\n", i);
			continue;
		}

		if (!gGPUs_Mask[i])
			continue;

		cudaDeviceProp deviceProp;
		cudaGetDeviceProperties(&deviceProp, i);
		printf("GPU %d: %s, %.2f GB, %d CUs, cap %d.%d, PCI %d, L2 size: %d KB\r\n", i, deviceProp.name, ((float)(deviceProp.totalGlobalMem / (1024 * 1024))) / 1024.0f, deviceProp.multiProcessorCount, deviceProp.major, deviceProp.minor, deviceProp.pciBusID, deviceProp.l2CacheSize / 1024);
		
		if (deviceProp.major < 6)
		{
			printf("GPU %d - not supported, skip\r\n", i);
			continue;
		}

		cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync);

		GpuKangs[GpuCnt] = new RCGpuKang();
		GpuKangs[GpuCnt]->CudaIndex = i;
		GpuKangs[GpuCnt]->persistingL2CacheMaxSize = deviceProp.persistingL2CacheMaxSize;
		GpuKangs[GpuCnt]->mpCnt = deviceProp.multiProcessorCount;
		GpuKangs[GpuCnt]->IsOldGpu = deviceProp.l2CacheSize < 16 * 1024 * 1024;
		GpuCnt++;
	}
	printf("Total GPUs for work: %d\r\n", GpuCnt);
}
#ifdef _WIN32
u32 __stdcall kang_thr_proc(void* data)
{
	RCGpuKang* Kang = (RCGpuKang*)data;
	Kang->Execute();
	InterlockedDecrement(&ThrCnt);
	return 0;
}
#else
void* kang_thr_proc(void* data)
{
	RCGpuKang* Kang = (RCGpuKang*)data;
	Kang->Execute();
	__sync_fetch_and_sub(&ThrCnt, 1);
	return 0;
}
#endif
void AddPointsToList(u32* data, int pnt_cnt, u64 ops_cnt)
{
	csAddPoints.Enter();
	PntTotalOps += ops_cnt;
	if (!pnt_cnt)
	{
		csAddPoints.Leave();
		return;
	}
	if (PntIndex + pnt_cnt >= MAX_CNT_LIST)
	{
		csAddPoints.Leave();
		printf("DPs buffer overflow, some points lost, increase DP value!\r\n");
		return;
	}
	memcpy(pPntList + GPU_DP_SIZE * PntIndex, data, pnt_cnt * GPU_DP_SIZE);
	PntIndex += pnt_cnt;
	csAddPoints.Leave();
}

bool Collision_SOTA(EcPoint& pnt, EcInt t, int TameType, EcInt w, int WildType, bool IsNeg)
{
	if (IsNeg)
		t.Neg();
	if (TameType == TAME)
	{
		gPrivKey = t;
		gPrivKey.Sub(w);
		EcInt sv = gPrivKey;
		gPrivKey.Add(Int_HalfRange);
		EcPoint P = ec.MultiplyG(gPrivKey);
		if (P.IsEqual(pnt))
			return true;
		gPrivKey = sv;
		gPrivKey.Neg();
		gPrivKey.Add(Int_HalfRange);
		P = ec.MultiplyG(gPrivKey);
		return P.IsEqual(pnt);
	}
	else
	{
		gPrivKey = t;
		gPrivKey.Sub(w);
		if (gPrivKey.data[4] >> 63)
			gPrivKey.Neg();
		gPrivKey.ShiftRight(1);
		EcInt sv = gPrivKey;
		gPrivKey.Add(Int_HalfRange);
		EcPoint P = ec.MultiplyG(gPrivKey);
		if (P.IsEqual(pnt))
			return true;
		gPrivKey = sv;
		gPrivKey.Neg();
		gPrivKey.Add(Int_HalfRange);
		P = ec.MultiplyG(gPrivKey);
		return P.IsEqual(pnt);
	}
}


// bb: one DP record through the DB + collision check. Returns true when the key was found (gPrivKey set).
bool ProcessDP(DBRec& nrec)
{
	DBRec* pref = (DBRec*)db.FindOrAddDataBlock((u8*)&nrec);
	if (gGenMode)
		return false;
	if (!pref)
		return false;
	//in db we dont store first 3 bytes so restore them
	DBRec tmp_pref;
	memcpy(&tmp_pref, &nrec, 3);
	memcpy(((u8*)&tmp_pref) + 3, pref, sizeof(DBRec) - 3);
	pref = &tmp_pref;

	if (pref->type == nrec.type)
	{
		if (pref->type == TAME)
			return false;
		//if it's wild, we can find the key from the same type if distances are different
		if (*(u64*)pref->d == *(u64*)nrec.d)
			return false;
	}

	EcInt w, t;
	int TameType, WildType;
	if (pref->type != TAME)
	{
		memcpy(w.data, pref->d, sizeof(pref->d));
		if (pref->d[21] == 0xFF) memset(((u8*)w.data) + 22, 0xFF, 18);
		memcpy(t.data, nrec.d, sizeof(nrec.d));
		if (nrec.d[21] == 0xFF) memset(((u8*)t.data) + 22, 0xFF, 18);
		TameType = nrec.type;
		WildType = pref->type;
	}
	else
	{
		memcpy(w.data, nrec.d, sizeof(nrec.d));
		if (nrec.d[21] == 0xFF) memset(((u8*)w.data) + 22, 0xFF, 18);
		memcpy(t.data, pref->d, sizeof(pref->d));
		if (pref->d[21] == 0xFF) memset(((u8*)t.data) + 22, 0xFF, 18);
		TameType = TAME;
		WildType = nrec.type;
	}

	bool res = Collision_SOTA(gPntToSolve, t, TameType, w, WildType, false) || Collision_SOTA(gPntToSolve, t, TameType, w, WildType, true);
	if (!res)
	{
		bool w12 = ((pref->type == WILD1) && (nrec.type == WILD2)) || ((pref->type == WILD2) && (nrec.type == WILD1));
		if (!w12) //in rare cases WILD and WILD2 can collide in mirror, in this case there is no way to find K
		{
			char s1[80], s2[80]; t.GetHexStr(s1); w.GetHexStr(s2);
			printf("Collision Error: types %d/%d, same_d=%d\r\n  t=%s\r\n  w=%s\r\n", pref->type, nrec.type, (*(u64*)pref->d == *(u64*)nrec.d), s1, s2);
			gTotalErrors++;
		}
		return false;
	}
	return true;
}

void CheckNewPoints()
{
	csAddPoints.Enter();
	if (!PntIndex)
	{
		csAddPoints.Leave();
		return;
	}

	int cnt = PntIndex;
	memcpy(pPntList2, pPntList, GPU_DP_SIZE * cnt);
	PntIndex = 0;
	csAddPoints.Leave();

	for (int i = 0; i < cnt; i++)
	{
		DBRec nrec;
		u8* p = pPntList2 + i * GPU_DP_SIZE;
		memcpy(nrec.x, p, 12);
		memcpy(nrec.d, p + 16, 22);
		nrec.type = gGenMode ? TAME : p[40];
		if (ProcessDP(nrec))
		{
			gSolved = true;
			break;
		}
	}
}

// ---- bb: DB file header (256 bytes). RC tames files (no magic, Header[0]=range) are still accepted as tames-only. ----
// 0..7 magic "BBKDB001" | 8 range | 9 dp | 10 layout | 11 flags | 16 jumps hash u64 | 24 ops u64 | 32..63 pubkey x | 64..95 pubkey y | 96..127 start
static const char BB_MAGIC[8] = { 'B','B','K','D','B','0','0','1' };
static u64 HashJumps()
{
	u64 h = 1469598103934665603ULL;
	for (int t = 0; t < 3; t++)
	{
		EcJMP* J = (t == 0) ? EcJumps1 : (t == 1) ? EcJumps2 : EcJumps3;
		for (int i = 0; i < JMP_CNT; i++)
			for (int k = 0; k < 3; k++)
			{
				h ^= J[i].dist.data[k];
				h *= 1099511628211ULL;
			}
	}
	return h;
}
static void FillHeader(u8* hdr, int Range, int dp)
{
	memset(hdr, 0, 256);
	memcpy(hdr, BB_MAGIC, 8);
	hdr[8] = (u8)Range; hdr[9] = (u8)dp; hdr[10] = (u8)gLayout; hdr[11] = gPubKey.x.IsZero() ? 0 : 1;
	memcpy(hdr + 16, &gJumpsHash, 8);
	memcpy(hdr + 24, &PntTotalOps, 8);
	memcpy(hdr + 32, gPubKey.x.data, 32);
	memcpy(hdr + 64, gPubKey.y.data, 32);
	memcpy(hdr + 96, gStart.data, 32);
}
// returns: -1 incompatible, 0 compatible tames only, 1 fully compatible (wild records usable)
static int CheckHeader(u8* hdr, int Range, const char* what)
{
	if (memcmp(hdr, BB_MAGIC, 8))
	{
		if (hdr[0] != (u8)Range) { printf("%s: RC tames file with different range, skipped\r\n", what); return -1; }
		printf("%s: RC tames file, tames only\r\n", what);
		return 0;
	}
	if (hdr[8] != (u8)Range) { printf("%s: different range (%d), skipped\r\n", what, hdr[8]); return -1; }
	u64 jh; memcpy(&jh, hdr + 16, 8);
	if (jh != gJumpsHash) { printf("%s: different jump tables, skipped\r\n", what); return -1; }
	bool samekey = (hdr[11] == 1) && !memcmp(hdr + 32, gPubKey.x.data, 32) && !memcmp(hdr + 64, gPubKey.y.data, 32) && !memcmp(hdr + 96, gStart.data, 32);
	if (hdr[9] != (u8)gDP) printf("%s: note: file DP=%d, current DP=%d (records are compatible)\r\n", what, hdr[9], gDP);
	if (!samekey) { printf("%s: other target or start, tames only\r\n", what); return 0; }
	return 1;
}
static bool SaveDb(int Range, int dp)
{
	if (!gDbFileName[0])
		return true;
	char tmp[1100];
	snprintf(tmp, sizeof(tmp), "%s.tmp", gDbFileName);
	FillHeader(db.Header, Range, dp);
	if (!db.SaveToFile(tmp))
	{
		printf("DB save failed: %s\r\n", tmp);
		return false;
	}
	if (rename(tmp, gDbFileName))
	{
		printf("DB rename failed\r\n");
		return false;
	}
	printf("DB saved: %s (%llu records, ops 2^%.3f)\r\n", gDbFileName, (unsigned long long)db.GetBlockCnt(), log2((double)PntTotalOps + 1));
	return true;
}
// bb: verify a DP record by recomputing its point: tame = d*G, wild1 = PntA + d*G, wild2 = -PntA + d*G, PntA = PntToSolve - (N/2)*G.
// Compares the low 12 bytes of x. This is the pool's proof-of-work check (one scalar multiplication per DP).
static bool VerifyRecord(DBRec& rec)
{
	EcInt d;
	memcpy(d.data, rec.d, 22);
	bool neg = (rec.d[21] == 0xFF);
	if (neg) { memset(((u8*)d.data) + 22, 0xFF, 18); d.Neg(); }
	else memset(((u8*)d.data) + 22, 0, 18);
	EcPoint P = ec.MultiplyG(d);
	if (neg) P.y.NegModP();
	if (rec.type != TAME)
	{
		EcPoint A = ec.AddPoints(gPntToSolve, Pnt_NegHalfRange);
		if (rec.type == WILD2) A.y.NegModP();
		P = ec.AddPoints(P, A);
	}
	return memcmp(P.x.data, rec.x, 12) == 0;
}
struct TVerifyCtx { u64 n, bad, every; };
static void VerifyCb(u8* rec35, void* ctx)
{
	TVerifyCtx* c = (TVerifyCtx*)ctx;
	c->n++;
	if (c->n % c->every)
		return;
	if (!VerifyRecord(*(DBRec*)rec35))
	{
		c->bad++;
		if (c->bad <= 5)
		{
			DBRec* r = (DBRec*)rec35;
			printf("verify: BAD record #%llu type %d d[0..7]=%016llx\r\n", (unsigned long long)c->n, r->type, *(unsigned long long*)r->d);
		}
	}
}
int gVerifyEvery = 0; // -verify N: check every N-th record of loaded/merged files
struct TMergeCtx { int keepType; u64 n, added; bool solved; };
static void MergeCb(u8* rec35, void* ctx)
{
	TMergeCtx* c = (TMergeCtx*)ctx;
	if (c->solved)
		return;
	DBRec* nrec = (DBRec*)rec35;
	if ((c->keepType >= 0) && (nrec->type != c->keepType))
		return;
	c->n++;
	if (ProcessDP(*nrec))
		c->solved = true;
}
static bool MergeFile(char* fn, int Range)
{
	u8 hdr[256];
	FILE* fp = fopen(fn, "rb");
	if (!fp) { printf("merge: cannot open %s\r\n", fn); return false; }
	size_t got = fread(hdr, 1, 256, fp);
	fclose(fp);
	if (got != 256) { printf("merge: bad file %s\r\n", fn); return false; }
	int c = CheckHeader(hdr, Range, fn);
	if (c < 0)
		return false;
	TMergeCtx ctx = { c == 1 ? -1 : TAME, 0, 0, false };
	u64 before = db.GetBlockCnt();
	if (!db.StreamFile(fn, NULL, MergeCb, &ctx)) { printf("merge: read error in %s\r\n", fn); }
	printf("merge: %s: %llu records read, DB %llu -> %llu%s\r\n", fn, (unsigned long long)ctx.n, (unsigned long long)before, (unsigned long long)db.GetBlockCnt(), ctx.solved ? ", KEY FOUND" : "");
	if (gVerifyEvery > 0)
	{
		TVerifyCtx vc = { 0, 0, (u64)gVerifyEvery };
		db.StreamFile(fn, NULL, VerifyCb, &vc);
		printf("verify: %s: checked %llu of %llu records, bad %llu\r\n", fn, (unsigned long long)(vc.n / vc.every), (unsigned long long)vc.n, (unsigned long long)vc.bad);
	}
	if (ctx.solved)
		gSolved = true;
	return true;
}

void ShowStats(u64 tm_start, double exp_ops, double dp_val)
{
#ifdef DEBUG_MODE
	for (int i = 0; i <= MD_LEN; i++)
	{
		u64 val = 0;
		for (int j = 0; j < GpuCnt; j++)
		{
			val += GpuKangs[j]->dbg[i];
		}
		if (val)
			printf("Loop size %d: %llu\r\n", i, val);
	}
#endif

	int speed = GpuKangs[0]->GetStatsSpeed();
	for (int i = 1; i < GpuCnt; i++)
		speed += GpuKangs[i]->GetStatsSpeed();

	u64 est_dps_cnt = (u64)(exp_ops / dp_val);
	u64 exp_sec = 0xFFFFFFFFFFFFFFFFull;
	if (speed)
		exp_sec = (u64)((exp_ops / 1000000) / speed); //in sec
	u64 exp_days = exp_sec / (3600 * 24);
	int exp_hours = (int)(exp_sec - exp_days * (3600 * 24)) / 3600;
	int exp_min = (int)(exp_sec - exp_days * (3600 * 24) - exp_hours * 3600) / 60;

	u64 sec = (GetTickCount64() - tm_start) / 1000;
	u64 days = sec / (3600 * 24);
	int hours = (int)(sec - days * (3600 * 24)) / 3600;
	int min = (int)(sec - days * (3600 * 24) - hours * 3600) / 60;
	 
	printf("%sSpeed: %d MKeys/s, Err: %d, DPs: %lluK/%lluK, Time: %llud:%02dh:%02dm/%llud:%02dh:%02dm\r\n", gGenMode ? "GEN: " : (IsBench ? "BENCH: " : "MAIN: "), speed, gTotalErrors, db.GetBlockCnt()/1000, est_dps_cnt/1000, days, hours, min, exp_days, exp_hours, exp_min);
}

bool SolvePoint(EcPoint PntToSolve, int Range, int DP, EcInt* pk_res)
{
	if ((Range < 32) || (Range > 180))
	{
		printf("Unsupported Range value (%d)!\r\n", Range);
		return false;
	}
	if ((DP < 8) || (DP > 60)) // bb
	{
		printf("Unsupported DP value (%d)!\r\n", DP);
		return false;
	}

	printf("\r\nSolving point: Range %d bits, DP %d, start...\r\n", Range, DP);
	double ops = 1.15 * pow(2.0, Range / 2.0);
	double dp_val = (double)(1ull << DP);
	double ram = (32 + 4 + 4) * ops / dp_val; //+4 for grow allocation and memory fragmentation
	ram += sizeof(TListRec) * 256 * 256 * 256; //3byte-prefix table
	ram /= (1024 * 1024 * 1024); //GB
	printf("SOTA method, estimated ops: 2^%.3f, RAM for DPs: %.3f GB. DP and GPU overheads not included!\r\n", log2(ops), ram);
	gIsOpsLimit = false;
	double MaxTotalOps = 0.0;
	if (gMax > 0)
	{
		MaxTotalOps = gMax * ops;
		double ram_max = (32 + 4 + 4) * MaxTotalOps / dp_val; //+4 for grow allocation and memory fragmentation
		ram_max += sizeof(TListRec) * 256 * 256 * 256; //3byte-prefix table
		ram_max /= (1024 * 1024 * 1024); //GB
		printf("Max allowed number of ops: 2^%.3f, max RAM for DPs: %.3f GB\r\n", log2(MaxTotalOps), ram_max);
	}

	u64 total_kangs = GpuKangs[0]->CalcKangCnt();
	for (int i = 1; i < GpuCnt; i++)
		total_kangs += GpuKangs[i]->CalcKangCnt();
	double path_single_kang = ops / total_kangs;	
	double DPs_per_kang = path_single_kang / dp_val;
	printf("Estimated DPs per kangaroo: %.3f.%s\r\n", DPs_per_kang, (DPs_per_kang < 5) ? " DP overhead is big, use less DP value if possible!" : "");

	if (!gGenMode && gTamesFileName[0])
	{
		printf("load tames...\r\n");
		if (db.LoadFromFile(gTamesFileName))
		{
			printf("tames loaded\r\n");
			if (db.Header[0] != gRange)
			{
				printf("loaded tames have different range, they cannot be used, clear\r\n");
				db.Clear();
			}
		}
		else
			printf("tames loading failed\r\n");
	}

	SetRndSeed(0); //use same seed to make tames from file compatible
	PntTotalOps = 0;
	PntIndex = 0;
//prepare jumps
	EcInt minjump, t;
	minjump.Set(1);
	minjump.ShiftLeft(Range / 2 + 3);
	for (int i = 0; i < JMP_CNT; i++)
	{
		EcJumps1[i].dist = minjump;
		t.RndMax(minjump);
		EcJumps1[i].dist.Add(t);
		EcJumps1[i].dist.data[0] &= 0xFFFFFFFFFFFFFFFE; //must be even
		EcJumps1[i].p = ec.MultiplyG(EcJumps1[i].dist);
	}

	minjump.Set(1);
	minjump.ShiftLeft(Range - 10); //large jumps for L1S2 loops. Must be almost RANGE_BITS
	for (int i = 0; i < JMP_CNT; i++)
	{
		EcJumps2[i].dist = minjump;
		t.RndMax(minjump);
		EcJumps2[i].dist.Add(t);
		EcJumps2[i].dist.data[0] &= 0xFFFFFFFFFFFFFFFE; //must be even
		EcJumps2[i].p = ec.MultiplyG(EcJumps2[i].dist);
	}

	minjump.Set(1);
	minjump.ShiftLeft(Range - 10 - 2); //large jumps for loops >2
	for (int i = 0; i < JMP_CNT; i++)
	{
		EcJumps3[i].dist = minjump;
		t.RndMax(minjump);
		EcJumps3[i].dist.Add(t);
		EcJumps3[i].dist.data[0] &= 0xFFFFFFFFFFFFFFFE; //must be even
		EcJumps3[i].p = ec.MultiplyG(EcJumps3[i].dist);
	}
	SetRndSeed(GetTickCount64());
	gJumpsHash = HashJumps(); // bb

	Int_HalfRange.Set(1);
	Int_HalfRange.ShiftLeft(Range - 1);
	Pnt_HalfRange = ec.MultiplyG(Int_HalfRange);
	Pnt_NegHalfRange = Pnt_HalfRange;
	Pnt_NegHalfRange.y.NegModP();
	Int_TameOffset.Set(1);
	Int_TameOffset.ShiftLeft(Range - 1);
	EcInt tt;
	tt.Set(1);
	tt.ShiftLeft(Range - 5); //half of tame range width
	Int_TameOffset.Sub(tt);
	gPntToSolve = PntToSolve;
	// bb: load own DB (resume) and merge other DP files
	if (gDbFileName[0] && IsFileExist(gDbFileName))
	{
		u8 hdr[256];
		FILE* fp = fopen(gDbFileName, "rb");
		if (fp && fread(hdr, 1, 256, fp) == 256)
		{
			fclose(fp);
			int c = CheckHeader(hdr, Range, gDbFileName);
			if (c >= 0)
			{
				if (db.LoadFromFile(gDbFileName, c == 1 ? -1 : TAME))
				{
					u64 ops = 0; if (!memcmp(hdr, BB_MAGIC, 8)) memcpy(&ops, hdr + 24, 8);
					if (c == 1) PntTotalOps = ops;
					printf("DB loaded: %llu records, previous ops 2^%.3f\r\n", (unsigned long long)db.GetBlockCnt(), log2((double)ops + 1));
				}
				else
					printf("DB loading failed\r\n");
			}
		}
		else if (fp)
			fclose(fp);
	}
	for (int i = 0; i < gMergeCnt; i++)
		MergeFile(gMergeFiles[i], Range);
	if (gSolved)
	{
		printf("Key found while merging DP files\r\n");
		SaveDb(Range, DP);
		double K = (double)PntTotalOps / pow(2.0, Range / 2.0);
		printf("Point solved, K: %.3f\r\n\r\n", K);
		db.Clear();
		*pk_res = gPrivKey;
		return true;
	}
	signal(SIGINT, OnSigInt);

//prepare GPUs
	for (int i = 0; i < GpuCnt; i++)
		if (!GpuKangs[i]->Prepare(PntToSolve, Range, DP, EcJumps1, EcJumps2, EcJumps3))
		{
			GpuKangs[i]->Failed = true;
			printf("GPU %d Prepare failed\r\n", GpuKangs[i]->CudaIndex);
		}

	u64 tm0 = GetTickCount64();
	printf("GPUs started...\r\n");

#ifdef _WIN32
	HANDLE thr_handles[MAX_GPU_CNT];
#else
	pthread_t thr_handles[MAX_GPU_CNT];
#endif

	u32 ThreadID;
	gSolved = false;
	ThrCnt = GpuCnt;
	for (int i = 0; i < GpuCnt; i++)
	{
#ifdef _WIN32
		thr_handles[i] = (HANDLE)_beginthreadex(NULL, 0, kang_thr_proc, (void*)GpuKangs[i], 0, &ThreadID);
#else
		pthread_create(&thr_handles[i], NULL, kang_thr_proc, (void*)GpuKangs[i]);
#endif
	}

	u64 tm_stats = GetTickCount64();
	u64 tm_save = GetTickCount64();
	while (!gSolved)
	{
		CheckNewPoints();
		Sleep(10);
		if (gStopReq)
		{
			printf("Stop requested\r\n");
			break;
		}
		if (gDbFileName[0] && (gSaveMin > 0) && (GetTickCount64() - tm_save > (u64)gSaveMin * 60 * 1000))
		{
			SaveDb(Range, DP);
			tm_save = GetTickCount64();
		}
		if (GetTickCount64() - tm_stats > 10 * 1000)
		{
			ShowStats(tm0, ops, dp_val);
			tm_stats = GetTickCount64();
		}

		if ((MaxTotalOps > 0.0) && (PntTotalOps > MaxTotalOps))
		{
			gIsOpsLimit = true;
			printf("Operations limit reached\r\n");
			break;
		}
		if (!ThrCnt) // bb: all GPU threads died (Prepare/Start/cudaMemcpy failure): stop instead of spinning forever
		{
			printf("All GPU threads stopped, aborting\r\n");
			gTotalErrors++;
			break;
		}
	}

	printf("Stopping work ...\r\n");
	for (int i = 0; i < GpuCnt; i++)
		GpuKangs[i]->Stop();
	while (ThrCnt)
		Sleep(10);
	if (!gSolved)
		CheckNewPoints(); // bb: drain DPs delivered after the last loop pass so the saved DB is complete
	for (int i = 0; i < GpuCnt; i++)
	{
#ifdef _WIN32
		CloseHandle(thr_handles[i]);
#else
		pthread_join(thr_handles[i], NULL);
#endif
	}

	if (gIsOpsLimit || gStopReq)
	{
		if (!gGenMode)
			SaveDb(Range, DP);
		if (gGenMode)
		{
			printf("saving tames...\r\n");
			db.Header[0] = gRange; 
			if (db.SaveToFile(gTamesFileName))
				printf("tames saved\r\n");
			else
				printf("tames saving failed\r\n");
		}
		db.Clear();
		return false;
	}

	double K = (double)PntTotalOps / pow(2.0, Range / 2.0);
	printf("Point solved, K: %.3f (with DP and GPU overheads)\r\n\r\n", K);
	SaveDb(Range, DP);
	db.Clear();
	*pk_res = gPrivKey;
	return true;
}

bool ParseCommandLine(int argc, char* argv[])
{
	int ci = 1;
	while (ci < argc)
	{
		char* argument = argv[ci];
		ci++;
		if (strcmp(argument, "-gpu") == 0)
		{
			if (ci >= argc)
			{
				printf("error: missed value after -gpu option\r\n");
				return false;
			}
			char* gpus = argv[ci];
			ci++;
			memset(gGPUs_Mask, 0, sizeof(gGPUs_Mask));
			for (int i = 0; i < (int)strlen(gpus); i++)
			{
				if ((gpus[i] < '0') || (gpus[i] > '9'))
				{
					printf("error: invalid value for -gpu option\r\n");
					return false;
				}
				gGPUs_Mask[gpus[i] - '0'] = 1;
			}
		}
		else
		if (strcmp(argument, "-dp") == 0)
		{
			int val = atoi(argv[ci]);
			ci++;
			if ((val < 8) || (val > 60)) // bb: dp>=8 allowed for small-range K benchmarks (GPU DP buffer: KangCnt*1000/2^dp must stay < MAX_DP_CNT)
			{
				printf("error: invalid value for -dp option\r\n");
				return false;
			}
			gDP = val;
		}
		else
		if (strcmp(argument, "-range") == 0)
		{
			int val = atoi(argv[ci]);
			ci++;
			if ((val < 32) || (val > 170))
			{
				printf("error: invalid value for -range option\r\n");
				return false;
			}
			gRange = val;
		}
		else
		if (strcmp(argument, "-start") == 0)
		{	
			if (!gStart.SetHexStr(argv[ci]))
			{
				printf("error: invalid value for -start option\r\n");
				return false;
			}
			ci++;
			gStartSet = true;
		}
		else
		if (strcmp(argument, "-pubkey") == 0)
		{
			if (!gPubKey.SetHexStr(argv[ci]))
			{
				printf("error: invalid value for -pubkey option\r\n");
				return false;
			}
			ci++;
		}
		else
		if (strcmp(argument, "-tames") == 0)
		{
			strcpy(gTamesFileName, argv[ci]);
			ci++;
		}
		else
		if (strcmp(argument, "-db") == 0)
		{
			strncpy(gDbFileName, argv[ci], sizeof(gDbFileName) - 1);
			ci++;
		}
		else
		if (strcmp(argument, "-save") == 0)
		{
			gSaveMin = atoi(argv[ci]);
			ci++;
		}
		else
		if (strcmp(argument, "-merge") == 0)
		{
			if (gMergeCnt < 16)
				strncpy(gMergeFiles[gMergeCnt++], argv[ci], 1023);
			ci++;
		}
		else
		if (strcmp(argument, "-verify") == 0)
		{
			gVerifyEvery = atoi(argv[ci]);
			ci++;
		}
		else
		if (strcmp(argument, "-blocks") == 0)
		{
			gBlocksLimit = atoi(argv[ci]);
			ci++;
		}
		else
		if (strcmp(argument, "-layout") == 0)
		{
			gLayout = atoi(argv[ci]);
			ci++;
		}
		else
		if (strcmp(argument, "-max") == 0)
		{
			double val = atof(argv[ci]);
			ci++;
			if (val < 0.001)
			{
				printf("error: invalid value for -max option\r\n");
				return false;
			}
			gMax = val;
		}
		else
		{
			printf("error: unknown option %s\r\n", argument);
			return false;
		}
	}
	if (!gPubKey.x.IsZero())
		if (!gStartSet || !gRange || !gDP)
		{
			printf("error: you must also specify -dp, -range and -start options\r\n");
			return false;
		}
	if (gTamesFileName[0] && !IsFileExist(gTamesFileName))
	{
		if (gMax == 0.0)
		{
			printf("error: you must also specify -max option to generate tames\r\n");
			return false;
		}
		gGenMode = true;
	}
	return true;
}

int main(int argc, char* argv[])
{
#ifdef _DEBUG	
	_CrtSetDbgFlag(_CRTDBG_ALLOC_MEM_DF | _CRTDBG_LEAK_CHECK_DF);
#endif

	printf("********************************************************************************\r\n");
	printf("*                    RCKangaroo v3.1  (c) 2024 RetiredCoder                    *\r\n");
	printf("********************************************************************************\r\n\r\n");

	printf("This software is free and open-source: https://github.com/RetiredC\r\n");
	printf("It demonstrates fast GPU implementation of SOTA Kangaroo method for solving ECDLP\r\n");

#ifdef _WIN32
	printf("Windows version\r\n");
#else
	printf("Linux version\r\n");
#endif

#ifdef DEBUG_MODE
	printf("DEBUG MODE\r\n\r\n");
#endif

	InitEc();
	gDP = 0;
	gRange = 0;
	gStartSet = false;
	gTamesFileName[0] = 0;
	gDbFileName[0] = 0;
	gMax = 0.0;
	gGenMode = false;
	gIsOpsLimit = false;
	memset(gGPUs_Mask, 1, sizeof(gGPUs_Mask));
	if (!ParseCommandLine(argc, argv))
		return 0;

	InitGpus();

	if (!GpuCnt)
	{
		printf("No supported GPUs detected, exit\r\n");
		return 0;
	}

	pPntList = (u8*)malloc(MAX_CNT_LIST * GPU_DP_SIZE);
	pPntList2 = (u8*)malloc(MAX_CNT_LIST * GPU_DP_SIZE);
	TotalOps = 0;
	TotalSolved = 0;
	gTotalErrors = 0;
	IsBench = gPubKey.x.IsZero();

	if (!IsBench && !gGenMode)
	{
		printf("\r\nMAIN MODE\r\n\r\n");
		EcPoint PntToSolve, PntOfs;
		EcInt pk, pk_found;

		PntToSolve = gPubKey;
		if (!gStart.IsZero())
		{
			PntOfs = ec.MultiplyG(gStart);
			PntOfs.y.NegModP();
			PntToSolve = ec.AddPoints(PntToSolve, PntOfs);
		}

		char sx[100], sy[100];
		gPubKey.x.GetHexStr(sx);
		gPubKey.y.GetHexStr(sy);
		printf("Solving public key\r\nX: %s\r\nY: %s\r\n", sx, sy);
		gStart.GetHexStr(sx);
		printf("Offset: %s\r\n", sx);

		if (!SolvePoint(PntToSolve, gRange, gDP, &pk_found))
		{
			if (!gIsOpsLimit)
				printf("FATAL ERROR: SolvePoint failed\r\n");
			goto label_end;
		}
		pk_found.AddModP(gStart);
		EcPoint tmp = ec.MultiplyG(pk_found);
		if (!tmp.IsEqual(gPubKey))
		{
			printf("FATAL ERROR: SolvePoint found incorrect key\r\n");
			goto label_end;
		}
		//happy end
		char s[100];
		pk_found.GetHexStr(s);
		printf("\r\nPRIVATE KEY: %s\r\n\r\n", s);
		FILE* fp = fopen("RESULTS.TXT", "a");
		if (fp)
		{
			fprintf(fp, "PRIVATE KEY: %s\n", s);
			fclose(fp);
		}
		else //we cannot save the key, show error and wait forever so the key is displayed
		{
			printf("WARNING: Cannot save the key to RESULTS.TXT!\r\n");
			while (1)
				Sleep(100);
		}
	}
	else
	{
		if (gGenMode)
			printf("\r\nTAMES GENERATION MODE\r\n");
		else
			printf("\r\nBENCHMARK MODE\r\n");
		//solve points, show K
		while (1)
		{
			EcInt pk, pk_found;
			EcPoint PntToSolve;

			if (!gRange)
				gRange = 78;
			if (!gDP)
				gDP = 16;

			//generate random pk
			pk.RndBits(gRange);
			PntToSolve = ec.MultiplyG(pk);

			if (!SolvePoint(PntToSolve, gRange, gDP, &pk_found))
			{
				if (!gIsOpsLimit)
					printf("FATAL ERROR: SolvePoint failed\r\n");
				break;
			}
			if (!pk_found.IsEqual(pk))
			{
				printf("FATAL ERROR: Found key is wrong!\r\n");
				break;
			}
			TotalOps += PntTotalOps;
			TotalSolved++;
			u64 ops_per_pnt = TotalOps / TotalSolved;
			double K = (double)ops_per_pnt / pow(2.0, gRange / 2.0);
			printf("Points solved: %d, average K: %.3f (with DP and GPU overheads)\r\n", TotalSolved, K);
			//if (TotalSolved >= 100) break; //dbg
		}
	}
label_end:
	for (int i = 0; i < GpuCnt; i++)
		delete GpuKangs[i];
	DeInitEc();
	free(pPntList2);
	free(pPntList);
}

