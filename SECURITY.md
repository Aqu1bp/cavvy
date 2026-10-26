# Security

Cavvy runs commands in your projects and holds your API keys, so a security
bug in it can cost you more than most bugs. Please report one privately, not in
an issue.

## Reporting a vulnerability

Open the repository's **Security** tab and choose **Report a vulnerability**.
That reaches the maintainer only. Say what you found, how to reproduce it,
and what it lets someone do. A proof of concept helps, but isn't required.

Cavvy is maintained by one person, so replies are best effort: expect an
acknowledgement within a week. Once it's fixed, the advisory credits you,
unless you'd rather it didn't.

## What counts

- A command, file edit or network request that goes ahead without the
  permission the mode requires, or escapes the sandbox.
- A key or other secret ending up somewhere Cavvy says it doesn't: a
  transcript, log, prompt, the model's context or another process.
- Another site, local user or program reaching the GUI server, the MCP
  server or the desktop app without the session's token.
- An account's sign-in becoming reachable from another account or project,
  or its history from an account that isn't meant to share it (accounts
  Cavvy makes share Default's on purpose).

Problems in Claude Code, Codex or a model provider itself go to them, not
here, unless Cavvy makes them worse.

## Supported versions

Only the latest `main`. Fixes aren't backported.
