// Compiles bumblebeam's BeamHash III oracle (oracle/src/pow.cpp) and the Blake2b reference into the
// pool binary. The same code the tests hold against the Beam core checks every share.
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(3)
        .file(root.join("src/pow.cpp"))
        .include(root.join("include"))
        .include(root.join("third_party/beam"))
        .warnings(false)
        .compile("bb_pow");
    cc::Build::new()
        .file(root.join("third_party/beam/blake/ref/blake2b-ref.c"))
        .include(root.join("third_party/beam"))
        .opt_level(3)
        .warnings(false)
        .compile("bb_blake2b");
    println!("cargo:rerun-if-changed={}", root.join("src/pow.cpp").display());
    println!("cargo:rerun-if-changed={}", root.join("include/bumblebeam/pow.h").display());
}
