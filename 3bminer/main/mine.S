// hwmine: one SHA256d nonce per iteration on the ESP32 SHA-256 engine, cycle-scheduled.
// uint32_t hwmine(uint32_t *tbl, uint32_t nonce_start, uint32_t count, uint32_t E, uint32_t d2)
//   tbl[0..15]  block1 words (header words 0..15)
//   tbl[16..18] header words 16..18 (merkle tail, time, bits)
//   tbl[19]=0x80000000 tbl[20]=640 tbl[21]=256 tbl[22]=1
//   tbl[24] <- 1 if a nonce with digest word7==0 was found (returned in a2); else returns nonce_start+count
//   E  = engine time budget in cycles between a START/CONTINUE store and the following control store (>= 44)
//   d2 = delay cycles after a LOAD store before using TEXT
//   (E and d2 are no longer used by the loop: per-stage waits come from tbl[25..29], see miner.c)
    .section .iram1, "ax"
    .align 4
    .global hwmine
    .type hwmine, @function
hwmine:
    entry   a1, 32
    movi    a7, 0x3ff03000          // SHA_TEXT_BASE; START=+0x90 CONTINUE=+0x94 LOAD=+0x98
    movi    a8, 0
    l32i    a9, a2, 76              // 0x80000000
    l32i    a10, a2, 80             // 640
    movi    a12, 1
    add     a4, a4, a3              // a4 = end nonce
    // prime block1 words 8..15
    l32i a13, a2, 32
    l32i a14, a2, 36
    s32i a13, a7, 32
    l32i a15, a2, 40
    s32i a14, a7, 36
    l32i a13, a2, 44
    s32i a15, a7, 40
    l32i a14, a2, 48
    s32i a13, a7, 44
    l32i a15, a2, 52
    s32i a14, a7, 48
    l32i a13, a2, 56
    s32i a15, a7, 52
    l32i a14, a2, 60
    s32i a13, a7, 56
    s32i a14, a7, 60
.Lloop:
    // ---- block 1, words 0..7 (8..15 are already in TEXT)
    l32i a13, a2, 0
    l32i a14, a2, 4
    s32i a13, a7, 0
    l32i a15, a2, 8
    s32i a14, a7, 4
    l32i a13, a2, 12
    s32i a15, a7, 8
    l32i a14, a2, 16
    s32i a13, a7, 12
    l32i a15, a2, 20
    s32i a14, a7, 16
    l32i a13, a2, 24
    s32i a15, a7, 20
    l32i a14, a2, 28
    s32i a13, a7, 24
    s32i a14, a7, 28
    s32i a12, a7, 0x90              // START (block 1)   -- engine streams W[i] at ~cycle i
    // ---- block 2 (written while block 1 computes; each word lands after the engine read it)
    l32i a13, a2, 64
    l32i a14, a2, 68
    s32i a13, a7, 0
    l32i a15, a2, 72
    s32i a14, a7, 4
    s32i a15, a7, 8
    l32i a13, a2, 100               // tbl[25]: wait before CONTINUE (loaded early: no load-use stall)
    s32i a3,  a7, 12                // nonce word
    s32i a9,  a7, 16                // 0x80000000
    s32i a8,  a7, 20
    s32i a8,  a7, 24
    s32i a8,  a7, 28
    s32i a8,  a7, 32
    s32i a8,  a7, 36
    s32i a8,  a7, 40
    s32i a8,  a7, 44
    s32i a8,  a7, 48
    s32i a8,  a7, 52
    s32i a8,  a7, 56
    s32i a10, a7, 60                // 640
    loopnez a13, .Ld1
    nop
.Ld1:
    s32i a12, a7, 0x94              // CONTINUE (block 2)
    l32i a13, a2, 104               // tbl[26]: wait before LOAD H1
    l32i a14, a2, 112               // tbl[28]: settle after LOAD H1
    nop; nop; nop; nop; nop; nop; nop; nop
    nop; nop; nop; nop; nop; nop; nop; nop; nop; nop   // let the engine read W[8..15] first
    s32i a9,  a7, 32                // 2nd-hash padding: word 8 = 0x80000000
    l32i a11, a2, 84                // 256
    s32i a11, a7, 60                // word 15 = 256
    loopnez a13, .Ld2
    nop
.Ld2:
    s32i a12, a7, 0x98              // LOAD -> H1 into TEXT[0..7]
    loopnez a14, .Ld3
    nop
.Ld3:
    s32i a12, a7, 0x90              // START (2nd hash)
    nop; nop; nop; nop; nop; nop; nop; nop; nop; nop
    nop; nop; nop; nop; nop; nop; nop; nop              // engine has consumed W[8..15]
    l32i a13, a2, 32                // next nonce's block1 words 8..15
    l32i a14, a2, 36
    s32i a13, a7, 32
    l32i a15, a2, 40
    s32i a14, a7, 36
    l32i a13, a2, 44
    s32i a15, a7, 40
    l32i a14, a2, 48
    s32i a13, a7, 44
    l32i a15, a2, 52
    s32i a14, a7, 48
    l32i a13, a2, 56
    s32i a15, a7, 52
    l32i a14, a2, 60
    l32i a15, a2, 108               // tbl[27]: wait before LOAD H2
    l32i a11, a2, 116               // tbl[29]: settle after LOAD H2
    s32i a13, a7, 56
    s32i a14, a7, 60
    loopnez a15, .Ld4
    nop
.Ld4:
    s32i a12, a7, 0x98              // LOAD -> H2
    loopnez a11, .Ld5
    nop
.Ld5:
    l32i a11, a2, 92                // hit mask
    l32i a13, a7, 28                // digest word 7
    and  a13, a13, a11
    beqz a13, .Lhit
    addi a3, a3, 1
    bne  a3, a4, .Lloop
    mov  a2, a3
    retw
.Lhit:
    movi a14, 1
    s32i a14, a2, 96                // tbl[24] = found
    mov  a2, a3
    retw
    .size hwmine, .-hwmine
