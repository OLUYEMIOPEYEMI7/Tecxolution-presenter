# Worship Presenter — Windows desktop app

Install it once on your PC. It runs **with or without internet**, keeps your songs, schedule and media
**on the PC**, syncs with your online copy when a connection is available, and **updates itself**.

## Install (one time)
1. Go to **https://github.com/OLUYEMIOPEYEMI7/Tecxolution-presenter/releases/latest**
2. Download **Worship-Presenter-Setup-x.y.z.exe** and double-click it.
3. Windows may show a blue **"Windows protected your PC"** box (the app isn't code-signed yet).
   Click **More info → Run anyway**. This appears once.
4. It installs for your user (no administrator needed), adds a **Worship Presenter** icon to the desktop
   and Start menu, and opens.

## First run
* The app signs itself in — there is no password to type.
* **Projector:** with a second screen/projector connected, the slides open on it automatically
  (full screen, no mouse pointer). Plugged it in later? Press **F5** (or **Open Projector**).
* **Tools ▸ Cloud sync & app:** enter your online address (pre-filled with
  `https://tecxolution-presenter.onrender.com`) and its operator password **once**. The app then syncs
  by itself (on start, every 10 minutes, and **Sync now**). The password is stored encrypted by Windows.

## Works offline
| Offline | Online only |
|---|---|
| Songs, 826-hymn RCCG hymnal, classic hymns, your own songs | Bibles other than KJV / WEB (NIV, NLT, AMP, MSG, ASV, …) |
| Scripture in **KJV** and **WEB**, with next/previous verse + chapter view | YouTube / Vimeo video links |
| Schedule, saved texts, ticker, timer, alerts, themes | Voice Detect (needs Chrome — see below) |
| Images, uploaded videos, PowerPoint decks already saved | Cloud sync, update checks |
| Projector, stage monitor | |

Anything you change while offline is kept on the PC and syncs when you're back online.

## Updates (nothing to reinstall)
When a new version is published, the app downloads it quietly in the background and shows
**"Update x.y.z is ready"**. It installs **the next time you close the app** — or click **Restart now**.
It never restarts by itself, so it can't interrupt a service. **Help ▸ Check for updates** checks on demand.

## PowerPoint files
The app turns each slide into a picture:
1. If **Microsoft PowerPoint** is installed it uses that (works offline, exact look).
2. Otherwise, if Cloud sync is set up and you're online, it uses your online copy to convert.
3. Otherwise: in PowerPoint use **File ▸ Export ▸ PNG**, then **Media ▸ Slide images** to upload the pictures as a deck.

## Phone remote
**Tools ▸ Phone remote…** turns on a link/password that lets a phone on the same Wi-Fi go next/previous,
go live, black/logo and send alerts (it cannot edit or delete). It's **off by default**; turning it on
restarts the app, and Windows may ask you to allow it through the firewall (choose *Private networks*).

## Voice Detect
It needs Chrome's speech service, which the desktop app doesn't include. Use
**Tools ▸ Open control room in Chrome/Edge (for Voice Detect)** (press **Alt** to show the menu bar).

## Where is my data?
`%APPDATA%\Worship Presenter\data` (menu **Tools ▸ Open data folder**). Uninstalling does **not** delete it.
Use **⋯ ▸ Download backup** any time for a single-file copy.

## Sync rules (so nothing is lost silently)
* Songs added on either side are copied to the other. If a song differs on both, the one with real lyrics beats a
  title-only card; otherwise the newer edit wins.
* Saved texts/announcements: merged. Media (images, videos, decks): copied both ways, never duplicated.
* The schedule is copied from the cloud only if the PC's schedule is empty.
* **Deleting** an item on one side does not delete it on the other (it can come back at the next sync).

---

## For whoever publishes updates
Updates are published from GitHub — no server of yours is involved.
1. Change `"version"` in `package.json` (e.g. `1.0.1`) and merge to `main`.
2. Create the tag: `git tag v1.0.1 && git push origin v1.0.1`.
3. The **Desktop app** workflow runs the tests, builds the Windows installer and creates a **GitHub Release**
   containing `Worship-Presenter-Setup-1.0.1.exe` and `latest.yml`. Installed apps pick it up within hours.

Every push to a `ccr-*` branch runs the tests and builds the installer **without publishing** (download it from the
workflow run's *Artifacts*).

The installer is **unsigned**, so Windows shows the "protected your PC" notice on first install. A code-signing
certificate removes it (see electron-builder's `win.certificateFile` / `CSC_LINK`).

Local commands: `npm run desktop` (run from source), `npm test`, `npm run test:desktop` (needs a display; on Linux uses xvfb),
`npm run dist` (build the installer on Windows).
