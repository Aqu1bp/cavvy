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

The card closes by itself when the service says it's signed in. Cavvy decides that by asking the service (`gh auth status`, `aws sts get-caller-identity`), not by whether the sign-in command exited cleanly. So signing in some other way while the card is up, in a terminal of your own, closes it too. Cavvy asks every few seconds for the first two minutes after the card appears or you do something in it, then every half minute (a minute on a server): a card can stay up for hours, and each look runs the CLI.

- **Use a token** is offered where the service takes one (GitHub).
- **Later** puts it off. The agent is told, does what doesn't need the sign-in, and says what's left. The sign-in stays above the message box with its own **Sign in**; when you do sign in (there, or any other way), Cavvy tells the agent and it picks up where it left off. Dismissing it there tells the agent not to ask again, and ends whatever of Cavvy's own was waiting on it (a watched pull request stops and says why). While it's listed Cavvy keeps looking: every minute or two for the first two hours, every ten minutes after. Whatever asks for the same sign-in meanwhile shares the one card and the one line, and all of it hears when you sign in.
- A code that expired offers **New code**. A sign-in that failed shows the CLI's own words and **Try again**. The agent hears nothing until you're done or choose Later.
- If something is already signed in, there's no card: the agent is told at once. On a server the sign-in's follow-up step still runs (for GitHub, `gh auth setup-git`, so `git push` uses the sign-in). On your own machine it doesn't: your git settings change only after a sign-in you did in the card. If a push is still refused there, the agent is told that git isn't using the sign-in and to ask before running `gh auth setup-git`.
- On a server, the card for GitHub adds `Agents there can push as you`: a server runs agents without asking, and they act as whoever is signed in.

A notification says what needs signing in, and names the machine.

In the terminal app the same thing is a prompt: `Sign in to GitHub? ` with `enter`, then the link and the code, or `> ` for a code or token. `/sign-in` goes back to one you put off.

## What Cavvy knows how to sign in

`gh` (GitHub), `aws`, `gcloud` (Google Cloud), `claude` (Claude Code) and `codex`, on this machine and on a server.

For anything else, the agent can offer the CLI's own sign-in command. The card then shows it with **Open in terminal**, which opens a terminal with the command typed in for you to run; Cavvy doesn't run it. **Done** tells the agent the sign-in was done (Cavvy can't check). **Done, and remember** also saves it as a sign-in of your own, so next time it runs in the card; add a `status` command to it in your settings and Cavvy can check it too.

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

- `status.run` is how to tell: signed in when it exits with 0, or, with `signedIn`, when its output matches that pattern. `who` is a pattern whose first group is the account. Without a status command Cavvy can't check: the agent is told the sign-in was done, not that it's signed in, and a sign-in made elsewhere isn't noticed.
- `here` is the sign-in on a machine with your browser: its `flow` (`browser`, `device`, `paste`, `callback`, `token` or `typed`) and the command. `away` is the same for a server, where your browser is elsewhere; without it, `here` is used there too unless it's `browser`. A `callback` names the `port` its page calls. For a session on a server, your own machine brings that port over, and only if the same sign-in, with that port, is in your settings there too, and only once you've pressed **Sign in** in that window.
- `reads` are patterns over what the sign-in prints: `url`, `code`, `prompt` (it's waiting for the pasted code), `expired`.
- `answers` reply to questions on the way: `[{ "when": "Press Enter", "send": "\r" }]`.
- `token.run` reads a token from its input; `token.url` is where to make one.
- `then` runs once it's signed in through the card or noticed while its card is up; on a server, also when a request finds it signed in already. `env` sets variables for all of them. `warning` is a line for the card on a server.
- `signedOut` are patterns, matched as written, for what its own failed commands print when it isn't signed in (see below). `commands` are the programs those commands start with; left out, it's the `id`.

Commands are words, not shell: no pipes, quotes or variables. Only your own settings file counts. A project's settings can't add or change a sign-in, since these are commands Cavvy runs outside any sandbox.

## How agents come to ask

- `RequestSignIn` for models used with an API key, and `request_sign_in` for Claude Code and Codex through Cavvy's tools. Rules that name the tool apply (`mcp__cavvy__request_sign_in` in a deny rule turns it off).
- When a command fails with a message that means "not signed in" (`gh`'s "not logged into any GitHub hosts", `aws`'s "Unable to locate credentials"), Cavvy adds a line to what the agent reads: ask the user with the sign-in tool. Only a failed command that ran that CLI counts (`gh` or `git` for GitHub): a test or a file that merely quotes "run gh auth login" doesn't. For Claude Code and Codex, whose own shell Cavvy only watches, that line arrives as a note right after.
- Sub-agents can't ask: what they found signed out is in their report.
- With no one to ask (`-p`), the tool says so and the agent goes on without.

Claude Code and Codex give one of Cavvy's tools about an hour. A sign-in still waiting near that limit answers "still waiting" and the agent ends its turn; the card stays, and the agent is told when you've signed in.

## Where Cavvy asks by itself

The same card comes up without an agent asking, wherever Cavvy used to say "run this, then try again":

- **A turn that stops because its CLI is signed out** (Claude Code, Codex), or because `gcloud` can't get a token for a Vertex model. The message says what's signed out, the card offers to fix it, and once it's signed in the agent carries on with what you asked. Later leaves it above the message box.
- **Pull requests.** `CreatePullRequest`, `GitPush` and `WatchPullRequest` ask when GitHub turns out signed out, then go on. A pull request being watched waits for the sign-in rather than giving up; the agent isn't woken for it unless you dismiss the sign-in, which ends the watch. In the desktop app, **Push and open pull request** shows **Sign in to GitHub** in place of the pull request's fields.

- **A server just added by an agent.** `Sign in on aws-mumbai?` lists what agents there use (Claude Code, Codex, GitHub), each with its own **Sign in**; what's already signed in says as whom. See [servers](servers.md#having-an-agent-set-one-up).

Where there's nothing to show (the CLI says it's signed in though the service refused it, or it isn't installed), you get the old message with the command.

## What goes where

- The command runs as you, on the machine named, with Cavvy's own process: not in the agent's shell, not in its sandbox.
- What it prints is read by Cavvy for the link and the code, shown in the card, and dropped. It isn't in the transcript, the session's file or the model's context.
- A token goes from the field to the CLI's sign-in on its input. Cavvy doesn't keep it. The CLI stores it as it would if you had typed it in a terminal.
- On a server reached from this machine, each command goes over SSH with the keys Cavvy uses for that server.

## What each CLI was seen to do

Checked by running each one signed out (2026-11): `gh` 2.45 and 2.103 print the code and `github.com/login/device`; `aws` 2.36 opens the browser with `aws login`, and with `--remote` prints a link and asks for the code (and first asks for a region when none is configured, which Cavvy answers with the one it offers); `gcloud` 581 does the same with `--no-launch-browser`; Claude Code 2.1 prints a link and `Paste code here if prompted >`, and says `Invalid code` without exiting; Codex 0.167 prints a code for `auth.openai.com/codex/device` with `--device-auth`.
