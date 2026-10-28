#pragma once
#include <stdint.h>
#include <stdbool.h>
#define MAX_BRANCH 24
typedef struct {
    uint32_t seq;                 // increments per notify
    char job_id[64];
    uint32_t prevhash_w[8];       // header words 1..8 (as sent, each 8-hex-char word parsed as a number)
    uint8_t coinb1[1024]; int coinb1_len;
    uint8_t coinb2[2048]; int coinb2_len;
    uint8_t branch[MAX_BRANCH][32]; int nbranch;
    uint32_t version, ntime, nbits;
    bool clean;
    char ntime_hex[9];
} job_t;
typedef struct {
    uint8_t extranonce1[16]; int en1_len; int en2_size;
} session_t;
int hex2bin(const char *hex, uint8_t *out, int maxlen);
void bin2hex(const uint8_t *b, int n, char *out);
// builds header words w[0..18] for the job with extranonce2 value (little-endian counter padded to en2_size)
void job_build_words(const job_t *j, const session_t *s, uint32_t en2, uint32_t w[19]);
// full software sha256d of header words w[0..18] + nonce word; out digest words H[0..7] (big-endian values)
void job_hash(const uint32_t w[19], uint32_t nonce_word, uint32_t H[8]);
// share difficulty of digest H (diff1 / hash)
double job_diff(const uint32_t H[8]);
