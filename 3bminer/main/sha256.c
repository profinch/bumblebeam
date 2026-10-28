#include "sha256.h"
#include <string.h>
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static const uint32_t KK[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
const uint32_t SHA256_IV[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
void sha256_compress(uint32_t st[8], const uint32_t w16[16]) {
    uint32_t w[64]; for (int i=0;i<16;i++) w[i]=w16[i];
    for (int i=16;i<64;i++){ uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3), s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10); w[i]=w[i-16]+s0+w[i-7]+s1; }
    uint32_t a=st[0],b=st[1],c=st[2],d=st[3],e=st[4],f=st[5],g=st[6],h=st[7];
    for (int i=0;i<64;i++){ uint32_t S1=ROR(e,6)^ROR(e,11)^ROR(e,25), ch=(e&f)^(~e&g), t1=h+S1+ch+KK[i]+w[i], S0=ROR(a,2)^ROR(a,13)^ROR(a,22), mj=(a&b)^(a&c)^(b&c), t2=S0+mj; h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
    st[0]+=a;st[1]+=b;st[2]+=c;st[3]+=d;st[4]+=e;st[5]+=f;st[6]+=g;st[7]+=h;
}
uint32_t sha256_h7(const uint32_t w16[16]) {
    uint32_t w[61]; for (int i=0;i<16;i++) w[i]=w16[i];
    for (int i=16;i<61;i++){ uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3), s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10); w[i]=w[i-16]+s0+w[i-7]+s1; }
    uint32_t a=SHA256_IV[0],b=SHA256_IV[1],c=SHA256_IV[2],d=SHA256_IV[3],e=SHA256_IV[4],f=SHA256_IV[5],g=SHA256_IV[6],h=SHA256_IV[7];
    for (int i=0;i<61;i++){ uint32_t S1=ROR(e,6)^ROR(e,11)^ROR(e,25), ch=(e&f)^(~e&g), t1=h+S1+ch+KK[i]+w[i], S0=ROR(a,2)^ROR(a,13)^ROR(a,22), mj=(a&b)^(a&c)^(b&c), t2=S0+mj; h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2; }
    return SHA256_IV[7] + e;
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
