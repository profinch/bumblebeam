//! Mains power, keeping the computer awake, and the GPU's power.
//!
//! On NVIDIA the power slider sets the board's power limit, the only knob that lowers the draw
//! there (an RTX 3090 at 200 W: 32 sol/s drawing 198 W; fewer blocks in flight instead: the
//! same speed at about 320 W). Setting it needs administrator rights, so it goes through
//! bb-power, a small helper started once per mining session with those rights (UAC on Windows,
//! polkit on Linux: no password with the .deb's rule). It reads the wanted watts from a file
//! this app writes and puts the default limit back when told to or when the app is gone.
//! Without the helper (rights refused, an AMD card) the slider limits the blocks in flight
//! (MXBM_LOAD), which lowers the speed but hardly the draw; the window says so.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    cmd.stdin(Stdio::null())
}

// ---------------------------------------------------------------------------------------------
// mains power and staying awake

/// Whether the computer runs on mains power (a desktop always does).
pub fn on_ac() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut s: SYSTEM_POWER_STATUS = std::mem::zeroed();
        if GetSystemPowerStatus(&mut s) != 0 {
            return s.ACLineStatus != 0; // 1 on mains, 255 unknown
        }
        true
    }
    #[cfg(not(windows))]
    {
        let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else { return true };
        let mut saw_mains = false;
        for e in dir.flatten() {
            let p = e.path();
            let kind = std::fs::read_to_string(p.join("type")).unwrap_or_default();
            if kind.trim() == "Mains" {
                saw_mains = true;
                if std::fs::read_to_string(p.join("online")).unwrap_or_default().trim() == "1" {
                    return true;
                }
            }
        }
        !saw_mains
    }
}

/// Keeps the computer from sleeping while `want` is set.
pub struct Awake {
    #[cfg(not(windows))]
    inhibit: Mutex<Option<Child>>,
    #[cfg(windows)]
    on: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Awake {
    pub fn new() -> Awake {
        #[cfg(windows)]
        {
            let on = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = on.clone();
            // SetThreadExecutionState without ES_CONTINUOUS resets the idle timer once; doing
            // it every 30 s from one thread keeps the system awake and lets go by just stopping
            std::thread::spawn(move || loop {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    unsafe {
                        windows_sys::Win32::System::Power::SetThreadExecutionState(
                            windows_sys::Win32::System::Power::ES_SYSTEM_REQUIRED,
                        );
                    }
                }
                std::thread::sleep(Duration::from_secs(30));
            });
            Awake { on }
        }
        #[cfg(not(windows))]
        Awake { inhibit: Mutex::new(None) }
    }

    pub fn set(&self, want: bool) {
        #[cfg(windows)]
        self.on.store(want, std::sync::atomic::Ordering::Relaxed);
        #[cfg(not(windows))]
        {
            let mut g = self.inhibit.lock().unwrap();
            if let Some(c) = g.as_mut() {
                if !matches!(c.try_wait(), Ok(None)) {
                    *g = None; // it ended by itself
                }
            }
            if want && g.is_none() {
                *g = quiet(Command::new("systemd-inhibit").args([
                    "--what=idle:sleep",
                    "--who=BumbleBeam Miner",
                    "--why=Mining",
                    "--mode=block",
                    "sleep",
                    "infinity",
                ]))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok();
            } else if !want {
                if let Some(mut c) = g.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        }
    }

    pub fn active(&self) -> bool {
        #[cfg(windows)]
        return self.on.load(std::sync::atomic::Ordering::Relaxed);
        #[cfg(not(windows))]
        self.inhibit.lock().unwrap().is_some()
    }
}

// ---------------------------------------------------------------------------------------------
// the GPU

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    /// "cuda" for NVIDIA, "opencl" for any other card MXBM can use
    pub solver: String,
    pub name: String,
    /// NVIDIA board power limits in watts
    pub min_watts: Option<f64>,
    pub default_watts: Option<f64>,
}

pub fn nvidia_smi() -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = ["nvidia-smi.exe", "C:\\Windows\\System32\\nvidia-smi.exe"];
    #[cfg(not(windows))]
    let candidates = ["nvidia-smi", "/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"];
    for c in candidates {
        if quiet(&mut Command::new(c)).arg("-L").stdout(Stdio::null()).stderr(Stdio::null()).status().map_or(false, |s| s.success()) {
            return Some(PathBuf::from(c));
        }
    }
    None
}

fn smi_query(smi: &Path, fields: &str) -> Option<Vec<String>> {
    let out = quiet(&mut Command::new(smi))
        .args(["-i", "0", &format!("--query-gpu={fields}"), "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next()?;
    Some(first.split(',').map(|x| x.trim().to_string()).collect())
}

/// The first GPU: NVIDIA through nvidia-smi, else whatever OpenCL card MXBM finds (named later).
pub fn detect_gpu() -> Option<Gpu> {
    if let Some(smi) = nvidia_smi() {
        if let Some(v) = smi_query(&smi, "name,power.min_limit,power.default_limit") {
            return Some(Gpu {
                solver: "cuda".into(),
                name: v.first().cloned().unwrap_or_else(|| "NVIDIA GPU".into()),
                min_watts: v.get(1).and_then(|x| x.parse().ok()),
                default_watts: v.get(2).and_then(|x| x.parse().ok()),
            });
        }
    }
    None
}

/// The GPU's draw and its current power limit, in watts (NVIDIA).
pub fn nvidia_power() -> Option<(f64, f64)> {
    let smi = nvidia_smi()?;
    let v = smi_query(&smi, "power.draw,power.limit")?;
    Some((v.first()?.parse().ok()?, v.get(1)?.parse().ok()?))
}

/// The power limit for a slider position: the card's minimum at 10 %, its default at 100 %.
pub fn watts_for(power: u32, gpu: &Gpu) -> Option<f64> {
    let (lo, hi) = (gpu.min_watts?, gpu.default_watts?);
    let p = power.clamp(10, 100) as f64;
    Some((lo + (hi - lo) * (p - 10.0) / 90.0).round())
}

/// What the power helper is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LimitMode {
    /// no NVIDIA card or not asked yet
    None,
    /// waiting for the user to allow the helper
    Asking,
    /// the board power limit follows the slider
    Watts,
    /// rights refused or not possible: the slider limits blocks in flight
    Blocks,
}

pub struct PowerLimit {
    file: PathBuf,
    helper: PathBuf,
    state: Mutex<LimitState>,
}

struct LimitState {
    mode: LimitMode,
    asked_at: Option<Instant>,
    target: Option<f64>,
    child: Option<Child>,
}

impl PowerLimit {
    pub fn new(work_dir: &Path, bin_dir: &Path) -> PowerLimit {
        PowerLimit {
            file: work_dir.join("power-limit"),
            helper: bin_dir.join(if cfg!(windows) { "bb-power.exe" } else { "bb-power" }),
            state: Mutex::new(LimitState { mode: LimitMode::None, asked_at: None, target: None, child: None }),
        }
    }

    pub fn mode(&self) -> LimitMode {
        self.state.lock().unwrap().mode
    }

    /// Mining starts or the slider moves: ask for the limit. At the default limit nothing is
    /// needed; below it the helper is started once (the system asks for the rights).
    pub fn apply(&self, gpu: &Gpu, watts: f64) {
        let mut st = self.state.lock().unwrap();
        st.target = Some(watts);
        let _ = std::fs::write(&self.file, format!("{watts}\n"));
        let needed = gpu.default_watts.map_or(false, |d| watts < d - 0.5);
        if st.mode == LimitMode::Watts || st.mode == LimitMode::Asking {
            return;
        }
        if !needed {
            return;
        }
        if st.mode == LimitMode::Blocks {
            return; // refused this session; the slider works by blocks
        }
        st.mode = LimitMode::Asking;
        st.asked_at = Some(Instant::now());
        st.child = self.spawn_helper();
        if st.child.is_none() && !cfg!(windows) {
            st.mode = LimitMode::Blocks;
        }
    }

    /// Called every few seconds: has the limit taken? Settles Asking into Watts or Blocks.
    pub fn poll(&self) -> LimitMode {
        let mut st = self.state.lock().unwrap();
        if st.mode == LimitMode::Asking {
            let took = match (st.target, nvidia_power()) {
                (Some(t), Some((_, limit))) => (limit - t).abs() <= 1.0,
                _ => false,
            };
            // pkexec stays while the helper runs, so its end means refused or failed; on Windows
            // PowerShell ends at once, with an error when the UAC prompt was declined
            let gave_up = st.child.as_mut().map_or(false, |c| match c.try_wait() {
                Ok(Some(status)) => !cfg!(windows) || !status.success(),
                _ => false,
            });
            if took {
                st.mode = LimitMode::Watts;
            } else if gave_up || st.asked_at.map_or(false, |t| t.elapsed() > Duration::from_secs(60)) {
                st.mode = LimitMode::Blocks;
            }
        }
        st.mode
    }

    /// Mining stops: the default limit goes back and the helper ends.
    pub fn release(&self) {
        let mut st = self.state.lock().unwrap();
        let _ = std::fs::write(&self.file, "exit\n");
        st.target = None;
        if st.mode != LimitMode::Blocks {
            st.mode = LimitMode::None;
        }
        st.child = None;
    }

    /// At launch: a limit left lowered by a crash goes back to the default.
    pub fn recover(&self, gpu: &Gpu) {
        let last = std::fs::read_to_string(&self.file).unwrap_or_default();
        if last.trim().is_empty() || last.trim() == "exit" {
            return;
        }
        if let (Some(d), Some((_, limit))) = (gpu.default_watts, nvidia_power()) {
            if limit < d - 0.5 {
                let _ = std::fs::write(&self.file, "exit\n");
                let _ = self.spawn_helper();
                return;
            }
        }
        let _ = std::fs::write(&self.file, "exit\n");
    }

    fn spawn_helper(&self) -> Option<Child> {
        let pid = std::process::id().to_string();
        let file = self.file.to_string_lossy().to_string();
        #[cfg(windows)]
        {
            // UAC: Start-Process -Verb RunAs; the helper runs hidden, elevated
            let ps = format!(
                "Start-Process -FilePath '{}' -ArgumentList '--file','\"{}\"','--parent','{}' -Verb RunAs -WindowStyle Hidden",
                self.helper.display(),
                file.replace('\'', "''"),
                pid
            );
            return quiet(Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &ps]))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok();
        }
        #[cfg(not(windows))]
        {
            quiet(Command::new("pkexec").arg(&self.helper).args(["--file", &file, "--parent", &pid]))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .ok()
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Windows' power mode on mains power
//
// Laptops cap the CPU and GPU together below "Best performance": a ThinkBook 16p (RTX 3060
// Laptop, 60 W) in "Best power efficiency" fell to 32 W and a quarter of the speed within 20 s
// and stayed there most of the time, the console miner as much as the app; in "Best
// performance" it held 55-60 W for the hour measured. So while mining the mains power mode is
// "Best performance" and the user's own comes back when mining stops, the app quits or, after a
// crash, at the next launch (kept in a file meanwhile). Only the mains setting is touched, and
// one the user changed while mining is left as they set it. The calls are powrprof.dll's
// PowerGet/SetUserConfiguredACPowerMode, what Settings itself uses; where Windows lacks them
// this does nothing.

pub struct PowerMode {
    file: PathBuf,
    held: Mutex<bool>,
}

/// "Best performance" (Settings › System › Power › Power mode)
#[cfg(windows)]
const BEST_PERFORMANCE: u128 = 0xded574b5_45a0_4f42_8737_46345c09c238;

#[cfg(windows)]
mod ac_mode {
    use windows_sys::core::GUID;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    type Get = unsafe extern "system" fn(*mut GUID) -> u32;
    type Set = unsafe extern "system" fn(*const GUID) -> u32;

    fn proc(name: &[u8]) -> Option<unsafe extern "system" fn() -> isize> {
        let dll: Vec<u16> = "powrprof.dll\0".encode_utf16().collect();
        unsafe {
            let h = LoadLibraryW(dll.as_ptr());
            if h.is_null() {
                return None;
            }
            GetProcAddress(h, name.as_ptr())
        }
    }

    fn to_u128(g: &GUID) -> u128 {
        (g.data1 as u128) << 96 | (g.data2 as u128) << 80 | (g.data3 as u128) << 64 | u64::from_be_bytes(g.data4) as u128
    }

    pub fn get() -> Option<u128> {
        let f: Get = unsafe { std::mem::transmute(proc(b"PowerGetUserConfiguredACPowerMode\0")?) };
        let mut g: GUID = unsafe { std::mem::zeroed() };
        (unsafe { f(&mut g) } == 0).then(|| to_u128(&g))
    }

    pub fn set(mode: u128) -> bool {
        let Some(p) = proc(b"PowerSetUserConfiguredACPowerMode\0") else { return false };
        let f: Set = unsafe { std::mem::transmute(p) };
        let g = GUID::from_u128(mode);
        unsafe { f(&g) == 0 }
    }
}

impl PowerMode {
    pub fn new(work_dir: &Path) -> PowerMode {
        PowerMode { file: work_dir.join("power-mode"), held: Mutex::new(false) }
    }

    /// Whether this Windows lets the app set the power mode.
    pub fn available() -> bool {
        #[cfg(windows)]
        return ac_mode::get().is_some();
        #[allow(unreachable_code)]
        false
    }

    /// Mining starts (or the switch is turned on): "Best performance" on mains power.
    pub fn hold(&self) {
        let mut held = self.held.lock().unwrap();
        if *held {
            return;
        }
        #[cfg(windows)]
        if let Some(mine) = ac_mode::get() {
            if mine != BEST_PERFORMANCE && std::fs::write(&self.file, format!("{mine:032x}\n")).is_ok() && !ac_mode::set(BEST_PERFORMANCE) {
                let _ = std::fs::remove_file(&self.file);
            }
        }
        *held = true;
    }

    /// Mining stops (or the switch is turned off): the user's own power mode comes back.
    pub fn release(&self) {
        *self.held.lock().unwrap() = false;
        self.recover();
    }

    /// At launch: a power mode left by a crash goes back to the user's.
    pub fn recover(&self) {
        let Ok(saved) = std::fs::read_to_string(&self.file) else { return };
        #[cfg(windows)]
        if let Ok(mine) = u128::from_str_radix(saved.trim(), 16) {
            if ac_mode::get() == Some(BEST_PERFORMANCE) {
                ac_mode::set(mine);
            }
        }
        let _ = saved;
        let _ = std::fs::remove_file(&self.file);
    }
}

// ---------------------------------------------------------------------------------------------
// a miner never outlives the app

#[cfg(windows)]
pub fn kill_with_app(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    unsafe {
        let job = *JOB.get_or_init(|| {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            h as usize
        });
        let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if !p.is_null() {
            AssignProcessToJobObject(job as _, p);
            CloseHandle(p);
        }
    }
}

/// Kills miners from this install that outlived an earlier run of the app (Linux: the pty's
/// hang-up normally ends them; this covers a miner that ignored it).
pub fn kill_leftovers(bin_dir: &Path) {
    #[cfg(target_os = "linux")]
    {
        let mine: Vec<PathBuf> = ["mxbm", "bumblebeam-miner"].iter().map(|n| bin_dir.join(n)).collect();
        if let Ok(procs) = std::fs::read_dir("/proc") {
            for p in procs.flatten() {
                let Ok(pid) = p.file_name().to_string_lossy().parse::<i32>() else { continue };
                if let Ok(exe) = std::fs::read_link(p.path().join("exe")) {
                    if mine.contains(&exe) {
                        let _ = Command::new("kill").arg(pid.to_string()).status();
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = bin_dir;
}
