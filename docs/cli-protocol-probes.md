# Subscription-CLI protocol probes (#219 PR 0)

Measured 2026-10-21/22 against Claude Code 2.1.304 (`claude`, stream-json, `--model haiku --effort low`) and Codex 0.163.0 (`codex app-server`, JSON-RPC, `gpt-6-luna` effort low, the cheapest model `model/list` returns). No product code was touched. Every claim below cites a recorded transcript in `test/fixtures/protocol/`; each probe is in `scripts/probes/` and can be re-run (`bun scripts/probes/<name>.ts`, scratch folder `/tmp/live-probes-scratch`, override with `PROBE_SCRATCH`).

Fixture format: one JSON object per line, `{"t": ms since spawn, "dir": "in"|"out"|"err"|"note", "frame": ...}`. `in` is what the CLI wrote to us, `out` what we wrote, `note` is the probe's own observation. Long strings and arrays are trimmed, and emails, org/account ids, the user name, the hostname and credit balances are scrubbed (`scripts/probes/lib.ts` `scrub`). The probes spawn the CLIs like Harness does (`STREAM_ARGS` plus the `initialize` control request for Claude Code; `initialize`/`initialized` for Codex), except that they use `--permission-mode bypassPermissions` instead of the stdio permission prompt tool, and skip `--include-partial-messages`.

| # | Question | Answer |
|---|---|---|
| 1 | Process stays alive and idle after a `result`; second user message is a second turn on the same pid | YES |
| 2 | Background tasks survive `interrupt` | PARTIAL: Bash and Monitor survive, background Agent (sub-agent) does NOT |
| 3 | Frames when a background task ends while idle | Recorded (a self-started wake turn, `result.origin.kind = "task-notification"`) |
| 4 | `set_model`, `apply_flag_settings`, `stop_task`, `background_tasks`, `get_context_usage` between turns | All answered `success`; `stop_task` does produce a `task_notification` (status `stopped`) |
| 5 | Two `turn/start`s on one thread, one connection | YES, thread stays loaded |
| 6 | Codex: `turn/interrupt` leaves a background terminal running; `backgroundTerminals/list` and `/terminate` | YES / work, but only with `experimentalApi` (refused without it) |
| 7 | `account/rateLimits/updated` between turns | NO (arrives inside turns only); `account/rateLimits/read` works any time |

## Claude Code

### Q1: idle process, second turn on the same pid: YES

Fixture: `claude-idle-and-controls.jsonl` (probe `claude-idle.ts`).

- Turn 1 ended with `result` (`subtype:"success"`), followed by `command_lifecycle {state:"completed"}`. The process did not exit.
- 8 s of idle: `new frames while idle=0`, process alive. stdin stayed open (we wrote to it afterwards).
- Turn 2 (`user` message on the same stdin) produced a `system/init` and a second `result`, `same pid=true`, same `session_id`.
- Every turn is announced by a `system/init` frame, so `init` is not a once-per-process frame.

Design meaning: one long-lived process per session works as §1 assumes. Do not treat `system/init` as "session start".

### Q2: background tasks and `interrupt`: PARTIAL (read this before building §4)

Fixtures: `claude-interrupt-background.jsonl` (main), `claude-interrupt-while-idle-first-attempt.jsonl` (the turn had already ended when we interrupted; see below), `claude-interrupt-monitor.jsonl`, plus `claude-steer-now-background.jsonl` for the `priority:"now"` alternative.

Setup (`claude-interrupt.ts`): one turn starts a `run_in_background` Bash (`sleep 61; touch marker`), a `run_in_background` Agent whose job is a foreground `python3 ... sleep(63)`, then a foreground `python3 ... sleep(120)`; we send `control_request {subtype:"interrupt"}` while all three run (process counts 2/2/2 before: each is a shell plus the sleeper).

Result of `{"type":"control_request","request_id":"probe-2","request":{"subtype":"interrupt"}}`:

- Response: `{"subtype":"success","response":{"still_queued":[]}}`.
- The turn's `result` came 8 ms later: `subtype:"error_during_execution"`, `is_error:true`, `stop_reason:"tool_use"`, `terminal_reason:"aborted_tools"`, `user_message_uuid` of the interrupted prompt.
- The foreground `sleep 120` was killed (count 2 to 0).
- The background Bash SURVIVED: `sleep 61` kept running, finished, wrote its marker, and reported (`task_updated {status:"completed"}`, `task_notification {status:"completed"}`, `background_tasks_changed {tasks:[]}`) 64 s after spawn, followed by a self-started wake turn (`system/init`, assistant frames, `result` with `origin:{"kind":"task-notification","producer":"session-task","runId":...}`, `runId` equal to the Bash task's).
- The background AGENT DID NOT SURVIVE. At the instant of the interrupt:
  `{"subtype":"task_updated","task_id":"adfb6aad0dc139855","patch":{"status":"killed",...}}`, then `{"subtype":"task_notification","task_id":"adfb6aad0dc139855","status":"stopped",...}`, then `background_tasks_changed` listing only the Bash task. The sub-agent's `python3 sleep(63)` died (count 2 to 0) and its marker file was never written.
- The process stayed alive; a new `user` message afterwards ran normally (`still-here`).

The `claude-interrupt-while-idle-first-attempt.jsonl` run is the same experiment where Claude had already ended the turn (it refused the `sleep 120` as a "standalone sleep" and finished), so the interrupt arrived with NO turn running. It still got `success` with `still_queued:[]` and no `result` frame (there was no turn to abort), and it still killed the background Agent (`task_notification status:"stopped"`, a `user` frame `[Request interrupted by user]` with that agent's `agent_id`) and the background Bash that the sub-agent itself owned (`owned_by_subagent:true`). The top-level background Bash survived and woke the model when it ended.

Monitor (`claude-interrupt-monitor.jsonl`): a `Monitor` task started in turn 1; in turn 2 we interrupted a foreground command. The monitor process kept running (`monitor process alive=true`) and kept delivering events: 14 tick lines in the 12 s after the interrupt, each waking the session with its own short turn (`system/init`, assistant, `result`).

Also recorded (`claude-steer-now-background.jsonl`): a `user` message with `"priority":"now"` sent mid-turn did NOT cancel the running foreground Bash in `-p` stream-json mode. It got `command_lifecycle {state:"queued"}`, the foreground `sleep 120` ran to completion (127 s), the interrupted turn's `result` arrived, the original prompt's uuid got `command_lifecycle {state:"cancelled"}`, and only then did the steered message start (`command_lifecycle {state:"started"}`, new `system/init`). Single run; the probe's own "result" bookkeeping for that run is stale (it picked up the original turn's result), so read the frames, not the notes. In that run nothing was killed: Bash and Agent both completed and the Agent marker was written.

What it means for the design (§4):

1. The §4 Esc plan for Bash and Monitor is validated: `interrupt` mid-turn (and while idle) leaves `run_in_background` Bash and Monitor tasks running, and they report later through the wake path. The process must not be killed, which is what #203 does today.
2. The background-sub-agent case is not covered by "Esc leaves background work alone". `interrupt` kills every running sub-agent, including `run_in_background` ones, and any shell they own, with a `task_notification` of `status:"stopped"` (not `"failed"`), and it does so even when no turn is active. §4's "Esc while idle does nothing to background work" is wrong for Claude Code unless the adapter does not forward the interrupt when there is no active turn. Recommended: when no Harness turn is active, Esc is a no-op for Claude Code and must not be sent to the CLI; when a turn is active, send it and expect background sub-agents to be stopped, and show them as stopped in the task strip. Tell the user ("Esc stops sub-agents; background commands keep running").
3. "Move to background" (`background_tasks {tool_use_id}`) is for foreground tools (see Q4); the sub-agents killed above were already background, so it is not a way to protect them.
4. `priority:"now"` is not a substitute for `interrupt` in `-p` mode on this version; do not use it as the steer path without re-probing (this contradicts the t3code assumption in §0). Unverified: whether it behaves differently in a TTY session or a newer version.
5. A sub-agent killed by the interrupt is idle-surfaced as a `task_notification` with `status:"stopped"`; the live layer should map that to a stopped (not failed) task.

Caveat: all sub-agents in these runs were busy in a foreground Bash call when interrupted. A sub-agent between tool calls was not probed separately.

### Q3: frames when a background task finishes while idle

Fixture: `claude-wake-and-stop-task.jsonl` (probe `claude-wake.ts`). Turn 1 started `sleep 14; echo WAKE_OK` and `sleep 301` in the background and ended (`result`, then `command_lifecycle completed`). 12 s later, with no turn running, the CLI wrote these frames unprompted, in this order (type/subtype):

1. `system/task_updated` `{"task_id":"bs09yy77q","run_id":"...","patch":{"status":"completed","end_time":...}}`
2. `system/task_notification` `{"task_id":"bs09yy77q","tool_use_id":"toolu_01WEw8...","status":"completed","output_file":".../tasks/bs09yy77q.output","summary":"Background command \"Background: sleep 14 then echo WAKE_OK\" completed (exit code 0)"}`
3. `system/background_tasks_changed` `{"tasks":[{ the still-running sleep 301 }]}`
4. `system/init` (a new turn begins; no `user` echo and no `command_lifecycle` frame for it)
5. `system/thinking_tokens` x2
6. `assistant` (tool_use Read of the `.output` file), `user` (the tool_result), `assistant` (text)
7. `result` `{"subtype":"success","origin":{"kind":"task-notification","producer":"session-task","runId":"0mvidu6pu-32d84c01"},"user_message_uuid":null,...}`

Notes: `origin` is `null` on normal turns, so `origin.kind === "task-notification"` identifies a wake `result`. The wake turn is not preceded by anything from Harness, and `user_message_uuid` is `null` (no prompt of ours caused it). The `task_updated`, `task_notification` and `background_tasks_changed` frames can arrive in the idle gap and in the middle of an unrelated turn (they carry `task_id`/`tool_use_id`, not a turn id), so they must be handled at the session level. `runId` in `origin` equals the `run_id` of the finished task.

Design meaning: wake adoption keys on `system/task_notification` (or `task_updated`) followed by `system/init` with no outstanding Harness prompt; the turn ends at the `result` with `origin.kind:"task-notification"`. Claude Code wakes itself: the host does not need to prompt (Codex does need one, see Q6).

### Q4: control requests between turns

Fixtures: `claude-idle-and-controls.jsonl`, `claude-wake-and-stop-task.jsonl`.

| Request | Response |
|---|---|
| `set_model {model:"haiku"}` | `{"subtype":"success","request_id":"probe-2"}` (no `response` body) |
| `apply_flag_settings {settings:{effortLevel:"low"}}` | `{"subtype":"success","request_id":"probe-3"}` |
| `get_context_usage` | `success` with `response:{categories:[{id:"system_prompt",name,tokens,color,kind}, ...], ...}` (full body in the fixture) |
| `set_permission_mode {mode:"bypassPermissions"}` | `success`, `response:{mode:"bypassPermissions"}` |
| `background_tasks {tool_use_id}` for an unknown id | `success`, `response:{backgrounded:false}` |
| `background_tasks {tool_use_id}` for a running FOREGROUND command | `success`, `response:{backgrounded:true}`, preceded by `background_tasks_changed` and `task_updated {patch:{is_backgrounded:true}}`; the command's `tool_result` then became "Command was manually backgrounded by user with ID: ...", the turn continued and ended, and the command kept running |
| `stop_task {task_id}` for a running background Bash | `success`, `response:{}`. Before the response: `task_updated {patch:{status:"killed"}}`, `task_notification {status:"stopped"}`, `background_tasks_changed {tasks:[]}`. The sleeper died (count 2 to 0). No turn and no `result` followed |
| `stop_task` for an id that does not exist | `success`, `response:{}` (same shape as a real stop) |

Gotchas:

- `stop_task` returns `success` even for a task that does not exist, so `success` is not a confirmation. The confirmation §4 specifies (a `task_notification` for that id, or the id leaving `background_tasks_changed`) is the right one. In the real case both arrive before the `control_response`.
- `background_tasks` on a foreground command answers `{backgrounded:false}` if asked before the command's `task_started` (`is_backgrounded:false`) frame, which arrives a few seconds after the `tool_use`. A "Move to background" button must only appear once that `task_started` is seen, and use the returned `backgrounded` boolean.
- `set_model` and `apply_flag_settings` produce no frame other than their `control_response` between turns. Whether they change the next turn's behavior was not checked (unverified; the probe set the same model and effort the process already had).

## Codex

### Q5: two turns, one connection, thread stays loaded: YES

Fixture: `codex-two-turns-one-connection.jsonl` (probe `codex-live.ts`). `thread/start` then `turn/start` twice on the same thread over one `codex app-server` process (same pid). `thread/loaded/list` returned the thread before turn 1, after turn 1 and after turn 2 (`contains ours: true` each time). Both turns ended with `turn/completed {status:"completed"}`. The server stayed up through a 10 s idle between them with no notifications.

### Q6: background terminals

Fixtures: `codex-background-terminal-experimental.jsonl` (`PROBE_EXPERIMENTAL=1`), `codex-background-terminal-no-capability.jsonl` (default).

- Turn A started a long `python3` via `exec_command` with a short `yield_time_ms` and ended; the process kept running after `turn/completed` (count 1). Turn A's `commandExecution` item was `item/started` with `source:"unifiedExecStartup"`, `status:"inProgress"`, `processId:"10566"` and had no `item/completed` before the turn ended.
- `turn/interrupt {threadId, turnId}` on a later turn B (a foreground sleep): response `{}`, then `turn/completed {status:"interrupted"}`. The foreground command died (1 to 0); the background terminal from turn A kept running (count stayed 1) in both runs (with and without the capability). The app-server stayed alive.
- With `capabilities:{experimentalApi:true}` in `initialize`:
  - `thread/backgroundTerminals/list {threadId}` returned `{"data":[{"itemId":"exec-...","processId":"10566","command":"python3 -c ...","cwd":"...","osPid":null,"cpuPercent":null,"rssKb":null}],"nextCursor":null}`, both after turn A and after the interrupt.
  - `thread/backgroundTerminals/terminate {threadId, processId:"10566"}` returned `{"terminated":true}`, the process died, the later `list` returned `{"data":[]}`, and the terminal's item completed with `status:"failed"`.
- Without the capability, both calls are refused: `{"code":-32600,"message":"thread/backgroundTerminals/list requires experimentalApi capability"}` (and the same for `terminate`). So Harness must send `capabilities:{experimentalApi:true}` in `initialize` to use them, and fall back to "can't list or stop terminals" if a future Codex drops them.
- Turn C (experimental run): a `sleep 9` terminal that outlived its turn ended by itself 9 s later. The app-server sent only `item/completed` for the `commandExecution` (`status:"completed"`, `exitCode:0`, `durationMs:8899`, same `processId`) and no new turn, no wake. `list` then returned `[]`.

Design meaning: Esc on Codex = `turn/interrupt`; background terminals survive it, which is exactly the §4 intent. "Stop background work" = `terminate` per `processId`, confirmed by `list` (needs `experimentalApi`). A terminal's end is visible only as an `item/completed` outside any active turn; Codex does not wake itself, so `codex.wakeOnBackgroundCommand` (§12 PR 3) has to be done by the host (start a turn that tells the model), as in the design. Whether the terminal also survives `thread/unsubscribe` or an app-server exit was not probed (unverified).

### Q7: `account/rateLimits/updated` between turns: NO

Fixture: `codex-two-turns-one-connection.jsonl`. Two `account/rateLimits/updated` notifications, one per turn, each immediately before that turn's `turn/completed` (frame indexes 30 and 44 against `turn/completed` at 32 and 46). None arrived in the 10 s idle after turn 1 (`notifications=[]`) nor in the 5 s idle after turn 2. `account/rateLimits/read {}` works on an idle connection and returns `rateLimits`, `rateLimitsByLimitId` and more. The notification carries `rateLimits.primary/secondary {usedPercent, windowDurationMins, resetsAt}`.

Design meaning: limits can be updated per turn from the notification, but showing a fresh number while idle needs polling `account/rateLimits/read`. Idle windows of this length produced no pushes; longer idles were not probed.

## Fixtures

| File | Probe | Used for |
|---|---|---|
| `claude-idle-and-controls.jsonl` | `claude-idle.ts` | Q1, Q4 |
| `claude-interrupt-background.jsonl` | `claude-interrupt.ts` | Q2, Q3 |
| `claude-interrupt-while-idle-first-attempt.jsonl` | `claude-interrupt.ts` (first run) | Q2, interrupt with no turn running |
| `claude-interrupt-monitor.jsonl` | `claude-interrupt-monitor.ts` | Q2 (Monitor) |
| `claude-steer-now-background.jsonl` | `PROBE_ACTION=now claude-interrupt.ts` | `priority:"now"` |
| `claude-wake-and-stop-task.jsonl` | `claude-wake.ts` | Q3, Q4 |
| `codex-two-turns-one-connection.jsonl` | `codex-live.ts` | Q5, Q7 |
| `codex-background-terminal-experimental.jsonl` | `codex-background-terminal.ts` | Q6 |
| `codex-background-terminal-no-capability.jsonl` | `codex-background-terminal.ts` | Q6 |
| `codex-model-list.jsonl` | `codex-models.ts` | model choice |

Timings were measured on one Mac under normal load, and the 8-12 s idle windows are samples, not limits. Each behavior was observed in one or two runs, not repeated for flakiness.
