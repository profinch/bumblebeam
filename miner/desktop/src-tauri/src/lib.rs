//! BumbleBeam Miner for Windows and Linux: a tray app for pool.bumblebeam.org, the same as the
//! Mac app (../mac) in a webview. It runs MXBM on the GPU or the console miner on the CPU.

mod address;
mod miner;
mod pool;
mod power;
mod settings;

use miner::Miner;
use pool::Pool;
use power::{Awake, Gpu, LimitMode, PowerLimit, PowerMode};
use serde::Serialize;
use settings::{Device, Settings};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

pub struct App {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    miner: Arc<Miner>,
    pool: Arc<Pool>,
    awake: Awake,
    /// on battery the keep-awake switch starts off; the user may turn it on (not remembered)
    awake_on_battery: Mutex<bool>,
    gpu: Mutex<Option<Gpu>>,
    limit: PowerLimit,
    power_mode: PowerMode,
    gpu_watts: Mutex<Option<f64>>,
    load_file: PathBuf,
    tray: Mutex<Option<TrayIcon>>,
    start_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    version: String,
    settings: Settings,
    miner: miner::Snapshot,
    pool: pool::PoolView,
    per_day: Option<f64>,
    gpu: Option<Gpu>,
    gpu_watts: Option<f64>,
    limit_mode: LimitMode,
    limit_watts: Option<f64>,
    cpu_name: String,
    cpu_threads: usize,
    on_ac: bool,
    keep_awake_on: bool,
    autostart_available: bool,
    power_mode_available: bool,
}

fn cpu_name() -> String {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        if let Ok(k) = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0") {
            if let Ok(n) = k.get_value::<String, _>("ProcessorNameString") {
                return n.trim().to_string();
            }
        }
        "This PC".into()
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|c| c.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split(':').nth(1)).map(|s| s.trim().to_string()))
            .unwrap_or_else(|| "This PC".into())
    }
}

impl App {
    fn view(&self, app: &AppHandle) -> View {
        let s = self.settings.lock().unwrap().clone();
        let m = self.miner.snapshot();
        let rate = if m.rate > 0.0 { m.rate } else { self.pool.view().worker_rate.unwrap_or(0.0) };
        let gpu = self.gpu.lock().unwrap().clone();
        let limit_watts = gpu.as_ref().and_then(|g| power::watts_for(s.power, g));
        View {
            version: app.package_info().version.to_string(),
            per_day: self.pool.per_day(rate),
            pool: self.pool.view(),
            miner: m,
            gpu_watts: *self.gpu_watts.lock().unwrap(),
            limit_mode: self.limit.mode(),
            limit_watts,
            gpu,
            cpu_name: cpu_name(),
            cpu_threads: miner::cpu_threads(),
            on_ac: power::on_ac(),
            keep_awake_on: self.awake.active(),
            autostart_available: true,
            power_mode_available: PowerMode::available(),
            settings: s,
        }
    }

    /// The GPU's power for the current slider: the board limit on NVIDIA when the helper
    /// runs, else blocks in flight through MXBM's load file (re-read before every solve).
    fn apply_power(&self) {
        let s = self.settings.lock().unwrap().clone();
        let running = self.miner.running();
        let gpu = self.gpu.lock().unwrap().clone();
        let mut load = s.power;
        if s.device == Device::Gpu && running {
            if let Some(g) = gpu.as_ref().filter(|g| g.solver == "cuda") {
                if let Some(w) = power::watts_for(s.power, g) {
                    self.limit.apply(g, w);
                    if matches!(self.limit.poll(), LimitMode::Watts | LimitMode::Asking) {
                        load = 100;
                    }
                }
            }
        }
        let _ = std::fs::write(&self.load_file, format!("{load}\n"));
    }

    fn update_awake(&self) {
        let s = self.settings.lock().unwrap();
        let want = self.miner.running() && if power::on_ac() { s.keep_awake } else { *self.awake_on_battery.lock().unwrap() };
        self.awake.set(want);
    }

    fn start(&self) {
        let s = self.settings.lock().unwrap().clone();
        self.miner.set_env(vec![
            ("MXBM_LOAD".into(), "100".into()),
            ("MXBM_LOAD_FILE".into(), self.load_file.to_string_lossy().to_string()),
        ]);
        let _ = std::fs::write(&self.load_file, "100\n");
        self.miner.start(&s);
        if s.best_performance {
            self.power_mode.hold();
        }
        self.pool.start_session(miner::now_unix());
        self.apply_power();
        self.update_awake();
    }

    fn stop(&self) {
        self.miner.stop();
        self.limit.release();
        self.power_mode.release();
        self.update_awake();
    }
}

// ---------------------------------------------------------------------------------------------
// commands for the window

#[tauri::command]
fn view(app: AppHandle, st: tauri::State<'_, Arc<App>>) -> View {
    st.view(&app)
}

#[tauri::command]
fn check_address(address: String) -> address::AddressType {
    address::check(&address)
}

#[tauri::command]
fn start(st: tauri::State<'_, Arc<App>>) {
    st.start();
}

#[tauri::command]
fn stop(st: tauri::State<'_, Arc<App>>) {
    st.stop();
}

#[tauri::command]
fn set_power(power: u32, st: tauri::State<'_, Arc<App>>) {
    let power = (power.clamp(10, 100) / 10) * 10;
    let device = {
        let mut s = st.settings.lock().unwrap();
        s.power = power;
        s.save(&st.settings_path);
        s.device
    };
    if device == Device::Cpu {
        let s = st.settings.lock().unwrap().clone();
        st.miner.restart_if_running(&s);
    }
    st.apply_power();
}

#[tauri::command]
fn set_device(device: Device, st: tauri::State<'_, Arc<App>>) {
    let s = {
        let mut s = st.settings.lock().unwrap();
        if s.device == device {
            return;
        }
        s.device = device;
        s.save(&st.settings_path);
        s.clone()
    };
    if device == Device::Cpu {
        st.limit.release();
    }
    st.miner.restart_if_running(&s);
    st.apply_power();
}

#[tauri::command]
fn set_keep_awake(on: bool, st: tauri::State<'_, Arc<App>>) {
    if power::on_ac() {
        let mut s = st.settings.lock().unwrap();
        s.keep_awake = on;
        s.save(&st.settings_path);
    } else {
        *st.awake_on_battery.lock().unwrap() = on;
    }
    st.update_awake();
}

#[tauri::command]
fn save_settings(app: AppHandle, new: Settings, first_run: bool, st: tauri::State<'_, Arc<App>>) {
    let changed = {
        let mut s = st.settings.lock().unwrap();
        let changed = s.address.trim() != new.address.trim() || s.clean_worker() != new.clean_worker() || s.mode != new.mode;
        s.address = new.address.trim().to_string();
        s.worker = if new.worker.trim().is_empty() { "bumblebeam".into() } else { new.worker.trim().to_string() };
        s.mode = new.mode;
        s.show_rate = new.show_rate;
        s.share_speed = new.share_speed;
        s.start_at_login = new.start_at_login;
        s.best_performance = new.best_performance;
        s.save(&st.settings_path);
        changed
    };
    if !new.best_performance {
        st.power_mode.release();
    } else if st.miner.running() {
        st.power_mode.hold();
    }
    let al = app.autolaunch();
    let _ = if new.start_at_login { al.enable() } else { al.disable() };
    let pool = st.pool.clone();
    let s = st.settings.lock().unwrap().clone();
    std::thread::spawn(move || pool.refresh(&s));
    if first_run {
        st.start();
    } else if changed {
        let s = st.settings.lock().unwrap().clone();
        st.miner.restart_if_running(&s);
    }
}

#[tauri::command]
fn open_url(url: String) {
    if !url.starts_with("https://") {
        return;
    }
    #[cfg(windows)]
    let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

#[tauri::command]
fn hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit(app: AppHandle, st: tauri::State<'_, Arc<App>>) {
    st.stop();
    app.exit(0);
}

// ---------------------------------------------------------------------------------------------
// the window and the tray

fn show_window(app: &AppHandle, near: Option<PhysicalPosition<f64>>) {
    let Some(w) = app.get_webview_window("main") else { return };
    place(&w, near);
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit("refresh", ());
}

/// Next to the tray icon when its position is known (Windows), else the screen's top right
/// (Linux panels mostly sit at the top) or bottom right on Windows.
fn place(w: &WebviewWindow, near: Option<PhysicalPosition<f64>>) {
    let Ok(Some(mon)) = w.current_monitor().or_else(|_| w.primary_monitor()) else { return };
    let (mp, ms) = (mon.position(), mon.size());
    let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new(360, 664));
    let margin = (12.0 * mon.scale_factor()) as i32;
    let (x, y) = match near {
        Some(p) => {
            let x = (p.x as i32 - size.width as i32 / 2).clamp(mp.x + margin, mp.x + ms.width as i32 - size.width as i32 - margin);
            let below = (p.y as i32) < mp.y + ms.height as i32 / 2;
            let y = if below { p.y as i32 + margin } else { p.y as i32 - size.height as i32 - margin };
            (x, y)
        }
        None if cfg!(windows) => (mp.x + ms.width as i32 - size.width as i32 - margin, mp.y + ms.height as i32 - size.height as i32 - 6 * margin),
        None => (mp.x + ms.width as i32 - size.width as i32 - margin, mp.y + 4 * margin),
    };
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

/// The tray icon: the hexagon with a play, pause or no-connection badge, light or dark.
fn tray_icon(state: &miner::State) -> tauri::image::Image<'static> {
    let light = light_taskbar();
    let png: &[u8] = match (state, light) {
        (miner::State::Mining | miner::State::Starting, false) => include_bytes!("../icons/tray-play-dark.png"),
        (miner::State::Mining | miner::State::Starting, true) => include_bytes!("../icons/tray-play-light.png"),
        (miner::State::NoConnection(_), false) => include_bytes!("../icons/tray-dot-dark.png"),
        (miner::State::NoConnection(_), true) => include_bytes!("../icons/tray-dot-light.png"),
        (miner::State::Stopped, false) => include_bytes!("../icons/tray-pause-dark.png"),
        (miner::State::Stopped, true) => include_bytes!("../icons/tray-pause-light.png"),
    };
    tauri::image::Image::from_bytes(png).expect("tray icon").to_owned()
}

/// Whether the taskbar is light (Windows' "SystemUsesLightTheme"); Linux panels: dark.
fn light_taskbar() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        return winreg::RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
            .and_then(|k| k.get_value::<u32, _>("SystemUsesLightTheme"))
            .map_or(false, |v| v == 1);
    }
    #[allow(unreachable_code)]
    false
}

fn update_tray(app: &AppHandle, st: &App) {
    let m = st.miner.snapshot();
    let show_rate = st.settings.lock().unwrap().show_rate;
    if let Some(t) = st.tray.lock().unwrap().as_ref() {
        let _ = t.set_icon(Some(tray_icon(&m.state)));
        let rate = if m.state == miner::State::Mining && m.rate > 0.0 { format!("{:.1} sol/s", m.rate) } else { String::new() };
        let tip = match &m.state {
            miner::State::Stopped => "BumbleBeam Miner: stopped".to_string(),
            miner::State::NoConnection(_) => "BumbleBeam Miner: no connection".to_string(),
            _ => format!("BumbleBeam Miner: mining {rate}"),
        };
        let _ = t.set_tooltip(Some(&tip));
        // a label next to the icon where the panel shows one (Linux)
        #[cfg(target_os = "linux")]
        let _ = t.set_title(Some(if show_rate { rate.as_str() } else { "" }));
        #[cfg(not(target_os = "linux"))]
        let _ = show_rate;
    }
    if let Some(item) = st.start_item.lock().unwrap().as_ref() {
        let _ = item.set_text(if m.state == miner::State::Stopped { "Start mining" } else { "Stop mining" });
    }
    let _ = app;
}

pub fn run() {
    tauri::Builder::default()
        // a second launch opens the first one's window instead of starting another miner
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app, None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .invoke_handler(tauri::generate_handler![view, check_address, start, stop, set_power, set_device, set_keep_awake, save_settings, open_url, hide, quit])
        .setup(|app| {
            let h = app.handle().clone();
            let cfg = app.path().app_config_dir()?;
            let data = app.path().app_data_dir()?;
            let logs = app.path().app_log_dir()?;
            let bin = std::env::current_exe()?.parent().map(PathBuf::from).unwrap_or_default();
            power::kill_leftovers(&bin);
            let settings_path = cfg.join("settings.json");
            let mut settings = Settings::load(&settings_path);
            let gpu = power::detect_gpu();
            if !settings.configured() && gpu.is_none() {
                settings.device = Device::Cpu; // no NVIDIA card: start on the CPU; GPU stays choosable
            }
            let miner = Miner::new(bin.clone(), data.clone(), logs);
            let limit = PowerLimit::new(&data, &bin);
            let power_mode = PowerMode::new(&data);
            power_mode.recover();
            if let Some(g) = gpu.as_ref() {
                limit.recover(g);
            }
            let st = Arc::new(App {
                settings: Mutex::new(settings.clone()),
                settings_path,
                miner,
                pool: Arc::new(Pool::new()),
                awake: Awake::new(),
                awake_on_battery: Mutex::new(false),
                gpu: Mutex::new(gpu),
                limit,
                power_mode,
                gpu_watts: Mutex::new(None),
                load_file: data.join("gpu-load"),
                tray: Mutex::new(None),
                start_item: Mutex::new(None),
            });
            app.manage(st.clone());

            // the tray: a click opens the window (Windows), the menu everywhere
            let open = MenuItem::with_id(app, "open", "Open BumbleBeam Miner", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Start mining", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &toggle, &PredefinedMenuItem::separator(app)?, &quit])?;
            *st.start_item.lock().unwrap() = Some(toggle);
            let tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon(&miner::State::Stopped))
                .tooltip("BumbleBeam Miner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| {
                    let st = app.state::<Arc<App>>().inner().clone();
                    match e.id.as_ref() {
                        "open" => show_window(app, None),
                        "toggle" => {
                            if st.miner.running() { st.stop() } else if st.settings.lock().unwrap().configured() { st.start() } else { show_window(app, None) }
                        }
                        "quit" => {
                            st.stop();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = e {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                                return;
                            }
                        }
                        show_window(app, Some(position));
                    }
                })
                .build(app)?;
            *st.tray.lock().unwrap() = Some(tray);

            // the window hides when it loses focus, like a tray popover (not on Linux, where
            // focus events from some panels arrive while the window opens)
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(windows)]
                {
                    let w2 = w.clone();
                    w.on_window_event(move |e| {
                        if let tauri::WindowEvent::Focused(false) = e {
                            let _ = w2.hide();
                        }
                    });
                }
                let _ = w;
            }

            // every second: the window's view and the tray; every 5 s: the GPU's power;
            // every 60 s: the pool and the speed report
            let st2 = st.clone();
            let h2 = h.clone();
            std::thread::spawn(move || {
                let mut tick: u64 = 0;
                let mut was_ac = power::on_ac();
                let mut reporter = SpeedReporter::default();
                loop {
                    if tick % 5 == 0 {
                        let watts = if st2.gpu.lock().unwrap().as_ref().map_or(false, |g| g.solver == "cuda") && st2.miner.running() {
                            power::nvidia_power().map(|(draw, _)| draw)
                        } else {
                            None
                        };
                        *st2.gpu_watts.lock().unwrap() = watts;
                        let before = st2.limit.mode();
                        if st2.limit.poll() != before {
                            st2.apply_power(); // rights refused: the slider goes by blocks
                        }
                        let ac = power::on_ac();
                        if ac != was_ac {
                            if !ac {
                                *st2.awake_on_battery.lock().unwrap() = false; // pulled: off until asked
                            }
                            was_ac = ac;
                        }
                        st2.update_awake();
                    }
                    if tick % 60 == 0 {
                        let s = st2.settings.lock().unwrap().clone();
                        st2.pool.refresh(&s);
                        reporter.tick(&st2, &h2);
                    }
                    update_tray(&h2, &st2);
                    let _ = h2.emit("view", st2.view(&h2));
                    tick += 1;
                    std::thread::sleep(Duration::from_secs(1));
                }
            });

            let start_now = std::env::args().any(|a| a == "--start") || settings.start_at_login && std::env::args().any(|a| a == "--autostart");
            if !settings.configured() {
                show_window(&h, None);
            } else if start_now {
                st.start();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("BumbleBeam Miner")
        .run(|app, e| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &e {
                if code.is_none() {
                    api.prevent_exit(); // closing the window keeps the tray app running
                }
            }
            if let tauri::RunEvent::Exit = e {
                if let Some(st) = app.try_state::<Arc<App>>() {
                    st.stop();
                }
            }
        });
}

// ---------------------------------------------------------------------------------------------
// "Share average speed"

/// After 30 minutes of steady mining on one device and power, the average speed and the machine
/// go to POST /api/benchmarks, no address; at most one report per device and power in 6 hours.
#[derive(Default)]
struct SpeedReporter {
    key: String,
    minutes: Vec<f64>,
    watts: Vec<f64>,
    sent: std::collections::HashMap<String, std::time::Instant>,
}

impl SpeedReporter {
    fn tick(&mut self, st: &App, app: &AppHandle) {
        let s = st.settings.lock().unwrap().clone();
        let m = st.miner.snapshot();
        if !s.share_speed || m.state != miner::State::Mining || m.rate <= 0.0 {
            self.reset(String::new());
            return;
        }
        let key = format!("{:?}-{}", s.device, s.power);
        if key != self.key {
            self.reset(key);
            return;
        }
        self.minutes.push(m.rate);
        if let Some(w) = *st.gpu_watts.lock().unwrap() {
            self.watts.push(w);
        }
        if self.minutes.len() < 32 {
            return; // the first two minutes settle, then 30 to average
        }
        let rates = &self.minutes[2..];
        let avg = rates.iter().sum::<f64>() / rates.len() as f64;
        let gpu = st.gpu.lock().unwrap().clone();
        let mut body = serde_json::json!({
            "app": app.package_info().version.to_string(),
            "os": os_name(),
            "arch": std::env::consts::ARCH,
            "model": gpu.as_ref().filter(|_| s.device == Device::Gpu).map(|g| g.name.clone()).unwrap_or_else(|| "pc".into()),
            "chip": if s.device == Device::Gpu { gpu.as_ref().map(|g| g.name.clone()).unwrap_or_else(|| "GPU".into()) } else { cpu_name() },
            "cpuThreads": miner::cpu_threads(),
            "device": if s.device == Device::Gpu { "gpu" } else { "cpu" },
            "power": s.power,
            "solPerSec": (avg * 100.0).round() / 100.0,
            "minutes": rates.len(),
        });
        if !self.watts.is_empty() {
            body["gpuWatts"] = serde_json::json!((self.watts.iter().sum::<f64>() / self.watts.len() as f64 * 10.0).round() / 10.0);
        }
        let k = self.key.clone();
        self.reset(k.clone());
        if self.sent.get(&k).map_or(true, |t| t.elapsed() > Duration::from_secs(6 * 3600)) && st.pool.report(&body) {
            self.sent.insert(k, std::time::Instant::now());
        }
    }

    fn reset(&mut self, key: String) {
        self.key = key;
        self.minutes.clear();
        self.watts.clear();
    }
}

fn os_name() -> String {
    #[cfg(windows)]
    return "Windows".into();
    #[cfg(not(windows))]
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|r| r.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l[12..].trim_matches('"').chars().take(60).collect()))
        .unwrap_or_else(|| "Linux".into())
}
