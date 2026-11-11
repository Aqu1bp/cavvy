# Other sessions

The agent in one session can reach your other Cavvy sessions: find one, read what was said in it, send its agent a message, or start a new session. Ask for it in your own words ("tell the session fixing login to run the tests", "start a session to write the README").

| Tool (Claude Code, Codex) | Does | App | Terminal |
| --- | --- | --- | --- |
| `ListSessions` (`list_sessions`) | Lists sessions with their status, model and last activity: this project's (its repository, worktrees included), or every project's | ✓ | ✓ |
| `ReadSession` (`read_session`) | Reads a session's recent prompts and replies, with the tools it used as one line | ✓ | ✓ |
| `SendToSession` (`send_to_session`) | Sends a session's agent a message | ✓ | |
| `StartSession` (`start_session`) | Starts a session in this one's folder, with a first message from it | ✓ | |

The terminal reads sessions from disk. It can't drive a session another Cavvy process has open, so it doesn't offer sending or starting. Sub-agents and `cavvy -p` runs get none of these tools. Cavvy's own models get them as tools; Claude Code and Codex get them from Cavvy's MCP server (see [Sub-agents on other models](sub-agents.md)).

## Sending

A message shows in the receiving session as a quote under "Message from another session": hover that line to see which session sent it, and click it to open that session. If that session is idle it starts working on the message; if it's working, the message joins its turn at the next step. Its agent is told the message comes from another session's agent, not from you: it acts on it only within what you asked of that session, and asks you before anything you haven't. It can answer the same way, and the answer arrives in the sender as a message.

- Sending and starting ask for permission in Manual and Accept edits mode ("don't ask again" allows the tool), go to the reviewer in Auto mode, and are refused in Plan mode. Read-only listing and reading don't ask.
- A session can't send work to one that asks you less: a Manual session can't send to one in Bypass permissions mode. Ask that session yourself, or change a mode.
- A session started by another gets the starter's mode or the folder's default mode, whichever asks you more, and the starter's model unless the agent names another.
- Pressing Esc in a session holds messages from other sessions until you next send it something, as it holds pull request and monitor events. Messages and events start at most 20 turns an hour in a session, so two agents answering each other can't run on unattended.
- A session that's closed is opened to take a message, and closed again once it's done, unless a window shows it. A session open in a terminal can't take one: it says so to the sender.

T3 Code's thread tools ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT) were the reference: listing by project, reading by id, messages that join a running turn, and no handing work to a session with a freer mode.
