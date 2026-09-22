# Connection resilience

The voice console survives a lost connection on its own: the browser client
reconnects automatically with exponential backoff, shows exactly what is
happening while it does, and offers a **Reconnect now** button to force an
immediate attempt. This page documents the behavior, its knobs, and how to
verify it.

## What the user sees

| Situation | Status line (`#state`) | Detail |
| --- | --- | --- |
| Link lost, retrying | `Connection lost — reconnecting (attempt 3, next in 4s)` (amber, pulsing) | "The voice link dropped. In-flight audio was lost." |
| Gateway process down | `Gateway not reachable — retrying; press Reconnect now to force (attempt 5, next in 8s)` (red, pulsing) | "The gateway did not answer. Attempts continue automatically." |
| Gateway up, speech pipeline (s2s) down | `Voice pipeline down — reconnecting (attempt 2, next in 2.5s)` (amber) | "The gateway is up, but its speech-to-speech link is not answering yet." |
| Attempt in progress | `Reconnecting — attempt 4 in progress…` | — |
| Recovered | previous state line returns (`Listening` / `Reconnected`) | "Reconnected. In-flight audio was lost." |

The **Reconnect now** button appears next to the status line whenever a retry
cycle is active (including while the gateway is genuinely down — it stays
available and every press forces an immediate attempt). Pressing it resets the
backoff clock, closes any half-open socket, and reconnects at once.

Every transition is logged with a timestamp in three places: the browser
console (`[hermes-live] HH:MM:SS …`), the on-screen conversation transcript /
log drawer (`⟳ …` system rows), and the supervisor's in-memory attempt history
(`window.__entity.supervisor.status.history` with `?dev=1`).

## What is preserved and what is lost

- **Preserved** — the session re-attaches to the same durable conversation
  (`persistent` mode), and the task inbox is re-hydrated from the gateway's
  reconnect snapshots (`task.snapshot` frames with reason `reconnect`,
  including every active task and unread notification; see
  [background-tasks.md](background-tasks.md)).
- **Preserved** — the microphone stays warm: capture frames buffer in preroll
  while disconnected and resume the moment the link returns, without a new
  permission prompt.
- **Lost** — any utterance audio that was in flight when the link dropped.
  The UI says so explicitly ("In-flight audio was lost") instead of failing
  silently. Finish the sentence again after recovery.

## Retry policy

`clients/browser/connection-supervisor.js` owns the policy on top of the
client SDK's existing loss reporting (`connection_lost`) and reconnect
hydration:

- **Fast first retry**: attempt 1 after a loss fires after exactly the base
  delay (default **1s**), so a brief gateway blip heals before it is noticed.
- **Exponential backoff with full jitter**: attempt *N* draws uniformly from
  `[base/2, min(cap, base · factor^(N-1)))` — defaults `factor 2`, `cap 30s`.
  The half-base floor keeps a dead network from spinning.
- **Retries continue indefinitely.** A dead network never kills the agent;
  the visible attempt counter and the button keep the user in control.
- **Backoff resets on success**: every successful connection restarts the
  clock, so the next outage again begins with the 1s fast retry.
- **One socket, always.** An in-flight attempt is never raced by the timer or
  by the button (a forced press during an in-flight attempt keeps it and only
  resets the clock); a half-open socket is torn down (bounded 2s wait) before
  a forced reconnect opens the next one.

Knobs (constructor options on `ConnectionSupervisor`): `baseDelayMs`,
`factor`, `maxDelayMs`; `conversation` (passed to each `client.connect`);
`fetchStatus` (probe used to distinguish gateway-down from pipeline-down);
`now` / `schedule` / `cancel` / `random` for deterministic tests.

## Disabling auto-reconnect

Load the console with `#no-reconnect` or `?no-reconnect=1` to restore the
previous single-shot behavior: one connection attempt (plus the historical
one-shot retry), no automatic retries, no button, and the audio pipeline
tears itself down on close as before. This is the escape hatch if an
operator ever needs the old failure semantics.

## Gateway side

### Browser ↔ gateway

Nothing new: the browser's reconnect re-runs the normal `session.start`
handshake. A dropped browser socket tears down that gateway session (background
tasks keep running server-side and re-hydrate the next connection).

### Gateway ↔ speech-to-speech (s2s)

The gateway attaches **one provider session per browser session** and does not
pool or re-attach links on its own. When the s2s link drops (for example the
`hermes-s2s` service restarting, or the brain-failover controller switching
models — see [brain-failover.md](brain-failover.md)):

1. The gateway logs `realtime provider session closed` and closes the browser
   socket with `1011` (`realtime_provider_closed`, recoverable).
2. The browser enters its reconnect cycle. While s2s is still down, each
   attempt fails at session start; `/status.json` reports the s2s probe as
   unreachable and the UI shows **Voice pipeline down**.
3. When s2s is back, the next attempt attaches a **fresh provider session**
   (gateway logs `realtime provider attached`) and speech resumes.

Recovery is therefore client-driven by design: a reconnecting browser is what
re-attaches the pipeline, which keeps the single s2s slot free for exactly one
live session.

### `GET /status.json`

Unauthenticated connection-health endpoint (a sibling of `/health`) that the
reconnecting page polls:

```json
{
  "ts": 1790075957760,
  "status": "ok",
  "service": "dev.hermes-live-voice.gateway",
  "uptimeMs": 61234,
  "provider": { "name": "local", "model": "…" },
  "sessions": { "browser": 1, "providerAttached": 1, "providerStarting": 0 },
  "providerLinks": [
    { "state": "attached", "provider": "local", "model": "…", "attachedMsAgo": 412, "detachedMsAgo": null, "lastDetach": null }
  ],
  "providerProbe": { "reachable": true, "latencyMs": 2, "target": "http://127.0.0.1:8765", "checkedAt": 1790075957758 }
}
```

`providerProbe` is a cheap HTTP reachability check of the speech-to-speech
origin (cached ~2s per target so polling cannot amplify it). Any HTTP answer
counts as reachable; only refused/timed-out connections report `false`. The
`mock`/`gemini` providers have no probe target and report `null`.

Gateway log lines to grep during incidents: `realtime provider attached`,
`realtime provider session closed` (with `providerCode`), `live session error`
(`realtime_provider_closed` / `session_start_failed`).

## How to test

- **Unit (deterministic, fake clock + fake sockets)**:
  `npx vitest run test/connection-supervisor.test.ts` — backoff sequence and
  cap, state transitions, the no-double-socket guard, force-reconnect racing
  the auto-retry, backoff reset on success, reconnect-snapshot re-hydration,
  and the gateway-status probe. Gateway side: `test/live-websocket.test.ts`
  covers `/status.json`, the attach/detach lifecycle, and the fresh-attach
  after an s2s restart.
- **E2E (real page, hermetic drop)**: `npm run test:e2e` includes
  *"a dropped connection visibly reconnects with backoff and re-arms the
  microphone"*.
- **Full live drill (kill real processes, headless chromium)**:

  ```bash
  npm run build && node scripts/reconnect-drill.mjs
  ```

  Spins a throwaway gateway (port 4601), fake s2s (4602), and fake Hermes
  (4610) — never the live services — then: connects the browser, SIGKILLs the
  gateway mid-session, presses **Reconnect now** during the backoff wait,
  relaunches the gateway on the same port, kills the fake s2s, and restarts
  it. Screenshots and a JSON evidence summary land in `/tmp/reconnect-drill/`.

  Note: a SIGKILLed gateway leaves a stale task-store lock
  (`tasks-v1.json.lock/`); the drill clears it exactly like the documented
  `hermes-live tasks unlock --confirm-no-gateway` runbook step before
  relaunching.
