# 48-hour build plan (coding only)

Video recording is left out of this plan: the show runs on placeholder cards until real clips are uploaded in the editor. A first working version of every part already exists in this project, so each tier is about getting it running, testing it with real people, tuning it and extending it.

| Tier | Hours | Goal | Done when… |
|---|---|---|---|
| 0 | 0–2 | Setup on every laptop | Everyone can run the show and vote from a phone |
| 1 | 2–8 | Story graph and player | Your team's own story plays start to finish with placeholders |
| 2 | 6–14 | Phone voting | 5+ phones vote at once with no errors |
| 3 | 10–20 | Voice input | Spoken answers reliably pick a branch in a noisy room |
| 4 | 10–22 | Camera actions | Hands-up works for 9 out of 10 tries across different people |
| 5 | 20–28 | Open answers with Claude | Free answers land in a sensible category |
| 6 | 28–36 | Decision engine and failure testing | The show never freezes, whatever the audience does |
| 7 | 36–42 | Page polish | The page reads clearly from across a room |
| 8 | 42–46 | Pitch and backup demo video | Slides done and a full run recorded |
| 9 | 46–48 | Buffer and rehearsal | Two full run-throughs |

Suggested split: one person on Tiers 1, 2 and 7 (story and page), one on Tiers 3 and 5 (voice and Claude), one on Tier 4 (camera), and one on the pitch from hour 0. Everyone joins Tier 6.

## Tier 0: Setup (hours 0–2)

**Need:** Python 3.10+, Chrome, this folder, a shared Wi-Fi or phone hotspot.

**Do:** Everyone runs `setup` then `run`, clicks through the whole sample story with the operator keys, and votes from a phone. Put the project in a shared GitHub repo so changes don't get lost; `.gitignore` already keeps `venv`, `.env` and backups out of it. Test the camera once now, because the pose model downloads on first use.

## Tier 1: Story graph and player (hours 2–8)

**Files:** `story.json`, `static/js/player.js`, `static/js/main.js`

**Do:** Replace the sample story with your final one in `story.json`, keeping 3 decision points (one `choice`, one `action`, one `open`) and branches that merge back together. Write each clip's `line` as the exact words the actor will say, so the placeholder version doubles as the filming script later. Set `duration` to how long each line takes to say aloud, so the timing feels real. If you want a transition between clips, add it in `player.js` (the two video elements already cross-fade in `show.css`).

## Tier 2: Phone voting (hours 6–14)

**Files:** `app.py`, `static/vote.html`

**Do:** Test with as many phones as you can borrow. Check what happens when a phone joins halfway, votes twice, or loses Wi-Fi. If the venue Wi-Fi blocks phones from reaching the laptop, use a hotspot from the laptop. Optional extension: show a live vote count on the phone after voting.

## Tier 3: Voice input (hours 10–20)

**Files:** `static/js/voice.js`, the `keywords` lists in `story.json`

**Do:** Say every option many ways (accents, Malay, Mandarin, mumbled, shouted) and watch the transcript in the side column. Every time it mishears, add the misheard word as an extra keyword (for example, if "castle" keeps coming out as "cassel", add "cassel"). Test in a noisy room with several people talking at once. Try the language selector in the operator panel. The browser can only listen in one language at a time, so decide which works best for mixed-language kids.

## Tier 4: Camera actions (hours 10–22)

**Files:** `static/js/pose.js` (the `THRESHOLDS` at the top)

**Do:** Test hands-up, jump and wave with people of different heights, near and far from the camera, and with 2–3 people in frame. The prototype tracks one person; if you want group detection, change `numPoses` and require that most detected people do the action. Tune `jumpRise` and `waveCrossings` until false triggers stop. Hands-up is the most reliable, so make it the one in your live demo.

## Tier 5: Open answers with Claude (hours 20–28)

**Files:** `app.py` (`/api/classify`), the `categories` in `story.json`

**Do:** Add an API key to `.env`. Write down 30+ answers kids might give and check which category each lands in (the operator log shows this). Improve each category's `description` until results make sense. Keep the fallback reaction friendly, since it will play whenever nothing fits. If the internet drops, keywords still work, so the show carries on.

## Tier 6: Decision engine and failure testing (hours 28–36)

**Files:** `static/js/engine.js`, `settings.weights` in `story.json`

**Do:** Try to break it: stay silent, block the camera, vote one way and shout the other, unplug Wi-Fi mid-show, restart halfway through. Every decision point must end in a clip, whatever happens. Adjust the weights to reflect how you think KLSP would want it (for example, trusting the room's voices over a few phones).

## Tier 7: Page polish (hours 36–42)

**Files:** `static/css/show.css`, `static/index.html`

**Do:** View the page on a projector or TV from the back of the room. Increase text sizes if needed, and consider hiding the side column in a "performance mode" so children only see the stage and the question. Test on the laptop you'll actually present with.

## Tier 8: Pitch and backup demo video (hours 42–46)

**Do:** Record a full run of the show with OBS as a backup in case anything fails on stage. Slides should cover the problem, the solution diagram, the live demo, a cost comparison with restaging live shows, child privacy (camera stays on-device, nothing saved, parental consent, PDPA) and honest limits with a roadmap.

## If you fall behind, cut in this order

1. Emoji reactions
2. Wave and jump (keep hands-up)
3. Claude classification (keep keywords)
4. Phone voting (keep on-screen buttons and voice)

Never cut the story player, the operator keys or the backup demo video.
