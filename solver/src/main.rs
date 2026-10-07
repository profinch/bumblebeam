//! bumblebeam-solver: BeamHash III on the CPU.
//!   bench [seconds] [threads]        random inputs, reports runs/s and sol/s
//!   solve <input-hex> <nonce-hex> [extra-hex]   all solutions, as JSON
//!   check <vectors-dir> [n]          re-solve n mainnet headers and the solver_*.json cases;
//!                                    the known solutions must be among ours

use anyhow::{anyhow, Result};
use rand::RngCore;
use std::time::Instant;

fn hex32(s: &str) -> Result<Vec<u8>> { Ok(hex::decode(s.trim())?) }

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("bench") => bench(args.get(1).and_then(|s| s.parse().ok()).unwrap_or(60.0), args.get(2).and_then(|s| s.parse().ok())),
        Some("solve") => {
            let input = hex32(args.get(1).ok_or_else(|| anyhow!("input"))?)?;
            let nonce: [u8; 8] = hex32(args.get(2).ok_or_else(|| anyhow!("nonce"))?)?.try_into().map_err(|_| anyhow!("nonce must be 8 bytes"))?;
            let extra: [u8; 4] = match args.get(3) { Some(e) => hex32(e)?.try_into().map_err(|_| anyhow!("extra nonce must be 4 bytes"))?, None => [0; 4] };
            let t = Instant::now();
            let (sols, st) = bumblebeam_solver::solve(&input, &nonce, &extra);
            let secs = t.elapsed().as_secs_f64();
            println!("{{\"input\": \"{}\", \"nonce\": \"{}\", \"extra\": \"{}\", \"seconds\": {secs:.2}, \"elements\": {:?}, \"candidates\": {}, \"rejected\": {}, \"solutions\": [",
                hex::encode(&input), hex::encode(nonce), hex::encode(extra), st.elements, st.candidates, st.rejected);
            for (i, s) in sols.iter().enumerate() { println!("{}  {{\"solution\": \"{}\"}}", if i > 0 { "," } else { "" }, hex::encode(s)); }
            println!("]}}");
            Ok(())
        }
        Some("check") => check(args.get(1).map(|s| s.as_str()).unwrap_or("../vectors"), args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3)),
        _ => { eprintln!("usage: bumblebeam-solver bench [seconds] [threads] | solve <input> <nonce> [extra] | check <vectors-dir> [n]"); std::process::exit(2) }
    }
}

fn bench(seconds: f64, threads: Option<usize>) -> Result<()> {
    if let Some(t) = threads { rayon::ThreadPoolBuilder::new().num_threads(t).build_global()?; }
    let mut rng = rand::thread_rng();
    let mut input = [0u8; 32];
    let mut nonce = [0u8; 8];
    rng.fill_bytes(&mut input);
    let t0 = Instant::now();
    let (mut runs, mut sols, mut rejected) = (0usize, 0usize, 0usize);
    eprintln!("threads: {}", rayon::current_num_threads());
    while t0.elapsed().as_secs_f64() < seconds {
        rng.fill_bytes(&mut nonce);
        let t = Instant::now();
        let (s, st) = bumblebeam_solver::solve(&input, &nonce, &[0; 4]);
        runs += 1; sols += s.len(); rejected += st.rejected;
        eprintln!("run {runs}: {:.2} s, {} solutions, elements per round {:?}", t.elapsed().as_secs_f64(), s.len(), st.elements);
    }
    let secs = t0.elapsed().as_secs_f64();
    println!("{runs} runs in {secs:.1} s: {:.3} runs/s, {:.3} sol/s ({sols} solutions, {rejected} rejected by the oracle, {:.2} sol/run)",
        runs as f64 / secs, sols as f64 / secs, sols as f64 / runs.max(1) as f64);
    Ok(())
}

fn check(dir: &str, n: usize) -> Result<()> {
    let hdrs: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/mainnet_headers.json"))?)?;
    let mut tested = 0;
    for h in hdrs["headers"].as_array().unwrap().iter().filter(|h| h["algo"] == "BeamHashIII").rev().take(n) {
        let input = hex::decode(h["input"].as_str().unwrap())?;
        let nonce: [u8; 8] = hex::decode(h["nonce"].as_str().unwrap())?.try_into().unwrap();
        let known: [u8; 104] = hex::decode(h["solution"].as_str().unwrap())?.try_into().unwrap();
        let extra: [u8; 4] = known[100..104].try_into().unwrap();
        let t = Instant::now();
        let (sols, st) = bumblebeam_solver::solve(&input, &nonce, &extra);
        let found = sols.iter().any(|s| *s == known);
        println!("height {}: {:.2} s, {} solutions, candidates {}, rejected {}, mainnet solution found: {}", h["height"], t.elapsed().as_secs_f64(), sols.len(), st.candidates, st.rejected, found);
        if !found { anyhow::bail!("the chain's solution for height {} was not found", h["height"]); }
        tested += 1;
    }
    for path in std::fs::read_dir(dir)?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("solver_") && n.ends_with(".json")).unwrap_or(false)) {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        let input = hex::decode(v["input"].as_str().unwrap())?;
        let nonce: [u8; 8] = hex::decode(v["nonce"].as_str().unwrap())?.try_into().unwrap();
        let known: Vec<String> = v["solutions"].as_array().unwrap().iter().map(|s| s["solution"].as_str().unwrap().to_string()).collect();
        let (sols, _) = bumblebeam_solver::solve(&input, &nonce, &[0; 4]);
        let ours: Vec<String> = sols.iter().map(hex::encode).collect();
        let missing: Vec<&String> = known.iter().filter(|k| !ours.contains(k)).collect();
        println!("{}: reference found {}, we found {}, missing {}", path.file_name().unwrap().to_string_lossy(), known.len(), ours.len(), missing.len());
        if !missing.is_empty() { anyhow::bail!("solutions the reference solver found are missing"); }
        tested += 1;
    }
    println!("{tested} cases, all known solutions found");
    Ok(())
}
