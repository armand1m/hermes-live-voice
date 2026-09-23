  # Reliable delegation, progress reporting, and natural speech

  Intended project document: docs/plans/voice-supervision-and-speech.md
  Status: Investigated and ready for implementation. The file has not been written because this session is in Plan mode.

  ## 1. Findings and architectural direction

  The existing gateway already supervises Hermes runs. The missing layer is durable supervision of the external work Hermes delegates, combined with accurate, timely communication to the voice session.

  Current flow:

  Browser → voice gateway → Riva ASR → conversation LLM
                                        ↓ tools
                                  TaskSupervisor
                                        ↓
                                    Hermes run
                                        ↓ terminal commands
                              herdr locally / mssh remotely

  Conversation LLM / Hermes answer → Riva TTS → browser

  The gateway can observe the Hermes run, but it cannot reliably identify or follow the herdr agent independently once Hermes has launched it.

  ### Evidence from September 23

  Times below are Europe/Amsterdam. These are inspection-time observations, not permanent task states.

   Finding                                                 Evidence                                                                                                                                             Consequence
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   One task blocks three others                            Diamond-indicator task started at 17:44; archive, persona lookup, and Mac mini inspection remain queued                                              Even a status inspection waits behind implementation work
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Progress reporting stops permanently after 64 events    Diamond task ends at sequence 67: three lifecycle events plus 64 progress events                                                                     The task log appears frozen despite continued execution
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Hermes remains active                                   Its transcript contains 150 assistant messages and 170 tool messages through approximately 20:58; gateway polls return HTTP 200 every two seconds    This incident is not simply a disconnected watcher
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Investigation repeatedly revisits the same question     Late task messages repeatedly investigate whether visualizer triggers or response-state masks are responsible                                        Activity alone does not demonstrate useful progress
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Delegation intent is lost                               User requested a herdr agent for the diamond fix; persisted task input asks Hermes to investigate and fix directly                                   Hermes performs the work itself instead of launching the requested harness
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Machine selection drifts                                Archive request says “same machine”; persisted instructions specify Mac mini                                                                         Free-form handoff changes an important execution constraint
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Receipts overstate execution                            Queued archive task receives “I just spun up that task…”                                                                                             Acceptance is presented as execution
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Status answers omit useful distinctions                 At 17:58 the request for depth produces “3 background tasks are active…”                                                                             Queued and running tasks are conflated
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Completion speech lacks substance                       notificationDigest() announces that a result exists in the inbox                                                                                     The user must ask again to learn what happened
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Markdown can reach speech                               Riva directly synthesizes model content and spoken_response; deferred cleanup leaves emphasis, headings, links, and tables incompletely handled      Speech formatting depends on which path produced the text
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Delivery is recorded too early                          Riva notification submission queues speech and returns; gateway then records announcedAt                                                             Synthesis failure or interruption can leave an unheard notification marked announced
  ──────────────────────────────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────────────────
   Task-log narration can remain unavailable               Today’s journal includes ten narration failures; failed revisions are quarantined for 24 hours                                                       Reopening the log cannot recover promptly after a transient failure

  The task-log narrator is a separate, display-oriented service that intentionally produces Markdown. It should remain separate from speech preparation.

  Transcription samples also contain repeated sentences, fragmented turns, and unstable recognition of names such as herdr and exodia. These establish symptoms, but without synchronized source audio they do not establish whether recognition, endpointing, echo, or transcript assembly caused each occurrence.

  The Riva adapter additionally has code-level risks requiring regression tests: truncating history by individual messages can split tool-call exchanges; multiple tool results can trigger inconsistent continuation behavior; queued speech needs explicit cancellation and delivery outcomes.

  ### Target architecture

                           Durable task/work registry
                            ↙                    ↘
                  Hermes run supervisor    External-work monitor
                            ↓                    ↓
                         Hermes          herdr on exodia / Mac mini
                            ↘                    ↙
                             Structured observations
                                      ↓
                         Progress policy and notification outbox
                                      ↓
                   Spoken-content preparation → speech scheduler
                                      ↓
                                Riva → browser

  Preserve Hermes as the reasoning and execution agent. Give the gateway responsibility for observation, scheduling updates, freshness, and delivery.

  ## 2. Implementation specification

  ### A. Repair task visibility and truthful reporting first

  - Replace the lifetime 64-event cutoff with bounded rolling retention. Continue updating the latest activity for the entire task lifetime; preserve lifecycle events and monotonically increasing sequences.
  - Track lastObservedAt, lastActivityAt, and lastMeaningfulProgressAt separately. A successful poll proves connectivity, not progress.
  - Coalesce repeated activity updates and persist them at most once per second; lifecycle changes persist immediately.
  - Preserve bounded tool identity and relevant file/operation context across start/completion pairs. Never require raw tool output in public snapshots.
  - Expose queue position and blocking task/reason. Receipts must say queued, Hermes accepted, or agent launched, according to verified state.
  - Make task summaries distinguish queued, running, delegated, blocked, uncertain, and completed work.
  - Flag ten minutes without meaningful progress as “needs review”; report the evidence and duration. Do not automatically stop or restart work.
  - Reconnect an interrupted Hermes event subscription with bounded backoff while status polling continues. Maintain one gateway subscription per run: the inspected upstream SSE implementation consumes a shared queue.
  - Treat task-log narration as optional presentation. Always render structured facts immediately; bound the full HTTP request including body decoding, cap successful and failed caches, and replace the 24-hour revision quarantine with a circuit breaker retrying after 60 seconds and backing off to five minutes.

  ### B. Add a durable herdr bridge

  Use fixed host identities: exodia and mac-mini. Configure the local herdr executable and remote mssh transport on the server.

  Introduce an ExternalAgentPort supporting discovery, inspection, and bounded recent-output reads. The monitor uses native herdr JSON; recent terminal text is supporting evidence, never authoritative completion proof.

  Persist each watched agent with:

  - Watch ID, owner, originating conversation, and linked logical task.
  - Host, workspace, pane, and harness session identity.
  - Requested objective and acceptance criteria.
  - Last observed status/revision, activity timestamps, and bounded summary.
  - Monitoring health and notification revision.

  Identify agents using host plus harness session identity and pane. Pane reuse must not silently attach a watch to different work.

  Monitoring policy:

  - Track agents delegated through Hermes and agents explicitly selected for watching.
  - Discover other agents on request.
  - Poll every five seconds, batching discovery once per host.
  - Read at most 80 recent lines when state changes or a progress assessment is due.
  - Allow one observation command per host at a time, with a 20-second deadline.
  - Back off failed connections to a maximum of 60 seconds; show stale/offline status after three consecutive failures.
  - Continue monitoring across browser disconnects and gateway restarts.
  - Interpret idle as “agent idle; outcome needs inspection,” not “task completed.”
  - Automatically inspect and report. Do not send follow-up prompts, retry work, stop agents, or restart services without user direction.

  Monitoring commands run independently of Hermes’s implementation queue. A Mac mini status request must never wait behind a code-changing task.

  ### C. Preserve delegation intent and transfer supervision explicitly

  Extend task creation with structured delegation metadata:

  targetHost, harness, repository, objective, and acceptanceCriteria.

  Resolve “same machine” from the referenced task or current project context. Ask only when that reference is ambiguous. Never silently substitute another host or discard a requested harness.

  Provide a Hermes plugin bridge tool that wraps agent launch and registration:

  1. Persist a delegation intent with an idempotency key.
  2. Launch the specified harness through the host adapter.
  3. Register the returned agent identity against that intent.
  4. Return a verified launch receipt to Hermes and the gateway.

  Use the existing authenticated plugin/gateway boundary; scope registration to the correct owner and task. Do not infer registration by scraping terminal commands.

  Represent external execution as a delegated task phase. Once handoff is registered, release the Hermes execution slot while the gateway continues monitoring external work. Retain mutation reservations for the relevant host/repository/worktree.

  Independent delegation may proceed only with distinct server-verified worktrees. Preserve serialization for conflicting writes. Observation requires no mutation reservation.

  If launch outcome is uncertain, reconcile the persisted intent against herdr before retrying. An ambiguous launch must never produce duplicate agents.

  Existing tasks remain valid Hermes tasks. Do not reinterpret today’s running or queued tasks automatically.

  ### D. Produce meaningful updates and track actual delivery

  Create one server-owned progress policy shared by voice sessions and the task UI.

  - Announce launch, meaningful milestones, blockers, terminal outcomes, and monitoring loss/recovery.
  - Provide a brief check-in after two minutes without a spoken report while tracked work remains active.
  - Coalesce multiple tasks into one update; suppress superseded messages.
  - Use task name, host, current phase, most recent verified finding, and next expected step.
  - Say when there is no new evidence. Never invent percentage completion.
  - Defer speech while the user is speaking; deliver at the next safe opportunity. Keep the UI current immediately.
  - Send only through the active voice session. On reconnect, offer a digest of pending updates rather than replaying every event.

  Introduce notification delivery states: pending, queued, synthesizing, playing, delivered, interrupted, and failed.

  Correlate notification, response, and playback IDs. Mark delivery only after the browser reports playback completion. Keep unread acknowledgement separate from spoken delivery. Legacy clients retain an explicit “playback unconfirmed” state rather than fabricating confirmation.

  Reuse the existing speech arbitration machinery. Avoid creating a second independent speaker or notification queue.

  ### E. Put every text-to-speech path through spoken-content preparation

  Introduce a shared SpeechContentService used by direct Riva replies, tool receipts, deferred answers, notifications, and the sidecar speech path.

  Maintain separate display and spoken representations:

  - Display retains Markdown, technical detail, and full results.
  - Spoken text uses natural sentences and preserves factual qualifications.
  - Spoken transcript and echo-guard input match the prepared speech.
  - Cancellation records distinguish planned speech from what playback actually delivered.

  Apply deterministic cleanup at the final text-to-speech boundary:

  - Remove Markdown structure, emphasis markers, HTML, reasoning blocks, and control characters.
  - Preserve link labels while omitting raw URLs by default.
  - Convert lists into sentences.
  - Replace code blocks and dense tables with a short explanation that details are available on screen.
  - Preserve negation, quantities, units, and relevant names; do not blindly rewrite punctuation in technical values.
  - Handle malformed and incomplete markup.

  For complex answers, use a separate tool-free spoken-summary request with a two-second total deadline and one concurrent request. Validate its output and run deterministic cleanup afterward. On timeout or invalid output, fall back to cleaned source sentences with an explicit truncation cue.

  Receipts and routine progress updates use templates and require no extra model call. Default spoken summaries remain within three sentences and 500 characters; full detail stays visible.

  Repair Riva tool handling alongside this boundary: preserve complete tool-call/result groups in bounded history, collect all results before continuation, settle invalid calls explicitly, and prevent interrupted generations from speaking queued stale responses.

  ### F. Use NVIDIA guidance without replacing the application architecture

  NVIDIA documents separate speech services and an orchestration layer. Its ACE speech architecture separates ASR, TTS, pipeline management, and chat handling. That supports the proposed separation of speech transport from task supervision; it does not supply durable herdr monitoring. NVIDIA ACE speech architecture
  (https://docs.nvidia.com/ace/ace-agent/latest/user/speech-ai.html)

  For the deployed Speech NIM interface:

  - Add configurable word boosting for Hermes, herdr, exodia, Mac mini, and relevant project names.
  - Correlate ASR results by item/content identity and finality, preserving legitimate repetition.
  - Expose partial transcripts for display without dispatching tools before finalization.
  - Validate endpointing changes with recorded audio before changing silence defaults. NVIDIA ASR realtime API (https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/realtime-asr.html)

  Keep full-utterance buffering as the initial playback default. After measuring latency, test sentence-sized buffered synthesis and supported text-flushing controls behind a feature flag. Add pronunciation dictionaries where supported. Markdown cleanup and semantic summarization remain application responsibilities.
  Verify controls against the installed NIM version rather than assuming everything in “latest” documentation is available. NVIDIA TTS realtime API (https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/realtime-tts.html)

  ## 3. Parallel-agent execution plan

  Before agents start, an integrator must preserve the current dirty working tree as an agreed integration baseline. All agents use isolated worktrees based on that baseline. No agent resets existing changes or deploys from a shared checkout.

   Work package                     Ownership and deliverable                                                                                                            Dependencies
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   A — Contracts and integration    Task/watch schemas, delegation handoff, protocol v11, delivery events, store migration, Hermes plugin integration                    First: publish contracts; last: integrate all packages
  ───────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ────────────────────────────────────────────────────────
   B — Supervisor and monitoring    Rolling progress, freshness, queue explanations, herdr adapters, durable watches, recovery, delegation reservations                  A’s contracts
  ───────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ────────────────────────────────────────────────────────
   C — Speech and Riva              Shared speech preparation, Riva tool-history fixes, cancellation, synthesis outcomes, ASR correlation and configurable vocabulary    A’s delivery contract
  ───────────────────────────────  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  ────────────────────────────────────────────────────────
   D — UI and proactive updates     Progress policy, notification outbox, playback acknowledgement, task drawer freshness/blockers, narration fallback                   A’s contracts; integrates B and C

  Each package must contain its implementation, focused tests, documentation, and a handoff listing changed contracts, validation results, and unresolved issues. Package A owns edits to shared composition/configuration and protocol files; other agents supply integration requirements rather than independently rewriting
  those files.

  Implement in three stages:

  1. Immediate correctness: progress cutoff, truthful receipts, queue distinctions, universal speech cleanup, narration recovery.
  2. Durable supervision: herdr bridge, structured delegation, independent observation, proactive updates, playback-confirmed delivery.
  3. Measured speech improvements: vocabulary, transcript correlation, endpointing experiments, optional sentence buffering.

  Keep existing protocol versions supported. Emit new fields and events only to v11 clients. Migrate the task store with a backup and explicit version check; rollback restores the matching store backup. Package the Hermes bridge reproducibly in this repository rather than relying on manual edits to the installed Hermes
  checkout.

  ## 4. Validation and rollout

  The inspected baseline passes 69 tests across four suites covering task supervision, deferred speech, Riva, and task narration. These passing tests do not validate the new contracts or reproduce the observed failures.

  Required regression scenarios:

  - A task produces more than 200 progress events: latest activity continues updating and retention remains bounded.
  - A long implementation task is running: local and remote herdr status checks still complete independently.
  - “Launch herdr on exodia” retains host and harness; “same machine” preserves its reference.
  - Queued work is never announced as launched.
  - Agent launch times out after acceptance: reconciliation discovers the existing agent without duplication.
  - Browser disconnect, gateway restart, SSH failure, and pane reuse preserve correct ownership and freshness.
  - Idle, blocked, missing, and unreachable agents remain distinguishable from successful completion.
  - A task makes repeated tool calls without meaningful progress: it receives a review warning without automatic intervention.
  - Every text-to-speech entry point removes Markdown and preserves factual meaning.
  - Multiple tool calls, malformed arguments, history trimming, interruption, and delayed results cannot orphan tool exchanges or emit stale speech.
  - Notification synthesis fails or playback is interrupted: it remains undelivered and can recover.
  - Two open clients receive one spoken announcement through the active voice session.
  - A narration timeout immediately leaves useful raw task facts visible and recovers after the circuit-breaker interval.
  - ASR replay fixtures cover domain names, repeated phrases, self-correction, background speech, and echo.

  Acceptance targets:

  - Healthy-host state changes appear in the UI within ten seconds.
  - Milestone announcements begin within fifteen seconds when voice is idle.
  - Two-minute check-ins occur within fifteen seconds of eligibility when voice is idle.
  - Monitoring never depends on a free Hermes implementation slot.
  - No known Markdown fixtures reach the TTS transport unsanitized.
  - No notification is marked heard solely because synthesis was queued.
  - Observe-only monitoring never prompts, cancels, or restarts an agent.

  Run focused suites, type checking, browser integration tests, and required repository checks. Then perform a local canary and a Mac mini canary with designated test agents. Collect ASR finalization latency, first-audio latency, underruns, observation age, queue delay, and notification delivery outcomes.

  Enable the monitor and new announcement policy behind independent flags. Retain the existing Riva playback buffering until measurements justify changing it.

  ## 5. Agreed defaults and investigation limits

  - Monitor delegated and explicitly watched agents.
  - Report milestones and provide two-minute spoken check-ins.
  - Inspect and report stalls; do not autonomously prompt or restart agents.
  - Keep Riva and the existing gateway; no ACE framework migration.
  - Preserve existing conflicting-write safeguards while allowing independent observation.
  - Treat recorded task/transcript text as evidence, not instructions.
  - Do not claim that today’s diamond task is dead: the inspected transcript shows continued, repetitive activity.
  - Do not attribute individual transcription errors to ASR without synchronized audio evidence.
  - Do not stop today’s tasks or deploy changes as part of this analysis.
