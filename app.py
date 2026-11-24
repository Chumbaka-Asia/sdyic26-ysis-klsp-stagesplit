"""
KLSP Interactive Show - local server.

What this server does:
  1. Serves the show page (/), the story editor (/editor) and the phone
     voting page (/vote).
  2. Keeps each show as a "project" in the projects/ folder: its story,
     its videos and automatic backups. One project is open at a time.
  3. Runs audience "rounds": each decision point opens a round, phones vote
     and send emojis, and the show page reads the running tally.
  4. Classifies open-ended spoken answers with Claude (optional; the show
     falls back to keyword matching when no API key is set).

Run it with run.bat (Windows) or ./run.sh (Mac/Linux).
"""

import io
import json
import os
import re
import shutil
import socket
import threading
import time
import zipfile
from collections import Counter
from datetime import datetime
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context
from werkzeug.utils import secure_filename

import atexit
import queue
import random
import secrets

import names
import tunnel
import whisper_engine

load_dotenv()

PORT = int(os.getenv("PORT", "8000"))
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-haiku-4-5-20251001")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PROJECTS_DIR = os.path.join(BASE_DIR, "projects")
TRASH_DIR = os.path.join(PROJECTS_DIR, ".trash")
WORKSPACE_PATH = os.path.join(BASE_DIR, "workspace.json")   # remembers the open project
SAMPLE_PATH = os.path.join(BASE_DIR, "sample", "story.json")
LEGACY_STORY = os.path.join(BASE_DIR, "story.json")           # from older versions
LEGACY_VIDEOS = os.path.join(STATIC_DIR, "videos")
BACKUP_EVERY_SEC = 120   # at most one automatic backup every 2 minutes
BACKUPS_TO_KEEP = 60
VIDEO_TYPES = {".mp4", ".webm", ".mov", ".m4v"}
PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
LIBRARY_PATH = os.path.join(BASE_DIR, "library", "names.json")
# By default the Studio and editor only work on the show laptop itself, so
# phones on the same Wi-Fi (used for voting) can't change anything.
ALLOW_REMOTE_EDITING = os.getenv("ALLOW_REMOTE_EDITING", "off").strip().lower() in {"on", "1", "true", "yes"}
# A fresh 4-digit room code each time the server starts. Phones join with it.
ROOM_CODE = f"{random.randint(0, 9999):04d}"
# Through the public link only these are reachable (voting only).
PUBLIC_PATHS = {"/vote", "/join", "/watch", "/api/round", "/api/vote", "/api/emoji", "/favicon.ico"}
# ...plus the online room (/api/live/…, except the host's controls) and show videos (/media/…).
PUBLIC_PREFIXES = ("/static/", "/api/live/", "/media/")

APP_VERSION = "2026.09.26-12"   # shown in the Studio and Camera check, so you can see which version is running

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
# Always let the browser check for newer files, so an update takes effect straight away.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4 GB (project files include videos)

# ---------------------------------------------------------------------------
# Audience round state (kept in memory; resets when the server restarts)
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_round = {
    "round_id": 0,
    "node_id": None,
    "question": "",
    "options": [],          # [{"id": "forest", "label": "The forest", "emoji": "🌲"}]
    "open": False,
    "paused": False,
}
_votes = {}                 # voter_id -> option_id
_emojis = Counter()         # emoji -> count


def get_lan_ip():
    """Best guess at this computer's Wi-Fi/LAN address, so phones can connect."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No data is sent; this only asks the OS which network card it would use.
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def lan_base():
    return f"http://{get_lan_ip()}:{PORT}"


def vote_url():
    """The address phones should open: the public link if it's on, else this Wi-Fi."""
    base = tunnel.status().get("url") or lan_base()
    return f"{base}/vote?room={ROOM_CODE}"


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.after_request
def no_stale_files(resp):
    if request.path.startswith("/static/") or request.path in ("/", "/play", "/studio", "/editor", "/operator", "/script", "/camera-check"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


def via_public_link():
    """Requests through the Cloudflare public link carry these headers."""
    return any(h in request.headers for h in ("Cf-Connecting-Ip", "Cf-Ray", "X-Forwarded-For"))


@app.before_request
def public_link_guard():
    """Through the public link, only the voting pages exist."""
    if via_public_link() and request.path not in PUBLIC_PATHS and not request.path.startswith(PUBLIC_PREFIXES):
        return ("Not found", 404)


def team_only(fn):
    """Studio, editor and anything that changes files: only on the show laptop."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        local = request.remote_addr in ("127.0.0.1", "::1") and not via_public_link()
        if local or (ALLOW_REMOTE_EDITING and not via_public_link()):
            return fn(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "reason": "Editing only works on the show laptop."}), 403
        return ("<h1 style='font-family:sans-serif'>This page only works on the show laptop.</h1>"
                "<p style='font-family:sans-serif'><a href='/'>Go to the stories</a></p>"), 403
    return wrapper


@app.route("/")
def home_page():
    return send_from_directory(STATIC_DIR, "home.html")


@app.route("/play")
def show_page():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/studio")
@team_only
def studio_page():
    return send_from_directory(STATIC_DIR, "studio.html")


@app.route("/edit/<pid>")
@team_only
def edit_project(pid):
    """Open a show in the editor (used by the Studio and the show page)."""
    from flask import redirect
    if pdir(pid):
        set_current(pid)
        return redirect("/editor")
    return redirect("/studio")


@app.route("/vote")
def vote_page():
    return send_from_directory(STATIC_DIR, "vote.html")


@app.route("/watch")
def watch_page():
    return send_from_directory(STATIC_DIR, "watch.html")


@app.route("/join")
def join_page():
    return send_from_directory(STATIC_DIR, "join.html")


@app.route("/operator")
@team_only
def operator_page():
    return send_from_directory(STATIC_DIR, "operator.html")


@app.route("/camera-check")
@team_only
def camera_check_page():
    return send_from_directory(STATIC_DIR, "camera.html")


@app.route("/script")
@team_only
def script_page():
    return send_from_directory(STATIC_DIR, "script.html")


@app.route("/editor")
@team_only
def editor_page():
    return send_from_directory(STATIC_DIR, "editor.html")


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
_story_lock = threading.Lock()
_last_backup = {}   # project id -> time of last automatic backup

BLANK_STORY = {
    "title": "New show",
    "start": "scene_1",
    "settings": {"speech_lang": "en-US", "weights": {"poll": 0.5, "voice": 0.4, "emoji": 0.1},
                 "default_window_sec": 15, "custom_actions": []},
    "nodes": {
        "scene_1": {"type": "scene", "next": None,
                    "clip": {"file": "", "title": "Opening scene", "line": "", "duration": 6}},
    },
}


def _json_load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _json_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # atomic: never leaves a half-written file


def pdir(pid):
    if not pid or not PROJECT_ID.match(pid):
        return None
    d = os.path.join(PROJECTS_DIR, pid)
    return d if os.path.isdir(d) else None


def current_id():
    pid = (_json_load(WORKSPACE_PATH, {}) or {}).get("current")
    return pid if pdir(pid) else None


def set_current(pid):
    _json_write(WORKSPACE_PATH, {"current": pid})


def story_path(pid):
    return os.path.join(PROJECTS_DIR, pid, "story.json")


def videos_dir(pid):
    d = os.path.join(PROJECTS_DIR, pid, "videos")
    os.makedirs(d, exist_ok=True)
    return d


def backups_dir(pid):
    return os.path.join(PROJECTS_DIR, pid, "backups")


def _slug(title):
    base = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:40] or "show"
    pid, n = base, 2
    while os.path.exists(os.path.join(PROJECTS_DIR, pid)):
        pid, n = f"{base}-{n}", n + 1
    return pid


def create_project(story, videos_from=None):
    """Make a new project folder from a story (and optionally copy videos in)."""
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    pid = _slug(story.get("title"))
    os.makedirs(os.path.join(PROJECTS_DIR, pid))
    _json_write(story_path(pid), story)
    vdir = videos_dir(pid)
    if videos_from and os.path.isdir(videos_from):
        for f in os.listdir(videos_from):
            if os.path.splitext(f)[1].lower() in VIDEO_TYPES:
                shutil.copy2(os.path.join(videos_from, f), os.path.join(vdir, f))
    return pid


def list_project_ids():
    if not os.path.isdir(PROJECTS_DIR):
        return []
    return sorted(d for d in os.listdir(PROJECTS_DIR)
                  if not d.startswith(".") and pdir(d) and os.path.exists(story_path(d)))


def ensure_first_project():
    """First run: turn the old story.json (or the sample) into a project."""
    if list_project_ids():
        return
    if os.path.exists(LEGACY_STORY):
        story = _json_load(LEGACY_STORY)
        pid = create_project(story, videos_from=LEGACY_VIDEOS)
        os.replace(LEGACY_STORY, LEGACY_STORY + ".moved-to-projects")
    else:
        pid = create_project(_json_load(SAMPLE_PATH, BLANK_STORY))
    set_current(pid)


def need_project():
    """Returns (project_id, None) or (None, error_response)."""
    pid = current_id()
    if not pid:
        return None, (jsonify({"ok": False, "no_project": True, "reason": "No project is open."}), 409)
    return pid, None


def _backup_current(pid, force=False):
    """Copy the project's story.json into its backups folder (throttled unless forced)."""
    src = story_path(pid)
    if not os.path.exists(src):
        return None
    if not force and time.time() - _last_backup.get(pid, 0) < BACKUP_EVERY_SEC:
        return None
    bdir = backups_dir(pid)
    os.makedirs(bdir, exist_ok=True)
    name = datetime.now().strftime("story-%Y%m%d-%H%M%S.json")
    shutil.copy2(src, os.path.join(bdir, name))
    _last_backup[pid] = time.time()
    labels = _labels(pid)
    old = sorted(f for f in os.listdir(bdir) if f.endswith(".json") and f != "labels.json" and f not in labels)
    for f in old[:-BACKUPS_TO_KEEP]:  # named versions are never cleared away
        os.remove(os.path.join(bdir, f))
    return name


def _labels(pid):
    return _json_load(os.path.join(backups_dir(pid), "labels.json"), {}) or {}


def save_named_version(pid, label):
    """A version the team saved on purpose, e.g. "Before dress rehearsal"."""
    _last_backup.pop(pid, None)
    name = _backup_current(pid, force=True)
    if name:
        labels = _labels(pid)
        labels[name] = label[:80]
        _json_write(os.path.join(backups_dir(pid), "labels.json"), labels)
    return name


def _validate_story(data):
    if not isinstance(data, dict):
        return "The story must be a JSON object."
    nodes = data.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        return "The story has no scenes."
    if data.get("start") not in nodes:
        return "The story's first scene is missing."
    for nid, node in nodes.items():
        if not isinstance(node, dict) or node.get("type") not in {"scene", "choice", "action", "open", "pause", "end"}:
            return f'Scene "{nid}" has an unknown type.'
    return None


def _project_summary(pid):
    story = _json_load(story_path(pid), {}) or {}
    vids = [f for f in os.listdir(videos_dir(pid)) if os.path.splitext(f)[1].lower() in VIDEO_TYPES]
    mtime = os.path.getmtime(story_path(pid))
    home = story.get("home") or {}
    return {
        "id": pid,
        "title": story.get("title") or pid,
        "published": bool(home.get("published")),
        "blurb": home.get("blurb", ""),
        "emoji": home.get("emoji") or "🎭",
        "color": home.get("color") or "velvet",
        "parts": len(story.get("nodes") or {}),
        "videos": len(vids),
        "updated": datetime.fromtimestamp(mtime).strftime("%d %b %Y, %I:%M %p"),
        "updated_ts": mtime,
    }


@app.get("/api/projects")
def projects_list():
    items = [_project_summary(p) for p in list_project_ids()]
    items.sort(key=lambda x: x["updated_ts"], reverse=True)
    return jsonify({"current": current_id(), "projects": items})


@app.post("/api/projects")
@team_only
def projects_new():
    data = request.get_json(force=True) or {}
    template = _json_load(SAMPLE_PATH, BLANK_STORY) if data.get("template") == "sample" else json.loads(json.dumps(BLANK_STORY))
    title = (data.get("title") or "").strip()
    if title:
        template["title"] = title
    with _story_lock:
        pid = create_project(template)
        set_current(pid)
    return jsonify({"ok": True, "id": pid})


@app.post("/api/projects/open")
@team_only
def projects_open():
    pid = (request.get_json(force=True) or {}).get("id")
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That project no longer exists."}), 404
    set_current(pid)
    return jsonify({"ok": True, "id": pid})


@app.post("/api/projects/close")
@team_only
def projects_close():
    set_current(None)
    return jsonify({"ok": True})


@app.post("/api/projects/duplicate")
@team_only
def projects_duplicate():
    pid = (request.get_json(force=True) or {}).get("id")
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That project no longer exists."}), 404
    story = _json_load(story_path(pid))
    story["title"] = f'{story.get("title", "Show")} (copy)'
    with _story_lock:
        new = create_project(story, videos_from=videos_dir(pid))
    return jsonify({"ok": True, "id": new})


@app.post("/api/projects/delete")
@team_only
def projects_delete():
    pid = (request.get_json(force=True) or {}).get("id")
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That project no longer exists."}), 404
    os.makedirs(TRASH_DIR, exist_ok=True)
    # Moved, not erased: it can be recovered from projects/.trash if needed.
    shutil.move(os.path.join(PROJECTS_DIR, pid), os.path.join(TRASH_DIR, f"{pid}-{int(time.time())}"))
    if current_id() is None:
        set_current(None)
    return jsonify({"ok": True})


@app.get("/api/projects/<pid>/export")
@team_only
def projects_export(pid):
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That project no longer exists."}), 404
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(story_path(pid), "story.json")
        vdir = videos_dir(pid)
        for f in os.listdir(vdir):
            if os.path.splitext(f)[1].lower() in VIDEO_TYPES:
                z.write(os.path.join(vdir, f), f"videos/{f}", compress_type=zipfile.ZIP_STORED)
    buf.seek(0)
    title = (_json_load(story_path(pid), {}) or {}).get("title") or pid
    name = secure_filename(title) or pid
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"{name}.klsp.zip")


@app.post("/api/projects/import")
@team_only
def projects_import():
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "reason": "No file was chosen."}), 400
    try:
        z = zipfile.ZipFile(f.stream)
    except zipfile.BadZipFile:
        return jsonify({"ok": False, "reason": "That isn't a project file. Choose a .klsp.zip file saved from this app."}), 400
    names = z.namelist()
    story_name = next((n for n in names if n.endswith("story.json") and n.count("/") <= 1), None)
    if not story_name:
        return jsonify({"ok": False, "reason": "That file doesn't contain a show (story.json is missing)."}), 400
    try:
        story = json.loads(z.read(story_name).decode("utf-8"))
    except ValueError:
        return jsonify({"ok": False, "reason": "The show inside that file is damaged."}), 400
    problem = _validate_story(story)
    if problem:
        return jsonify({"ok": False, "reason": problem}), 400
    prefix = story_name[: -len("story.json")]
    with _story_lock:
        pid = create_project(story)
        vdir = videos_dir(pid)
        for n in names:
            if n.startswith(prefix + "videos/") and not n.endswith("/"):
                fname = secure_filename(os.path.basename(n))
                if fname and os.path.splitext(fname)[1].lower() in VIDEO_TYPES:
                    with z.open(n) as src, open(os.path.join(vdir, fname), "wb") as dst:
                        shutil.copyfileobj(src, dst)
        set_current(pid)
    return jsonify({"ok": True, "id": pid})


# ---------------------------------------------------------------------------
# The open project's story, backups and videos
# ---------------------------------------------------------------------------
@app.route("/story.json")
def story():
    pid, err = need_project()
    if err:
        return err
    resp = send_file(story_path(pid), mimetype="application/json", max_age=0)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/story")
@team_only
def get_story():
    pid, err = need_project()
    if err:
        return err
    data = _json_load(story_path(pid))
    return jsonify({**data, "_project": pid})


@app.put("/api/story")
@team_only
def save_story():
    pid, err = need_project()
    if err:
        return err
    data = request.get_json(force=True, silent=True)
    if isinstance(data, dict):
        sent_for = data.pop("_project", pid)
        if sent_for != pid:  # another project was opened in a different tab
            return jsonify({"ok": False, "reason": "A different project is open now. Reload this page."}), 409
    problem = _validate_story(data)
    if problem:
        return jsonify({"ok": False, "reason": problem}), 400
    with _story_lock:
        _backup_current(pid)
        _json_write(story_path(pid), data)
    return jsonify({"ok": True, "saved_at": datetime.now().strftime("%H:%M:%S")})


@app.get("/api/backups")
@team_only
def list_backups():
    pid, err = need_project()
    if err:
        return err
    bdir = backups_dir(pid)
    if not os.path.isdir(bdir):
        return jsonify([])
    labels = _labels(pid)
    names_ = sorted((f for f in os.listdir(bdir) if f.endswith(".json") and f != "labels.json"), reverse=True)
    out = []
    for n in names_:
        try:
            when = datetime.strptime(n, "story-%Y%m%d-%H%M%S.json").strftime("%d %b, %I:%M:%S %p")
        except ValueError:
            when = n
        out.append({"name": n, "label": f"{when}: {labels[n]}" if n in labels else when, "named": n in labels})
    return jsonify(out)


@app.post("/api/backups/restore")
@team_only
def restore_backup():
    pid, err = need_project()
    if err:
        return err
    name = secure_filename((request.get_json(force=True) or {}).get("name", ""))
    path = os.path.join(backups_dir(pid), name)
    if not name or not os.path.isfile(path):
        return jsonify({"ok": False, "reason": "That version no longer exists."}), 404
    data = _json_load(path)
    with _story_lock:
        _backup_current(pid, force=True)  # so restoring can itself be undone
        _json_write(story_path(pid), data)
    return jsonify({"ok": True, "story": {**data, "_project": pid}})


@app.route("/media/<path:name>")
def media(name):
    pid = current_id()
    if not pid:
        return ("No project is open", 404)
    return send_from_directory(videos_dir(pid), name, max_age=0)


@app.get("/api/videos")
def list_videos():
    pid, err = need_project()
    if err:
        return err
    vdir = videos_dir(pid)
    return jsonify(sorted(f for f in os.listdir(vdir) if os.path.splitext(f)[1].lower() in VIDEO_TYPES))


@app.post("/api/videos")
@team_only
def upload_video():
    pid, err = need_project()
    if err:
        return err
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "reason": "No file was chosen."}), 400
    name = secure_filename(f.filename)
    if os.path.splitext(name)[1].lower() not in VIDEO_TYPES:
        return jsonify({"ok": False, "reason": "Please choose a video file (MP4, WebM or MOV)."}), 400
    f.save(os.path.join(videos_dir(pid), name))
    return jsonify({"ok": True, "file": name})


@app.post("/api/projects/<pid>/version")
@team_only
def projects_save_version(pid):
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That project no longer exists."}), 404
    label = ((request.get_json(force=True) or {}).get("label") or "").strip() or "Saved version"
    with _story_lock:
        name = save_named_version(pid, label)
    return jsonify({"ok": bool(name), "name": name})


@app.post("/api/projects/<pid>/home")
@team_only
def projects_set_home(pid):
    """Studio switch: show or hide a story on the audience home page."""
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That project no longer exists."}), 404
    data = request.get_json(force=True) or {}
    with _story_lock:
        story = _json_load(story_path(pid))
        story.setdefault("home", {})["published"] = bool(data.get("published"))
        _json_write(story_path(pid), story)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Audience: published shows, and playing any show by its id
# ---------------------------------------------------------------------------
@app.get("/api/shows")
def shows_list():
    items = [_project_summary(p) for p in list_project_ids()]
    items = [{k: i[k] for k in ("id", "title", "blurb", "emoji", "color")} for i in items if i["published"]]
    items.sort(key=lambda x: x["title"].lower())
    return jsonify(items)


@app.get("/api/shows/<pid>/story.json")
def show_story(pid):
    if not pdir(pid):
        return jsonify({"ok": False, "reason": "That story no longer exists."}), 404
    resp = send_file(story_path(pid), mimetype="application/json", max_age=0)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/media/<pid>/<path:name>")
def show_media(pid, name):
    if not pdir(pid):
        return ("Not found", 404)
    return send_from_directory(videos_dir(pid), name, max_age=0)


# ---------------------------------------------------------------------------
# Name library: names the team wants recognised in every show
# ---------------------------------------------------------------------------
def library_names():
    data = _json_load(LIBRARY_PATH, {}) or {}
    return [n for n in data.get("names", []) if isinstance(n, str) and n.strip()]


def save_library(items):
    best = {}  # lower-case -> preferred spelling (keeps "Bobo" over "bobo")
    for n in items:
        n = re.sub(r"\s+", " ", str(n)).strip()[:40]
        if not n:
            continue
        k = n.lower()
        if k not in best or (best[k][0].islower() and not n[0].islower()):
            best[k] = n
    clean = sorted(best.values(), key=str.lower)
    os.makedirs(os.path.dirname(LIBRARY_PATH), exist_ok=True)
    _json_write(LIBRARY_PATH, {"names": clean[:2000]})
    return clean


@app.get("/api/library")
def library_get():
    return jsonify({"names": library_names()})


@app.put("/api/library")
@team_only
def library_put():
    return jsonify({"ok": True, "names": save_library((request.get_json(force=True) or {}).get("names", []))})


@app.post("/api/library/add")
@team_only
def library_add():
    new = (request.get_json(force=True) or {}).get("names") or []
    if isinstance(new, str):
        new = [new]
    return jsonify({"ok": True, "names": save_library(library_names() + list(new))})


# ---------------------------------------------------------------------------
# Online room: people watch on their own devices, in sync with the host
# ---------------------------------------------------------------------------
# The host's show window is the "director": it tells the server which clip is
# playing, what's being asked and what move to do. The server passes that to
# every participant instantly (Server-Sent Events). Participants send back
# votes, what they said, and whether they've done the move - never video.
_live_lock = threading.Lock()
_live = {
    "state": {"clip": None, "prompt": None, "task": {"type": "none", "seq": 0}, "paused": False, "title": "", "showId": None},
    "task_seq": 0,
    "participants": {},   # pid -> {name, token, joined, seen, cam, fps, move, zone, level, kicked}
    "speech": [],         # [{id, pid, name, text, alts}]
    "speech_id": 0,
    "subs": [],           # connected participants' message queues
    "version": 0,         # goes up whenever the state changes (for pages checking in by polling)
    "scores": [],
}
LIVE_ACTIVE_SEC = 15      # participants heard from this recently count as "here"


def now_ms():
    return int(time.time() * 1000)


def _live_msg(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _live_broadcast(event, data, only=None):
    msg = _live_msg(event, data)
    for sub in list(_live["subs"]):
        if only and sub["pid"] != only:
            continue
        try:
            sub["q"].put_nowait(msg)
        except queue.Full:  # a stuck connection: drop it, the browser will reconnect
            if sub in _live["subs"]:
                _live["subs"].remove(sub)


def _participant(data):
    """The participant making this request, if their room, id and token are right."""
    if not room_ok(data.get("room")):
        return None
    p = _live["participants"].get(str(data.get("pid", "")))
    if not p or p["kicked"] or p["token"] != data.get("token"):
        return None
    return p


@app.get("/api/live/time")
def live_time():
    return jsonify({"t": now_ms()})


@app.post("/api/live/join")
def live_join():
    data = request.get_json(force=True) or {}
    if not room_ok(data.get("room")):
        return jsonify({"ok": False, "reason": "That room code isn't running. Check the code from the host."}), 403
    name = re.sub(r"\s+", " ", str(data.get("name", ""))).strip()[:20]
    blocked = names.load_blocked()
    with _live_lock:
        if not name or names.is_blocked(name, blocked):
            name = f"Guest {len(_live['participants']) + 1}"
        old = _live["participants"].get(str(data.get("pid", "")))
        if old and old["token"] == data.get("token") and not old["kicked"]:  # coming back after a reload
            old.update(name=name, seen=time.time())
            return jsonify({"ok": True, "pid": data["pid"], "token": old["token"], "name": name})
        pid, token = secrets.token_hex(4), secrets.token_hex(8)
        _live["participants"][pid] = {"name": name, "token": token, "joined": time.time(), "seen": time.time(),
                                      "cam": "off", "fps": 0, "move": {}, "zone": {}, "level": {}, "kicked": False}
        _live_broadcast("people", {"count": _live_count()})
    return jsonify({"ok": True, "pid": pid, "token": token, "name": name})


def _live_count():
    now = time.time()
    return sum(1 for p in _live["participants"].values() if not p["kicked"] and now - p["seen"] < LIVE_ACTIVE_SEC)


def _lobby_title():
    """The show that's open, so the lobby can say what's about to start."""
    st = _live["state"]
    if st.get("title"):
        return st["title"]
    pid = current_id()
    return ((_json_load(story_path(pid), {}) or {}).get("title") if pid else None) or "The show"


@app.get("/api/live/events")
def live_events():
    """A live stream of what the host is showing, for one participant."""
    args = {"room": request.args.get("room"), "pid": request.args.get("pid"), "token": request.args.get("token")}
    with _live_lock:
        p = _participant(args)
        if not p:
            return jsonify({"ok": False, "reason": "Please join again."}), 403
        sub = {"pid": args["pid"], "q": queue.Queue(maxsize=200)}
        _live["subs"].append(sub)
        # A block of padding first: some proxies hold back small responses until
        # they've collected enough to send. "retry" tells the browser to reconnect quickly.
        first = (":" + " " * 2048 + "\n\nretry: 2000\n\n"
                 + _live_msg("state", {**_live["state"], "title": _lobby_title()}) + _live_msg("people", {"count": _live_count()}))

    def stream():
        yield first
        try:
            while True:
                try:
                    msg = sub["q"].get(timeout=8)
                except queue.Empty:
                    # A real event (not a comment), so the page can tell the stream is getting through.
                    yield _live_msg("ping", {"t": now_ms()})
                    continue
                yield msg
                if msg.startswith("event: kicked"):
                    break
        finally:
            with _live_lock:
                if sub in _live["subs"]:
                    _live["subs"].remove(sub)

    return Response(stream_with_context(stream()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.get("/api/live/poll")
def live_poll():
    """The same updates as the live stream, for pages whose stream is held back by a proxy."""
    args = {"room": request.args.get("room"), "pid": request.args.get("pid"), "token": request.args.get("token")}
    with _live_lock:
        p = _live["participants"].get(str(args["pid"] or ""))
        if p and p["kicked"] and p["token"] == args["token"]:
            return jsonify({"kicked": True})
        if not _participant(args):
            return jsonify({"ok": False, "rejoin": True}), 403
        p["seen"] = time.time()
        since = int(request.args.get("since") or -1)
        out = {"ok": True, "version": _live["version"], "people": _live_count(), "scores": _live["scores"]}
        if _live["version"] != since:
            out["state"] = {**_live["state"], "title": _lobby_title(), "version": _live["version"]}
        return jsonify(out)


@app.post("/api/live/report")
def live_report():
    """A participant's heartbeat, move progress, position, cheering or something they said."""
    data = request.get_json(force=True) or {}
    with _live_lock:
        p = _participant(data)
        if not p:
            return jsonify({"ok": False, "rejoin": True}), 403
        p["seen"] = time.time()
        kind = data.get("kind")
        seq = int(data.get("taskSeq") or 0)
        if kind == "heartbeat":
            p["cam"] = str(data.get("cam", "off"))[:10]
            p["fps"] = int(data.get("fps") or 0)
        elif kind == "move":
            p["move"] = {"taskSeq": seq, "value": float(data.get("value") or 0), "done": bool(data.get("done")),
                         "doing": bool(data.get("doing")), "via": str(data.get("via", "camera"))[:10]}
        elif kind == "zone":
            p["zone"] = {"taskSeq": seq, "index": int(data.get("index", -1)), "t": time.time()}
        elif kind == "level":
            p["level"] = {"taskSeq": seq, "level": max(0.0, min(1.0, float(data.get("level") or 0))), "t": time.time()}
        elif kind == "speech":
            text = str(data.get("text", "")).strip()[:200]
            if text:
                _live["speech_id"] += 1
                alts = [str(a)[:200] for a in (data.get("alts") or [text])][:5]
                _live["speech"].append({"id": _live["speech_id"], "pid": data.get("pid"), "name": p["name"], "text": text, "alts": alts})
                _live["speech"] = _live["speech"][-200:]
        elif kind == "problem":
            text = str(data.get("text", "")).strip()[:300]
            if text:
                _live["speech_id"] += 1
                _live["speech"].append({"id": _live["speech_id"], "pid": data.get("pid"), "name": p["name"], "text": text, "alts": [], "problem": True})
                _live["speech"] = _live["speech"][-200:]
        elif kind == "leave":
            p["seen"] = 0
            _live_broadcast("people", {"count": _live_count()})
    return jsonify({"ok": True})


@app.post("/api/live/host")
@team_only
def live_host():
    """The host's show window: what's playing, what's asked, what to do."""
    data = request.get_json(force=True) or {}
    with _live_lock:
        st = _live["state"]
        if data.get("reset"):
            st.update(clip=None, prompt=None, paused=False, task={"type": "none", "seq": _live["task_seq"]})
        for k in ("title", "showId", "lang"):
            if k in data:
                st[k] = data[k]
        if "clip" in data:
            clip = data["clip"]
            if clip:
                # Participants work out where to be in the clip from when it started (server time).
                clip["startedAt"] = now_ms() - int(float(clip.pop("offset", 0) or 0) * 1000)
                clip["key"] = secrets.token_hex(3)
            st["clip"] = clip
        if "prompt" in data:
            st["prompt"] = data["prompt"]
        if "task" in data:
            _live["task_seq"] += 1
            st["task"] = {**(data["task"] or {"type": "none"}), "seq": _live["task_seq"]}
        if "paused" in data and bool(data["paused"]) != st["paused"]:
            st["paused"] = bool(data["paused"])
            if st["paused"]:
                st["pausedAt"] = now_ms()
            elif st.get("clip") and st.get("pausedAt"):  # carry on from the same spot
                st["clip"]["startedAt"] += now_ms() - st["pausedAt"]
        _live["version"] += 1
        st["version"] = _live["version"]
        _live_broadcast("state", st)
        return jsonify({"ok": True, "taskSeq": st["task"]["seq"]})


@app.post("/api/live/scores")
@team_only
def live_scores():
    with _live_lock:
        _live["scores"] = (request.get_json(force=True) or {}).get("scores", [])
        _live_broadcast("scores", _live["scores"])
    return jsonify({"ok": True})


@app.get("/api/live/roster")
@team_only
def live_roster():
    """For the host: who's here, how they're doing, and anything new they said."""
    since = int(request.args.get("since") or 0)
    now = time.time()
    with _live_lock:
        people = [{"pid": pid, "name": p["name"], "active": now - p["seen"] < LIVE_ACTIVE_SEC, "cam": p["cam"],
                   "fps": p["fps"], "move": p["move"], "zone": p["zone"] if now - p["zone"].get("t", 0) < 3 else {},
                   "level": p["level"] if now - p["level"].get("t", 0) < 1.5 else {}}
                  for pid, p in _live["participants"].items() if not p["kicked"] and now - p["seen"] < 120]
        speech = [x for x in _live["speech"] if x["id"] > since]
        return jsonify({"participants": people, "speech": speech, "lastSpeech": _live["speech_id"],
                        "connected": len(_live["subs"])})


@app.post("/api/live/kick")
@team_only
def live_kick():
    pid = str((request.get_json(force=True) or {}).get("pid", ""))
    with _live_lock:
        p = _live["participants"].get(pid)
        if p:
            p["kicked"] = True
            _live_broadcast("kicked", {}, only=pid)
            _live_broadcast("people", {"count": _live_count()})
    return jsonify({"ok": bool(p)})


# ---------------------------------------------------------------------------
# API: info + QR code
# ---------------------------------------------------------------------------
@app.get("/api/info")
def info():
    t = tunnel.status()
    base = tunnel.status().get("url") or lan_base()
    return jsonify({"version": APP_VERSION, "watch_url": f"{base}/watch?room={ROOM_CODE}",
                    "vote_url": vote_url(), "llm_enabled": bool(ANTHROPIC_API_KEY),
                    "whisper": whisper_engine.status(), "room": ROOM_CODE,
                    "lan_url": f"{lan_base()}/join", "public": t,
                    "join_url": f"{t['url']}/join" if t.get("url") else f"{lan_base()}/join"})


@app.post("/api/tunnel/start")
@team_only
def tunnel_start():
    return jsonify(tunnel.start(PORT))


@app.post("/api/tunnel/stop")
@team_only
def tunnel_stop():
    return jsonify(tunnel.stop())


@app.get("/api/projects/<pid>/videos")
@team_only
def project_videos(pid):
    if not pdir(pid):
        return jsonify([]), 404
    vdir = videos_dir(pid)
    return jsonify(sorted(f for f in os.listdir(vdir) if os.path.splitext(f)[1].lower() in VIDEO_TYPES))


@app.get("/api/qr")
def qr():
    import qrcode

    target = vote_url()
    if request.args.get("watch"):
        target = f"{tunnel.status().get('url') or lan_base()}/watch?room={ROOM_CODE}"
    img = qrcode.make(target, box_size=8, border=2)  # includes the room code
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png", max_age=0)


# ---------------------------------------------------------------------------
# API: audience rounds
# ---------------------------------------------------------------------------
@app.post("/api/round")
def start_round():
    """Called by the show page when a decision point begins (or ends)."""
    data = request.get_json(force=True) or {}
    with _lock:
        _round["round_id"] += 1
        _round["node_id"] = data.get("node_id")
        _round["question"] = data.get("question", "")
        _round["options"] = data.get("options", [])
        _round["open"] = bool(data.get("open", True))
        _votes.clear()
        _emojis.clear()
        return jsonify(dict(_round))


@app.post("/api/pause")
def set_paused():
    data = request.get_json(force=True) or {}
    with _lock:
        _round["paused"] = bool(data.get("paused"))
        return jsonify(dict(_round))


@app.post("/api/round/close")
def close_round():
    with _lock:
        _round["open"] = False
        return jsonify(dict(_round))


def room_ok(code):
    return str(code or "").strip() == ROOM_CODE


@app.get("/api/round")
def get_round():
    # The show page reads without a code; phones must send the right one.
    if request.args.get("room") is not None and not room_ok(request.args.get("room")):
        return jsonify({"bad_room": True}), 403
    if request.args.get("room") is None and via_public_link():
        return jsonify({"bad_room": True}), 403
    with _lock:
        return jsonify(dict(_round))


@app.post("/api/vote")
def vote():
    data = request.get_json(force=True) or {}
    if not room_ok(data.get("room")):
        return jsonify({"ok": False, "bad_room": True, "reason": "That room code isn't running. Check the code on the screen."}), 403
    with _lock:
        if _round["paused"]:
            return jsonify({"ok": False, "reason": "The show is paused. Vote again when it carries on."}), 409
        if not _round["open"] or data.get("round_id") != _round["round_id"]:
            return jsonify({"ok": False, "reason": "This question has closed."}), 409
        option_ids = {o["id"] for o in _round["options"]}
        if data.get("option_id") not in option_ids:
            return jsonify({"ok": False, "reason": "Unknown option."}), 400
        voter = str(data.get("voter_id", ""))[:64] or request.remote_addr
        _votes[voter] = data["option_id"]  # one vote per phone; changing it replaces it
        return jsonify({"ok": True})


@app.post("/api/emoji")
def emoji():
    data = request.get_json(force=True) or {}
    if not room_ok(data.get("room")):
        return jsonify({"ok": False, "bad_room": True}), 403
    e = str(data.get("emoji", ""))[:8]
    with _lock:
        if _round["paused"] or not _round["open"] or data.get("round_id") != _round["round_id"] or not e:
            return jsonify({"ok": False}), 409
        _emojis[e] += 1
        return jsonify({"ok": True})


@app.get("/api/tally")
def tally():
    with _lock:
        votes = Counter(_votes.values())
        return jsonify({
            "round_id": _round["round_id"],
            "votes": dict(votes),
            "voters": len(_votes),
            "emojis": dict(_emojis),
        })


# ---------------------------------------------------------------------------
# API: classify an open-ended answer with Claude
# ---------------------------------------------------------------------------
_client = None


def claude():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return _client


@app.post("/api/classify")
def classify():
    """
    Body: {"question": "...", "answer": "...",
           "categories": [{"id": "animal", "description": "an animal name"}, ...]}
    Returns: {"category": "animal" | null, "source": "llm" | "disabled" | "error"}
    """
    data = request.get_json(force=True) or {}
    categories = data.get("categories", [])
    answer = (data.get("answer") or "").strip()
    if not ANTHROPIC_API_KEY:
        return jsonify({"category": None, "source": "disabled"})
    if not answer or not categories:
        return jsonify({"category": None, "source": "empty"})

    ids = [c["id"] for c in categories]
    lines = "\n".join(f"- {c['id']}: {c.get('description', '')}" for c in categories)
    prompt = (
        "You are helping run an interactive children's theatre show. "
        f"The actor asked the children: \"{data.get('question', '')}\"\n"
        f"A child answered (speech-to-text, may be misspelled or mix English, "
        f"Malay and Mandarin): \"{answer}\"\n\n"
        f"Pick the ONE category that best fits the answer:\n{lines}\n\n"
        f"Reply with only the category id, exactly one of: {', '.join(ids)}."
    )
    try:
        msg = claude().messages.create(
            model=CLAUDE_MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        choice = text.strip().lower().strip(".\"' ")
        return jsonify({"category": choice if choice in ids else None, "source": "llm"})
    except Exception as exc:  # network down, bad key, etc. - the show must go on
        app.logger.warning("Claude classify failed: %s", exc)
        return jsonify({"category": None, "source": "error"})


ensure_first_project()
atexit.register(tunnel.stop)
whisper_engine.load_in_background()   # warm up Whisper so the first name isn't slow

@app.post("/api/extract-name")
def extract_name():
    """
    Body: {"question": "...", "utterances": [["best guess", "alt 1", ...], ...],
           "blocked": ["extra", "words"]}
    Returns: {"name": "Bobo" | null, "source": "llm" | "rules"}
    Names are not stored anywhere; they only go back to the show page.
    """
    data = request.get_json(force=True) or {}
    utterances = [[str(a)[:200] for a in (u or [])][:5] for u in (data.get("utterances") or [])][:20]
    utterances = [u for u in utterances if u and u[0].strip()]
    blocked = names.load_blocked(data.get("blocked"))
    expected = [str(e).strip()[:40] for e in (data.get("expected") or []) if str(e).strip()][:60]
    if data.get("use_library", True):
        expected = list(dict.fromkeys(expected + library_names()))
    if not utterances:
        return jsonify({"name": None, "source": "empty"})
    if ANTHROPIC_API_KEY:
        try:
            name = names.extract_with_claude(claude(), CLAUDE_MODEL, data.get("question", ""), utterances, blocked, expected)
            return jsonify({"name": name, "source": "llm"})
        except Exception as exc:  # fall back to rules if Claude can't be reached
            app.logger.warning("Claude name extraction failed: %s", exc)
    return jsonify({"name": names.extract_with_rules(utterances, blocked, expected), "source": "rules"})


@app.post("/api/transcribe")
def transcribe():
    """
    Whisper speech-to-text for one listening window.
    Form fields: audio (file), lang, question, hints (JSON list of expected names).
    The audio is processed in memory and never saved.
    """
    f = request.files.get("audio")
    if not f:
        return jsonify({"ok": False, "reason": "No audio was sent."}), 400
    st = whisper_engine.status()
    if not st["enabled"] or not st["installed"]:
        return jsonify({"ok": False, "reason": "Whisper is turned off or not installed."}), 503
    try:
        hints = json.loads(request.form.get("hints") or "[]")
    except ValueError:
        hints = []
    if request.form.get("use_library", "1") == "1":
        # The show's own names first; Whisper only reads a limited number of hints.
        hints = list(dict.fromkeys(list(hints) + library_names()))
    audio = io.BytesIO(f.read())
    try:
        result = whisper_engine.transcribe(audio, request.form.get("lang", "en-US"),
                                           [str(h)[:40] for h in hints][:40], request.form.get("question", ""))
    except Exception as exc:
        app.logger.warning("Whisper failed: %s", exc)
        return jsonify({"ok": False, "reason": str(exc)[:200]}), 500
    return jsonify({"ok": True, **result})


if __name__ == "__main__":
    print(f"\n  KLSP Interactive Show is running (version {APP_VERSION})")
    print(f"  Show page (this computer): http://localhost:{PORT}")
    print(f"  Studio (for the team): http://localhost:{PORT}/studio")
    print(f"  Phones join at: {lan_base()}/join   Room code: {ROOM_CODE}")
    print(f"  Claude classification: {'ON' if ANTHROPIC_API_KEY else 'OFF (keyword matching only)'}")
    w = whisper_engine.status()
    print(f"  Whisper speech-to-text: {'loading ' + w['model'] + ' model…' if w['enabled'] and w['installed'] else 'OFF'}\n")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
