# Peculiar Voices — Worship Presenter

Live worship projection software: song slides, scripture, media, PowerPoint decks,
ticker, countdown and alerts — controlled from a laptop or phone, shown on the
projector in real time (WebSocket-synced).

## Pages
| URL | Who | Purpose |
|---|---|---|
| `/control` | operator (sign-in) | Control room: songs, scripture, schedule, media, timer, alerts |
| `/display` | public (view-only) | The projector output — open fullscreen on the second screen |
| `/stage` | public (view-only) | Stage / confidence monitor: current slide, **next** slide, clock, timer, alerts |
| `/remote` | operator (sign-in) | Phone remote: next/prev/go-live, black/logo/clear, alerts, schedule |
| `/healthz` | public | Health + DB status (use as the Render health-check path) |

## Configuration (environment variables)
| Variable | Required | Notes |
|---|---|---|
| `OPERATOR_PASSWORD` | **yes (production)** | Operator sign-in. With `NODE_ENV=production` and no password the control room is locked (fails closed). |
| `REMOTE_PASSWORD` | optional | Second password for volunteers: opens the phone remote only (next/prev, go live, black/logo/clear, alerts). Cannot edit, upload, delete or open the control room. |
| `SESSION_SECRET` | optional | Signs login cookies. Defaults to a key derived from the password (changing the password signs everyone out). |
| `DATABASE_URL` | recommended | Supabase/Postgres. Without it data lives in local files and is wiped on every redeploy. |
| `API_BIBLE_KEY` / `NLT_API_KEY` | optional | NIV/AMP/MSG via API.Bible; higher NLT limits. |
| `SUPABASE_URL` + `PRESENTER_STORAGE_SECRET` | optional | Enables Supabase Storage for uploaded media (images, video, PowerPoint slides) via the `presenter-storage` Edge Function. Existing database-stored media is migrated automatically at boot. If unset or unavailable, media stays in Postgres. |
| `DATA_DIR` | optional | Where file-fallback data is written (default `./data`). |

## Run it
```
npm install
OPERATOR_PASSWORD=choose-one ./start.sh
npm test        # end-to-end tests (auth, socket gating, validation, uploads, persistence)
```

## Operator shortcuts
`Ctrl+K` or `/` search everything (songs, hymn numbers, lyrics, scripture like `john 3:16`, schedule, actions) ·
`←` `→` previous/next slide (continues into the next schedule item) · `1`–`9` stage slide N ·
`Enter`/`Space` go live · `B` black · `L` logo · `C` clear text (press again to restore the same slide) ·
`Esc` clear all · `?` shortcut help. `Shift+Enter` in search goes straight live.

## Finding songs and scripture
- **Search** (song box or `Ctrl+K`) matches the title, artist, hymn number **and any words from the lyrics**, best matches
  first, with the matching lyric line highlighted. Word order and punctuation don't matter; one misremembered word still finds it.
- Songs imported as titles only show **NO LYRICS**; the footer link lists them. **Import lyrics** (menu or song panel) fills them from
  pasted text or `.txt` files you are licensed to use (`### Title | Artist` then the lyrics). It never overwrites existing lyrics.
- **Scripture navigator:** after any verse is shown, use **◀ Verse / Verse ▶ / ⏮ ⏭** under GO LIVE, the keys `[` `]` (verse) and
  `{` `}` (chapter), or click any verse in the **chapter view** (Scripture tab; double-click = live, Shift+click = range).
  "Live as I click" sends each pick straight to the projector. References are always shown properly ("jn 3:16" → "John 3:16").

## Control room
Tabbed workspace (Slides · Schedule · Scripture · Media · Text & Ticker · Tools), a persistent **LIVE bar**
(what is on screen, for how long, with Black/Logo/Clear), slide **thumbnails** with the live slide highlighted,
drag-to-reorder schedule with auto-advance, favourites, instant search, lines-per-slide, and projector
typography (font, size, spacing, alignment, caps, shadow, lower-third). Responsive down to phone width.

## Security model
- Operator session = signed, HttpOnly, SameSite=Lax cookie; login is rate-limited.
- Every write API and every write socket event requires the session; the projector and stage monitor are view-only.
- All socket payloads, uploads (checked by magic bytes), links and schedule items are validated server-side.
- CSP and security headers on every response; same-origin check on writes.
- Postgres tables are RLS-enabled with no public policy — only this server can reach them.

## Reliability
- Live screen, preview, ticker, timer, overlay and text size are persisted and restored after a restart or free-tier sleep.
- Service worker caches the projector shell and images; open screens keep the server awake (keep-alive ping) and reconnect automatically.
- Graceful shutdown saves state on every Render deploy. DB pool errors can no longer crash the process.
- One PowerPoint conversion at a time (LibreOffice is memory-hungry); video supports Range requests.
- `Backup` / `Restore` in the control room export/merge songs, schedule, announcements and saved texts.

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
