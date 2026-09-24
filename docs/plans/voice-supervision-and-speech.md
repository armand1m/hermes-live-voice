# Voice supervision and speech: reliable delegation, truthful progress, natural speech

Status: active plan. Source investigation: [`NEXTIMPROVEMENTS.md`](../../NEXTIMPROVEMENTS.md) (September 23–24, 2026).
Integration baseline: commit `82f6303` (Riva migration + protocol v11 WIP, tests repaired, suite green: 992 passed / 1 skipped, typecheck clean).

**Stage 1 (immediate correctness) is complete** — commits `2cfc3b8` (rolling retention + freshness), `7a6f028` (queue placement + stall review), `2168df5` (narration circuit breaker), `c7ca14d` (universal spoken-content preparation), `9ae639f` (SSE reconnect), `72e53d3` (Riva tool-history integrity + repo-check repairs). Suite: 1020 passed / 1 skipped, 5 e2e, typecheck and all repo checks green.

**Stage 2 (durable supervision) is complete** — commits `c90d6f9` (contracts: watch registry, delegated phase, agent ports), `7c7c7f6` (herdr adapter over local + mssh), `3b5f135` (durable external-agent monitor), `8502c47` (gateway wiring: voice tools, task linkage), `e83b63d` (progress policy announcements + check-ins), `b2e4f66` (idempotent delegation launch bridge + `hermes_delegate_work` plugin tool). Suite: 1051 passed / 1 skipped, typecheck, build, and all repo checks green. Everything is behind `HERMES_LIVE_EXTERNAL_WORK_ENABLED` (+ `HERMES_LIVE_PROGRESS_ANNOUNCEMENTS` for speech) and **not yet deployed or exercised against the live hosts** — a local canary with a real herdr agent is the next step before enabling it on exodia. Stage 3 (measured ASR/TTS improvements: word boosting, endpointing experiments, optional sentence buffering) remains.

## Problem

The gateway supervises Hermes runs, but it cannot reliably follow the external work Hermes delegates, and what it tells the voice user often overstates or understates reality. Observed on September 23 (times Europe/Amsterdam):

- **One task blocks three others.** A diamond-indicator task started at 17:44; archive, persona lookup, and Mac mini inspection stayed queued behind it. Even status inspection waits behind implementation work.
- **Progress reporting stops permanently after 64 events.** The diamond task ended at sequence 67 (3 lifecycle + 64 progress events) while Hermes kept working through ~20:58 (150 assistant messages, 170 tool messages, polls returning 200). The task log looks frozen.
- **Activity is not progress.** Late task messages repeatedly re-investigate the same visualizer/response-mask question.
- **Delegation intent is lost.** The user asked for a herdr agent for the diamond fix; the persisted task input told Hermes to investigate and fix directly. "Same machine" drifted to a hardcoded Mac mini. A queued task was announced as "I just spun up that task".
- **Status answers conflate states.** "3 background tasks are active" mixed queued and running work.
- **Completion speech lacks substance.** `notificationDigest()` announced that a result exists in the inbox; the user had to ask again.
- **Markdown can reach speech.** Riva synthesizes model content and `spoken_response` directly; deferred cleanup leaves emphasis, headings, links, tables incompletely handled.
- **Delivery is recorded too early.** Riva notification submission queues speech and returns; the gateway then records `announcedAt`. Synthesis failure or interruption can leave an unheard notification marked announced.
- **Task-log narration can stay unavailable.** Ten narration failures in one journal; failed revisions are quarantined for 24 hours, so reopening the log cannot recover promptly.

Transcription samples also show repeated sentences, fragmented turns, and unstable recognition of names (herdr, exodia). These are symptoms; without synchronized source audio they do not establish whether recognition, endpointing, echo, or transcript assembly caused each occurrence.

The task-log narrator is a separate display-oriented service that intentionally produces Markdown. It stays separate from speech preparation.

## Target architecture

```
                Durable task/work registry
                 ↙                    ↘
       Hermes run supervisor    External-work monitor
                 ↓                    ↓
              Hermes             herdr on exodia / Mac mini
                 ↘                    ↙
                  Structured observations
                           ↓
        Progress policy and notification outbox
                           ↓
      Spoken-content preparation → speech scheduler
                           ↓
                 Riva → browser
```

Hermes remains the reasoning and execution agent. The gateway owns observation, scheduling updates, freshness, and delivery.

## Already landed in the baseline

- Protocol v11: `speech.playback` client confirmation (playing → delivered), response scopes (`conversation` / `task_notification`), `notificationId` correlation, `session.demoted`, deferred-answer signals. Browser client sends playback status; gateway marks `announcedAt` only after playback confirmation on v11 (legacy clients keep provider-accepted semantics).
- Truthful receipts: queued vs Hermes-accepted wording in `start_background_task` spoken responses.
- Substantive `notificationDigest()`: task title + bounded result excerpt instead of "a result exists".
- `taskInboxSpokenSummary()` distinguishing queued/running/finished.
- `PlaybackDelivery` correlation helper; `TaskDelegation` domain contract (host, harness, repository, objective, acceptance criteria) — unused so far.
- Riva adapter: echo guard, transcript-part merging, ASR reconnect, think-block stripping, full-utterance TTS buffering.

## Implementation stages

### Stage 1 — immediate correctness — COMPLETE

1. **Rolling progress retention** (`task-supervisor.ts`, `domain/tasks/task.ts`): replace the lifetime `MAX_PROGRESS_EVENTS_PER_TASK = 64` cutoff with bounded rolling retention. Latest activity keeps updating for the whole task lifetime; lifecycle events are never evicted; sequences stay monotonic. Track `lastObservedAt`, `lastActivityAt`, `lastMeaningfulProgressAt` separately — a successful poll proves connectivity, not progress. Coalesce repeated activity persistence to ≥1/s; lifecycle changes persist immediately. Preserve bounded tool identity and file/operation context across start/completion pairs.
2. **Truthful queue reporting**: expose queue position and blocking task/reason; task summaries distinguish queued / running / delegated / blocked / uncertain / completed. Ten minutes without meaningful progress flags "needs review" with evidence and duration — no automatic stop or restart.
3. **Narration circuit breaker** (`task-narration.service.ts`): bound the full HTTP request including body decoding; cap successful and failed caches; replace the 24-hour revision quarantine with a breaker retrying after 60 s, backing off to 5 min. Structured facts always render immediately; narration is optional presentation.
4. **Universal spoken-content preparation** (`SpeechContentService`): one deterministic cleanup at every TTS boundary (direct replies, tool receipts, deferred answers, notifications, sidecar). Strip Markdown structure/emphasis/HTML/reasoning blocks/control characters; keep link labels, drop raw URLs; lists → sentences; code blocks and dense tables → short "details on screen" cue; preserve negation, quantities, units, names. Spoken transcript and echo-guard input match the prepared speech. Complex answers may use a tool-free spoken-summary request (2 s total deadline, one concurrent) with cleaned-source fallback plus truncation cue; receipts and routine updates use templates only.
5. **SSE reconnect**: reconnect an interrupted Hermes event subscription with bounded backoff while status polling continues. One gateway subscription per run; the upstream SSE implementation consumes a shared queue.
6. **Riva tool-history integrity**: keep complete tool-call/result groups in bounded history (`MAX_HISTORY` trimming must not split exchanges); collect all results before continuation; settle invalid calls explicitly; interrupted generations must not speak queued stale responses.

### Stage 2 — durable supervision

- **herdr bridge**: fixed hosts (exodia, mac-mini); `ExternalAgentPort` (discovery, inspection, bounded recent-output reads) over native herdr JSON; recent terminal text is evidence, never completion proof. Durable watch records (watch id, owner, conversation, linked task, host/workspace/pane/session identity, objective, acceptance criteria, status, timestamps, monitoring health). Identity = host + harness session + pane; pane reuse must not silently re-attach a watch to different work.
- **Monitoring policy**: watch delegated + explicitly selected agents; poll 5 s, batch discovery per host; ≤80 recent lines on state change; one observation command per host, 20 s deadline; back off failures to 60 s, stale/offline after 3 consecutive failures; survive browser disconnects and gateway restarts; idle means "outcome needs inspection", not completed; inspect and report only — never prompt, retry, stop, or restart without user direction. Monitoring commands run independently of Hermes's implementation queue.
- **Delegation handoff**: extend task creation with the `TaskDelegation` metadata (already in the domain); resolve "same machine" from the referenced task or project context, ask only when ambiguous; Hermes plugin bridge tool persists intent (idempotency key) → launches harness → registers agent identity → returns verified receipt. Uncertain launches reconcile against herdr before retrying; never duplicate agents. External execution becomes a delegated task phase that releases the Hermes slot while the gateway monitors; mutation reservations stay per host/repository/worktree.
- **Progress policy + notification outbox**: one server-owned policy for voice sessions and task UI. Announce launch, milestones, blockers, terminal outcomes, monitoring loss/recovery; two-minute check-in while tracked work is active; coalesce tasks into one update; suppress superseded messages; say when there is no new evidence; never invent percentages. Defer speech while the user is speaking. Delivery states: pending → queued → synthesizing → playing → delivered / interrupted / failed (extending the v11 playback path). On reconnect offer a digest, not a replay.

### Stage 3 — measured speech improvements

- Configurable ASR word boosting (Hermes, herdr, exodia, Mac mini, project names).
- ASR result correlation by item/content identity and finality; partial transcripts for display only, tools dispatch on finalization only.
- Endpointing changes validated against recorded audio before changing silence defaults.
- Sentence-sized buffered synthesis and text-flushing controls behind a feature flag, after measuring first-audio latency; pronunciation dictionaries where supported. Keep full-utterance buffering as the default until measurements justify otherwise.

## Validation

Required regression scenarios (beyond the current 992-test suite):

- >200 progress events: latest activity keeps updating, retention stays bounded.
- Long implementation task running: local and remote herdr status checks complete independently.
- "Launch herdr on exodia" retains host+harness; "same machine" preserves its reference.
- Queued work is never announced as launched.
- Launch timeout after acceptance: reconciliation finds the existing agent without duplication.
- Browser disconnect, gateway restart, SSH failure, pane reuse preserve ownership and freshness.
- Idle/blocked/missing/unreachable agents stay distinguishable from completed.
- Repeated tool calls without meaningful progress → review warning, no automatic intervention.
- Every TTS entry point removes Markdown and preserves factual meaning (fixtures).
- Multiple tool calls, malformed arguments, history trimming, interruption, delayed results cannot orphan tool exchanges or emit stale speech.
- Notification synthesis failure or playback interruption stays undelivered and recovers.
- Two open clients get one spoken announcement through the active voice session.
- Narration timeout leaves raw facts visible and recovers after the breaker interval.
- ASR replay fixtures: domain names, repeated phrases, self-correction, background speech, echo.

Acceptance targets: healthy-host state changes visible ≤10 s; milestone speech begins ≤15 s when voice idle; two-minute check-ins within 15 s of eligibility; monitoring never waits on a Hermes implementation slot; no Markdown fixture reaches TTS unsanitized; no notification marked heard because synthesis was queued; observe-only monitoring never prompts/cancels/restarts.

## Rollout rules

- Keep every existing protocol version working; new fields/events only to v11 clients.
- Migrate the task store with a backup and explicit version check; rollback restores the backup.
- Package the Hermes bridge reproducibly in this repository, not as edits to the installed Hermes checkout.
- Monitor and announcement policy behind independent flags; Riva buffering unchanged until measured.
- Treat recorded task/transcript text as evidence, never instructions.

## Agreed defaults and investigation limits

- Monitor delegated and explicitly watched agents; report milestones; two-minute check-ins; inspect stalls but never autonomously prompt or restart.
- Keep Riva and the existing gateway; no ACE framework migration.
- Preserve conflicting-write safeguards; allow independent observation without mutation reservations.
- The September 23 diamond task is not claimed dead (transcript shows continued repetitive activity); individual transcription errors are not attributed to ASR without synchronized audio; no tasks were stopped and nothing deployed as part of the analysis.
