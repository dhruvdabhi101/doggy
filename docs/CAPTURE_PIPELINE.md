# Capture pipeline: from screen text to items

This is how screen text from the desktop agents becomes tasks, and which gates decide whether a model call
happens at all. Read it before you change `server/src/capture.ts`, `sources.ts`, `lanes.ts`, `pipeline.ts` or
`usage.ts`.

## The problem

Observed on 2026-11-02, 12:49 to 14:58 IST, on one Mac. The agent sent 604 capture events. The server made about
143 Haiku calls. Four tasks were kept. Most events came from X, YouTube and WhatsApp Web.

Three things caused it.

- The agent diffs lines per app and window title. Titles change all the time ("(3) WhatsApp", "(2) Home / X"), so
  the agent re-sends text that is still on screen.
- The server ran one extraction per app and window episode. Every title change started a new episode and a new call.
- Feeds never carry the user's commitments, yet they were read like chats.

The total Claude budget is $100 and more users are about to join. The goal is far fewer calls and tokens without
missing real commitments.

We do not gate on keywords. A regex like the old `TASK_RE` misses "can we push the review to Thursday?" and passes
every tweet that says "please". The gates below look at where text came from and whether it is new, never at what
it says. The model still decides what is a task.

## Flow

```
agent ─POST /api/capture─▶ parse ─▶ classify source ─▶ drop lines seen for this source ─▶ captures (pending)
                                                                                               │
worker every 10s ◀─────────────────────────────────────────────────────────────────────────────┘
  group pending captures into episodes per (user, device, source key, window)
  lane per source: user override, else adaptive demotion, else kind default
  skip lane            ─▶ SKIPPED (own, feed, user_off), no call
  fast or slow, ready  ─▶ pack the user's ready episodes into calls of ~24k chars
                       ─▶ one extract() per pack ─▶ item guards ─▶ items
                       ─▶ llm_usage and source_stats updated
```

The agents did not change. Everything here runs on the server.

## The gates

### 1. Seen-line dedupe at ingest

`POST /api/capture` splits each event into lines, collapses whitespace, and hashes the lowercased line with SHA-256
(first 32 hex chars). The hash is stored in `seen_lines` per user and **scope**. The scope is the source key from
gate 2, not the window title. A title that changes from "(2) WhatsApp" to "(3) WhatsApp" keeps the same scope, so
the re-sent lines are dropped.

- Lines shorter than 8 characters are kept but never fingerprinted. "ok" and "thanks" recur in every chat.
- An event with no new line of 8 or more characters is dropped, short lines and all.
- The stored capture holds only the kept lines. The response is `{accepted, deduped}`.
- The worker deletes fingerprints older than 30 days once an hour. A line last stored more than 30 days ago can
  come back once.

### 2. Source registry

`sources.ts` holds one rule table. Each rule matches a URL host suffix (optionally with a path prefix) or a native app
(name pattern or bundle id) and names a kind. The first match wins, and path rules come before host rules. A capture
with an http(s) URL is matched on its URL, otherwise on its app.

The source key is the bundle id (or app name) for native apps. For browsers it is the host without `www.`, plus the
matched path prefix when the rule has one, so `x.com/messages` and `x.com` are separate sources.

| Kind | Examples | Default lane |
|---|---|---|
| conversation | WhatsApp, Slack, Discord, Teams, Messages, Telegram, Signal, Mail, Outlook, Spark, Gmail, x.com/messages, linkedin.com/messaging, instagram.com/direct | fast |
| document | Notion, Obsidian, Notes, Google Docs and Sheets, Linear, Jira, GitHub, Calendar, Fantastical, Google Calendar, Todoist | slow |
| unknown | anything without a rule | slow |
| feed | x.com, twitter.com, youtube.com, reddit.com, instagram.com, facebook.com, linkedin.com/feed, news.ycombinator.com, tiktok.com | skip |
| own | doggy.ruv.world, localhost, 127.0.0.1, `$DOGGY_PUBLIC_HOST`, the Doggy app | skip |

### 3. Lanes

| Lane | Ready when | Why |
|---|---|---|
| fast | the episode has been quiet for `DOGGY_EPISODE_IDLE_MS` (45s), or holds 12k chars | Chats carry most commitments, and people expect them soon |
| slow | the clock-aligned `DOGGY_SLOW_LANE_MS` window (60 min) it started in has ended, or it holds 12k chars | Documents change slowly. Every slow episode from one window is ready at the same moment, so they share one packed call |
| skip | immediately | Marked SKIPPED with a reason. No call |

The lane of a source is decided in this order.

1. The user's override in `source_prefs` (set from the Devices tab or `PUT /api/sources/:key`).
2. Adaptive demotion. A fast source with 30 or more extracted episodes and no kept items moves to slow
   (`DEMOTE_AFTER_EPISODES` in `sources.ts`). The system never promotes and never skips on its own. Only users skip.
3. The kind's default from the table above.

`source_stats` counts extracted episodes, chars sent and items kept per user and source. Skipped episodes write a
row with zero counts, so feeds still appear in the Sources list and a user can turn one on.

### 4. Usage ledger

Every model call records its usage in `llm_usage` per UTC day, user and kind (`capture`, `voice`, `text`, `ask`).
Input tokens include cache writes and cache reads.

There is no daily cap. A cap would make new screen tasks silently stop for the rest of the day, which is worse for
users than the cost it saves. Spend is controlled by the gates above and watched through the ledger. Check it with
`GET /api/usage` per user, or sum `llm_usage` on the server for everyone.

### Screen text retention

The worker deletes capture rows whose `captured_at` is older than `DOGGY_CAPTURE_RETENTION_DAYS` (default 30).
It runs that delete about once an hour, together with the fingerprint prune. The SQL does not exclude pending rows,
so a capture that is still unprocessed is deleted once it is that old. A delete trigger
keeps the capture search index in step.

Items are not affected. Each item keeps its own title and evidence quote, so the exact title and quote checks and
the near-duplicate guard keep working after the screen text that produced the item is gone. What is lost is Ask's
search over screen text older than the window, and the source link on an item older than the window.

### 5. Batched extraction

Each tick, the worker collects all ready fast and slow episodes of a user and packs them in order into calls of up
to 24k chars of source text (`CALL_MAX_CHARS`). An episode is never split. One episode sends at most its last 12k
chars. Each episode goes into the prompt as

```
<source id="N" app="…" window="…" url="…">
…lines…
</source>
```

The extraction schema has `source: integer` on every item. The pipeline uses it to set `sourceApp`, `sourceWindow`
and `sourceId` from the right episode, and drops items whose `source` is out of range. Notes still go through the
same prompt as a single `<source id="0">`.

### 6. Item guards

After extraction, an item is kept only if all of these hold.

- Confidence is at least 0.6 for captures (0.2 for notes).
- No item of this user has the same normalized title or evidence quote (`itemKeyTaken`).
- For captures only, no open or done item among the top 5 FTS hits shares 60% or more of its content words
  (token-set Jaccard after stopwords, `nearDuplicate`). Notes skip this check because the user asked for them
  directly.

The prompt also lists the 15 most recently done items as "recently completed; do not recreate".

## Capture status

`captures.processed` holds a status. `skip_reason` says why a capture was skipped.

| Value | Name | Meaning |
|---|---|---|
| 0 | PENDING | Waiting for its episode to be ready. A failed call leaves it here for the next tick |
| 1 | DONE | Extracted, or too short to extract (under 20 chars) |
| 2 | SKIPPED | Never sent. `skip_reason` is `own`, `feed` or `user_off` |

Rows from before this change hold only 0 or 1. Pending rows get their source key filled in on boot.

## Tradeoffs

- **30-day seen window.** A line seen more than 30 days ago is sent again once. Fingerprints are not refreshed when
  a line reappears, which saves a write per line.
- **Scope is the source, not the chat.** A long line repeated word for word in a second WhatsApp chat is dropped,
  because both chats share the `web.whatsapp.com` scope. A forwarded message is one example. Short lines are
  exempt.
- **Slow lane latency.** A task in a document or an unknown app can take up to an hour to appear. Users can set any
  source to Fast.
- **Feeds are off.** A real request in an X reply or a YouTube comment is missed unless the user turns that source on.
  DMs on X, LinkedIn and Instagram have their own conversation rules.
- **Batching depends on timing.** Episodes share a call only when they become ready in the same 10s tick. A user who
  works in one chat at a time still gets one call per episode.
- **Adaptive demotion uses kept items, not dismissals.** A source whose items are all dismissed still counts as
  productive.

## Tuning

| Knob | Where | Default |
|---|---|---|
| Fast lane quiet time | `DOGGY_EPISODE_IDLE_MS` | 45000 |
| Slow lane age | `DOGGY_SLOW_LANE_MS` | 3600000 |
| Days processed screen text is kept | `DOGGY_CAPTURE_RETENTION_DAYS` | 30 |
| Source rules and kind defaults | `RULES`, `KIND_LANE` in `server/src/sources.ts` | table above |
| Demotion threshold | `DEMOTE_AFTER_EPISODES` in `sources.ts` | 30 |
| Short-line cutoff, seen window | `MIN_FINGERPRINT_CHARS`, `SEEN_LINE_TTL_DAYS` in `capture.ts` | 8, 30 |
| Episode and call size | `EPISODE_MAX_CHARS`, `CALL_MAX_CHARS` in `capture.ts` | 12000, 24000 |
| Near-duplicate threshold | `NEAR_DUPLICATE_JACCARD` in `db.ts` | 0.6 |

To add a site or app, add a rule to `RULES`. Put path rules above the host rule for the same host. Run replay before
and after.

## Replay

`server/scripts/replay.ts` runs stored captures through the same pure functions the server uses (line
fingerprints, `classify`, `resolveLane`, `isReady` timing, `packEpisodes`). It makes no model calls and opens the
database read-only.

```bash
cp /var/lib/doggy/doggy.db /tmp/doggy-copy.db        # on the server; never point it at the live file
cd server && bun run replay /tmp/doggy-copy.db --from 2026-11-02T07:19:00Z --to 2026-11-02T09:28:00Z
```

It prints raw events, events left after dedupe, episodes per lane, model calls and chars sent for the old pipeline
and the new one, a per-source table, and one line per kept capture item. That line says whether the new pipeline
would still extract the item's episode, or would skip it (feed, own, user off) or drop it as already seen.

Approximations. The worker tick is a 10s bucket. Adaptive demotion is not modelled. Current user
overrides apply to all history. A database written by the new server already holds deduped captures, so its
"after dedupe" count equals the raw count.

A synthetic fixture of 605 events in the same 2h10m window (interleaved X feed, YouTube, a WhatsApp chat re-sent
under changing titles, Slack, one Notion doc) gave these numbers. They show the shape, not production savings.

```
raw events                605
events after dedupe       413
episodes per lane         fast 180, slow 1, skip 232
model calls  old 575      new 173
chars sent   old 377573   new 7880
```

Run it on a copy of the production database to get the real numbers for 2026-11-02.

## Measured on production data (2 November 2026)

`bun run replay` on a copy of the production database, all 868 capture events of the day:

| | Old pipeline | New pipeline |
|---|---|---|
| Model calls | 215 | 68 |
| Source characters sent | 545,125 | 287,179 |

All three real tasks from WhatsApp are still extracted. The fourth kept item came from Doggy's own page, which is now skipped on purpose.

Clock-aligned slow windows did most of the call reduction. Before them, each slow episode became ready 60 minutes after its own first capture, so slow episodes rarely shared a call, and the same data needed 121 calls. Every call also carries the system prompt and the user's open and recently done items, so fewer calls cut tokens even when the source text is the same.

The replay does not model adaptive demotion.
