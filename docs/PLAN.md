# Doggy: plan & status

_Last updated: 2026-11-02 (MVP day 1)._ Keep this file current: move items between sections when they change.

## Goal
Never forget anything you committed to or were asked to do. Capture from Mac and Windows; sync to every device
(Mac, Windows, iOS, Android); add memories by voice or text from anywhere; retrieve by asking.

Reference product: projectminimi.com (Mac only, Accessibility capture, cloud LLM extraction, local vector DB, MCP).
We match its capture approach, add Windows, and add cross-device sync and phone apps.

**Out of scope by decision:** reading phone content (screen, notifications, calls). Phones only show synced data, take
voice/text notes, and answer questions.

## MVP scope (2-hour build) and the shortcuts taken

| Target architecture | MVP shortcut | Why |
|---|---|---|
| Tauri desktop app + native capture helpers | Headless CLI capture agents (Swift, C#) + web app | Capture was the hard part; UI shell is cheap to add later |
| React Native iOS/Android apps | Installable web app (PWA) | Works on both phones today; same API |
| Local-first Rust core, E2E-encrypted sync | Server is the source of truth (SQLite); devices sync by signing into the same account | Simplest correct sync; E2E later needs key distribution |
| Hybrid search (keyword + embeddings + people graph) | SQLite FTS5 keyword search | No embedding provider needed yet |
| Server-side transcription (Deepgram/Whisper) | Browser speech recognition (Web Speech API) | No key; works on Chrome/Safari/iOS |

## Status

### Done and verified
- [x] API contract: `docs/API.md`
- [x] Server (Bun + Hono + SQLite): accounts, per-device tokens, capture intake, notes, items, incremental sync
      (`/api/changes`), search, ask, MCP endpoint. Verified end to end with curl.
- [x] Extraction pipeline: one shared prompt for screen text, voice, and typed notes. Requires an evidence quote;
      dedupes against open items; auto-closes loops when the source shows them done. Uses Claude (`claude-opus-5-5`)
      with server-side refusal fallback; rule-based fallback when no key.
- [x] Episode batching: screen text grouped per (device, app, window), processed after 45s idle or 12k chars.
- [x] Capture cost gates (2026-11-02): server-side seen-line dedupe per source, source registry with fast/slow/skip
      lanes and per-user overrides (Devices → Sources), batched extraction per user tick, usage
      ledger, 30-day expiry of processed screen text, near-duplicate guard, and `bun run replay` to measure it. See CAPTURE_PIPELINE.md.
      **Verified** on a throwaway DB (heuristic and real-key runs). **Not yet measured on production captures.**
- [x] Web app/PWA: open loops grouped by due date (overdue/today/week/later), mark done/dismiss, evidence and source
      on tap, Ask (cited answers), Memory (search + filters + matching screen text), Devices, voice and text composer.
      Desktop layout checked in headless Chrome.
- [x] Mac agent: Accessibility tree walk of the focused window, Electron/Chrome support (`AXManualAccessibility`),
      password-field skip, app exclusions, pause file, line diffing, batched upload with retry.
      **Verified on a real Mac:** read WhatsApp Web in Chrome (82 new lines in 69 ms) and uploaded it.
- [x] Windows agent: UI Automation walk with caching, `IsPassword` skip, exclusions, pause file, diffing, batching.
      **Compiles only; never run on Windows.**

- [x] **Deployed:** https://doggy.ruv.world (VPS + Caddy + Let's Encrypt, systemd service, deploy from git with
      `deploy/deploy.sh`). See TECHNICAL.md → Production deployment.
- [x] **iOS-ready PWA:** PNG icons (180/192/512, opaque), manifest with shortcuts, offline shell cache, and an
      "Add to Home Screen" hint on iOS Safari.
- [x] **Desktop apps with UI, downloadable from the Devices page:**
      Mac menu bar app `Doggy.app` / `Doggy-mac.dmg` (arm64, ad-hoc signed; built and launched, menus not clicked through).
      Windows tray app `Doggy-windows.exe` (self-contained single file; compiles, **never run on Windows**).
      Both: sign in / create account, status, quick note, pause/resume, start at login, open web app.

### Not verified yet (do these first)
- [ ] Click through the Mac app: sign in to doggy.ruv.world, grant Accessibility, confirm items appear.
- [ ] Windows tray app on a real PC (sign in, tray menu, start with Windows, capture in Chrome/Slack/Teams/WhatsApp/Outlook).
- [ ] Install the PWA on a real iPhone; voice notes in standalone mode.
- [x] Extraction with a real key (2026-11-02 smoke test). Voice note → 3/3 correct items with resolved dates
      (Sonnet, ~5s). Noisy Slack screen → 3/3 correct (task, commitment, decision), UI chrome ignored (Haiku).
      Fixed: "ask" misread UTC times as local; sources now show local times.
- [ ] Extraction accuracy on a full day of real capture (precision/recall); one smoke test isn't an eval.
- [ ] Windows agent on a real machine: Chrome, Edge, Slack, Teams, WhatsApp desktop, Outlook (classic and new).
- [ ] Web app at real phone width (headless Chrome couldn't render narrower than about 500px) and voice on iOS Safari over HTTPS.

## Next (in order)
0. **Replay production.** Copy `/var/lib/doggy/doggy.db`, run `bun run replay` for 2026-11-02 07:19 to 09:28 UTC,
   and check that none of the 4 kept items would be skipped. Then deploy and watch `/api/usage`.
1. **Accuracy loop.** Set the key and run a day of real capture. Hand-label about 200 episodes and measure precision
   and recall of tasks/commitments. Tune the prompt, `MIN_CONFIDENCE`, and episode sizing. Use the dismiss button
   as labels.
2. **Per-app parsers** (like minimi's): structured extraction of sender/time/thread for WhatsApp, Slack, Teams,
   Gmail, Outlook on Mac and Windows, falling back to the generic tree walk for other apps.
3. **Windows field test**, plus fixes per app (see agents/windows/README.md).
4. **Deploy** the server (Fly.io/Railway with a volume, or a VPS) behind HTTPS so phones work; add Litestream backups.
5. **Reminders:** web push notifications for due/overdue items, plus a daily digest.
6. **Better voice:** record with MediaRecorder and transcribe server-side (Deepgram) for accuracy and long notes.
7. **Embeddings + hybrid search** for "ask" (sqlite-vec), plus people/entity resolution (Raj = raj@acme = +91…).
8. **Desktop distribution polish:** Apple Developer ID + notarization, Windows code-signing cert, universal (arm64+x64)
   Mac build, exclusions UI, auto-update. Build both in GitHub Actions on tag and publish to the server.
9. **Native phone apps (Expo/React Native):** home-screen widget, Action button / Siri Shortcut, Android quick tile
   for one-tap voice; offline cache from `/api/changes`.
10. **Privacy hardening:** redact secrets/PII before LLM calls; encrypt captures at rest; retention limits for raw
   captures; E2E encryption (recovery phrase or approval from an existing device).
11. **Meetings:** system audio + mic capture with diarized transcription.
12. Browser extension (exact page text + URLs); Gmail/Calendar/Slack integrations for messages never viewed on screen.

## Decisions log
- 2026-11-02: Phones do not capture; they're companions (user decision).
- 2026-11-02: Same account = synced devices; no separate pairing in the MVP.
- 2026-11-02: Cheap models by default. Capture extraction → `claude-haiku-5-5` ($0.10/$0.50 per MTok), notes and ask →
  `claude-sonnet-5-5`. Override with `DOGGY_MODEL_FAST` / `DOGGY_MODEL`. Accuracy should come from better input
  (per-app parsing, episodes), not a bigger model.
- 2026-11-02: Cut capture model calls with gates on where text came from and whether it is new, never on its words
  (keyword gating like `TASK_RE` was rejected as brittle). Observed that day: 604 capture events from one Mac in two
  hours led to about 143 Haiku calls and 4 kept tasks, mostly from X, YouTube and WhatsApp Web. The server now drops
  lines it already stored per source, skips feeds and our own site, reads documents hourly, batches ready episodes per
  user, and records token usage. Server-only, so desktop agents need
  no new release.
- 2026-11-02: No daily token cap. A cap silently stops new screen tasks for the rest of the day, which is worse for
  users than the cost. Usage is still recorded. Processed screen text expires after 30 days so the database stays
  small. Items keep their quotes, so dedupe is unaffected.
