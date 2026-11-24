"""
Pick the name out of what children shouted.

  "his name is Bobo!"           -> "Bobo"
  "Ali! No, no, Adam!"          -> "Adam"
  "nama dia Comel"              -> "Comel"
  "叫他小白"                     -> "小白"

Two ways of doing it:
  * extract_with_rules()  - works offline, handles tidy answers
  * extract_with_claude() - understands messy, mixed-language answers (needs an API key)

Either way, the result is checked against a list of words that must never
appear on screen. Nothing here is saved to disk: names only live in memory
for the current performance.
"""

import json
import os
import re
from collections import Counter
from difflib import SequenceMatcher

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BLOCKED_FILE = os.path.join(BASE_DIR, "blocked_words.txt")
MAX_WORDS = 3          # longest name we accept, e.g. "Captain Sparkle Pants"
MAX_CHARS = 30

# Phrases that come before the name. Longer phrases first.
LEAD_INS = [
    # English
    r"(?:i think )?(?:the |our )?\w+'?s name (?:should|could|will|would) be", r"(?:the |our )?\w+'?s name is",
    r"i think (?:his|her|its|their|the) name (?:should|could|will|would) be",
    r"(?:his|her|its|their|the) name (?:should|could|will|would) be",
    r"(?:his|her|its|their|the) name is", r"(?:his|her|its|their) name'?s",
    r"let'?s call (?:him|her|it|them)", r"we should call (?:him|her|it|them)",
    r"you should call (?:him|her|it|them)", r"call (?:him|her|it|them)",
    r"name (?:him|her|it|them)", r"how about", r"what about", r"i want", r"i choose",
    r"i think", r"maybe", r"it'?s", r"it is",
    # Malay
    r"nama (?:dia|dya|nya) (?:ialah|adalah)", r"nama (?:dia|dya|nya)", r"namakan (?:dia|dya)",
    r"panggil (?:dia|dya)", r"saya rasa", r"mungkin",
    # Mandarin
    r"就叫(?:他|她|它)?", r"叫(?:他|她|它)", r"(?:他|她|它)的名字(?:是|叫)", r"名字(?:是|叫)", r"我觉得", r"可能",
]
LEAD_RE = re.compile(r"^(?:" + "|".join(LEAD_INS) + r")\s*", re.IGNORECASE)
FILLERS = re.compile(r"\b(?:uh+|um+|erm+|hmm+|ah+|er+|like|okay|ok|yeah|yes|please|the|a|an)\b", re.IGNORECASE)
# "Ali! No, Adam" -> keep what comes after the last correction word.
CORRECTION = re.compile(r"(?:\bno+\b|\bnot\b|\bwait\b|\btak\b|\bbukan\b|不是|不对)[\s,.!]*", re.IGNORECASE)

DEFAULT_BLOCKED = {
    "fuck", "fucking", "shit", "bitch", "bastard", "asshole", "dick", "cock", "pussy", "cunt",
    "sex", "sexy", "penis", "vagina", "boobs", "porn", "nigger", "nigga", "fag", "faggot", "retard",
    "slut", "whore", "kill", "die", "dead",
    "babi", "bodoh", "sial", "pukimak", "puki", "celaka", "lancau", "butoh", "kote",
    "他妈的", "傻逼", "操", "屎",
}


def load_blocked(extra=None):
    words = set(DEFAULT_BLOCKED)
    if os.path.exists(BLOCKED_FILE):
        with open(BLOCKED_FILE, encoding="utf-8") as f:
            words |= {w.strip().lower() for w in f if w.strip() and not w.startswith("#")}
    words |= {str(w).strip().lower() for w in (extra or []) if str(w).strip()}
    return words


def is_blocked(name, blocked):
    low = name.lower()
    if any(ch in low for ch in blocked if re.search(r"[\u4e00-\u9fff]", ch)):
        return True
    parts = re.findall(r"[a-z0-9']+", low)
    joined = "".join(parts)
    return any(p in blocked for p in parts) or joined in blocked


def tidy(name):
    """Trim punctuation and spaces, and give Latin-script names capital letters."""
    name = re.sub(r"[\"“”'‘’.,!?;:()\[\]]", " ", name or "")
    name = re.sub(r"\s+", " ", name).strip()
    if not name:
        return None
    words = name.split(" ")[:MAX_WORDS]
    name = " ".join(w[:1].upper() + w[1:] if re.match(r"[a-z]", w) else w for w in words)
    return name[:MAX_CHARS] or None


# ---------------------------------------------------------------------------
# Expected names: snap near-misses ("Boh boh", "Comell") to the names we expect
# ---------------------------------------------------------------------------
_SWAPS = [("ph", "f"), ("ck", "k"), ("qu", "kw"), ("sh", "s"), ("ch", "c"), ("th", "t"),
          ("gh", "g"), ("kh", "k"), ("ee", "i"), ("oo", "u"), ("ou", "u"), ("x", "ks")]
_SOUNDS = {"b": "p", "d": "t", "g": "k", "c": "k", "q": "k", "z": "s", "v": "f", "h": ""}


def sound_key(text):
    """A rough 'how it sounds' spelling: Bobo, Boh Boh and Bo-bo all become 'papa'."""
    w = re.sub(r"[^a-z]", "", (text or "").lower())
    for a, b in _SWAPS:
        w = w.replace(a, b)
    out = ["a" if ch in "aeiouy" else _SOUNDS.get(ch, ch) for ch in w]
    out = [c for c in out if c]
    return "".join(c for i, c in enumerate(out) if i == 0 or c != out[i - 1])


def _plain(text):
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", (text or "").lower())


def similarity(a, b):
    """(spelling similarity, sound similarity), each 0..1."""
    pa, pb = _plain(a), _plain(b)
    if not pa or not pb:
        return 0.0, 0.0
    spell = SequenceMatcher(None, pa, pb).ratio()
    ka, kb = sound_key(pa), sound_key(pb)
    sound = SequenceMatcher(None, ka, kb).ratio() if ka and kb else spell
    return spell, sound


def snap_to_expected(name, expected, strict=False):
    """Return the expected name this sounds like, or the name unchanged."""
    if not name or not expected:
        return name
    best, best_score = None, 0.0
    for e in expected:
        spell, sound = similarity(name, e)
        if strict:
            ok = spell >= 0.88 or (sound >= 0.95 and spell >= 0.6)
        else:
            ok = spell >= 0.8 or (sound >= 0.85 and spell >= 0.5)
        score = max(spell, sound * 0.95)
        if ok and score > best_score:
            best, best_score = e, score
    return best or name


def find_expected_in(text, expected):
    """Look for an expected name anywhere in a sentence (for when no name was extracted)."""
    words = re.findall(r"[\w']+", text or "")
    for size in (3, 2, 1):
        for i in range(len(words) - size + 1):
            chunk = " ".join(words[i:i + size])
            hit = snap_to_expected(chunk, expected, strict=True)
            if hit != chunk or any(_plain(hit) == _plain(e) for e in expected):
                if any(_plain(hit) == _plain(e) for e in expected):
                    return hit
    return None


def extract_one(text):
    """Rule-based: pull a name out of one sentence."""
    if not text:
        return None
    t = text.strip()
    parts = CORRECTION.split(t)
    t = parts[-1] if parts[-1].strip() else t
    t = re.sub(r"[!?.,]+", " ", t).strip()
    for _ in range(3):  # strip stacked lead-ins: "I think his name is ..."
        new = LEAD_RE.sub("", t).strip()
        if new == t:
            break
        t = new
    t = FILLERS.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return tidy(t)


def extract_with_rules(utterances, blocked, expected=None):
    """utterances: [[best guess, alternative, ...], ...]. Returns the most-heard name."""
    counts, first_seen, spelling = Counter(), {}, {}
    for i, alts in enumerate(utterances):
        name = extract_one(alts[0] if alts else "")
        if expected:
            if name:
                name = snap_to_expected(name, expected)
            # If the best guess held no expected name, check the other guesses too.
            if not name or not any(_plain(name) == _plain(e) for e in expected):
                for alt in alts:
                    hit = find_expected_in(alt, expected)
                    if hit:
                        name = hit
                        break
        if not name or is_blocked(name, blocked):
            continue
        key = name.lower()
        counts[key] += 1
        first_seen.setdefault(key, i)
        spelling.setdefault(key, name)
    if not counts:
        return None
    best = max(counts, key=lambda k: (counts[k], -first_seen[k]))
    return spelling[best]


def extract_with_claude(client, model, question, utterances, blocked, expected=None):
    """Ask Claude for the most popular, child-appropriate name. Returns (name or None)."""
    lines = []
    for i, alts in enumerate(utterances, 1):
        guesses = " | ".join(a for a in alts if a)
        lines.append(f"{i}. {guesses}")
    prompt = (
        "You are helping run an interactive children's theatre show in Malaysia. "
        f"The actor asked the children: \"{question}\"\n"
        "Below is what speech recognition heard. Each numbered line is one shout; "
        "alternatives separated by | are other guesses for the same shout. Children may "
        "mix English, Malay and Mandarin, correct themselves, or add filler words.\n\n"
        + "\n".join(lines)
        + (
            "\n\nNames the team expects children to suggest: " + ", ".join(expected[:40])
            + ". If a shout sounds like one of these (speech recognition often mishears names), "
            "use that exact spelling. Other names are fine too."
            if expected else ""
        )
        + "\n\nWork out the NAME the children are suggesting. If different names were "
        "shouted, pick the one said most often (or the first, if tied). Keep the name "
        "short (at most 3 words) and spell it the way a child would expect to see it. "
        "If a child corrected themselves, use the corrected name. If there is no real "
        "name, or the name is rude, unkind or not suitable for young children, use null.\n"
        'Reply with only JSON, like {"name": "Bobo"} or {"name": null}.'
    )
    msg = client.messages.create(model=model, max_tokens=40, messages=[{"role": "user", "content": prompt}])
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    text = re.sub(r"```(?:json)?|```", "", text).strip()
    match = re.search(r"\{.*\}", text, re.S)
    data = json.loads(match.group(0)) if match else {}
    name = tidy(data.get("name") or "")
    if name and expected:
        name = snap_to_expected(name, expected)
    if name and is_blocked(name, blocked):
        return None
    return name
