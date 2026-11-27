# Suggested tasks

While an agent works, it may come across a problem that has nothing to do with its task: a bug, a UI glitch, a test failing for a reason its change didn't cause. Instead of fixing it there or only mentioning it, it suggests a task: a card in the conversation with a title, what it saw, and the prompt a new session would start with. Nothing starts until you press Start.

On the card you pick the model and effort, the machine (this Mac or one of your connected servers), the folder, and whether it gets a new worktree; you can edit the title and the prompt. Then Start, or Dismiss (Restore brings it back).

- **Starting** makes a session on that machine as if you'd started it: the prompt is your first message, and its agent is told, out of sight, which session suggested it, so it can ask that one what it saw. It runs in the suggesting session's mode or the folder's default, whichever asks you more (Plan counts as Manual). In a new worktree, the branch is `fix/<title>`, or `fix/<title>-2` and so on when that's taken. Pressing Start twice (two windows, a retry after an error) gives the same session, not a second one, as long as both pick the same machine.
- **The prompt is the agent's words.** Read it before you start it, as you would a message you send. Characters that don't show (direction marks, zero-width spaces) are shown as `⟨U+…⟩`.
- **Limits:** at most 3 a turn and 20 waiting in a session. A problem already suggested, or one you dismissed, isn't suggested again.
- **Noticing them:** the session's row in the sidebar counts the ones waiting, and the notification at the end of a turn says how many it suggested ("· suggested 1 task").
- **Where:** the main agent of a session in the app, on any model: Cavvy's own models get `SuggestTask`, Claude Code and Codex get `suggest_task` from Cavvy's MCP server. Not in the terminal, in `cavvy -p` runs, or to sub-agents. Claude Code's and Codex's own sub-agents can see `suggest_task`, but Cavvy tells their calls apart and refuses them: they're told to put the problem in their report, so the main agent can suggest it.
- A session open in the terminal can't be started from: close it there first. Rewinding past a suggestion takes its card away; a fork doesn't copy the cards.

**Cost:** the tool's description adds about 420 tokens to every request a Cavvy model makes (estimated at 4 characters a token). With Claude Code and Codex it adds a few lines to Cavvy's MCP server instructions, besides the tool in the CLI's own list (Claude Code lists it by name and reads its description when the agent uses it).
