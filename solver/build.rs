// The oracle (oracle/src/pow.cpp) checks every solution the solver produces.
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../oracle");
    cc::Build::new().cpp(true).std("c++17").opt_level(3).file(root.join("src/pow.cpp")).include(root.join("include")).include(root.join("third_party/beam")).warnings(false).compile("bb_pow");
    cc::Build::new().file(root.join("third_party/beam/blake/ref/blake2b-ref.c")).include(root.join("third_party/beam")).opt_level(3).warnings(false).compile("bb_blake2b");
    println!("cargo:rerun-if-changed={}", root.join("src/pow.cpp").display());
}
