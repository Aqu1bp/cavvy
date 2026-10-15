//! The Harness desktop app: a native window around the GUI, plus the harness
//! server as a sidecar process (the same Bun program as the CLI, built with
//! `bun build --compile`).
//!
//! Startup: the sidecar is started with `serve --handshake`, prints one JSON
//! line with its port and a random token, and keeps running until its stdin
//! closes (which happens when this app exits, however it exits). The webview
//! asks for the port and token with the `sidecar_info` command and connects
//! to the server's WebSocket on 127.0.0.1 directly.
//!
//! The webview gets no shell access: only this file starts processes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize)]
pub struct SidecarInfo {
    port: u16,
    token: String,
}

#[derive(Deserialize)]
struct Handshake {
    #[serde(rename = "type")]
    kind: String,
    port: u16,
    token: String,
}

struct Sidecar {
    info: watch::Sender<Option<SidecarInfo>>,
    child: Mutex<Option<CommandChild>>,
    /** When it last (re)started, for giving up on a crash loop. */
    starts: Mutex<Vec<Instant>>,
    exiting: AtomicBool,
}

/// How to reach the server. Waits for it to start (or restart).
#[tauri::command]
async fn sidecar_info(state: State<'_, Sidecar>) -> Result<SidecarInfo, String> {
    let mut rx = state.info.subscribe();
    let ready = async {
        let v = rx.wait_for(|v| v.is_some()).await.map_err(|_| "the harness server stopped".to_string())?;
        Ok::<_, String>(v.clone().expect("checked by wait_for"))
    };
    match tokio::time::timeout(Duration::from_secs(25), ready).await {
        Ok(r) => r,
        Err(_) => Err("the harness server didn't start in time".into()),
    }
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Sidecar>();
    {
        let mut starts = state.starts.lock().unwrap();
        let now = Instant::now();
        starts.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if starts.len() >= 5 {
            return Err("the harness server keeps stopping; not restarting it again".into());
        }
        starts.push(now);
    }

    let shell = app.shell();
    let dev = cfg!(debug_assertions) && std::env::var_os("HARNESS_USE_SIDECAR").is_none();
    let cmd = if dev {
        // Development: the TypeScript source, so server changes need no rebuild.
        let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        shell.command("bun").args([
            "--no-env-file".to_string(),
            format!("--config={repo}/bunfig.toml"),
            format!("{repo}/src/index.ts"),
            "serve".into(),
            "--handshake".into(),
            "--login-env".into(),
            "--dev-origin".into(),
            "http://localhost:5173".into(),
        ])
    } else {
        shell
            .sidecar("harness")
            .map_err(|e| e.to_string())?
            .args(["serve", "--handshake", "--login-env"])
    };
    // Start in the home folder; sessions say which project they work in.
    let cmd = match app.path().home_dir() {
        Ok(home) => cmd.current_dir(home),
        Err(_) => cmd,
    };
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("couldn't start the harness server: {e}"))?;
    *state.child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut pending = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    pending.push_str(&String::from_utf8_lossy(&bytes));
                    pending.push('\n');
                    while let Some(i) = pending.find('\n') {
                        let line: String = pending.drain(..=i).collect();
                        if let Ok(h) = serde_json::from_str::<Handshake>(line.trim()) {
                            if h.kind == "ready" {
                                eprintln!("[harness] server ready on port {}", h.port);
                                // send_replace: stores it even while no window is waiting (send would drop it).
                                app.state::<Sidecar>().info.send_replace(Some(SidecarInfo { port: h.port, token: h.token }));
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(e) => eprintln!("[harness] {e}"),
                CommandEvent::Terminated(p) => {
                    let state = app.state::<Sidecar>();
                    state.info.send_replace(None);
                    *state.child.lock().unwrap() = None;
                    if state.exiting.load(Ordering::SeqCst) {
                        break;
                    }
                    eprintln!("[harness] server exited ({:?}); restarting", p.code);
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    if let Err(e) = spawn_sidecar(&app) {
                        eprintln!("[harness] {e}");
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<Sidecar>();
    state.exiting.store(true, Ordering::SeqCst);
    // Closing its stdin is enough (it exits and runs its SessionEnd hooks);
    // killing it is the fallback for when it doesn't.
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

pub fn run() {
    let (info, _) = watch::channel(None);
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // A second launch focuses the window that's already open.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar { info, child: Mutex::new(None), starts: Mutex::new(Vec::new()), exiting: AtomicBool::new(false) })
        .invoke_handler(tauri::generate_handler![sidecar_info])
        .setup(|app| {
            spawn_sidecar(app.handle()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Harness")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_sidecar(app);
            }
        });
}
