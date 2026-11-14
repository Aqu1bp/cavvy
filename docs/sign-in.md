# Signing in

When an agent needs something signed in (the GitHub CLI before a push, AWS before it creates anything, Claude Code on a server), it asks you with a card and waits, instead of telling you to run a login command and stopping. Cavvy runs the sign-in itself; you finish it in the card. The agent then carries on in the same turn.

The agent names only what to sign in to and on which machine. It never chooses the command that runs, and it gets back only "signed in as you@example.com" or "not signed in". It doesn't see the code, the link, a token, or anything the sign-in prints.

## What you see

The card asks `Sign in to GitHub?`, or `Sign in to GitHub on box?` when it's for one of your [servers](servers.md). **Sign in** starts it. What comes next depends on how that service signs in:

| | |
|---|---|
| A browser on this machine (`aws login`, `gcloud auth login`, Claude Code) | Your browser opens. The card waits, with **Open again**. |
| A code to enter (`gh`, Codex on a server) | The code, with a button to copy it, and **Open** for the page that takes it. |
| A code to paste back (Claude Code, AWS or Google Cloud on a server) | **Open page**, then a field for the code the page gives you. |
| A page that ends by calling the CLI's machine | On a server, Cavvy brings that port to your machine first; then it's the first row. |
| A token | A masked field. The token goes to the CLI's own sign-in and nowhere else. |
| A name and password at prompts (`docker login`) | The CLI's own prompts, in the card. You type there. |

The card closes by itself when the service says it's signed in. Cavvy decides that by asking the service (`gh auth status`, `aws sts get-caller-identity`), not by whether the sign-in command exited cleanly. So signing in some other way while the card is up, in a terminal of your own, closes it too.

- **Use a token** is offered where the service takes one (GitHub).
- **Later** puts it off. The agent is told, does what doesn't need the sign-in, and says what's left. The sign-in stays above the message box with its own **Sign in**; when you do sign in (there, or any other way), Cavvy tells the agent and it picks up where it left off. Dismissing it there tells the agent not to ask again.
- A code that expired offers **New code**. A sign-in that failed shows the CLI's own words and **Try again**. The agent hears nothing until you're done or choose Later.
- If something is already signed in, there's no card: the agent is told at once.
- On a server, the card for GitHub adds `Agents there can push as you`: a server runs agents without asking, and they act as whoever is signed in.

A notification says what needs signing in, and names the machine.

In the terminal app the same thing is a prompt: `Sign in to GitHub? ` with `enter`, then the link and the code, or `> ` for a code or token. `/sign-in` goes back to one you put off.

## What Cavvy knows how to sign in

`gh` (GitHub), `aws`, `gcloud` (Google Cloud), `claude` (Claude Code) and `codex`, on this machine and on a server.

For anything else, the agent can offer the CLI's own sign-in command. The card then shows it with **Open in terminal**, which opens a terminal with the command typed in for you to run; Cavvy doesn't run it. **Done** tells the agent you've signed in (Cavvy can't check). **Done, and remember** also saves it as a sign-in of your own, so next time it runs in the card.

### Your own

`signIns` in your settings (`~/.cavvy/settings.json`) adds sign-ins, or replaces one of Cavvy's by using its `id`:

```json
{
  "signIns": [
    {
      "id": "ghe",
      "name": "GitHub Enterprise",
      "status": { "run": "gh auth status --hostname git.example.com", "who": "account (\\S+)" },
      "here": { "flow": "device", "run": "gh auth login --hostname git.example.com --git-protocol https --web" },
      "token": { "run": "gh auth login --hostname git.example.com --git-protocol https --with-token" },
      "env": { "GH_PROMPT_DISABLED": "1" },
      "reads": { "code": "\\b([A-Z0-9]{4}-[A-Z0-9]{4})\\b" }
    }
  ]
}
```

- `status.run` is how to tell: signed in when it exits with 0, or, with `signedIn`, when its output matches that pattern. `who` is a pattern whose first group is the account. Without a status command, Cavvy goes by whether the sign-in command itself succeeded, and can't notice a sign-in made elsewhere.
- `here` is the sign-in on a machine with your browser: its `flow` (`browser`, `device`, `paste`, `callback`, `token` or `typed`) and the command. `away` is the same for a server, where your browser is elsewhere; without it, `here` is used there too unless it's `browser`. A `callback` names the `port` its page calls.
- `reads` are patterns over what the sign-in prints: `url`, `code`, `prompt` (it's waiting for the pasted code), `expired`.
- `answers` reply to questions on the way: `[{ "when": "Press Enter", "send": "\r" }]`.
- `token.run` reads a token from its input; `token.url` is where to make one.
- `then` runs once it's signed in. `env` sets variables for all of them. `warning` is a line for the card on a server.
- `signedOut` are patterns that mean "not signed in" in any command's output (see below).

Commands are words, not shell: no pipes, quotes or variables. Only your own settings file counts. A project's settings can't add or change a sign-in, since these are commands Cavvy runs outside any sandbox.

## How agents come to ask

- `RequestSignIn` for models used with an API key, and `request_sign_in` for Claude Code and Codex through Cavvy's tools. Rules that name the tool apply (`mcp__cavvy__request_sign_in` in a deny rule turns it off).
- When a command fails with a message that means "not signed in" (`gh`'s "not logged into any GitHub hosts", `aws`'s "Unable to locate credentials"), Cavvy adds a line to what the agent reads: ask the user with the sign-in tool. For Claude Code and Codex, whose own shell Cavvy only watches, that line arrives as a note right after.
- Sub-agents can't ask: what they found signed out is in their report.
- With no one to ask (`-p`), the tool says so and the agent goes on without.

Claude Code and Codex give one of Cavvy's tools about an hour. A sign-in still waiting near that limit answers "still waiting" and the agent ends its turn; the card stays, and the agent is told when you've signed in.

## What goes where

- The command runs as you, on the machine named, with Cavvy's own process: not in the agent's shell, not in its sandbox.
- What it prints is read by Cavvy for the link and the code, shown in the card, and dropped. It isn't in the transcript, the session's file or the model's context.
- A token goes from the field to the CLI's sign-in on its input. Cavvy doesn't keep it. The CLI stores it as it would if you had typed it in a terminal.
- On a server reached from this machine, each command goes over SSH with the keys Cavvy uses for that server.

## What each CLI was seen to do

Checked by running each one signed out (2026-11): `gh` 2.45 and 2.103 print the code and `github.com/login/device`; `aws` 2.36 opens the browser with `aws login`, and with `--remote` prints a link and asks for the code (and first asks for a region when none is configured, which Cavvy answers with the one it offers); `gcloud` 581 does the same with `--no-launch-browser`; Claude Code 2.1 prints a link and `Paste code here if prompted >`, and says `Invalid code` without exiting; Codex 0.167 prints a code for `auth.openai.com/codex/device` with `--device-auth`.
