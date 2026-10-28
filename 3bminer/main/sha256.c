#include "sha256.h"
#include <string.h>
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static const uint32_t KK[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
const uint32_t SHA256_IV[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
// rounds unrolled by 8 with the eight working variables renamed instead of shifted (h=g; g=f; ... cost ~8 moves a round);
// the schedule first, in its own loop. ~2 KB of code: still well inside the flash cache, so its speed does not depend on
// where the linker puts the rest
#define S0(x) (ROR(x,2)^ROR(x,13)^ROR(x,22))
#define S1(x) (ROR(x,6)^ROR(x,11)^ROR(x,25))
#define s0(x) (ROR(x,7)^ROR(x,18)^((x)>>3))
#define s1(x) (ROR(x,17)^ROR(x,19)^((x)>>10))
#define RND(a,b,c,d,e,f,g,h,i) { uint32_t t1 = h + S1(e) + ((e&f)^(~e&g)) + KK[i] + w[i]; d += t1; h = t1 + S0(a) + ((a&b)^(a&c)^(b&c)); }
#define RND8(i) RND(a,b,c,d,e,f,g,h,i) RND(h,a,b,c,d,e,f,g,i+1) RND(g,h,a,b,c,d,e,f,i+2) RND(f,g,h,a,b,c,d,e,i+3) \
                RND(e,f,g,h,a,b,c,d,i+4) RND(d,e,f,g,h,a,b,c,i+5) RND(c,d,e,f,g,h,a,b,i+6) RND(b,c,d,e,f,g,h,a,i+7)
void sha256_compress(uint32_t st[8], const uint32_t w16[16]) {
    uint32_t w[64]; for (int i=0;i<16;i++) w[i]=w16[i];
    for (int i=16;i<64;i++) w[i]=w[i-16]+s0(w[i-15])+w[i-7]+s1(w[i-2]);
    uint32_t a=st[0],b=st[1],c=st[2],d=st[3],e=st[4],f=st[5],g=st[6],h=st[7];
    for (int i=0;i<64;i+=8) { RND8(i) }
    st[0]+=a;st[1]+=b;st[2]+=c;st[3]+=d;st[4]+=e;st[5]+=f;st[6]+=g;st[7]+=h;
}
uint32_t sha256_h7(const uint32_t w16[16]) {   // h after 64 rounds is e after 61: rounds 0..60, then the e of round 60
    uint32_t w[61]; for (int i=0;i<16;i++) w[i]=w16[i];
    for (int i=16;i<61;i++) w[i]=w[i-16]+s0(w[i-15])+w[i-7]+s1(w[i-2]);
    uint32_t a=SHA256_IV[0],b=SHA256_IV[1],c=SHA256_IV[2],d=SHA256_IV[3],e=SHA256_IV[4],f=SHA256_IV[5],g=SHA256_IV[6],h=SHA256_IV[7];
    for (int i=0;i<56;i+=8) { RND8(i) }
    RND(a,b,c,d,e,f,g,h,56) RND(h,a,b,c,d,e,f,g,57) RND(g,h,a,b,c,d,e,f,58) RND(f,g,h,a,b,c,d,e,59) RND(e,f,g,h,a,b,c,d,60)
    return SHA256_IV[7] + h;   // a round puts its new e in its 4th argument: round 60's is h
}
// sha256d of an 80-byte header for one nonce, down to digest word 7, with what stays the same for a job done once
// (sha256d_prep): the midstate, rounds 0..2 of the second block (its words 0..2 are the job's) and schedule words 16 and 17.
// The block's other words are padding constants written as literals, so the compiler drops their zero terms.
void sha256d_prep(sha256d_pre_t *p, const uint32_t mid[8], const uint32_t w3[3]) {
    memcpy(p->mid, mid, 32); memcpy(p->w, w3, 12);
    uint32_t a=mid[0],b=mid[1],c=mid[2],d=mid[3],e=mid[4],f=mid[5],g=mid[6],h=mid[7];
    for (int i=0;i<3;i++){ uint32_t t1=h+S1(e)+((e&f)^(~e&g))+KK[i]+w3[i], t2=S0(a)+((a&b)^(a&c)^(b&c)); h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
    p->st3[0]=a;p->st3[1]=b;p->st3[2]=c;p->st3[3]=d;p->st3[4]=e;p->st3[5]=f;p->st3[6]=g;p->st3[7]=h;
    p->w16 = w3[0] + s0(w3[1]);                       // + w9 + s1(w14), both 0
    p->w17 = w3[1] + s0(w3[2]) + s1(640);             // + w10 (0)
}
uint32_t sha256d_h7(const sha256d_pre_t *p, uint32_t nonce) {
    uint32_t w[64] = { p->w[0], p->w[1], p->w[2], nonce, 0x80000000u, 0,0,0,0,0,0,0,0,0,0, 640 };
    w[16] = p->w16; w[17] = p->w17;
    #pragma GCC unroll 46
    for (int i=18;i<64;i++) w[i]=w[i-16]+s0(w[i-15])+w[i-7]+s1(w[i-2]);
    uint32_t a=p->st3[0],b=p->st3[1],c=p->st3[2],d=p->st3[3],e=p->st3[4],f=p->st3[5],g=p->st3[6],h=p->st3[7];
    RND8(3)                                           // rounds 3..10
    for (int i=11;i<59;i+=8) { RND8(i) }              // 11..58
    RND(a,b,c,d,e,f,g,h,59) RND(h,a,b,c,d,e,f,g,60) RND(g,h,a,b,c,d,e,f,61) RND(f,g,h,a,b,c,d,e,62) RND(e,f,g,h,a,b,c,d,63)
    // five renamings past the last full eight: A..H are in d,e,f,g,h,a,b,c
    uint32_t m[61] = { p->mid[0]+d, p->mid[1]+e, p->mid[2]+f, p->mid[3]+g, p->mid[4]+h, p->mid[5]+a, p->mid[6]+b, p->mid[7]+c, 0x80000000u, 0,0,0,0,0,0, 256 };
    #pragma GCC unroll 45
    for (int i=16;i<61;i++) m[i]=m[i-16]+s0(m[i-15])+m[i-7]+s1(m[i-2]);
    a=SHA256_IV[0];b=SHA256_IV[1];c=SHA256_IV[2];d=SHA256_IV[3];e=SHA256_IV[4];f=SHA256_IV[5];g=SHA256_IV[6];h=SHA256_IV[7];
    #define w m
    for (int i=0;i<56;i+=8) { RND8(i) }
    RND(a,b,c,d,e,f,g,h,56) RND(h,a,b,c,d,e,f,g,57) RND(g,h,a,b,c,d,e,f,58) RND(f,g,h,a,b,c,d,e,59) RND(e,f,g,h,a,b,c,d,60)
    #undef w
    return SHA256_IV[7] + h;
}
static inline uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
void sha256_raw(const uint8_t *data, size_t len, uint8_t out[32]) {
    uint32_t st[8]; memcpy(st, SHA256_IV, 32);
    uint8_t blk[64]; size_t i = 0;
    while (len - i >= 64) { uint32_t w[16]; for (int k=0;k<16;k++) w[k]=be32(data+i+4*k); sha256_compress(st, w); i += 64; }
    size_t rem = len - i; memset(blk, 0, 64); memcpy(blk, data + i, rem); blk[rem] = 0x80;
    if (rem >= 56) { uint32_t w[16]; for (int k=0;k<16;k++) w[k]=be32(blk+4*k); sha256_compress(st, w); memset(blk, 0, 64); }
    uint64_t bits = (uint64_t)len * 8; for (int k = 0; k < 8; k++) blk[63 - k] = bits >> (8 * k);
    uint32_t w[16]; for (int k=0;k<16;k++) w[k]=be32(blk+4*k); sha256_compress(st, w);
    for (int k = 0; k < 8; k++) { out[4*k]=st[k]>>24; out[4*k+1]=st[k]>>16; out[4*k+2]=st[k]>>8; out[4*k+3]=st[k]; }
}
void sha256d_raw(const uint8_t *data, size_t len, uint8_t out[32]) { uint8_t t[32]; sha256_raw(data, len, t); sha256_raw(t, 32, out); }
