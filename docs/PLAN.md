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
- [x] Web app/PWA: open loops grouped by due date (overdue/today/week/later), mark done/dismiss, evidence and source
      on tap, Ask (cited answers), Memory (search + filters + matching screen text), Devices, voice and text composer.
      Desktop layout checked in headless Chrome.
- [x] Mac agent: Accessibility tree walk of the focused window, Electron/Chrome support (`AXManualAccessibility`),
      password-field skip, app exclusions, pause file, line diffing, batched upload with retry.
      **Verified on a real Mac:** read WhatsApp Web in Chrome (82 new lines in 69 ms) and uploaded it.
- [x] Windows agent: UI Automation walk with caching, `IsPassword` skip, exclusions, pause file, diffing, batching.
      **Compiles only; never run on Windows.**

### Not verified yet (do these first)
- [x] Extraction with a real key (2026-11-02 smoke test). Voice note → 3/3 correct items with resolved dates
      (Sonnet, ~5s). Noisy Slack screen → 3/3 correct (task, commitment, decision), UI chrome ignored (Haiku).
      Fixed: "ask" misread UTC times as local; sources now show local times.
- [ ] Extraction accuracy on a full day of real capture (precision/recall); one smoke test isn't an eval.
- [ ] Windows agent on a real machine: Chrome, Edge, Slack, Teams, WhatsApp desktop, Outlook (classic and new).
- [ ] Web app at real phone width (headless Chrome couldn't render narrower than about 500px) and voice on iOS Safari over HTTPS.

## Next (in order)
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
8. **Desktop app shell (Tauri):** tray icon, onboarding, permission prompts, pause button, exclusions UI. Bundle the
   agents as sidecars. Code-sign (Apple notarization, Windows EV cert).
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
