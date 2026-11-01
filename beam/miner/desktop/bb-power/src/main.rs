//! bb-power: BumbleBeam Miner's helper for the NVIDIA power limit, the one thing the app needs
//! administrator rights for. Started once per mining session (UAC on Windows, pkexec on Linux):
//!
//!   bb-power --file <path> --parent <pid> [--gpu <index>]
//!
//! Every second it reads <path>: a number of watts sets the limit (kept within the card's own
//! minimum and maximum), "exit" puts the default limit back and ends. It also puts the default
//! back and ends when the app's process <pid> is gone. It runs nvidia-smi with numbers only and
//! writes no file.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn smi() -> Option<String> {
    #[cfg(windows)]
    let c = ["C:\\Windows\\System32\\nvidia-smi.exe", "nvidia-smi.exe"];
    #[cfg(not(windows))]
    let c = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"];
    c.iter().find(|p| std::path::Path::new(p).exists() || !p.contains(['/', '\\'])).map(|p| p.to_string())
}

fn run(smi: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(smi);
    cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(h);
        ok
    }
    #[cfg(not(windows))]
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let (Some(file), Some(parent)) = (arg("--file"), arg("--parent").and_then(|p| p.parse::<u32>().ok())) else {
        eprintln!("usage: bb-power --file <path> --parent <pid> [--gpu <index>]");
        std::process::exit(2);
    };
    let gpu = arg("--gpu").and_then(|g| g.parse::<u32>().ok()).unwrap_or(0).to_string();
    let Some(smi) = smi() else { std::process::exit(3) };
    let q = run(&smi, &["-i", &gpu, "--query-gpu=power.min_limit,power.max_limit,power.default_limit", "--format=csv,noheader,nounits"]);
    let lim: Vec<f64> = q.unwrap_or_default().lines().next().unwrap_or("").split(',').filter_map(|x| x.trim().parse().ok()).collect();
    let [min, max, default] = lim[..] else { std::process::exit(4) };
    let set = |w: f64| {
        let w = format!("{}", w.clamp(min, max).round());
        run(&smi, &["-i", &gpu, "-pl", &w]).is_some()
    };

    let mut applied: Option<f64> = None;
    loop {
        let want = std::fs::read_to_string(&file).unwrap_or_default();
        let want = want.trim();
        if want == "exit" || !alive(parent) {
            if applied.map_or(true, |a| (a - default).abs() > 0.5) {
                set(default);
            }
            return;
        }
        if let Ok(w) = want.parse::<f64>() {
            if w.is_finite() && applied.map_or(true, |a| (a - w).abs() > 0.5) && set(w) {
                applied = Some(w);
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
