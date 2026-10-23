"""Local server for Longitude. Standard library only.

    python serve.py            serve web/ on http://localhost:8770
    python serve.py --open     also open it (Edge app window on Windows when available)
    python serve.py --port 9000

Why not plain `python -m http.server`: on Windows it takes MIME types from the
registry, which can serve .js as text/plain and break ES modules. This server
pins the types, disables caching while you develop, and sends the
cross-origin isolation headers that let background removal use WASM threads.
"""

import argparse
import http.server
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "web"

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    # Keep-alive: the app is ~90 small ES modules, and a new connection per file is slow.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(str(path))[1].lower(), "application/octet-stream")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "--quiet" not in sys.argv:
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Server6(Server):
    address_family = socket.AF_INET6


def also_ipv6(port):
    # Browsers resolve "localhost" to ::1 first. Without an IPv6 listener each
    # connection waits ~300 ms before falling back to 127.0.0.1.
    try:
        httpd6 = Server6(("::1", port), Handler)
    except OSError:
        return
    threading.Thread(target=httpd6.serve_forever, daemon=True).start()


def open_app(url):
    # A chromeless Edge window feels like a desktop app. Fall back to the default browser.
    if sys.platform == "win32":
        for exe in (
            shutil.which("msedge"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        ):
            if exe and os.path.exists(exe):
                subprocess.Popen([exe, f"--app={url}", "--window-size=1440,900"])
                return
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description="Serve Longitude locally.")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--open", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    if not (ROOT / "index.html").exists():
        sys.exit(f"Cannot find {ROOT / 'index.html'}")
    try:
        httpd = Server((a.bind, a.port), Handler)
    except OSError:
        url = f"http://localhost:{a.port}/"
        print(f"Port {a.port} is busy. If Longitude is already running, open {url}")
        if a.open:
            open_app(url)
        return
    if a.bind in ("127.0.0.1", "localhost"):
        also_ipv6(a.port)
    url = f"http://localhost:{a.port}/"
    print(f"Longitude is running at {url}  (Ctrl+C to stop)")
    if a.open:
        threading.Timer(0.4, open_app, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
