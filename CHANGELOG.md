# Changelog

## Unreleased

- Make Hermes an orchestrator. `start_background_task` now defaults to delegation: Hermes gets orchestrator instructions for the task (resolve the machine and repository from the user's words, write a self-contained brief with acceptance criteria), then hands the work to a herdr coding agent through the newly registered `hermes_delegate_work` plugin tool. The gateway launches the agent unattended, links it to the task, and monitors it; the task enters the delegated phase within seconds. `work: "quick_check"` keeps short read-only lookups in Hermes. Both kinds are short Hermes runs admitted in parallel instead of queueing behind each other.
- Launch delegated agents with per-host defaults: `claude-glm` on exodia and `claude` on the Mac mini (`HERMES_LIVE_DELEGATION_AGENTS`), or `codex` on request. Each runs with its kind's unattended flag; before this, agents stopped at their first permission prompt. `claude-glm` loads the z.ai provider environment from the operator's wrapper inside the pane, so the credential never appears on a command line.
- Shorten task receipts to one line ("On it — Hermes will brief a coding agent for that." / "Checking now.") and announce a start only after a real wait. A "queued" promise followed seconds later by "has started" was padding.
- Fix delegation handoffs with multi-line briefs: the watch's first event summary is now kept to one line, where it used to fail after the agent had already launched.

- Re-frame the LAYA shadow questions and read the user's mood. An offline re-test showed the original single 4-way route question over a free-text state scored at chance. One yes/no question per intent over `{"utterance": …}`, phrased like LAYA's own presets, scored AUC 0.84–0.92 at about half the latency. The shadow now asks two calls per turn: mood (`small_talk`, a 0–3 `frustration` score, a `mood` word), then intents (`new_work`, `task_status`, `recall`, `remember`). It also classifies typed turns, and `analyze_shadow.py` reports per-intent AUC for the new `schema: 2` rows. The latest mood appears in the diagnostics overlay (`mood` row, `userMood` in `GET /v1/metrics`), next to a new `eot` row for the end-of-turn silence wait. With `HERMES_LIVE_LAYA_MOOD_STEERING`, a frustrated, stressed, or confused previous message adds a one-line hint to the voice brain's next turn.

- Add an endpointing tuning loop ([docs/vad-tuning.md](docs/vad-tuning.md)). `HERMES_LIVE_VAD_RECORDING` (default off) records what the speech gate heard in each voice session: frames with arrival times, per-chunk probabilities, decisions, echo-window changes, and transcripts. Recordings are local and owner-only, pruned by age and size. `hermes-live vad replay` runs the recordings through the real gate and Silero model on a virtual clock with a grid of stop/tail settings, and ranks them by turns, split turns, silence wait, and clipped speech against the live settings. `GET /v1/metrics` now reports `silenceWait` p50/p95 and `gateStops`/`gateResumes`.

- Add opt-in post-session learning (`HERMES_LIVE_KNOWLEDGE_REFLECTION`, default off). After a voice session with at least four user turns, one quiet Hermes run (not a supervised task: no inbox entry, no announcement) reviews the bounded transcript and updates memory and skills with Hermes' own tools, treating the transcript as data. Voice turns bypass Hermes, so its learning loop otherwise never sees them.

- Add a local knowledge index for fast recall (`HERMES_LIVE_KNOWLEDGE_INDEX`, default on). It is an SQLite FTS5 file (node:sqlite, Node ≥ 22.5; off automatically elsewhere), created owner-only next to the task state, covering finished tasks, Hermes session titles and previews, the skills catalog, and memory entries. `search_past_chats` answers from strong local matches in about a millisecond and falls back to the full Hermes recall turn on a miss or with `deep: true`. `HERMES_LIVE_KNOWLEDGE_TURN_CONTEXT` (default off) adds strong matches as bounded reference context to each Riva brain turn.
- Add `suggest_work`, deterministic suggestions from the owner's own history: delegated work an agent reports done, stalled runs, recent failures nobody followed up, unread results, and requests repeated on several days. Suggestions are offers only.
- Hold a delegated task's explicitly declared resources against conflicting admission; the implicit shared `workspace:default` key never blocks.

- Speak progress on running Hermes tasks (with `HERMES_LIVE_PROGRESS_ANNOUNCEMENTS` on). A task the session saw queued is announced when it starts; a long run reports its latest recorded step at most every four minutes; a run with no new activity is called out once. Template-only, lowest priority behind answers, external updates, and terminal notices.
- Add `resolve_delegated_task`, so the owner can close a delegated task as completed or failed by voice after checking the external agent's work. Monitoring still never closes delegated work on its own. The confirmed outcome counts as already heard, so it is not re-announced. A linked agent's "reports done" announcement now says how to close the task.
- Catch a reconnecting voice session up on watched-agent states that changed while no session was connected, once per unspoken update.
- Break down the console's task status line by state ("2 running · 1 queued · 1 delegated · 1 needs review") instead of "Running · N".

- Speak streamed Riva answers sentence by sentence. With `HERMES_LIVE_RIVA_BRAIN_STREAMING` on, the brain call streams over SSE and each finished sentence is synthesized while generation continues. Every sentence is still emitted only after complete synthesis, so there are no mid-word underruns. Reasoning blocks are stripped across chunk boundaries, and streamed tool calls are assembled into the usual shape. Measured first audio on a four-sentence answer dropped from 6.9 s to 2.9 s. `HERMES_LIVE_RIVA_BRAIN_PREWARM` (default on) prefills each session's prompt into the SGLang prefix cache; `HERMES_LIVE_RIVA_BRAIN_THINKING=false` disables the reasoning phase.
- Measure per-stage turn latency. Each voice or typed turn logs a `turn latency` line: endpoint, ASR, brain, TTS, response, and total, where applicable. `GET /v1/metrics` reports p50/p95 per stage under `turnLatency`.
- Send the configured ASR word boost to Riva. `HERMES_LIVE_RIVA_ASR_WORD_BOOST` was parsed but never reached the NIM. The new `HERMES_LIVE_RIVA_ASR_WORD_BOOST_SCORE` (default 30) sets the weight, and both keys are allow-listed in managed config.
- Fix the half-duplex echo window. The playback-drain deadline now accumulates across a TTS burst; each 200 ms chunk used to reset it, so echo could leak in while the reply was still playing.
- Record external-agent announcements only after they are heard. Monitor claims are now in-memory speaker leases. Delivery is recorded after playback, failed speech is retried within the notification budget, a bounded key history prevents repeats, and sessions only speak their own owner's watches.
- Ship only the bare `herdr` name to remote hosts over mssh, so the local absolute path is never embedded in the remote command.

- Summarize the task log through the gateway's own LLM. A new authenticated `POST /v1/task-narration` route resolves a task record from the gateway's owner inbox (the client only sends the task id — never the content being summarized) and asks the configured OpenAI-compatible LLM (`HERMES_LIVE_NARRATOR_URL`, e.g. the local sglang qwen3.8-27b already serving the voice stack; unset answers `503`) for a concise markdown rewrite of the record under rules that forbid inventing facts and keep commands, paths, and numbers verbatim. Summaries are cached server-side per `taskId:sequence:updatedAt` (bounded FIFO, in-flight dedupe — a revision summarizes exactly once no matter how many clients or drawer opens ask), the LLM call is bounded in tokens and wall time and strips thinking-model `<think>` blocks, and the route follows the page's subpath mount with the same bearer auth as the WebSocket. The browser's task drawer shows a soft "restructuring…" line while the fetch is in flight, then renders the returned markdown with a "restructured by `<model>`" mark in the entry meta; the client keeps its own revision cache, races a deadline so a hung request can never wedge an entry, negative-caches failures briefly, and short-circuits to raw text when the route answers 503. Opt out per tab with `?no-ai=1` / `#no-ai`. The markdown renders through a new dependency-free vendored renderer (`clients/browser/markdown.js`) instead of react-markdown — the page ships as plain local ES modules with no bundler, so React would cost it the fully-local, offline-first character it has; the renderer builds DOM via createElement/textContent only (source HTML can never execute, matching react-markdown's safety by construction) and covers headings, bold/italic with CommonMark-style guards, inline and fenced code, nested lists, quotes, rules, and safe-scheme links.

- Add a Task log drawer to the voice console. A "Task log" toggle now sits beside the conversation-log button in the top-right corner (both buttons stay anchored there whether their drawer is open or closed — the conversation toggle no longer jumps to a new position when opened), with a live accent pulse on the task toggle while background work is running. The drawer renders one durable entry per task from the client's reconciled task snapshot — state glyph and label, title, creation clock time, running/total duration, follow-up lineage, latest progress message, error, result summary and bounded output — plus a Stop action for queued/running tasks and a "Load output" action that fetches retained output via `task.get` when a snapshot omitted it. Opening one drawer closes the other (they share the right rail); Escape still closes whichever is open.

- Give the voice console interface sound cues (Arwes-style synthesized bleeps, pure Web Audio — no assets). The palette mirrors the entity's own state vocabulary — connected/disconnected, error, thinking, tool, waiting, speaking, paused, a gentle "over to you" when a turn ends with the mic live, satisfied/uncertain expressions, mic mute/unmute chirps, and task start/tick cues — so pinning a state in the `?dev=1` playground plays its sound. Cues ride a dedicated page-lifetime AudioContext (they survive playback teardown and never touch the lipsync analyser), duck under the assistant's voice, collapse bursts with per-sound refractory windows, and stay under 160 ms so echo cancellation treats them like any speaker output. On by default; opt out with `?no-sfx=1` / `#no-sfx`. Sound preferences persist in localStorage.
- Let the agent control browser audio by voice (protocol v9). A new `set_client_audio` tool — advertised to the provider, described in the system instructions, and matched by the local-stack EN/ES/CA regex router — asks the client to resume or pause the microphone after a pause and to turn the interface sound effects on/off or set their volume (0–1). The gateway relays it as an advisory `client.audio_settings` message (fire-and-forget like `input.pause_requested`: the client stays authoritative over its own hardware), the browser applies it, persists the preference, confirms audibly, and logs a `♪` system transcript row; a tab booted with `?no-sfx=1` stays silent regardless. `GET /v1/capabilities` advertises `client_audio_control`.
- Make tool calls non-blocking for live conversation. `continue_hermes_conversation` and `search_past_chats` now return an instant spoken receipt (`deferred: true`) and stream the real answer from Hermes' `/chat/stream` SSE, speaking it at the next idle gap — the held-input window collapses from the full chat timeout to milliseconds (`HERMES_LIVE_ASYNC_TOOLS_ENABLED=0` restores blocking behavior). Deferred answers that cannot be delivered after 20s escalate with an "answer ready" filler clip, and pending speech older than `HERMES_LIVE_ANNOUNCE_MAX_DELAY_MS` (default 90s) is forced into the next inter-turn gap instead of waiting on a wedged idle gate.
- Add a filler side-channel so slow work is never silence: pre-recorded clips in the same Qwen3-TTS Aiden voice (`assets/filler/`, generated by `scripts/generate-filler-clips.py` on the voice-stack venv) stream to the client as ordinary `audio.output` frames ~2.5s after a tool call starts and every ~15s after, max three per wait. Barge-in, provider speech, and receipt delivery stop a clip instantly; held audio now runs through the speech gate so the gateway detects the user speaking during tool waits (`HERMES_LIVE_FILLER_*` settings; `HERMES_LIVE_FILLER_ENABLED=0` disables).
- Add a gateway TTS sidecar (`services/tts-sidecar/`, FastAPI wrapping the same Qwen3-TTS GGML engine on 127.0.0.1:8766, systemd unit included). With `HERMES_LIVE_TTS_URL` set, tool receipts and deferred Hermes answers — including sentence-by-sentence speech as `/chat/stream` deltas arrive — are synthesized without any provider-LLM round-trip and keep working while the provider pipeline is stalled; a 60s cooldown on failure falls back silently to the provider exact-speech path. Unset the URL to disable.
- Keep live sessions alive and reap zombies: client↔gateway and gateway↔speech-to-speech WebSockets now ping every 15s and terminate after two missed pongs (`HERMES_LIVE_WS_KEEPALIVE_MS=0` disables), so a vanished client (sleep/roam) no longer bricks the single provider pipeline slot with 503s until restart.
- Extend the diagnostics overlay and `GET /v1/metrics` with speech-wait telemetry: tool-call → first-speech latency and task-completion → spoken-announcement delay (p50/p95 each) plus filler injection counts.
- Add an always-on voice diagnostics overlay to the browser console (top-right, recedes with the entity modes, opt out with `?no-diagnostics=1`). It measures end-of-utterance → first TTS frame latency and TTS inter-frame arrival jitter (median/p95/worst), playback underruns and stalls, and render FPS on the client, and polls a new authenticated `GET /v1/metrics` on the gateway for gateway CPU, event-loop lag, host load, the upstream `speech-to-speech serve` process CPU (resolved from `/proc`, no new dependencies), and the server-side audio emit cadence. A verdict line attributes stutter heuristically to the server (gateway/voice-stack CPU), the client (browser/device), or the transport, with the raw numbers shown beside it. The metrics endpoint follows the page's subpath mount (e.g. `/voice/v1/metrics` through Tailscale Serve) and the same auth as `/ready`.

- Give the FaceKit 3D head its full expression rig back. Every controller spring now reaches the model: the eyeballs physically rotate in their sockets toward the gaze springs (with micro-saccades, eyes leading the lagging head), lids follow the blink scheduler plus the `lidOpen` expression channel, brows read `browRaise`/`browFurrow` through stronger blendshape gains, the head nods with real speech energy and inhales on utterance capture, and disruption hitches the shader's sense of time with a surface jitter. State colour finally touches the scan: the mixed accent (teal → amber while reasoning, coral on error) tints the rim, scan lines, sweep, point cloud and — strongest — the irises, while the pupil dilates with interest and constricts with focus. Tool packets stay in frame: anchors moved from the far periphery to just beside the head, clamp per-frame to the visible frustum on narrow viewports, and their label chips clamp to the viewport edge without sliding over the face.
- Sync lipsync to the words actually being said. A new `TextVisemeScheduler` converts assistant transcript text into a grapheme→viseme unit queue (bilabials close, rounded vowels purse, fricatives show teeth) played back at speech rate with amplitude gated by the live output-audio envelope — text shapes the mouth, audio paces and scales it — and blended over the audio-only estimator, which reads as generic flapping by comparison. The mouth rig also honours the `press`/`teeth` channels that were previously dropped, and the jaw aperture is tuned to a restrained conversational parting (vowels part the lips rather than gape; lip-shape channels carry most of the articulation).

- Give the voice agent persistent memory (protocol v8). Every session now opens with a bounded context digest — Hermes' USER.md/MEMORY.md, recent conversation titles, and the skills catalog — framed as reference data the model may read but never obey. The browser binds a durable per-user voice thread (`conversation.mode: "persistent"`, resumed across tabs, restarts, and devices; degrades to unbound on Hermes installs without session continuity). Two new tools bridge knowledge on demand: `search_past_chats(query)` runs a Hermes `session_search` turn on a dedicated recall session, and `remember(fact)` submits a durable Hermes run through its memory tool and approval staging, with an honest spoken receipt. Local-model regex routing gains recall/remember utterance patterns (EN/ES/CA) that take precedence over work-delegation keywords.
- Hold user speech and text while a realtime provider tool call is executing and deliver it once the tool result reaches the provider. The local speech runtime hard-fails (and drops the whole session) when a new turn arrives while a function call output is still pending — so asking "how is it going?" mid-tool disconnected the call. Held input replays in order after the tool result, bounded to the last 10 seconds, for both gated (v7) and legacy sessions.
- Detect real speech in the gateway with the bundled Silero VAD model (protocol v7) so keyboard clicks, doors, and room noise no longer interrupt the agent. Only speech the model confirms (with a stricter, longer confirmation while the agent itself is talking, guarding against speaker echo) cuts playback and cancels the response. The browser client keeps a permissive energy pre-gate for streaming and stops interrupting on raw energy. `onnxruntime-node` is an optional dependency: when it or the model is unavailable the gateway falls back to an energy detector, and `HERMES_LIVE_VAD=disabled` restores the previous client-side behavior exactly. Speech thresholds are tunable via `HERMES_LIVE_VAD_*` settings; the vendored model is Silero VAD v5.1.2 (MIT, sha256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`).
- Restore a cwd-independent browser voice console at the gateway root, automatically connect the Dashboard voice tab, and replace manual turn submission with continuous PCM VAD and mute/unmute. Preserve the authenticated Dashboard relay and existing provider/task protocol.
- Default to offline local voice and OpenAI server VAD when explicitly selected. Retry transient single-pipeline busy errors for stock local servers as well as managed runtimes.
- Add a shared canvas voice field with microphone-reactive rings, thinking particles, playback AnalyserNode spectrum petals, and reduced-motion support.
- Add synthetic PCM VAD tests, real local S2S audio contracts, ephemeral gateway-to-Hermes HTTP round trips (including the running local API), and Playwright fake-microphone browser automation to verification/CI. See [validation and configuration](docs/voice-v2.md).
- Remember a directly supplied gateway token for the current browser tab and show delegated task states in the standalone voice console.
- Add adaptive microphone noise gating and low-frequency cleanup before browser PCM reaches VAD or speech recognition.

## 1.1.3 - 2026-09-07

- Merge the pending Node 22 Docker image refresh and CodeQL action updates from dependency PRs #78 and #75.
- Resolve Zod dependency PR #77 with the 4.5.4 package while preserving Hermes Live v1's exported Zod 3 schema and error API through `zod/v3`. Declare Zod as a compatible peer so existing integrations can share their installed Zod 3 or Zod 4 package. Normal npm installs resolve the peer automatically.
- Add clean packed-package consumer checks for both supported Zod package lines, including TypeScript compilation, schema composition, metadata parsing, and validation-error identity. Native Zod 4 schemas remain a separate public API migration.

## 1.1.2 - 2026-09-07

- Correct the upgrade steps for the local voice fix: first run `npm install --global hermes-live-voice@latest`, then `hermes-live upgrade`, then restart Hermes Dashboard. The upgrade command refreshes the plugin and services from the installed package; it does not download a newer package.
- Includes the v1.1.1 fixes for silent formatted/long/error replies, saved-chat timeouts, and current Hermes Dashboard authorization. Automated validation covers 749 tests, clean package installation, Linux, Windows, Docker, and Hermes v0.20.0/v0.21.0 compatibility. Fresh live audio remains unverified; see the [validation receipt](https://github.com/bielcarpi/hermes-live-voice/blob/v1.1.2/docs/provider-receipts/2026-09-07-local-voice-v1.1.1.md).

## 1.1.1 - 2026-09-07

- Fix silent local voice replies after Hermes completes saved-chat work. Formatted, long, empty, and failed answers now use the summary response path instead of being rejected as invalid exact speech. Short plain-text answers still speak exactly.
- Give saved-chat requests at least two minutes by default to finish tool execution. Add `HERMES_LIVE_HERMES_CHAT_TIMEOUT_MS` for an explicit limit, preserve longer existing request limits, and retain cancellation without retrying a possibly accepted request.
- Support Dashboard WebSocket auth helpers in both `hermes_cli.web_server_chat` and legacy `hermes_cli.web_server`, while failing closed on broken helpers or rejected authentication and origin checks.
- Add gateway-to-Python speech contract regressions, including Chinese and Markdown answers, plus timeout and authorization coverage. Fresh live audio was unavailable in the release environment; see the [validation receipt](https://github.com/bielcarpi/hermes-live-voice/blob/v1.1.1/docs/provider-receipts/2026-09-07-local-voice-v1.1.1.md).

## 1.1.0 - 2026-08-31

- Remove the standalone browser demo, demo flag, static-file serving path, and `browser_demo` capability.
- Keep old managed configs compatible with the removed `HERMES_LIVE_DEMO_ENABLED` key.
- Remove public launch plans, outreach drafts, historical readiness audits, and their prose-enforcement scripts.
- Limit the npm package to runtime files and operator documentation. Contributor, release, roadmap, and transcript files remain in the source repository.
- Replace the illustrative Dashboard preview with a real, sanitized capture from the bundled plugin running in Hermes Agent v0.20.6.

## 1.0.2 - 2026-08-29

- Tighten the README around the core workflow: keep talking while Hermes runs background work, with a provider quick path and a static Dashboard preview.
- Align package discovery keywords with the stricter Hermes, voice-gateway, and Dashboard-plugin positioning.
- Add a text-only workflow transcript and public roadmap items for adoption-focused contributor work.
- Add an upstream integration RFC, upstream comment drafts, and provider compatibility receipt template for maintainer-facing review.
- Declare the Hermes plugin's v2 review metadata, optional gateway environment variables, Python dependencies, plugin-local license/security pointers, review boundary, and local manifest smoke for scanner-friendly review.
- Add a provider compatibility issue template so users can share live-provider evidence without leaking private audio, prompts, secrets, or task results.
- Document the pinned Hermes plugin-only install path for reviewers while keeping npm setup as the normal gateway runtime install.
- Clarify that direct Hermes subdirectory plugin installs are pinned review
  installs, while npm setup and `hermes-live upgrade` remain the normal managed
  gateway update path.
- Document provider-doc alignment for the upstream integration path, including Gemini's synchronous function-calling constraint and the fast-receipt `/v1/runs` design.
- Add a community sharing guide, Hermes plugin-index submission draft, current listing status, and refreshed launch sequence for an evidence-bounded Hermes-focused community launch without generic launch sites or broad cross-posting.
- Add copy-ready community issue drafts for provider receipts, Dashboard screenshots, and Linux local-runtime research so first contributors have narrow, evidence-oriented entry points.
- Add a maintainer readiness smoke check that keeps package counts, docs counts, version parity, and launch-boundary evidence synchronized with the current release candidate.
- Add a checked plugin-index entry generator so bare-name install metadata is derived from the package and plugin manifest instead of hand-edited.
- Add a positioning smoke check that fails false official claims, unrelated product copy, and stale broad package keywords.
- Add a maintainer readiness audit that separates proven local quality from live-provider evidence and upstream acceptance still required before any official claim.
- Add a maintainer review packet with the exact review question, PR body, proven evidence, non-proven claims, and post-release sequence.
- Add `npm run audit:public-launch` as an external go/no-go check for public
  release state, GitHub description/topics/homepage, Issues, Discussions, npm
  latest version, and required branch-protection checks before outreach.
- Add `npm run audit:upstream-readiness` as a read-only external gate for
  Hermes upstream issue state, `hermes-talk` coordination, plugin-index
  availability, public release state, and maintainer-acceptance blockers.
- Add `npm run check:scripts` to syntax-check JavaScript maintenance scripts,
  including release and external audit helpers, as part of `npm run verify`.
- Add `npm run check:external-audits` to fixture-check public launch and
  upstream readiness audit behavior, including expected stale-metadata,
  missing-branch-check, and absent-maintainer-acceptance failures.
- Add a measured 100-star adoption plan grounded in peer Hermes/plugin/realtime
  repo patterns, with launch gates, expected channels, and anti-manipulation
  rules.
- Document the exact required branch-protection checks for the v1.0.2 public
  outreach gate.
- Clarify the upstream relationship with existing realtime voice work,
  especially `hermes-talk`, and separate core-hosted, surface-hosted, and
  gateway-hosted realtime transport topologies.
- Refresh `@google/genai` from 2.18.0 to 2.19.0 and keep the same-major Gemini SDK path under verification.
- Refresh the OpenAI Realtime default model from an obsolete reasoning-preview
  example to the current documented `gpt-realtime-2` default, while preserving
  explicit `gpt-realtime-1.5` configuration support and documenting the provider
  docs' model-name inconsistency in the release evidence.
- Refresh CodeQL and Docker Buildx action pins to match the current green Dependabot maintenance PR.
- Add a pinned OpenSSF Scorecard workflow for repository-level open-source security health reporting.
- Add a pinned `workflow-lint` CI job that installs `rhysd/actionlint` v1.7.12 from a SHA256-verified release archive.
- Add a workflow pin smoke check so external GitHub Actions must stay pinned to
  full commit SHAs.
- Replace the invalid release workflow `concurrency.queue` key with explicit non-cancelling release concurrency.
- Give the Windows-heavy task-stop race test an explicit timeout after the public v1.0.1 CI run exceeded Vitest's default by a small margin.
- Add a 1280x640 PNG social preview asset for GitHub repository settings.
- Document `verify-windows` as a required branch-protection launch gate.
- Add `actionlint` to the contributor and pull-request workflow-change checklist.
- Add a blocked provider receipt for the current local environment and wire the plugin-local manifest contract smoke into `npm run verify`.
- Strengthen Hugging Face realtime adapter close coverage around idempotent close, the normal provider close frame, and the local pipeline reuse grace window.
- Make the upstream-Hermes evidence boundary explicit: pinned deterministic fixtures cover Hermes Agent 0.20.0, while current-upstream claims need a refreshed fixture or latest-image compatibility workflow.
- Make explicit floating Hermes compatibility image checks pull before testing and give large image downloads enough time to finish.
- Verify the current floating Hermes image after a forced pull; it reports Hermes Agent v0.20.6 and passes the existing capabilities plus plugin discovery smoke.
- Tighten PR and CODEOWNERS review boundaries around realtime provider changes, the bundled plugin, package metadata, release workflow, and security docs.

## 1.0.1 - 2026-08-25

- Add the community sharing guide with canonical descriptions, community posting guidance, and directory refresh text for the v1.0.1 distribution push.
- Align npm metadata with the GitHub discovery language for Hermes, realtime voice, local AI, browser SDK, and voice-agent searches.

## 1.0.0 - 2026-08-25

- Add `hermes-live launch-check` as the stable v1 launch proof. It rejects mock mode and proves the real voice provider, Dashboard plugin version, gateway readiness, and one bounded Hermes worker with an exact output token.
- Refresh managed local voice to Hugging Face `speech-to-speech` 0.2.12. Keep the compatibility guard and the Hermes task-tool patch for the tested realtime path.
- Refresh `@google/genai` to 2.18.0 and Vitest to 4.1.11. Package, CLI, and release smokes now require the shipped CLI to expose `launch-check`.
- Keep setup and release docs focused on one user path: install, run setup, run launch-check, open Hermes Dashboard, and talk to Hermes in Live Voice.

## 0.9.6 - 2026-08-19

- Publish multi-architecture release images to GitHub Container Registry with semver, major/minor, and `latest` tags, plus provenance attestation and manifest verification.
- Stop Gemini Live audio/text parts from being duplicated when SDK messages expose the same payload through both camelCase and snake_case aliases. Add deterministic regression coverage for the alias shape.
- Refresh the Gemini Live SDK to `@google/genai` 2.17.1, the `tsx` development runner to 4.23.12, and CodeQL analysis actions to 4.37.7. The refreshed release candidate passes Linux, Windows, Hermes compatibility, dependency review, and package verification.

## 0.9.5 - 2026-08-12

- Refresh the pinned Node 22 image, WebSocket and Gemini SDKs, TypeScript runner, and CodeQL action. The production image now installs dependencies once and prunes development tools for the runtime layer. All compatibility, security, Linux, and Windows checks pass with this dependency set.

## 0.9.4 - 2026-08-11

- Test the bundled plugin and required API capabilities against the official Hermes Agent v0.20.0 image. Add scheduled and release compatibility gates. The doctor now checks the installed Hermes version.
- Add `hermes-live upgrade` to reconcile the npm package with the installed plugin, configuration, Hermes bridge, and user services.
- Add `hermes-live diagnostics` for a private, redacted support bundle. It excludes logs, prompts, task results, audio, and secret values. It refuses to overwrite a file.
- Clarify that task state, notifications, and retained results are durable, while in-progress computation still depends on the current Hermes Agent process.

## 0.9.3 - 2026-08-11

- Start normally on Windows when the filesystem rejects directory `fsync`, while keeping file writes atomic and surfacing real I/O errors. Add a Windows Node 24 CI lane.
- Emit each Gemini audio part once. The adapter no longer repeats the SDK's derived top-level `data` value alongside its source parts.
- Raise the browser playback buffer from 5 seconds to 2 minutes. Keep a hard memory bound and show one detailed warning if a response exceeds it.
- Honor explicit OpenAI `audio.end` messages in push-to-talk and VAD modes. Clients that stop sending packets at turn end no longer need to synthesize silence.
- Enable OpenAI input transcription by default and forward completed user transcripts without repeating the assistant transcript. The model and optional language hint are configurable.
- Resolve the release audit advisory in the development dependency tree.

## 0.9.2 - 2026-08-05

- Make the product promise consistent across npm, the README, CLI, Dashboard, and plugin metadata: continuous voice for saved Hermes chats while durable work runs and reports back.
- Add a branded social preview and focused discovery keywords for Hermes, local speech-to-speech, and full-duplex voice directories.

## 0.9.1 - 2026-08-05

- Make `hermes-live setup` the complete install path. It now configures Hermes' private API bridge, installs the Dashboard plugin, starts both services, waits for them to become ready, and warms a real task call. Custom and remote Hermes deployments remain operator-managed.
- Run the tested Hugging Face speech-to-speech stack as a private Apple Silicon service. Setup owns its install, startup, endpoint selection, health checks, log limits, retries, and removal when switching providers; a second terminal is no longer part of the normal workflow.
- Let Hermes choose its configured model instead of sending the old `hermes-agent` alias as a literal model override. New and resumed chats resolve the real selection, while `HERMES_MODEL` remains available for deliberate overrides.
- Resolve config, plugin state, and task state from `HERMES_HOME`, including named Hermes profiles.
- Add protocol v6 microphone pause by voice or UI. Pausing keeps playback, the conversation, and background work alive; resuming always requires an explicit user action.
- Make Dashboard Connect wait for the gateway, Hermes, task store, and provider to be ready, then start the microphone automatically. Disconnect remains immediate even while browser permission is pending, and late microphone grants are discarded.
- Keep saved-chat conversation responsive while durable work runs. The voice can inspect bounded live activity, target tasks by a short spoken reference, start follow-ups, and report completion without exposing internal reasoning or opaque IDs in normal speech.
- Harden local provider compatibility around exact speech turns, tool-call history, fragmented transcripts, empty responses, response deadlines, disconnects, provider crashes, and the upstream single-pipeline limit.
- Preserve accepted work when the voice provider dies or disconnects. Public task state now distinguishes confirmed terminal outcomes from unknown ones instead of guessing or repeating a possibly accepted mutation.
- Detect occupied local ports and unrelated processes before setup claims them. Managed endpoints move safely when possible, every readiness probe verifies Hermes Live service identity, and normal setup leaves the standalone browser demo disabled.
- Keep local speech and assistant text out of managed runtime logs while retaining operational warnings. The package also excludes Python cache artifacts and provides configuration-free CLI help.

## 0.8.0 - 2026-08-01

- Add fully local voice on Apple Silicon through the official Hugging Face `speech-to-speech` stack, with a pinned one-command launcher and no provider API key.
- Add a dedicated local realtime adapter and protocol v5 support for 24 kHz PCM audio, provider VAD, interruption, tool calls, and background-task updates.
- Make local voice a first-class option in setup, doctor, readiness, the Dashboard, browser client, and Docker while keeping Gemini and OpenAI support.
- Simplify the environment template, README, and supporting docs, and update the dependency and security baseline.

## 0.7.1 - 2026-07-20

- Stop Dashboard and terminal clients from reusing fixed titles for every new Hermes chat. Fresh voice sessions can now be created repeatedly without Hermes rejecting a duplicate title.

## 0.7.0 - 2026-07-19

- Bind each protocol v4 voice session to a real persisted Hermes conversation. Dashboard and terminal users can start a new chat or resume an existing session, including its current writable compression tip, while protocol v3 remains available as an unbound compatibility mode.
- Keep canonical conversation turns in Hermes Sessions Chat so Hermes continues to own history, memory, tools, and skills. Long-running work stays on a separate durable Runs plane, allowing voice to remain responsive and tasks to survive client or provider disconnects.
- Add sanitized live task activity from Hermes tool lifecycle events. Authenticated owner clients can ask what a task is doing without exposing raw reasoning, full tool arguments/output, upstream run ids, or provider envelopes.
- Add durable follow-ups through the realtime provider, browser SDK, wire protocol, Dashboard, and terminal. Each follow-up is a new exclusive Hermes worker seeded with the selected terminal task's bounded retained result and linked by explicit parent/root task ids.
- Add authenticated conversation list/create endpoints and a same-origin Dashboard proxy so saved chats are usable without exposing Hermes or gateway credentials in browser code.
- Update the terminal with `--resume`, `--unbound`, and `/followup`, keep its default as a new persisted chat, and report the selected Hermes session after connection.
- Let restart reconciliation fall back quietly to run-status polling when Hermes has already removed a terminal run's SSE stream; the recovered result or confirmed-missing state remains authoritative.
- Tighten the public docs around the two-plane architecture and remove the speculative roadmap page. Conversation continuity is canonical; task follow-ups preserve durable work-product lineage rather than claiming hidden process resumption or automatic multi-agent orchestration.

## 0.6.0 - 2026-07-18

- Add `hermes-live setup` as the normal installation path. It securely reuses Hermes's existing API Server key when available, prompts without echoing missing provider credentials, writes an allowlisted private config, installs and enables the matching plugin, verifies Hermes capabilities and a real Gemini/OpenAI session, and waits for the gateway to become ready.
- Add a native user-service lifecycle through launchd on macOS and systemd on Linux. `hermes-live service install|uninstall|start|stop|restart|status|logs` keeps the gateway available without a dedicated terminal, while service definitions contain only the managed-config path and never API keys.
- Add `hermes-live doctor` with human and JSON output for Node compatibility, config integrity, plugin/runtime version parity, Hermes CLI and durable-run capabilities, provider configuration and optional live session, service state, and gateway readiness. Every failed check includes an exact remediation.
- Store managed settings under `~/.hermes/hermes-live/config.env` with private permissions, atomic writes, process-environment precedence, an explicit key allowlist, and strict rejection of symlinks, unsafe permissions, duplicate/unexpected settings, oversized input, and non-string values. Project `.env` files are never loaded or executed.
- Make setup the primary README, plugin, Dashboard, and support path. The Dashboard now turns missing configuration, offline services, and failed readiness into the corresponding setup, service, and doctor commands.
- Verify the complete activation path from a clean packed npm install: Hermes key import, managed config permissions, exact plugin version, gateway startup, real readiness response, and redacted doctor output. Protocol v3 and the durable background-task contract are unchanged.

## 0.5.0 - 2026-07-16

- Keep the realtime conversation open while Hermes works. Delegated work is now owned by a durable server-side supervisor, survives client detachment, and reports retained results through an unread completion inbox after reconnect.
- Persist a task before accepting it, reconcile known Hermes runs after a gateway restart, and fence ambiguous dispatches as `dispatch_unknown` instead of retrying a mutation that Hermes may already have accepted. In-progress work still cannot survive a Hermes Agent restart.
- Run work exclusively by default. Operators can opt into parallel read-only tasks with disjoint resource keys only when they explicitly trust model-declared scopes through `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true`.
- Add exact background-task controls to the realtime tools, terminal, Dashboard, browser client, and wire protocol v3. Speech interruption and task cancellation remain separate operations.
- Harden the local task store with a private atomic file, strict single-writer lock, bounded retention, startup reconciliation, task-store readiness checks, offline containment and abandoned-lock recovery commands, and bounded shutdown. The stable state format reads beta state but becomes forward-only after writing new recovery fields.
- Deliver completion speech through bounded, retryable session claims and mark notifications spoken only after provider handoff. OpenAI isolates each task notice from conversation history, keeps a newly finished notice behind the user's current VAD turn, and targets interruption to the exact notice response; Gemini notices remain best effort.
- Remove the provisional `queuePosition` hint from protocol v3 because the bounded scheduler is not a strict FIFO queue. The field was optional in beta clients, but beta gateways and clients should still be upgraded together before reconnecting to stable v0.5.
- Keep approvals fail-closed until Hermes exposes identity that can target one exact request safely. Unknown or confirmed-missing runs can be contained without fabricating a result.
- Add a real built-image Docker smoke, pin the Hermes v0.18.2 fixture to its published image digest and revision, update `@google/genai` to 2.12.0, and verify the packed CLI, plugin, Dashboard, browser client, task recovery, and provider adapters.
- Export the new `tasks.trustDeclaredReadOnly`, task-store `health()`, readiness `tasks`, and `input_speech_stopped` contracts. Simplify the README, Dashboard, demo, and release docs around the project's actual role: real-time voice for Hermes Agent.

## 0.5.0-beta.1 - 2026-07-15

- Replace session-bound delegation with a server-owned durable task supervisor: tasks are persisted before acceptance, retain bounded results, survive client detachment, and reconcile after a gateway restart when Hermes still knows the upstream run.
- Keep the realtime conversation responsive while Hermes works, expose a durable unread completion inbox, restore every retained active/unread task even beyond the recent-history window, atomically claim spoken notices across concurrent sessions, and deliver bounded completion alerts without injecting task output into an unrelated provider turn.
- Add safe bounded concurrency: mutating and unspecified work runs exclusively, while explicitly `parallel_read_only` work overlaps only when its declared resource keys are disjoint.
- Introduce exact task control through `start_background_task`, `list_background_tasks`, `get_background_task`, and `stop_background_task`; provider interruption and task cancellation remain independent.
- Move the breaking wire contract to protocol v3, replace public `run.*` lifecycle messages with owner-scoped `task.*` snapshots/events/notifications, add per-task sequences and exact notification acknowledgements, and reject older clients clearly.
- Make ambiguous run dispatch fail closed as `dispatch_unknown` without automatic retry, reconcile Hermes run state through SSE plus bounded polling, and surface unprovable post-restart outcomes as `unknown` rather than guessing.
- Remove interactive approval controls from the truthful v0.5 surface. Current Hermes approvals are denied and the exact task is stopped fail-closed until upstream provides safely targetable approval identity.
- Upgrade the Dashboard, bundled browser demo, dependency-free browser SDK, and terminal around the same durable task inbox; add reconnect recovery, exact result/stop controls, and detach-without-cancel semantics.
- Add `/tasks`, `/status <taskId>`, `/result <taskId>`, `/stop <taskId>`, and `/interrupt` to the terminal, and make the one-shot client wait for the exact accepted task rather than an unrelated provider response.
- Isolate OpenAI completion notices from the active conversation, add authenticated best-effort Gemini realtime notices, and harden task/result content as untrusted input at the provider boundary.
- Persist state in a private atomic file, add retention and queue/concurrency bounds, run Docker non-root/read-only/capability-free with a dedicated state volume, and keep upstream run IDs, credentials, and approval authority out of the public protocol.
- Exercise the release candidate against the official Hermes Agent v0.18.2 Docker image for real run/SSE/stop behavior, exclusive serialization, reconnect restoration, retained results, and completion reporting, and require deterministic protocol, supervisor, client, plugin, terminal, gateway, package, security, and Docker gates before tagged publication.

## 0.4.0 - 2026-07-15

- Handle Gemini Live `toolCallCancellation` as an explicit exported provider event, correlate every cancellation to the bounded tool-call ledger, stop owned active runs, suppress queued and not-yet-sent results, and fail closed when Hermes side effects or provider delivery become indeterminate.
- Add a separate 120-second Hermes run-event SSE idle watchdog that is refreshed by upstream events and keepalive bytes while preserving the existing 30-second initial-response deadline.
- Remove upstream approval IDs from summary-mode run events; authenticated clients continue to receive only the gateway-owned approval identity used for decisions.
- Reject redirects and suppress untrusted error bodies on credentialed Hermes JSON/SSE calls; require credential-free, protocol-scoped Hermes/OpenAI endpoints; redact provider URL path/query text and provider-controlled error/close text from logs and diagnostics; prevent second-attempt OpenAI WebSocket authentication; pin Gemini/Vertex to validated official Google endpoints despite ambient SDK overrides; exact-pin the credentialed realtime transport dependencies; and harden the Hermes status tool and Dashboard bridge against unsafe origins and tokens, HTTP/WebSocket redirects, environment proxies, oversized/non-JSON responses, reflected credentials, untrusted fields, and inconsistent readiness claims.
- Correct the comparison with current Hermes Voice Mode and Desktop voice surfaces, document the synchronous delegation and provider-data boundaries, clarify community UI and terminal roles, avoid browser-playback warnings in text-only sessions, and make installed CLI diagnostics the primary support path.
- Slim the npm artifact by excluding contributor-only scripts, add a static package-renderable architecture diagram, and remove the obsolete completed migration plan and speculative model watchlist.
- Re-verify the packed CLI/plugin, Dashboard proxy, mock and real Hermes runs, and a real Gemini Live connection against the official Hermes Agent v0.18.2 image.

## 0.3.2 - 2026-07-15

- Publish `hermes-live-voice` on npm and make the installed `hermes-live` CLI the primary setup path for the gateway, Hermes plugin, terminal, and custom browser clients.
- Serialize tagged releases, protect immutable version tags/assets, select explicit npm dist-tags, make GitHub release creation retry-safe, and verify the exact npm tarball, provenance, dist-tag, and installed CLI after trusted publication.
- Streamline the README around a Dashboard-first quick start, clearer client choices, and concise production-readiness evidence.
- Update the runtime WebSocket dependency to `ws` 8.21.1 and move the development toolchain to TypeScript 7.0.2 and tsx 4.23.1, with an explicit TypeScript build root.
- Upgrade the GitHub Actions setup and artifact actions, make checksum manifests portable, group compatible Dependabot updates, and preserve the intentional Node 20 runtime baseline.
- Harden contribution guidance, checkout credential handling, and ignored secret, build, and editor artifacts for safer community contributions.

## 0.3.1 - 2026-07-14

- Negotiate targeted Hermes approval responses explicitly. Any current uncorrelated approval triggers deny-all where possible, run stop, fatal session closure, and an operator-verification warning; interactive choices require stable upstream IDs and exact run/approval/choice/count confirmation.
- Require exact Hermes stop confirmation instead of accepting missing, running, unknown, wrong-run, or conflicting-alias responses, and contain uncertain mutations.
- Make browser microphone stop/dispose independent of stalled permission, audio-context resume, and cleanup promises; keep disconnect responsive, preserve fatal UI errors, clear terminal approval cards, and improve push-to-talk/accessibility copy.
- Confirm Gemini/OpenAI provider closure, bound provider connection attempts, suppress and close late Gemini handshakes, and make provider smoke success require the upstream close event.
- Separate read-only package verification from release write/OIDC credentials, publish the already-verified tarball artifact, harden the Docker build/context and Compose runtime, and reject unbounded Hermes request timeouts.

## 0.3.0 - 2026-07-13

- Add a first-class **Live Voice** integration for Hermes Dashboard with responsive desktop/mobile layouts, browser microphone and playback, text fallback, transcript, capability status, task activity, separate response interruption and Hermes run cancellation, and approval controls.
- Add an authenticated same-origin Dashboard HTTP/WebSocket proxy that delegates to Hermes' own Dashboard authentication and origin checks while keeping the upstream gateway URL and bearer out of browser code.
- Publish a dependency-free `hermes-live-voice/browser` client and microphone worklet with strict protocol/lifecycle validation, bounded input and playback queues, request IDs, state subscriptions, and host-provided authenticated WebSocket URLs.
- Normalize client close frames to browser-legal codes and bounded UTF-8 reasons, recover from missing close events, suppress late audio after interruption until the next response begins, and replace stale connected notices when a gateway connection drops.
- Reserve browser playback capacity before awaiting autoplay permission, time-bound suspended-context resume, expose a user-gesture `primePlayback()` API, and make audio disposal independent of a stalled playback chain.
- Clear stale demo approvals on fatal disconnects and run npm trusted publishing on an explicitly verified Node 24/npm 11 OIDC runtime.
- Move the negotiated wire contract to protocol v2, a breaking client handshake that removes raw provider envelopes, adds `run.stopping`, and requires exact approval identity and choice correlation while retaining `/v1/live` as the endpoint path.
- Enable Gemini Live input/output audio transcription, preserve speaker/final metadata, avoid duplicate transcript events, and emit a normalized response-start lifecycle before assistant output.
- Preserve concurrent approvals in a capacity-bounded FIFO across the browser client, Dashboard, demo, persistent terminal, and one-shot CLI; only the queue head is actionable and only the exact confirmed entry is removed.
- Assign gateway-owned approval IDs, correlate them to bounded upstream identities, cache exact responses idempotently, and reject request-ID reuse, duplicate upstream identities, mismatched run/approval IDs, widened choices, and bulk resolution.
- Project approval details without silently rewriting them: opaque or incomplete requests are deny-only, `once` requires informed display context, and session/permanent choices require exact inspectable permission patterns plus a second interactive confirmation.
- Remove approval submission from realtime-provider tools and contain indeterminate approval or run mutations by stopping owned work and closing the session instead of risking a retry against the wrong action.
- Emit `run.stopping` when Hermes accepts a stop request and reserve `run.stopped` for confirmed `run.cancelled`; completion and failure retain their own terminal messages.
- Harden the default unauthenticated loopback WebSocket policy against Host-header and DNS-rebinding attacks while retaining headerless terminal/native clients and exact configured browser origins.
- Bound client/provider queues, WebSocket backpressure, PCM16 conversion, transcripts, audio, usage, tool arguments/results, Hermes JSON/SSE bodies, and terminal output; close on violated provider contracts instead of allowing unbounded memory growth.
- Correlate Hermes run IDs across start responses, status, SSE events, approvals, and terminal events; treat ambiguous starts, early event-stream EOF, late starts, failed stops, and unconfirmed disconnect cleanup as fatal containment conditions.
- Bound provider input, tool-result, response-cancel, and close operations so a stalled realtime provider cannot make session shutdown wait forever.
- Add `hermes-live terminal` and its `chat` alias for persistent remote/headless text control with transcripts, task progress, approvals, `/interrupt`, `/stop`, and safe exit behavior.
- Package the Dashboard frontend/backend assets and browser client in plugin, npm tarball, and Docker runtime outputs, with generated-asset parity and smoke checks.
- Make the Hermes Dashboard integration the recommended UI, add the persistent terminal as a first-class headless surface, document the secure browser SDK/relay path for community UIs, clarify Hermes Voice Mode and generic OpenAI-compatible UI boundaries, and add a real Dashboard screenshot.
- Align the Docker Compose OpenAI Realtime default with the then-current reasoning model.
- Make tagged release jobs fail when the Git tag does not match `package.json` or point at the exact protected `main` commit.

## 0.2.1 - 2026-07-13

- Replace session-label regex trimming with a linear sanitizer to prevent adversarial input from causing excessive processing.
- Keep unexpected internal HTTP failure details in server logs while returning a generic error response to clients.
- Add regression coverage for long hostile session labels and internal error-detail disclosure.
- Document and verify native Hermes plugin installation directly from the repository subdirectory.

## 0.2.0 - 2026-07-12

- Reposition the project as the realtime custom-client bridge for Hermes Agent, with a marketing-first README, honest Voice Mode comparison, provider compatibility roadmap, support guide, and release runbook.
- Default OpenAI Realtime sessions to the then-current documented reasoning model.
- Add a documented `gpt-live-1` compatibility watchlist without claiming current API availability.
- Make Hermes memory identity server-owned by default; client-selected `profileId` and `userLabel` now require `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true`.
- Default Hermes run events to an allowlisted summary, with explicit `summary`, `none`, and trusted-development `raw` policies.
- Add a configurable concurrent WebSocket limit through `HERMES_LIVE_MAX_SESSIONS`.
- Serialize client message handling and sanitize Hermes run failures returned to clients and realtime providers.
- Ask realtime models to acknowledge meaningful work briefly before starting a Hermes run.
- Add CODEOWNERS, a pull-request template, issue routing, support documentation, CodeQL, dependency review, and a Node 20/22/24 CI matrix.
- Prepare optional npm trusted publishing behind the `PUBLISH_NPM=true` repository variable.
- Align the Hermes plugin manifest with package version `0.2.0`, add explicit standalone-plugin metadata, and verify version parity in the release gate.
- Pin GitHub Actions to current immutable release commits and replace the deprecated dependency-license denylist with an explicit non-copyleft allowlist.
- Rename the documented Hermes credential env to `HERMES_AGENT_API_SERVER_KEY` while keeping `HERMES_API_KEY` as a legacy alias.
- Remove unsupported OpenAI Realtime reasoning effort value `none` and tighten clone-first setup docs.
- Add `hermes-live provider-smoke` and `npm run check:live-provider` for optional real Gemini Live/OpenAI Realtime session handshakes.
- Upgrade the Gemini SDK to v2, Vitest to v4, and tsx to the latest v4 release while keeping Node type-checking aligned with the package's minimum supported Node 20 runtime.
- Treat client-close aborts of active Hermes event streams as expected cancellation instead of logging or emitting a false run failure.
- Normalize structured realtime-provider startup errors into safe, actionable diagnostics instead of displaying `[object Object]`.

## 0.1.0

- Initial public gateway shape.
- Add Gemini Live, OpenAI Realtime, and mock live providers.
- Add Hermes run/event/approval/stop bridge.
- Add browser demo, docs, examples, and Hermes plugin metadata.
- Protect readiness/capabilities behind gateway auth when configured.
- Restrict query-token auth to browser WebSocket upgrades.
- Add `HERMES_LIVE_DEMO_ENABLED=false` to disable the built-in browser demo, with production defaults closed.
- Validate base64 audio frames and PCM16 byte alignment before provider forwarding.
- Keep internal Hermes session keys server-side.
- Add OpenAI push-to-talk/VAD turn detection configuration.
- Add best-effort realtime provider response cancellation for interruption handling.
- Require `GOOGLE_CLOUD_PROJECT` for Gemini Enterprise mode before startup.
- Default Gemini Live to `gemini-3.1-flash-live-preview`.
- Bound stalled Hermes JSON requests with `HERMES_LIVE_HERMES_TIMEOUT_MS` while keeping established run event streams open.
- Restrict gateway JSON endpoints to `GET`/`HEAD` and return `405` for unsupported methods.
- Reconstruct completed Hermes output from streamed message deltas when the terminal event omits output.
- Stop active Hermes runs before aborting run event streams on client disconnect.
- Add live-provider testing guide, Docker healthcheck, CI Docker build, web demo syntax checks, and package smoke checks.
- Add `hermes-live client "..."` for terminal smoke tests against a running gateway.
- Fail the terminal client when the gateway closes before completing a one-shot request.
- Add a built gateway smoke test against a fake Hermes API Server.
- Verify the packed npm tarball installs, exposes the CLI, and imports correctly.
- Require Hermes run/event/stop/approval support before `/ready` reports ready.
- Add a provider-ready timeout so live sessions fail visibly instead of hanging before `session.ready`.
- Close OpenAI Realtime sockets when initial session setup is rejected.
- Fail session startup immediately when a provider errors or closes before readiness.
- Add `HERMES_LIVE_MAX_TEXT_CHARS` to bound client text input and provider tool-call messages.
- Scope run stop, status, and approval actions to the active Hermes run for the current voice session.
- Require gateway auth for network-accessible binds unless explicitly opted out, and only send Hermes session-key headers on authenticated Hermes requests.
- Bound raw client WebSocket payload size from configured audio/text limits before JSON parsing.
- Flush the web demo microphone worklet before sending `audio.end`.
- Keep the web demo in a starting/error state until `session.ready` succeeds.
- Include Hermes plugin syntax validation in `npm run verify`.
- Register the Hermes plugin's `hermes_live_status` tool and `/hermes-live` slash command.
- Add `hermes-live plugin install/status/path` so npm installs can place the Hermes plugin under `~/.hermes/plugins`.
- Move the TypeScript gateway into a ports-and-adapters layout with domain protocol/audio helpers, application ports, inbound HTTP/WebSocket adapters, and outbound Hermes/realtime adapters.
- Run the Docker image as the non-root `node` user.
- Add defensive security headers to JSON and browser demo responses.
- Close idle and active HTTP connections during explicit server shutdown.
- Bound client protocol metadata fields before dispatch.
- Only send OpenAI Realtime reasoning-only session fields to reasoning-capable models.
- Let the terminal client complete on direct realtime provider transcript responses.
- Fail the terminal client clearly when a direct realtime response has no text output.
- Emit normalized provider transcript/audio/tool events before raw provider envelopes.
- Send Gemini text turns through `sendClientContent`.
- Normalize Gemini Live top-level audio data messages and require tool-call IDs for Gemini tool responses.
- Require `HERMES_API_KEY` before serving so Hermes auth failures fail fast.
- Require stronger gateway auth tokens for network-accessible binds.
- Enforce gateway exposure checks in the exported server API, not only the CLI.
- Fail fast on missing Hermes or realtime provider credentials when the exported server API creates default clients.
- Document `HERMES_LIVE_MAX_AUDIO_BYTES` in the example environment and compose files.
- Document every public server event in the client protocol guide.
- Render streamed Hermes run deltas clearly in the web demo.
- Send OpenAI truncation metadata for queued assistant audio even when the user has heard `0` ms.
- Forward OpenAI VAD speech-start events as `input.speech_started` and make the web demo stop/truncate queued playback.
- Cancel provider output on web-demo speech-start even when no truncation metadata is available yet.
- Echo client message IDs as `requestId` on related `session.error` responses.
- Fail direct provider adapter connects with clear credential/configuration errors.
- Make `hermes-live check` report actionable gateway, Hermes, and realtime configuration failures.
- Align `/ready` with the same actionable readiness report used by the CLI.
- Disclose that realtime readiness does not open a provider session handshake.
- Send the derived Hermes session key on authenticated run status, stop, and approval calls.
- Send the derived Hermes session key on authenticated run event streams.
- Reject realtime provider tool calls without call IDs before starting Hermes work.
- Send Gemini Live text turns through realtime input before falling back to client-content history updates.
- Rename the public package and repository positioning to `hermes-live-voice` while keeping the `hermes-live` CLI and Hermes plugin id stable.
