# Other sessions

The agent in one session can reach your other Cavvy sessions: find one, read what was said in it, send its agent a message, or start a new session. Ask for it in your own words ("tell the session fixing login to run the tests", "start a session to write the README").

| Tool (Claude Code, Codex) | Does | App | Terminal |
| --- | --- | --- | --- |
| `ListSessions` (`list_sessions`) | Lists sessions with their status, model and last activity: this project's (its repository, worktrees included), or every project's | ✓ | ✓ |
| `ReadSession` (`read_session`) | Reads a session's recent prompts and replies, with the tools it used as one line | ✓ | ✓ |
| `SendToSession` (`send_to_session`) | Sends a session's agent a message | ✓ | |
| `StartSession` (`start_session`) | Starts a session in this one's folder, with a first message from it | ✓ | |

The terminal reads sessions from disk. It can't drive a session another Cavvy process has open, so it doesn't offer sending or starting. Sub-agents (Cavvy's, and Claude Code's or Codex's own) and `cavvy -p` runs get none of these tools. Cavvy's own models get them as tools; Claude Code and Codex get them from Cavvy's MCP server (see [Sub-agents on other models](sub-agents.md)).

## Sending

A message shows in the receiving session as a quote under "Message from another session": hover that line to see which session sent it, and click it to open that session. A long message is collapsed, as a long prompt is, with Show more. If that session is idle it starts working on the message; if it's working, the message joins its turn at the next step and is shown there, in the turn. With Claude Code or Codex, a message the CLI's turn ended before reading is taken back from that turn and gets a turn of its own instead. Its agent is told the message comes from another session's agent, not from you: it acts on it only within what you asked of that session, and asks you before anything you haven't. It can answer the same way, and the answer arrives in the sender as a message.

- Sending and starting ask for permission in Manual and Accept edits mode ("don't ask again" allows the tool), go to the reviewer in Auto mode, and are refused in Plan mode. Read-only listing and reading don't ask.
- A session can't send work to one that asks you less: a Manual session can't send to one in Bypass permissions mode. Ask that session yourself, or change a mode.
- A session started by another gets the starter's mode or the folder's default mode, whichever asks you more, the starter's model unless the agent names another, and the starter's Claude Code and Codex accounts. It can't start sessions itself, and a session starts at most 5 an hour, so sessions can't multiply on their own.
- Pressing Esc in a session holds messages from other sessions until you next send it something, as it holds pull request and monitor events. Messages from other sessions start or join at most 20 turns an hour in a session (events count toward the turns they start), so two agents answering each other can't run on unattended. Both limits are kept while Cavvy runs, through closing and reopening the session.
- A session that's closed is opened to take a message, and closed again once it's done, unless a window shows it. A session open in a terminal can't take one: it says so to the sender.

T3 Code's thread tools ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT) were the reference: listing by project, reading by id, messages that join a running turn, and no handing work to a session with a freer mode.
