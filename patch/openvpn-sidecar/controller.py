#!/usr/bin/env python3
from __future__ import annotations

import hmac
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CONTROL_TOKEN = os.environ.get("CONTROL_TOKEN", "")
STATE_DIR = Path(os.environ.get("STATE_DIR", "/state"))
STATE_FILE = STATE_DIR / "connection.json"
CONFIG_FILE = STATE_DIR / "nordvpn.tcp.ovpn"
AUTH_FILE = STATE_DIR / "auth.txt"
LOG_FILE = STATE_DIR / "openvpn.log"
HOST_RE = re.compile(r"^[a-z]{2}[0-9]+\.nordvpn\.com$", re.IGNORECASE)
MAX_BODY = 16 * 1024
CONNECT_TIMEOUT = 50

lock = threading.RLock()
openvpn_process: subprocess.Popen[str] | None = None
socks_process: subprocess.Popen[str] | None = None
active_hostname = ""
last_error = ""


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, mode)
    temporary.replace(path)


def download_config(hostname: str) -> str:
    url = f"https://downloads.nordcdn.com/configs/files/ovpn_tcp/servers/{hostname}.tcp.ovpn"
    request = urllib.request.Request(url, headers={"User-Agent": "PasarGuard-Nord-OpenVPN/1.0"})
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read(512 * 1024 + 1)
    if len(body) > 512 * 1024:
        raise RuntimeError("NordVPN configuration exceeded the safety limit")
    config = body.decode("utf-8")
    if "client" not in config.splitlines() or not re.search(r"(?m)^proto tcp(?:-client)?\s*$", config):
        raise RuntimeError("NordVPN did not return a TCP OpenVPN client configuration")
    forbidden = re.compile(r"(?mi)^\s*(up|down|route-up|ipchange|plugin|script-security)\b")
    if forbidden.search(config):
        raise RuntimeError("NordVPN configuration contains unsupported script directives")
    return config


def stop_openvpn() -> None:
    global openvpn_process, socks_process
    if socks_process is not None and socks_process.poll() is None:
        socks_process.terminate()
        try:
            socks_process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            socks_process.kill()
    socks_process = None
    process = openvpn_process
    openvpn_process = None
    if process is None or process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def read_log_tail() -> str:
    try:
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lines[-20:])


def proxy_egress_ip(timeout: int = 12) -> tuple[str, int]:
    started = time.monotonic()
    result = subprocess.run(
        [
            "curl", "--silent", "--show-error", "--fail", "--max-time", str(timeout),
            "--socks5-hostname", "127.0.0.1:1080", "https://api.ipify.org",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout + 2,
    )
    delay = int((time.monotonic() - started) * 1000)
    ip = result.stdout.strip()
    if result.returncode != 0 or not re.fullmatch(r"[0-9a-fA-F:.]+", ip):
        raise RuntimeError("SOCKS egress check failed")
    return ip, delay


def connect(payload: dict[str, Any], *, persist: bool = True) -> dict[str, Any]:
    global openvpn_process, socks_process, active_hostname, last_error
    hostname = str(payload.get("hostname", "")).strip().lower()
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not HOST_RE.fullmatch(hostname):
        raise ValueError("Only official NordVPN server hostnames are accepted")
    if not username or len(username) > 256 or not password or len(password) > 512:
        raise ValueError("Valid NordVPN service credentials are required")

    with lock:
        stop_openvpn()
        active_hostname = ""
        last_error = ""
        config = download_config(hostname)
        atomic_write(CONFIG_FILE, config)
        atomic_write(AUTH_FILE, f"{username}\n{password}\n")
        LOG_FILE.write_text("", encoding="utf-8")
        os.chmod(LOG_FILE, 0o600)
        log_handle = LOG_FILE.open("a", encoding="utf-8")
        openvpn_process = subprocess.Popen(
            [
                "openvpn", "--config", str(CONFIG_FILE), "--auth-user-pass", str(AUTH_FILE),
                "--auth-nocache", "--connect-retry-max", "1", "--connect-timeout", "10",
            ],
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.monotonic() + CONNECT_TIMEOUT
        while time.monotonic() < deadline:
            if openvpn_process.poll() is not None:
                tail = read_log_tail()
                last_error = "Nord OpenVPN exited before connecting"
                if "AUTH_FAILED" in tail:
                    last_error = "NordVPN rejected the service credentials"
                raise RuntimeError(last_error)
            if "Initialization Sequence Completed" in read_log_tail():
                break
            time.sleep(0.5)
        else:
            last_error = "Nord OpenVPN connection timed out"
            stop_openvpn()
            raise RuntimeError(last_error)

        socks_process = subprocess.Popen(["sockd", "-f", "/app/sockd.conf"])
        time.sleep(0.5)
        if socks_process.poll() is not None:
            stop_openvpn()
            raise RuntimeError("SOCKS proxy failed to start on the OpenVPN tunnel")
        ip, delay = proxy_egress_ip()
        active_hostname = hostname
        if persist:
            atomic_write(STATE_FILE, json.dumps({"hostname": hostname, "username": username, "password": password}))
        return {"connected": True, "hostname": hostname, "egress_ip": ip, "delay": delay, "proxy_port": 1080}


def status() -> dict[str, Any]:
    with lock:
        if openvpn_process is None or openvpn_process.poll() is not None or socks_process is None or socks_process.poll() is not None or not active_hostname:
            return {"connected": False, "hostname": active_hostname, "egress_ip": "", "delay": 0, "error": last_error}
        try:
            ip, delay = proxy_egress_ip(timeout=8)
            return {"connected": True, "hostname": active_hostname, "egress_ip": ip, "delay": delay, "proxy_port": 1080}
        except Exception as exc:
            return {"connected": False, "hostname": active_hostname, "egress_ip": "", "delay": 0, "error": str(exc)}


def disconnect() -> dict[str, Any]:
    global active_hostname, last_error
    with lock:
        stop_openvpn()
        active_hostname = ""
        last_error = ""
        STATE_FILE.unlink(missing_ok=True)
        AUTH_FILE.unlink(missing_ok=True)
    return {"connected": False, "hostname": "", "egress_ip": "", "delay": 0}


class Handler(BaseHTTPRequestHandler):
    server_version = "PasarGuardOpenVPN/1.0"

    def log_message(self, format: str, *args: object) -> None:
        return

    def send_json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
        return bool(CONTROL_TOKEN) and hmac.compare_digest(supplied, CONTROL_TOKEN)

    def read_payload(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_BODY:
            raise ValueError("Request body is too large")
        value = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(value, dict):
            raise ValueError("JSON object required")
        return value

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if not self.authorized():
            self.send_json(401, {"error": "Unauthorized"})
            return
        if self.path == "/status":
            self.send_json(200, status())
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self.authorized():
            self.send_json(401, {"error": "Unauthorized"})
            return
        try:
            if self.path == "/connect":
                self.send_json(200, connect(self.read_payload()))
            elif self.path == "/disconnect":
                self.send_json(200, disconnect())
            else:
                self.send_json(404, {"error": "Not found"})
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(502, {"error": str(exc)})


def restore_connection() -> None:
    if not STATE_FILE.is_file():
        return
    try:
        payload = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        connect(payload, persist=False)
    except Exception as exc:
        global last_error
        last_error = f"Automatic reconnect failed: {exc}"


def shutdown(_signum: int, _frame: object) -> None:
    with lock:
        stop_openvpn()
    raise SystemExit(0)


def main() -> None:
    if len(CONTROL_TOKEN) < 32:
        raise SystemExit("CONTROL_TOKEN must contain at least 32 characters")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    threading.Thread(target=restore_connection, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
