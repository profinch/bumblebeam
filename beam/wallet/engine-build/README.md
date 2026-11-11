# The Beam engine (wasm-client), rebuilt

`extension/vendor/wasm-client.{js,wasm,worker.js}` is BeamMW's wasm wallet client 7.5.14548 (commit `2f38843ed`,
master after HF6), built as BeamMW's CI builds it (`.github/workflows/build.yml`, job wasm), with one addition:
`wasmclient-export-import.patch` gives the client `exportData(callback)` and `importData(json, callback)`, thin
wrappers over Beam's own `storage::ExportDataToJson` / `ImportDataFromJson` (the CLI's `export_data` /
`import_data`, the mobile wallets' export). The JS glue is BeamMW's, unchanged but for its constants' addresses.

Build (Linux, no root):

1. `git clone https://github.com/BeamMW/beam && cd beam && git checkout 2f38843ed && git apply wasmclient-export-import.patch`
2. emsdk 3.1.10 (`./emsdk install 3.1.10 && ./emsdk activate 3.1.10`), BeamMW's `boost_prebuild_ubuntu-22.04`
   (branch boost-1.90) and `openssl-wasm`, as in the CI job.
3. cmake as in the CI job. With cmake 3.31 its FindOpenSSL asks for `ZLIB::ZLIB` and links `-lzstd`: give it a
   `ZLIB::ZLIB` target through `-DCMAKE_PROJECT_INCLUDE` (emscripten's zlib port) and an empty `libzstd.a` in
   emscripten's sysroot lib folder; `fix-client.py` runs as `python`, so a `python` on the PATH.
4. `emmake make -C <build> wasm-client`; the three files from `<build>/wasmclient/` go to `extension/vendor/`, their
   sha256 into `extension/SHA256SUMS`.
