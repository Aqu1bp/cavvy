# Antigravity

Cavvy can run Google's Antigravity CLI (`agy`) with your Antigravity plan, the way it runs [Claude Code and Codex](subscriptions.md). `agy` works as it does when you run it yourself: its own tools, models, modes, permission prompts, settings and skills, signed in its own way. Cavvy shows what it does, passes on its questions, and adds only its own tools.

## Setup

1. Install [Antigravity's CLI](https://antigravity.google/docs/cli), run `agy` once and sign in there (Google's own sign-in).
2. In Cavvy, `/login antigravity` (`cavvy auth add antigravity` from a shell, or **Use my Antigravity plan** in the desktop app's Settings → Providers). Cavvy runs `agy models` to check that it's installed and signed in, then turns it on.
3. Pick a model in `/model`, like `antigravity:gemini-4-neon-medium`. The list comes from `agy models`, and each model id names its effort (`-low`, `-medium`, `-high`), so Cavvy's effort setting isn't used.

## How it works

- Each Cavvy session gets one `agy acp` process in the session's folder, kept between turns, speaking the [Agent Client Protocol](https://agentclientprotocol.com). Your next message continues the same Antigravity conversation, also after a restart. If that conversation is gone, a new one starts with the conversation so far as context.
- **Modes.** Each of Cavvy's modes is one of `agy`'s own:

  | Cavvy mode | `agy` |
  |---|---|
  | Manual | Its default mode: it asks before edits and commands. |
  | Accept edits | `accept-edits`: it edits without asking, and asks before commands. |
  | Auto | `auto`: its own reviewer approves edits and safe commands, and it asks before anything it can't undo. Where your account doesn't have it, `agy` runs as in Manual, and Cavvy says so. |
  | Plan | `plan`: it plans before it changes anything. |
  | Bypass | Started with `--dangerously-skip-permissions`: it asks nothing. |

  A mode change takes effect from your next message. A stricter one while it works stops the turn, and it goes on under the new mode. Switching to or from Bypass restarts `agy` on the same conversation.
- **Permission prompts** are `agy`'s own: you see its question with Allow and Deny, and Cavvy's rules decide none of it. Your `agy` settings and rules apply as they do in a terminal. A Deny with a note sends the note to `agy` as your message, and it goes on with it. A Deny without one stops the turn.
- **Cavvy's tools.** The agent gets the tools Claude Code and Codex get from Cavvy, on Cavvy's MCP server: the browser, the simulator, delegation to other models, secrets, sign-ins, schedules, pull request watches, themes, your other sessions and your servers. `agy` asks before each MCP call; for the tools that check your rules themselves when they run, Cavvy answers that question for you, so you aren't asked twice. You answer the others (delegation, schedules, watches) as `agy`'s prompt.
- **Skills and commands** are `agy`'s own: those in `~/.agents/skills` and its other folders show in the `/` menu, and `/name` goes to `agy` as you typed it.
- `esc` stops the turn at once. The process stays for the next one.
- **Steer** (a message you send while the turn runs) goes to `agy` at once, as a second prompt: it ends what it was doing there and goes on with the work and your message, as one Cavvy turn.
- **Images and PDFs.** Images go in the message. A PDF is written to a folder only you can read and linked in the message, and `agy` reads it there without asking. The files are kept while the session is open and deleted when it closes or Cavvy quits. Steering messages carry them the same way.
- Changing the model switches it in the running conversation.
- **Fork and rewind.** `agy` can't fork or rewind a conversation of its own, so a fork, or a rewind, starts a new one with the conversation so far as context.
- **Titles.** `agy` can't answer a one-off request, so with no `smallModel` set, a session is named after its first prompt.
- Usage is recorded in tokens only. It's covered by your plan, so no dollar cost is recorded.

## The agent's credentials

Cavvy never reads, copies or stores Antigravity's sign-in. It starts your installed `agy` with the same environment as any child process, minus Cavvy's own provider keys, and doesn't offer it Cavvy's file system or terminal over ACP. Whether it's signed in comes from what `agy models` prints. Signing in and out (`/logout` inside `agy`) is Antigravity's own.

## What isn't available

- Several accounts, and plan limits.
- Cavvy's permission rules and hooks on the agent's own tool calls (they run on calls of Cavvy's tools).
- Cavvy's own skills: `agy` has its own.
- Importing its conversations, and its usage logs.
- One-off requests (titles, goal checks, summaries): set `smallModel` to another provider's model.
