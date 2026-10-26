Plan-limit payloads, in the shapes the installed CLIs emit (captured 2026-10-16):

- `claude-normal.json` is a `rate_limit_event`'s `rate_limit_info` from Claude Code 2.1.301, verbatim.
  `claude-warning.json` and `claude-rejected.json` are built from it (no limit was hit during capture);
  `claude-missing.json` has only a status, as an older CLI or an unexpected payload may send.
- `codex-read.json` is Codex 0.163.0's `account/rateLimits/read` result with account fields
  (accountId, planType, credits, upsell) set to null. The `codex-update-*.json` files are
  `account/rateLimits/updated` params in its schema's shape (`codex app-server generate-ts`,
  AccountRateLimitsUpdatedNotification); `codex-read-reached.json` is a read at the limit.

Past a reached limit on credits (#434), built, not captured (no capture was at the limit):

- `codex-read-credits.json` and `codex-update-credits.json`: at the limit with a CreditsSnapshot
  (`{hasCredits, unlimited, balance}`, codex-rs/app-server-protocol `CreditsSnapshot`). The balance is
  there so tests can check it is never kept.
- `claude-overage.json`: `claude-rejected.json` with extra usage in use, as Claude Code 2.1.304 builds it
  (`isUsingOverage` is set when the status is rejected and `overageStatus` is allowed or allowed_warning).

`resetsAt` is in epoch seconds in both CLIs.
