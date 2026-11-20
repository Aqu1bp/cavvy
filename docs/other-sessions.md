# Other sessions

The agent in one session can reach your other Cavvy sessions: find one, read what was said in it, send its agent a message, or start a new session. Ask for it in your own words ("tell the session fixing login to run the tests", "start a session to write the README").

| Tool (Claude Code, Codex) | Does | App | Terminal |
| --- | --- | --- | --- |
| `ListSessions` (`list_sessions`) | Lists sessions with their status, model and last activity: this project's (its repository, worktrees included), or every project's | ✓ | ✓ |
| `ReadSession` (`read_session`) | Reads a session's recent prompts and replies, with the tools it used as one line | ✓ | ✓ |
| `SendToSession` (`send_to_session`) | Sends a session's agent a message | ✓ | |
| `StartSession` (`start_session`) | Starts a session in this one's folder, or in a folder on another of your machines, with a first message from it | ✓ | |

The terminal reads sessions from disk. It can't drive a session another Cavvy process has open, so it doesn't offer sending or starting. Sub-agents (Cavvy's, and Claude Code's or Codex's own) and `cavvy -p` runs get none of these tools. Cavvy's own models get them as tools; Claude Code and Codex get them from Cavvy's MCP server (see [Sub-agents on other models](sub-agents.md)).

## Sending

A message shows in the receiving session as a quote under "Message from another session": hover that line to see which session sent it, and click it to open that session. A long message is collapsed, as a long prompt is, with Show more. If that session is idle it starts working on the message; if it's working, the message joins its turn at the next step and is shown there, in the turn. With Claude Code or Codex, a message the CLI's turn ended before reading is taken back from that turn and gets a turn of its own instead. Its agent is told the message comes from another session's agent, not from you: it acts on it only within what you asked of that session, and asks you before anything you haven't. It can answer the same way, and the answer arrives in the sender as a message.

- Sending and starting ask for permission in Manual and Accept edits mode ("don't ask again" allows the tool), go to the reviewer in Auto mode, and are refused in Plan mode. Read-only listing and reading don't ask.
- A session can't send work to one that asks you less: a Manual session can't send to one in Bypass permissions mode. Ask that session yourself, or change a mode.
- A session started by another takes its first message as its task, and does it under its own mode and rules; what you tell that session yourself comes first. A message sent to a session later is a request from another agent, weighed against what you asked of that session.
- A session started by another gets the starter's mode or the folder's default mode, whichever asks you more, the starter's model and effort unless the agent names others, and the starter's Claude Code and Codex accounts. A model that isn't set up here, or an effort the model doesn't take, is refused before you're asked, and the agent is shown the models it can use and the efforts each takes. The permission prompt shows a model or effort the agent chose. It can't start sessions itself, and a session starts at most 5 an hour (counted while Cavvy runs), so sessions can't multiply on their own.
- Pressing Esc in a session holds messages from other sessions until you next send it something, as it holds pull request and monitor events. Messages from other sessions start or join at most 20 turns an hour in a session (events count toward the turns they start), so two agents answering each other can't run on unattended. Both limits are kept while Cavvy runs, through closing and reopening the session.
- A session that's closed is opened to take a message, and closed again once it's done, unless a window shows it. A session open in a terminal can't take one: it says so to the sender.

## On your other machines

In the app, sessions on your servers can be reached the same way, and a session on a server can reach your Mac's sessions and your other servers'. `ListSessions` with every project lists them after the ones here, each named by its machine: `box/<id>` for a session on server `box`, `mac/<id>` for one on your Mac, as seen from a server. `ReadSession` and `SendToSession` take that name. It goes through your Mac's desktop app, so it works while the app is open and connected to the server; otherwise the agent is told that machine isn't connected.

- A message sent to a session on a server isn't refused for that session's mode: sessions there start in Bypass permissions, and the server is where they're meant to run without asking. A message from a server to a session on your Mac is held to the rule above, with the sender counted as Auto at most: a Mac session in Bypass permissions takes no work from a server, except from the session that started it.
- Your Mac's own deny rules for these tools (`ListSessions`, `ReadSession`, `SendToSession`, `StartSession` in `permissions.deny`) hold for what a server asks through it: about its own sessions and about your other servers'. A rule there that asks first (`permissions.ask`) refuses too: a call from another machine can't be asked about.
- `StartSession` with `machine` and `folder` starts a session on another machine: on a server from your Mac, on your Mac (`mac`) or another server from a server. It gets its prompt as a message from the starter, and can answer it with `SendToSession`.
    - On your Mac it starts only in a folder you've opened in Cavvy there by its real path (or one inside it, such as a worktree; links are followed first), in the default mode you've set for that folder there, whatever mode the starter runs in. The session that started it can send it more messages, whatever the two modes. A folder with configuration you haven't trusted is refused.
    - On a server it starts in the starter's mode or the folder's default there, whichever asks you more.
    - It runs on that machine's own model unless the agent names one that machine has.
    - The bounds on starting hold across machines: a session started by another starts none, and one session starts at most 5 an hour, counted on its own machine and on the one it starts them on. On your Mac, all of one server's sessions together start at most 10 an hour.
    - Its answer is a message like any other, held to the same rule: a session on your Mac in a freer mode than the one it started doesn't take it.
    - A machine that doesn't answer in time may have started the session all the same: the agent is told to look before it starts another.

T3 Code's thread tools ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT) were the reference: listing by project, reading by id, messages that join a running turn, and no handing work to a session with a freer mode.
