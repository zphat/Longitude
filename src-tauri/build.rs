fn main() {
    // The installer copies the background remover (onnxruntime-web and the Fast model) from src-tauri/vendor/,
    // which stage_vendor.py fills from tools/fetch_model.py (docs/DESKTOP.md). A build without those files still
    // needs the folder that tauri.conf.json lists as a resource: it gets an empty manifest, and that copy of the
    // app downloads the model on first use, like the browser version.
    let vendor = std::path::Path::new("vendor");
    if !vendor.join("manifest.json").exists() {
        let _ = std::fs::create_dir_all(vendor);
        let _ = std::fs::write(vendor.join("manifest.json"), "{\"v\": 1, \"ort\": null, \"models\": {}}\n");
    }
    // Everything in ../web is compiled into the program, web/vendor/ (about 82 MB) included. The desktop app never
    // reads that copy: it loads src-tauri/vendor/ from the install folder instead.
    if std::path::Path::new("../web/vendor").exists() {
        println!("cargo:warning=web/vendor/ is compiled into the program as well. Run `python src-tauri/stage_vendor.py --move` first (docs/DESKTOP.md).");
    }
    tauri_build::build()
}
