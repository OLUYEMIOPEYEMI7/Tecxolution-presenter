# Peculiar Voices — Worship Presenter (Phase 1)

Live two-screen worship projection software: pick a song slide or look up
scripture from the control room, and it instantly appears on the projection
screen in real time (WebSocket-synced).

## Run it
```
./start.sh
```
Then open:
- **Control room** (your laptop): http://localhost:4000/control
- **Projection screen** (drag to the projector/second monitor, fullscreen it): http://localhost:4000/display

## Add more songs
Edit `data/songs.json` — each song has sections (verse/chorus/etc.) with
`pairs` (call/response lyric lines), an optional `finale` banner line, and a
`background` image path (drop images into `public/images/`).

## Scripture
Looked up live from bible-api.com (free, no key needed) — type any reference
like "Genesis 1:1" or "Romans 8:28" and hit Project.

## What's next (Phase 2/3 — not built yet)
- Auto-detect scripture references spoken by the preacher via live speech-to-text
- Auto-detect which song/line is being sung and auto-advance slides
- Both will sit on top of this same control/display architecture — the
  socket.io "project" event is already the hook point for an automated
  trigger instead of a manual click.

## Phase 2 — Voice Detect (shipped)

The control room now has a "🎙 Voice Detect (Beta)" panel that listens live
via the browser's built-in speech recognition (Chrome only — uses
`webkitSpeechRecognition`, free, no API key, no server audio streaming).

**How it works:**
1. Click "Start Listening" (Chrome will ask for mic permission — allow it).
2. It transcribes continuously and scans for spoken scripture references
   ("Genesis chapter one verse one", "John 3 16", "Romans eight twenty eight", etc.)
3. With **Auto-project** checked, a confidently detected reference is looked
   up and projected immediately. Uncheck it for **suggest-only** mode, which
   shows "Heard: X" with a one-click confirm button instead — safer for a
   first live run.
4. A 12-second cooldown stops the same verse re-firing repeatedly while the
   preacher keeps talking about it.

**Important — must use Chrome, must be on the laptop with the live mic.**
Speech recognition runs in the browser tab itself, not the server, so the
control room browser tab needs the microphone that's actually picking up
the preacher (e.g. plugged into the sound board, or just the laptop mic
pointed at the room).

**Known limitation**: this is speech parsing, not perfect. It will
occasionally mishear a reference, especially with background music/noise.
Recommend running in suggest-only mode for the first few services until
you trust it, then switch to auto-project.

**Not yet built (Phase 3)**: auto-detecting *sung* lyrics to auto-advance
song slides. Scripture detection (Phase 2) was prioritized first because
spoken references are far more reliable to detect than lyrics sung over
music/harmony.

## RCCG Hymnal (826 hymns)

The full official RCCG "Redeemed Hymnal — 4th Edition" (hymns #1–826) is built in,
sourced from getrhema.net and scraped via `scripts/scrape-rccg-hymnal.js` into
`data/rccg-hymnal.json`. Search by title or hymn number in the "RCCG Hymnal" tab.

To re-scrape (e.g. if the source site updates): `node scripts/scrape-rccg-hymnal.js`

## Adding your own songs

Click "+ Add Your Own Song", enter a title, then paste the full lyrics into the
box — leave one blank line between each verse/chorus and it auto-splits into
slides. Starting a block with "Chorus", "Refrain", "Bridge", "Intro" or "Outro"
labels that slide automatically; everything else is numbered VERSE 1, VERSE 2...
