//! Longitude desktop shell. The app is ../web, plain static files that Tauri embeds at build time; this file is the
//! thin native layer around it (docs/DESKTOP.md):
//! - the bundled background remover (onnxruntime-web and the Fast model), installed next to the program as
//!   resources and served from there on the `vendor` protocol (http://vendor.localhost/ on Windows),
//! - files handed to Longitude (a double-clicked .longitude, "Open with", a second launch) queued for the page,
//! - links opened in the default browser,
//! - a close that gives the page a moment to write its last autosave.

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    http::{header, Method, Response, StatusCode},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

// ---------- the bundled background remover ----------

/// The folder under the resource directory (the install folder on Windows) that bundle.resources fills.
const VENDOR_DIR: &str = "vendor";

/// The request path as a file under `root`, or None for anything but a plain relative path of letters, digits,
/// '.', '-' and '_' (no "..", no hidden files, no drive letters, no backslashes, no percent escapes).
fn vendor_path(root: &Path, uri_path: &str) -> Option<PathBuf> {
    let rel = uri_path.trim_start_matches('/');
    if rel.is_empty() || rel.len() > 200 {
        return None;
    }
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        let plain = !seg.is_empty()
            && !seg.starts_with('.')
            && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
        if !plain {
            return None;
        }
        out.push(seg);
    }
    Some(out)
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mjs" | "js" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "json" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Every vendor response, errors included, carries what a cross-origin isolated page needs to use it: CORS for
/// fetch() and module imports, Cross-Origin-Resource-Policy for anything else.
fn reply(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header("cross-origin-resource-policy", "cross-origin")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    reply(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", b"Not found".to_vec())
}

fn vendor_response(app: &AppHandle, method: &Method, uri_path: &str) -> Response<Vec<u8>> {
    if *method == Method::OPTIONS {
        return reply(StatusCode::NO_CONTENT, "text/plain; charset=utf-8", Vec::new());
    }
    let head = *method == Method::HEAD;
    if *method != Method::GET && !head {
        return reply(StatusCode::METHOD_NOT_ALLOWED, "text/plain; charset=utf-8", Vec::new());
    }
    let root = match app.path().resource_dir() {
        Ok(dir) => dir.join(VENDOR_DIR),
        Err(_) => return not_found(),
    };
    let Some(file) = vendor_path(&root, uri_path) else {
        return not_found();
    };
    match fs::read(&file) {
        Ok(bytes) => reply(StatusCode::OK, mime_for(&file), if head { Vec::new() } else { bytes }),
        Err(_) => not_found(),
    }
}

// ---------- files handed to the app ----------

/// What the page can open (fileKind in web/js/ui/commands-core.js): designs, images and fonts.
const OPENABLE: [&str; 13] = ["longitude", "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg", "ttf", "otf", "woff", "woff2"];
const MAX_OPEN_BYTES: u64 = 1 << 30;
const MAX_FILES_PER_LAUNCH: usize = 20;

/// Every file handed over this session (an id is its index) and the ids the page has not taken yet.
#[derive(Default)]
struct OpenedState {
    files: Vec<PathBuf>,
    pending: Vec<usize>,
}

struct Opened(Mutex<OpenedState>);

#[derive(Serialize)]
struct OpenedFile {
    id: usize,
    name: String,
}

fn openable(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    OPENABLE.iter().any(|x| ext.eq_ignore_ascii_case(x))
}

/// The files among a command line's arguments. The program itself, flags and anything that is not an existing
/// file Longitude opens are skipped; relative paths are taken from the launching shell's folder.
fn file_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for a in args {
        if a.is_empty() || a.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(a);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        if openable(&p) && p.is_file() && !out.contains(&p) {
            out.push(p);
        }
        if out.len() >= MAX_FILES_PER_LAUNCH {
            break;
        }
    }
    out
}

/// Queues the files for the page. `notify`: the page is already running, so it is told to come and take them
/// (take_opened_files); on a cold start it asks by itself once it has loaded.
fn queue_files(app: &AppHandle, args: &[String], cwd: &Path, notify: bool) {
    let paths = file_args(args, cwd);
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<Opened>() {
        if let Ok(mut g) = state.0.lock() {
            for p in paths {
                let id = g.files.len();
                g.files.push(p);
                g.pending.push(id);
            }
        }
    }
    if notify {
        let _ = app.emit("longitude://open-files", ());
    }
}

fn opened_path(app: &AppHandle, id: usize) -> Option<PathBuf> {
    let state = app.try_state::<Opened>()?;
    let guard = state.0.lock().ok()?;
    let path = guard.files.get(id).cloned();
    path
}

/// The files handed over since the last call, as { id, name }. Only these ids can be read.
#[tauri::command]
fn take_opened_files(app: AppHandle) -> Vec<OpenedFile> {
    let mut out = Vec::new();
    if let Some(state) = app.try_state::<Opened>() {
        if let Ok(mut g) = state.0.lock() {
            let ids: Vec<usize> = g.pending.drain(..).collect();
            for id in ids {
                if let Some(p) = g.files.get(id) {
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "file".to_string());
                    out.push(OpenedFile { id, name });
                }
            }
        }
    }
    out
}

/// The bytes of a handed-over file, as an ArrayBuffer on the page. Off the main thread: a project file can be
/// tens of megabytes.
#[tauri::command(async)]
fn read_opened_file(app: AppHandle, id: usize) -> Result<tauri::ipc::Response, String> {
    let path = opened_path(&app, id).ok_or_else(|| "That file is no longer available.".to_string())?;
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_OPEN_BYTES {
        return Err("That file is too large to open.".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------- links ----------

/// Opens a web page in the default browser. Only http and https: a page must never start another program.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let web = url.starts_with("https://") || url.starts_with("http://");
    if !web || url.len() > 2048 || url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("Only web links can be opened.".to_string());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------- window ----------

/// Set once the page listens for close requests (desktop.js). Until then the close button closes at once, so a
/// page that failed to start never holds the window open.
static CLOSE_HANDSHAKE: AtomicBool = AtomicBool::new(false);
/// A close is under way; a second click on the close button closes without waiting.
static CLOSING: AtomicBool = AtomicBool::new(false);
/// How long the page gets to save before the window closes anyway.
const CLOSE_GRACE: Duration = Duration::from_millis(4000);

#[tauri::command]
fn close_handshake() {
    CLOSE_HANDSHAKE.store(true, Ordering::SeqCst);
}

/// The page has saved; close now. From a plain thread: tearing a webview down inside its own IPC call can
/// deadlock on Windows.
#[tauri::command]
fn close_now(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        let _ = window.destroy();
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder: tauri::Builder<tauri::Wry> = tauri::Builder::default();
    builder
        // First, so a second launch goes no further: it hands its files to this one, which comes to the front.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            queue_files(app, &args, Path::new(&cwd), true);
            show_main(app);
        }))
        // Size, position and maximized are remembered. preventOverflow in tauri.conf.json keeps the first window
        // inside the screen's work area.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(Opened(Mutex::new(OpenedState::default())))
        // http://vendor.localhost/<path> (vendor://localhost/<path> on macOS and Linux) -> <resources>/vendor/<path>.
        // Asynchronous, so reading a 44 MB model never blocks the window.
        .register_asynchronous_uri_scheme_protocol("vendor", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let method = request.method().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                responder.respond(vendor_response(&app, &method, &path));
            });
        })
        .setup(|app| {
            // A double-clicked .longitude (or "Open with") arrives as an argument of the first launch.
            let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            queue_files(app.handle(), &args, &cwd, false);
            Ok(())
        })
        // The close button asks the page to save first (desktop.js), then the page closes the window. WebView2
        // fires no pagehide when a window is destroyed, so without this the last second of work could be lost.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" || !CLOSE_HANDSHAKE.load(Ordering::SeqCst) || CLOSING.swap(true, Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("longitude://close-requested", ());
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(CLOSE_GRACE);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.destroy();
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            take_opened_files,
            read_opened_file,
            open_url,
            close_handshake,
            close_now
        ])
        .run(tauri::generate_context!())
        .expect("error while running Longitude");
}
