# Vendored from the Beam core

These files are copied **unchanged** from [BeamMW/beam](https://github.com/BeamMW/beam) at commit
`daf7191567b746953e6e7a8d72d4396b6d4c94f5` (master, 2026-09-22). The BeamHash III files were last
changed upstream in `b4ec903347e962f550906334aceae25912d0ce47`.

| File | Upstream path | License |
|---|---|---|
| `beamHashIII.h`, `beamHashIII_impl.cpp`, `powScheme.h` | `3rdparty/crypto/` | Apache-2.0 (The Beam Team) |
| `blake/ref/blake2.h`, `blake2-impl.h`, `blake2b-ref.c` | `3rdparty/crypto/blake/ref/` | CC0 / OpenSSL / Apache-2.0 (Samuel Neves) |

They are the **reference**: the code every Beam node runs to accept or reject a block. bumblebeam's
own implementation in `../../src` is tested against them and against real mainnet headers, and is
never the other way round. Do not edit these files; update them only by re-copying from upstream.

Known upstream quirk, kept as is: `GetMinimalFromIndices` starts its loop at `i = sol.size()` and so
reads one element past the end of the vector. The value is shifted out of the 800-bit stream and does
not affect the result, but it is undefined behaviour, so the reference solver is not built with
sanitizers.
