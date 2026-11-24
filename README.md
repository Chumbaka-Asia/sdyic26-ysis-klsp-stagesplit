# KLSP Interactive Show (prototype)

A pre-recorded show that children can steer with their voice, their phones, emoji reactions and body movements. Scenes that haven't been filmed yet appear as placeholder cards, so the whole show can be built and tested before recording anything.

## First-time setup

You need Python 3.10 or newer ([python.org](https://www.python.org)). On Windows, tick "Add python.exe to PATH" during install. You also need Google Chrome or Microsoft Edge, because voice recognition only works in those browsers.

On Windows, double-click `setup.bat`. On Mac or Linux, open a terminal in this folder and run `./setup.sh`.

This creates the `venv` folder (the project's own private copy of Python and its packages) and a `.env` settings file. You only do this once per computer. The `venv` folder is not shared between computers: each teammate runs the setup script on their own machine.

## Running the show

On Windows, double-click `run.bat`. On Mac or Linux, run `./run.sh`.

The browser opens the **audience home page** at http://localhost:8000, where the audience chooses a story. Press **Start the show** and allow the microphone and camera when Chrome asks.

The team works in the **Studio** at http://localhost:8000/studio. There's also a small "For the team" link at the bottom of the home page.

To let phones vote, connect them to the same Wi-Fi as the computer and scan the QR code on screen, or open the address shown and type the **4-digit room code**. A new code is made each time the server starts. For phones on mobile data or another network, see "Phones and the public link" below.

To stop the server, press `Ctrl+C` in the terminal window.

## Turning on Claude for open-ended answers (optional)

Without an API key, open questions like "What should we name the donkey?" are matched by keywords only. To let Claude understand any answer, get an API key from https://console.anthropic.com, paste it after `ANTHROPIC_API_KEY=` in the `.env` file, and restart the server. Each answer costs a tiny fraction of a cent.

## The two home pages

**Audience home page** (`/`): big, friendly cards for every story that's switched on for the audience. Tap one to play it. At the end of a show, **Choose another story** comes back here, and the pause menu has **Back to all stories**. Each story's picture, colour and short description are set in the editor under **Settings → Audience home page**.

**Studio** (`/studio`, for the team). Each show is a separate project, kept in the `projects` folder with its own story, videos and backups. In the Studio you can:

- Start a **New empty show**, or a show **New from the example**.
- **Upload a show file**: a `.klsp.zip` saved earlier or sent by a teammate, videos included.
- **✎ Edit** a show, or **▶ Play** it (works even if it isn't on the audience home page yet).
- Switch **On the audience home page** on or off for each show.
- **★ Save a version** with a name, such as "Before dress rehearsal". Named versions are never cleared away automatically. Bring one back in the editor under **Project → Earlier versions**.
- **⤓ Download** a show as one `.klsp.zip` file to email or put on a USB stick.
- **Make a copy** of a show, or **Delete** one. Deleted shows are moved to `projects/.trash`, so they can be recovered by hand.
- Manage the **Name library** (see below).

The Studio and editor only work **on the show laptop itself**. Phones on the same Wi-Fi can open the audience home page and vote, but can't change anything. To let teammates edit from other computers on the network, set `ALLOW_REMOTE_EDITING=on` in `.env`.

## Name library

Names saved in the Studio's **Name library** are recognised in every show that asks the children for a name. Whisper is given them as hints, and near-misses are snapped to them, just like a question's own "Names children often suggest". Add names by typing them in (several at once, separated by commas), or save a good name during a show: when "I heard: …" appears, the operator can press **★ Save to name library**.

Each name question can opt out with **Also recognise the names in the Studio's Name library**. The library is stored in `library/names.json`. It only holds names the team chose to save, never anything recorded automatically.

## Names the children shout

A **Say anything** part can pick out a name the children shout and use it for the rest of the show. For example, "I think his name should be Bobo!" becomes **Bobo**, and later captions read "Meet Bobo the donkey!"

To set it up in the editor:

1. Open the Say anything part and tick **Remember a name**. Give the name a short **name tag**, such as `donkey name`, and some backup words for when no name is heard, such as "our donkey".
2. In any clip, fill in **Words shown on screen** and put the tag in curly brackets, e.g. `Meet {donkey name}!`. This appears over the video like a subtitle. Tags also work in questions and in the placeholder text.
3. In **Settings**, under **Names the children shout**, choose what happens before a name appears:
   - **Give the operator a few seconds to check it (recommended):** "I heard: Bobo" appears, and it's used automatically after the countdown unless the operator changes it.
   - **Always wait for the operator to approve it.**
   - **Show it straight away.**

When "I heard…" is on screen, the operator can press `Enter` to use the name, `E` to type a different one, `R` to listen again, or `X` to carry on without a name. There are buttons for these too.

How the name is picked out: the show keeps listening for about two seconds after the first shout, so several children can be heard. It records that moment and transcribes it with **Whisper** (see below), while Chrome's live listening runs as a backup. With an API key, Claude reads everything heard and picks the most popular suitable name, understanding mixed English, Malay and Mandarin and children correcting themselves ("Ali! No, Adam!"). Without a key, simple rules remove phrases like "his name is", "call him", "nama dia" and "叫他", and the name heard most often wins.

To make names more reliable, list the names children often suggest in **Names children often suggest** on the Say anything part. Whisper is nudged toward those spellings, and anything that sounds close is snapped to the listed name ("Boh boh" or "Bo-bo" becomes Bobo, "Comell" becomes Comel). Names that aren't on the list still work normally.

Rude words are never shown. A built-in list covers common ones in English, Malay and Mandarin. Add more in **Settings**, or in `blocked_words.txt` to cover every show.

Names are only kept in memory while the show runs. They're never saved to a file, and they're forgotten when the show starts again from the beginning.

## Whisper: better listening on this laptop

Chrome's built-in listening often mishears unusual names and mixed English, Malay and Mandarin. For name questions, the show also records the shouts and transcribes them with **Whisper**, a speech recognition model that runs on this laptop. It's generally more accurate, it's given the expected names as hints, and the children's voices never leave the computer.

**Setup:** `setup.bat` / `setup.sh` installs Whisper and downloads the model once (about 480 MB, so it needs internet). After that it works offline. The first name of each session can take a few extra seconds while the model loads.

**Checking it works:** the server window says whether Whisper is loading, and the editor's **Settings** tab shows its status, e.g. "Whisper is ready (small model)".

**Options** (in the `.env` file):

| Setting | What it does |
|---|---|
| `WHISPER_MODEL=small` | The default. Try `base` if names take too long to appear on an older laptop, or `medium` on a fast one for better accuracy. Run setup again after changing it, to download the new model. |
| `WHISPER=off` | Turns Whisper off, so only Chrome's listening is used. |

Each show can also choose **Chrome's built-in listening only** in **Settings → How to listen for names**.

If Whisper is missing, still loading, or fails, the show automatically falls back to Chrome's listening, so a name question never gets stuck. Whisper also works in browsers without Chrome's listening (such as Firefox), in which case the show notices shouts by loudness.

Recordings are held in memory only long enough to transcribe them, and are never saved.

## Online room (Zoom classes and watching from home)

People can watch the show on their own laptop or phone, in sync with the host, and join in from wherever they are. This is ideal for a Zoom class. Zoom carries faces and voices, and the show runs in everyone's browser.

**Host:** the show is always shared with anyone who joins, so there's nothing to switch on. Before you start, the start screen shows how many people are waiting online, and the **online panel** (link, QR code, who's joined) opens by itself when someone joins, or tick **🌐 Show the online room panel** to see it straight away. If everyone is online, untick the camera; the host doesn't need one. For people outside your Wi-Fi (a Zoom class), press **🌐 Make a public link** in the online panel. Then share the link in the Zoom chat, or show the QR code. Participants type the 4-digit room code and a first name or nickname.

**Before the show starts**, participants wait in a lobby showing the show's title, how many people are here, and quick checks: their camera (with a preview showing it can see them), their microphone (say hello to test it) and a test sound. As soon as the host starts, everyone's screen switches to the show.

**What participants get** on the watch page:

- The same clip at the same moment as the host, including when the host pauses, skips or jumps. Latecomers join mid-scene in sync.
- At questions: answer buttons with live bars, emojis, and spoken answers through their own microphone (Chrome or Edge). Stand to choose becomes moving to the left or right of their own camera picture, and cheer loudest uses their own microphone.
- At moves: **their own camera** checks the move, with a progress ring and "Counted! Well done". Without a camera, or if it struggles, they tap **✋ I did it!**
- At "say anything" and name questions: say it out loud, or type it.
- Their camera and microphone stay on their device. Only answers and "done / not done" are sent to the host.

**What the host sees:** the online panel shows how many people are here, with a chip for each person (📷 camera, ✋ button, ✓ done). Click a chip to remove someone. Votes, emojis and everyone's actions count alongside anyone in the room: a Move part's "share of children" applies to everyone together, e.g. "12 of 20 doing it". The stage shows a figure per person.

**Editing during the show:** **✎ Edit story** in the top bar opens the editor. Changes apply from the next part, without interrupting the one playing.

**Good to know:**

- **Participants' cameras and microphones need the secure public link.** Browsers only allow the camera and microphone on secure links (starting with `https://`) or on the computer itself. The Wi-Fi link (`http://192.168…`) is not secure, so participants on it can watch, vote, type and tap "I did it", but can't use their camera or microphone. Press **🔒 Make a secure public link** in the online panel (it needs internet). It works for people on the same Wi-Fi too, and anyone already on the Wi-Fi link gets a **Switch to the secure link** banner.
- On many Windows laptops, only one app can use the webcam at a time. If Zoom has it, the show's camera check can't start. The easiest fix is for participants to open the show on a **phone** propped up facing them, with Zoom on the laptop, or to switch their Zoom video off during the show.
- Ask the host to not share computer sound in Zoom, since everyone hears the show from their own device.
- Some phones (especially iPhones) need a tap before playing sound; a **🔊 Tap for sound** button appears if so.
- Updates reach participants through a live stream. Some internet connections and proxies hold live streams back; if that happens, the watch page automatically switches to checking in with the server every second, so the show still arrives (a moment later at most).
- The laptop server comfortably handles a class (around 30 people). For much bigger audiences, put the show on a cloud server.

## Full screen

Press **⛶ Full screen** at the top of the show page, or the `F` key. The top bar disappears and the stage gets bigger. Move the mouse to bring up the controls (Pause, Restart, Exit full screen); they hide again after a few seconds. `Esc` also leaves full screen.

## Pausing

Press **⏸ Pause** at the top of the show page, or the `P` key, at any moment. Everything stops together: the video, the timers, the countdowns, the camera and microphone checks, and phone voting (phones show "Paused").

The pause menu shows which part you're at and how long you've been paused. From there you can:

- **Resume.** A 3-2-1 countdown gives everyone a moment to get ready. Press Resume or `P` again to skip the countdown.
- **Restart this part**, or **Start from the beginning**.
- **Jump to a part**, which is handy in rehearsals.

The **↺ Restart** button opens the same menu. Restarting always loads the latest version of the story, so edits made in the editor show up straight away.

The show also pauses by itself if the browser tab is hidden or minimised. You can turn this off in the operator panel.

For planned breaks, add a **Pause part** to the story in the editor. The show holds on a break screen until the presenter presses **Continue** (or `C`), or carries on by itself after a set time.

## Operator console

Press **🎛 Console** at the top of the show page. It opens a second window, like PowerPoint's presenter view. Put the show window on the projector (full screen), and keep the console on the laptop screen. While the console is open, operator-only buttons disappear from the stage, so the audience sees only the show.

The console shows what's happening now and gives big buttons to override the AI at any moment:

| At a… | The console offers |
|---|---|
| Question | **Force an answer** buttons for each answer, with live vote, voice, emoji and cheer counts |
| Move | A progress bar, **✓ They did it** and **Time's up** |
| Say anything | A button for each reaction group, and **No answer / skip** |
| Name check | The heard name, a box to **type the right name**, **Listen again**, **No name** and **Save to name library** |
| Pause part | **Continue the show** |
| Scene | **Skip this clip** |

The console also always has Pause/Resume, Skip, Restart this part, Start again and Jump to any part. Its side panel shows the camera picture with body tracking, the loudness and room-movement meters, what the microphone heard, the names remembered so far, the room code and QR, and the Single child / Auditorium switch.

Keyboard shortcuts work in both windows:

| Key | What it does |
|---|---|
| `P` | Pause or resume the whole show |
| `F` | Full screen on or off (show window) |
| `Space` | Skip the current clip, or end the waiting time now |
| `1`–`6` | Choose that answer or reaction group |
| `Enter` | Mark the move as done, or use the heard name |
| `C` | Carry on after a Pause part |
| `R` / `X` | At a name check: listen again / carry on without a name |
| `E` | Console only: jump to the name box to type a correction |

The **⋯ More** button on the show page opens a small panel with the same keys, the speech language, the log, and links to all stories and the editor.

## On-stage meters

While the children answer, the stage shows live feedback instead of a static wait: sound bars that bounce with the room's loudness, each answer's emoji growing as it gains votes, a big progress ring for moves ("2 of 3" jumping jacks, or "4 of 7 children" in Auditorium mode), and "Cheer for 🌲 The forest!" during cheer voting.

## Single child and Auditorium modes

Camera and microphone behave very differently for one child at a laptop and a hall of thirty. Set **Settings → Audience → Who's watching** for each show, and switch during the show in the console.

**Single child** follows the child nearest the camera (the biggest in the picture), so people walking past in the background don't count.

**Auditorium** follows **each child separately**. Every child the camera can pick out gets a number that stays with them as they move (shown above their head in the camera view, with a ✓ once they've done the move). Each child's hands and face are matched to them, and every child is judged on their own:

- **Poses** (hands up, arms out, your own moves): each child must hold it for the hold time.
- **Repeated moves** (jumping jacks, clapping, marching…): each child's repetitions are counted separately.
- **Taught gestures** (finger on forehead, a wand swirl…): each child is compared with the recorded examples. Children further back look smaller, so the show automatically allows a little more tolerance for them.

The move then counts for the group once enough children have done it. Each Move part sets **the share of children needed** (e.g. 50%) and **at least this many children** (so one keen child can't finish it for the whole room). The stage shows a little figure for each child, turning green as they finish, with "3 of 7 children" in the ring.

**Settings → Children tracked at once** (2–10, default 6) sets how many children are followed. More children needs a faster laptop, so check the speed in 📷 Camera check. If nobody can be picked out at all (too far away, too crowded, too dark), repeated moves fall back to overall movement in the picture ("Everybody moving!").

For big groups, questions have two answer types made for crowds (see below): **📣 Cheer loudest** and **🚶 Stand to choose**. Name questions listen a little longer in Auditorium mode.

## Changing the story with the editor

In the Studio, click **✎ Edit** on a show (or **Edit story** on the show page). No coding is needed. **Project → ← Back to the Studio** returns to the list of shows.

The **Story map** on the left has two views, switched with **🗺 Canvas** and **☰ List**:

- **Canvas** shows the whole show as parts joined by wires, so branches, loops and loose ends are easy to see. Drag a part by its top to move it. Drag from a path's dot (on a part's right edge) onto another part to connect them, or into empty space to add a new part there. Click a wire and press **✕ Remove link** (or Delete) to disconnect it. Drag the background to move around, and scroll or use + and − to zoom. **Fit** shows everything and **Tidy up** arranges the parts neatly. Wires going back to an earlier part (loops) are dashed red, parts with problems glow red with a "!", and parts nothing leads to are dashed. The **Add** buttons along the top create a new, unconnected part.
- **List** shows the same story as an indented tree. Straight runs of scenes sit in a line, and every question or move branches out underneath. It's easier on small screens.

Click any part to change it on the right. Wherever the story doesn't say what happens next, there's a **+ Add what happens next** button. It offers six kinds of part:

| Part | What it does |
|---|---|
| 🎬 Scene | The audience just watches |
| ❓ Question | Children pick between 2–6 answers |
| 🙌 Move | Children do a movement to carry on |
| 💬 Say anything | Children shout any answer and the actors react |
| ⏸️ Pause | The show waits until the presenter presses Continue |
| 🏁 Ending | The show finishes |

The same dialog also lets you **join up** with a part that already exists, so different branches can meet again.

Every part's form ends with a **What happens next** box. Use it to change where any path goes, or press **Add a new part here** to slot a new scene in between two existing parts. The story then carries on to where it went before. **Make a copy** duplicates a part, which is handy for reusing a question with small changes.

Questions can have up to 6 answers and Say-anything parts up to 6 reaction groups. The ↑ and ↓ buttons change their order.

**How children answer** is set on each Question separately. Tick any of 🗣 spoken answers, 📱 phone votes, 😀 emoji reactions and 📣 **cheer loudest**. With cheering, after the waiting time the stage asks the room to cheer for each answer in turn, and the loudest cheer wins. With **🚶 stand to choose**, children walk to the left or right of the room (left, middle or right for three answers; for more, they stand under their choice), and the camera counts how many are in each part. The camera preview shows the zones with a live count in each, and the last few seconds count most, once everyone has had time to move. "Left" and "right" are as the children see themselves on screen. A quiet moment might use phones only, and a big hall might use cheering or standing. Each Question uses the show's usual weights from Settings unless you tick **Give this question its own weights**.

**Moves** are also set on each Move part: which move to watch for, how long to hold it (poses) or how many times (repeated moves), **how strict the camera is** (Relaxed suits young children and loose movements), and in Auditorium mode what share of the children must do it. Detection is smoothed over a fraction of a second, so one flickering frame can't pass or break a move.

The **Moves** tab lists the ready-made moves:

| Hold it | Repeat it |
|---|---|
| Both hands up, Arms out like a star, Touch your toes | Jump, Wave, Clap, Jumping jacks, Flap fairy wings, March on the spot, Spin around |

You can also make your own pose from simple rules, such as "Right hand is close to Head" for "Touch your head". Every move has a **Try it** box: turn on the camera, choose strictness and mode, and watch the progress bar fill as you do it.

### Teaching a move by example (fingers, face and tricky moves)

For specific gestures, like a finger pointing at the middle of the forehead, a "shh" finger on the lips or a magic-wand swirl, use **🎓 Teach a new move by example** at the top of the Moves tab (or choose it from a Move part's move list). There are no rules to write: you show the camera the move a few times.

1. Name the move and choose **A pose to hold** or **A movement** (for movements, set roughly how long one takes).
2. Choose what the camera looks at: **Body**, **Hands and fingers** (all 21 points on each hand) and/or **Face** (forehead, nose, mouth and chin, so it knows where fingers touch the face). Leave **Either hand works** ticked unless the hand matters.
3. **Turn on camera**, press **● Record the move**, wait for "Go!", and hold the pose for 2 seconds (or do the movement once). Repeat 5 or more times, from slightly different spots, varying it a little. Children make the best examples, since they perform moves more loosely than adults.
4. Record a few **● Record "not this"** examples: things that look similar but shouldn't count, like scratching your head or pointing at your nose. These make it much harder to fool.
5. The panel says whether it **looks reliable**, or what to add. Use **Try it** to check, then choose the move in any Move part.

How it works: every camera frame becomes measurements that don't depend on the child's size or distance, such as finger shapes and how far each fingertip is from the forehead, nose, mouth and chin. These are compared with the recorded examples. Poses are compared moment by moment, and movements as short sequences that allow for doing it faster or slower. How close counts as a match is worked out automatically from the examples, and **How strict the camera is** on the Move part adjusts it. Hand and face tracking only run when a move needs them, and the show loads them at the start, so there's no delay mid-show. Examples are saved inside the show, so they travel with **Download** and copy-paste.

Fingers and faces need the child fairly close to the camera (about 2–3 metres for an ordinary webcam) and good light. In Auditorium mode, taught moves follow the child nearest the camera.

The **Settings** tab covers the whole show: the audience home page card, Single child or Auditorium, which part it starts with, the microphone's language, name handling, and the usual weights for each kind of answer.

**↶ Undo** and **↷ Redo** in the top bar (or `Ctrl+Z` and `Ctrl+Y`) step backwards and forwards through your changes. Typing in one box counts as one step.

**Keyboard shortcuts** (⌘ Cmd on a Mac): `Ctrl+S` save now, `Ctrl+F` find a part, `Ctrl+C` / `Ctrl+X` / `Ctrl+V` copy, cut and paste the selected part (paste works in another show too, and brings along any custom move it uses), `Ctrl+D` make a copy, `Delete` delete the part, `Ctrl+Enter` try the show from here, `Ctrl+Shift+E` filming script, and on the canvas `Ctrl+ +` / `Ctrl+ −` to zoom and `Ctrl+0` to fit. Inside a text box these keys work on the text as usual. `Ctrl+/` or **Project → ⌨ Keyboard shortcuts** shows the full list.

**▶ Try from here**, at the bottom of every part, opens the show starting at that part, so you can test a scene without watching everything before it.

The **Find a part…** box above the story map searches questions, lines, answers and keywords. On a big story, **▾ Hide paths** under a question or move folds its branches away to keep the map tidy.

Changes save automatically. The red **things to fix** box lists anything that would stop the show from running, like a question with no next step. The server also keeps a copy every couple of minutes in the project's `backups` folder. To go back further than Undo allows, open the **Project** menu, choose **Earlier versions…** and bring one back.

Each video spot in the editor has an **Upload video** button, which copies the file into the project's `videos` folder for you. When you upload or choose a video, its real length is read from the file and replaces the length slider.

## Filming script

**Project → 📄 Filming script…** in the editor (or **📄 Script** in the Studio) opens every clip the actors need to record, with every branch variation:

- **By scene** follows the story path by path, with the path each part belongs to ("Path: If they pick 🌲 The forest").
- **By actor** groups clips by the **Who says it** field on each clip, so each actor can record all their lines in one block.

Each clip shows its number, role (e.g. "Waiting loop"), file name, length, lines, on-screen words, a tick box, and whether it's filmed yet (a video with that name is uploaded). **Only clips not filmed yet** makes a to-do list for a filming day. **🖨 Print or save as PDF** prints it; choose "Save as PDF" as the printer to get a file.

**📺 Teleprompter** shows just the lines, large on black, scrolling automatically. `Space` starts and stops, the arrow keys change speed, and **Mirror** flips the text for a teleprompter glass.

## Phones and the public link

Phones join with the **4-digit room code** shown next to the QR code: scan the QR, or go to the address shown and type the code. A new code is made each time the server starts, so phones from a previous show can't vote in the next one.

Phones on the same Wi-Fi work straight away. For phones on **mobile data or another network**, press **🌐 Make a public link** in the operator console. It creates a free, temporary `https://….trycloudflare.com` address using Cloudflare's tunnel tool (no account needed), and the QR code switches to it automatically. The first time, the tool (about 40 MB) is downloaded into the `tools` folder, so this needs internet. Through the public link **only the voting pages are reachable**; the Studio, editor, show pages and everything else stay private to this laptop.

A permanent short address like `klsp.show/1234` would need a paid domain and a cloud server. The public link shows how it would work.

## Changing the story by hand (advanced)

Each show's story lives in `projects/<your show>/story.json`. No code changes are needed to add scenes, change questions, add keywords or tune weights. Each entry in `nodes` is one of six types:

| Type | What happens |
|---|---|
| `scene` | Plays `clip`, then goes to `next` |
| `choice` | Plays `prompt`, loops `idle` for `window_sec`, then goes to the winning option's `next` |
| `action` | Plays `prompt`, loops `idle` until the camera sees `action` (`hands_up`, `jump` or `wave`), then goes to `success`, or to `timeout_next` after `timeout_sec` |
| `open` | Plays `prompt`, listens for an answer, plays the matching category's `reaction` (or `fallback_reaction`), then goes to `next` |
| `pause` | Loops `clip` and shows `message` until the presenter continues (or after `auto_sec` seconds, if above 0), then goes to `next` |
| `end` | Plays `clip` and shows the end screen |

The `weights` in `settings` control how much phone votes, spoken answers and emojis count at choice points. They only apply to input types that were actually used, so a room with no phones is decided fully by voice.

## Adding real videos

Use the **Upload video** buttons in the editor, or put MP4 files straight into `projects/<your show>/videos/` using the file names from the story (for example `intro.mp4`). Any clip that exists plays as video; any that's missing stays a placeholder card. Refresh the page after adding files.

**Use MP4 with H.264 video and AAC sound.** That format plays in every browser. iPhone `.mov` files (often HEVC/H.265) and some other formats won't play in Chrome on Windows. If a file can't play, the show uses its placeholder card and the log says why (🎬 lines). To convert a clip, use HandBrake's "Fast 1080p30" preset, or `ffmpeg -i in.mov -c:v libx264 -c:a aac -movflags +faststart out.mp4`. Smaller files (720p, a few MB each) start faster, especially over the public link.

If a video takes more than about 1.5 seconds to start, "Loading video…" appears in the corner. After 15 seconds the show moves on with the placeholder card. If the browser blocks sound, the video plays muted and a **🔊 Turn sound on** button appears on the stage.

## Project map

| File | Job |
|---|---|
| `app.py` | Local server: pages, phone voting, QR code, Claude classification, saving, backups, uploads |
| `projects/` | Your shows: each has `story.json`, `videos/` and `backups/` |
| `sample/story.json` | The example show used for "New show from the example" |
| `static/index.html`, `static/css/show.css` | The show page |
| `static/vote.html` | The phone voting page |
| `static/home.html`, `static/css/home.css` | The audience home page |
| `static/studio.html`, `static/js/studio.js` | The Studio (team home page) |
| `static/editor.html`, `static/js/editor.js`, `static/css/editor.css` | The story editor (the CSS also styles the Studio) |
| `library/names.json` | The Name library (created when the first name is saved) |
| `static/js/main.js` | Runs the story and connects all inputs |
| `static/js/player.js` | Plays clips without gaps; shows placeholder cards |
| `static/js/voice.js` | Speech-to-text and keyword matching |
| `static/js/pose.js` | Camera move detection: body, hand and face tracking, smoothing, strictness, the ready-made moves, custom and taught moves, Auditorium mode (MediaPipe, runs on this computer) |
| `static/js/taught.js` | Teach by example: turns frames into measurements and matches them against recorded examples |
| `static/js/moves.js` | What each move is, and how to judge it for one child |
| `static/js/crowd.js` | Several children: keeps track of who's who, matches hands and faces to each child, judges each child and decides for the group |
| `static/js/engine.js` | Combines votes, voice and emojis into one decision |
| `static/js/clock.js` | The show clock that stops while paused |
| `static/js/canvas.js` | The story canvas in the editor |
| `static/operator.html`, `static/js/operator.js`, `static/css/operator.css` | The operator console |
| `static/script.html`, `static/js/script.js` | The filming script and teleprompter |
| `static/join.html` | Phones type the room code here (voting only) |
| `static/watch.html`, `static/js/watch.js`, `static/css/watch.css` | The online room's watch page for participants |
| `static/js/live.js` | The host side of the online room |
| `static/camera.html`, `static/js/camera.js` | The Camera check page |
| `tunnel.py` | The public link for phones (Cloudflare quick tunnel) |
| `tools/` | Created when the public link is first used; holds the tunnel tool |
| `names.py` | Picks names out of what the children shouted, matches expected names, and filters rude words |
| `whisper_engine.py` | Speech-to-text on this laptop with Whisper |
| `static/js/recorder.js` | Records the microphone during name questions and notices shouts |
| `blocked_words.txt` | Extra words that must never appear on screen, for every show |

## Camera check and troubleshooting

Open **📷 Camera check** from the Studio, the editor's Moves tab or the show's **⋯ More** panel. It shows:

- Whether the camera and each tracker (body, hands and fingers, face) are working, and whether they run on the graphics card or the processor. Trackers try the graphics card first and fall back to the processor automatically.
- The speed in frames a second (15 or more is good).
- Which body parts the camera can see right now: head, shoulders, hands, hips, knees, feet, fingers and face.
- A **Try a move** box for any built-in move, or any custom or taught move from the open show.
- Tips for whatever isn't working, and a **📋 Copy report** button to send to whoever helps with the tech.

**If moves don't respond:**

1. **After updating, press `Ctrl+F5` once on each page** (or close and reopen Chrome) so the browser loads the new version. The Studio and Camera check show the version number; it should match the one printed in the server window. From this version on, the server tells the browser to check for new files every time, so this won't be needed again.
2. **Check the camera box was ticked** on the show's start screen, and that the camera chip at the top says "Watching".
3. **Open Camera check.** If a tracker says "couldn't load", connect to the internet and start again. The trackers download the first time they're used.
4. **Frame the children.** Jumps work from the shoulders if the hips are out of view, but marching and touching toes need the whole body, and fingers need the child within about 2–3 metres, in good light.

## Known limits (worth saying in the pitch)

- Chrome's speech recognition sends audio to Google to transcribe it. A production version should use on-device recognition (such as Whisper) for children's privacy.
- Camera frames are processed on the computer and never sent anywhere or saved.
- Speech recognition struggles more with young children's voices and mixed-language sentences, which is why phone votes and operator keys exist as backups.
- The first time the camera starts, it downloads the pose model from the internet (a few MB), so run it once before the demo.
- The ready-made moves (jumping jacks, flapping wings and so on) are motion-pattern rules built on body tracking. Taught moves compare against a handful of examples rather than a trained AI model. The recorded examples are exactly the data a trained model would need, so training one is a natural next step once KLSP has collected many examples from real children.
- Auditorium mode follows up to 10 children individually (6 by default). In a bigger crowd it judges the children it can pick out, typically the ones nearer the camera, as a sample of the room. A wider-angle camera placed high at the front helps it see more children. Fingers and faces are only reliable within about 2–3 metres.
- The public link is a free temporary address that changes each time. A permanent domain needs paid hosting.
