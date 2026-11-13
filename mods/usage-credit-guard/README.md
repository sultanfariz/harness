# Usage Credit Guard

Usage Credit Guard checks Claude Code's reported usage before selected model requests. When either the five-hour or seven-day usage window is at or above 100%, it pauses the pending request and asks what to do. It also asks when usage data is unavailable.

## Install

Run this once in your terminal (Claude Code 2.1.292 or later):

```sh
claude plugin marketplace add sultanfariz/harness && claude plugin install usage-credit-guard@harness --scope user
```

This downloads the mod and enables it across your projects. Start a new Claude Code session, or run `/reload-plugins` in an existing one. You do not need a manual clone or `--plugin-dir` after installation. The command requires the marketplace manifest and plugin to be merged into the repository's default branch; private repositories also require access.

Inside Claude Code, run `/plugin install usage-credit-guard --marketplace sultanfariz/harness` and choose **Install for you**. To install into a separate profile, use that profile's launcher; for example, run `claudeb plugin install usage-credit-guard --marketplace sultanfariz/harness --scope user` in a shell where the `claudeb` alias is defined.

To update the installed copy:

```sh
claude plugin marketplace update harness
claude plugin update usage-credit-guard@harness
```

## Develop a local copy

From the `mods/` directory, load your working copy for one session:

```sh
claude --plugin-dir "$PWD/usage-credit-guard"
```

For the `.claudeb` profile, replace `claude` with `claudeb`. This flag is for local development; installed users can start Claude normally. Spending approvals remain request-scoped and are never saved as a permanent exception.

## Approval behavior

The guard presents an AskUserQuestion dialog with these choices:

- **Stop** (first choice): deny this request.
- **Allow this request**: send only the request currently waiting for approval.

Approval applies only to the one request waiting in that dialog. It does not change a setting, carry over to another request, or create a stored exception. Each later request is checked against the next usage reading: if a limit is still reached, the guard asks again; once both readings are below 100%, requests proceed without approval. Dismissing the dialog, entering other text, or having no available UI denies the request. In non-interactive sessions, the guard cannot ask and denies when approval is required. The dialog uses Claude Code’s AskUserQuestion tool; other loaded mods can hook that call, so trust the mods enabled in the session.

## What it checks

The guard reads Claude Code's session usage and checks both the five-hour and seven-day rate limits. It blocks when either reaches 100%. Claude drops an expired window until a new request reports usage again. If the guard observed that window's reset time, it allows one refresh request after that time passes, provided the other window is known and below 100%. The status shows `reset` for that window. The refresh allowance is shared across concurrent requests and covered model APIs; subsequent missing readings require approval.

Missing readings without an observed reset, malformed readings, completely empty usage snapshots, and usage read failures still require approval. Reset evidence is cleared when the session ends or the mod reloads, so an unknown window can still require approval after a restart. When a request requires approval, it is not sent until you approve it. Approving a request while usage is unknown may incur usage credits.

The guard covers main and subagent `turn.step` model requests, plus the separate `model.complete`, `model.fork`, and `model.classify` plugin API calls. Background work may not be observed or stopped reliably. Concurrent work can outlive the usage reading used for a decision, and requests already sent cannot be recalled. Usage data may lag. Model calls made outside these intercepted Claude Code events are outside its coverage. This plugin cannot guarantee a zero-spend session or enforce a hard billing ceiling.

## Usage status

After startup, the status line under the prompt shows the latest reported five-hour and weekly usage, plus the current context token count. For example:

```text
⚠ usage-credit-guard: Guard active · 5h: 0% · weekly: 8% · context: 12,345 tokens
```

The context count is the last response's input tokens, including uncached, cache-written, and cache-read tokens. It uses Claude Code's reported count, not a percentage converted back to tokens or a cumulative session total. Before the first response, or just after compaction until the next response, it shows `context: ? tokens`. The count can decrease after compaction. Reading it does not trigger a model or token-counting request.

Values vary by account. An unknown reading appears as `?`; a reading at or above 100% adds `approval required`. The line updates at startup and when Claude Code reports a usage measurement, such as after a turn or a rate-limit percentage change. It is not a live poll.

## Confirm the mod loaded

In the interactive session, run `/plugin`. The header’s `mods active` line should include `usage-credit-guard`. The status line is also evidence that the mod loaded and its usage reading succeeded.

To check whether the current CLI process can load mods without starting a session, run this from the `mods/` directory (which has no hooks module of its own):

```sh
claude plugin test
```

`no hooks module to load` means mods are enabled and there is no mod in the current directory to test; it does not by itself confirm that this plugin loaded. A message saying hooks modules are turned off points to `disableAllHooks` or an organization policy. A rollout-switch message means mods were turned off remotely. `--safe-mode` disables installed plugins, and an organization may allow only managed mods. For load errors, check the Errors tab in `/plugin`.

For hard protection against charges, turn off paid usage credits or extra usage in the applicable account or provider settings, such as [Claude usage settings](https://claude.ai/settings/usage). Use this plugin as an additional request gate, not as a billing cap.

## Validate and run the plugin tests

From the repository root:

```sh
claude plugin validate .
claude plugin validate ./mods/usage-credit-guard
claude plugin test ./mods/usage-credit-guard
```

These commands validate the plugin structure and run its local mod tests.
