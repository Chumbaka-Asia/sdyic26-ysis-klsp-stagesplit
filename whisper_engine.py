"""
Speech-to-text on this laptop with Whisper (faster-whisper).

Why: Chrome's built-in listening often mishears unusual names and mixed
English/Malay/Mandarin. Whisper is usually more accurate, can be given hints
(the names we expect), and the children's voices never leave this computer.

The model is downloaded once (setup does this) and then works offline.
Choose the size in .env with WHISPER_MODEL:
    base   ~150 MB  fastest, less accurate
    small  ~480 MB  good balance (default)
    medium ~1.5 GB  most accurate, slow on ordinary laptops
Set WHISPER=off in .env to turn it off completely.
"""

import os
import threading
import time

WHISPER_ON = os.getenv("WHISPER", "on").strip().lower() not in {"off", "0", "false", "no"}
MODEL_SIZE = os.getenv("WHISPER_MODEL", "small").strip() or "small"

# Show languages -> Whisper language codes. None lets Whisper guess.
LANGS = {"en-US": "en", "en-GB": "en", "ms-MY": "ms", "zh-CN": "zh", "auto": None}

_model = None
_lock = threading.Lock()
_status = {"state": "off" if not WHISPER_ON else "not loaded", "error": None, "model": MODEL_SIZE}


def installed():
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def status():
    s = dict(_status)
    s["installed"] = installed()
    s["enabled"] = WHISPER_ON
    s["ready"] = _model is not None
    return s


def load():
    """Load (and on first use, download) the model. Safe to call many times."""
    global _model
    if _model is not None or not WHISPER_ON:
        return _model
    with _lock:
        if _model is not None:
            return _model
        if not installed():
            _status.update(state="not installed", error="Run setup again to install Whisper.")
            return None
        from faster_whisper import WhisperModel

        _status.update(state="loading", error=None)
        try:
            # int8 on the CPU works on any ordinary laptop without a graphics card.
            _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
            _status.update(state="ready")
        except Exception as exc:  # usually: no internet the first time
            _status.update(state="failed", error=f"{type(exc).__name__}: {exc}"[:300])
        return _model


def load_in_background():
    if WHISPER_ON and installed():
        threading.Thread(target=load, daemon=True).start()


def build_prompt(question, hints):
    """Whisper reads this as 'what came before', which nudges its spelling."""
    bits = []
    if question:
        bits.append(question.strip())
    if hints:
        bits.append("Names: " + ", ".join(hints[:40]) + ".")
    return " ".join(bits)[:800] or None


def transcribe(audio_file, lang="en-US", hints=None, question=""):
    """
    audio_file: a file-like object (webm/ogg/wav from the browser).
    Returns {"segments": ["his name is Bobo", "Bobo!"], "seconds": 1.8}
    """
    model = load()
    if model is None:
        raise RuntimeError(_status.get("error") or "Whisper is not available.")
    hints = [h for h in (hints or []) if h]
    kwargs = dict(
        language=LANGS.get(lang, None) if lang in LANGS else (lang or None),
        initial_prompt=build_prompt(question, hints),
        beam_size=5,
        vad_filter=True,                      # skip silence and background hum
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
        no_speech_threshold=0.5,
    )
    if hints:
        kwargs["hotwords"] = " ".join(hints[:40])   # extra nudge towards expected names
    start = time.time()
    try:
        segments, _info = model.transcribe(audio_file, **kwargs)
    except TypeError:  # older faster-whisper without hotwords
        kwargs.pop("hotwords", None)
        audio_file.seek(0)
        segments, _info = model.transcribe(audio_file, **kwargs)
    texts = [seg.text.strip() for seg in segments if seg.text and seg.text.strip()]
    # In silence Whisper sometimes repeats its prompt back. Drop only obvious echoes,
    # never a short shout like "Bobo" that happens to be one of the hints.
    prompt = (kwargs.get("initial_prompt") or "").lower()
    texts = [t for t in texts if not (t.lower().startswith("names:") or (len(t) > 20 and t.lower() in prompt))]
    return {"segments": texts, "seconds": round(time.time() - start, 2)}


if __name__ == "__main__":
    # Used by setup: download the model now, so the show works offline later.
    print(f"Downloading the Whisper '{MODEL_SIZE}' model (only needed once)…")
    WHISPER_ON = True
    if load() is not None:
        print("Whisper is ready.")
    else:
        print("Whisper could not be downloaded:", _status.get("error"))
        print("The show still works using Chrome's built-in listening. Run setup again when online.")
