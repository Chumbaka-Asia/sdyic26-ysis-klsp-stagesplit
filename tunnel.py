"""
A public link for phones that aren't on the show's Wi-Fi (mobile data, or a
different network), using a free Cloudflare "quick tunnel". No account needed.

    tunnel.start(port)  -> starts it in the background
    tunnel.status()     -> {"state": "on", "url": "https://….trycloudflare.com", ...}

The first time, the small cloudflared program is downloaded from Cloudflare's
official GitHub releases into the tools/ folder.

Only the voting pages are reachable through the public link (app.py enforces
this); the Studio, editor and show pages stay private to this laptop.
"""

import os
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import threading
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.join(BASE_DIR, "tools")
RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

_proc = None
_status = {"state": "off", "url": None, "error": None}
_lock = threading.Lock()


def status():
    return dict(_status)


def _asset():
    system, machine = platform.system(), platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if system == "Windows":
        return "cloudflared-windows-amd64.exe", "cloudflared.exe"
    if system == "Darwin":
        return ("cloudflared-darwin-arm64.tgz" if arm else "cloudflared-darwin-amd64.tgz"), "cloudflared"
    return ("cloudflared-linux-arm64" if arm else "cloudflared-linux-amd64"), "cloudflared"


def find_or_download():
    """Path to cloudflared: already installed, in tools/, or downloaded now."""
    found = shutil.which("cloudflared")
    if found:
        return found
    asset, exe = _asset()
    target = os.path.join(TOOLS_DIR, exe)
    if os.path.exists(target):
        return target
    os.makedirs(TOOLS_DIR, exist_ok=True)
    _status.update(state="downloading", error=None)
    tmp = target + ".download"
    urllib.request.urlretrieve(RELEASES + asset, tmp)
    if asset.endswith(".tgz"):
        with tarfile.open(tmp) as tar:
            member = next(m for m in tar.getmembers() if m.name.endswith("cloudflared"))
            with tar.extractfile(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
        os.remove(tmp)
    else:
        os.replace(tmp, target)
    os.chmod(target, os.stat(target).st_mode | stat.S_IEXEC)
    return target


def _run(port):
    global _proc
    try:
        exe = find_or_download()
        _status.update(state="starting", error=None)
        _proc = subprocess.Popen(
            [exe, "tunnel", "--no-autoupdate", "--url", f"http://localhost:{port}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        for line in _proc.stdout:  # cloudflared prints the public address in its log
            m = URL_RE.search(line)
            if m and _status["state"] != "on":
                _status.update(state="on", url=m.group(0), error=None)
        if _status["state"] != "off":
            _status.update(state="failed", url=None, error="The public link stopped. Check the internet connection and try again.")
    except Exception as exc:
        _status.update(state="failed", url=None, error=f"{type(exc).__name__}: {exc}"[:300])


def start(port):
    with _lock:
        if _status["state"] in ("downloading", "starting", "on"):
            return status()
        _status.update(state="starting", url=None, error=None)
        threading.Thread(target=_run, args=(port,), daemon=True).start()
    return status()


def stop():
    global _proc
    with _lock:
        _status.update(state="off", url=None, error=None)
        if _proc and _proc.poll() is None:
            _proc.terminate()
        _proc = None
    return status()
