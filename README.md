# dsh-context-guard

npm package: **`@2jumpsina/dsh-context-guard`** · [中文](README.zh.md)

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) plugin that **tells you to wrap up and start a new session before the session gets too long**.

It consumes the `contextPressure` projection that the official `dsh-token-meter` has already computed, and **after a turn has ended** it speaks up on two thresholds: "write the handoff into a document first, then start a new session." It then helps turn that sentence **into an action** — once the threshold is crossed it drafts a handoff block into the session working directory.

**Context tax = 0**: it registers no model-facing tool, injects no prompt section, and sends no extra request. The host does the arithmetic, the UI does the talking.

> ⚠️ **Do not run `npm i dsh-context-guard`** — that unscoped name is a **third party's** package
> (by `greenlv`). This plugin's name is scoped: **`@2jumpsina/dsh-context-guard`**, published on npm
> (see [Install](#install)).

![Session-header badge (ctx 48%) and the one-shot banner — redacted screenshot, session content masked](docs/badge-and-banner.png)

---

## ⚠️ It writes to your working directory (read this before installing)

- **On by default** (`handoverOnWarn: true`). When a session's occupancy crosses `warnRatio` (default 45%), the plugin creates/rewrites `handoverPath` (default `HANDOVER.md`) in **that session's working directory**, and then refreshes it every further 5 percentage points.
- What it writes are **machine facts**: session id, title, working directory, occupancy, turn/call counts, **ledger cost**, **the files this session wrote**, **previews of the last few prompts and replies**, plus empty "to be filled in" slots for the agent.
  ⇒ **It may contain sensitive content** (file paths, fragments of your questions and replies), and **it may end up committed by git**.
- Suggestions: add `HANDOVER.md` to your `.gitignore`; or point `handoverPath` at a location **outside any repository**; or simply set `handoverOnWarn: false`.
- Boundaries: a missing parent directory is refused; an existing target that is not a text file (`.json`/`.yml`/…) is refused; a **symlink** pointing elsewhere is refused; writes are atomic (temp file + rename) with tight permissions (`0o600`). Any failure is recorded as status only — it **never affects** the badge, the banner, or the push.

## Why this plugin has to exist

**In one line**: a long session is not a technical failure, it is a **bill that grows every turn**. This plugin
exists to put that bill in front of you at the one moment you can still act on it — after a turn has ended and
before the next request goes out.

### The problem is measurable

Cost ≈ (average prompt size) × (number of calls) × (unit price). A long session pushes the first two factors up
**at the same time**, and the unit price itself rises with occupancy. Measured against the ledger of the machine
this plugin was calibrated on (its local session-projection cache: **84 sessions / 14 days**, ¥252.29
self-reported) and the official DeepSeek pricing table:

| Measurement | Value |
|---|---|
| Self-check (price table × `contextTimeline.cost`, against the ledger total) | ¥254.29 vs ¥252.29 ⇒ **0.8% deviation**; per-request rows cover 85.4% of the total |
| Unit price by occupancy | **¥0.011/call** at 0–10% → **¥0.045/call** at 70–80% (**4.2×**) |
| Where the historical spend sits | calls at **≥40%** occupancy: **37.4%** of spend · at **≥60%**: **20.0%** |
| Session peaks | **75/75 sessions never exceed ~80%** (6 of them drop sharply at 79–80%) ⇒ the platform compacts around there |
| Interruption cost, if the line is drawn at 40% / 50% / 60% | **0.78 / 0.57 / 0.50** prompts per day |

And one real session, from the very repository this plugin was built in: **584 calls, 274M tokens, ¥31.66 — of
which 98.6% was re-reading context and 0.17% was model output.** That is the failure shape being addressed here:
no crash, no error message, just an invoice.

### Why this guard is the cheap half of the trade

The formula above has a shape worth spelling out. A session's total is

```
total ≈ Σ over turns ( prompt_i × unit_price(occupancy_i) )
```

and both factors move the **same way**: `prompt_i` grows monotonically with every turn, and the unit price
itself rises with occupancy (measured above: **¥0.011/call at 0–10% → ¥0.045/call at 70–80%**). A session
therefore does not get linearly more expensive as it runs, it gets **super-linearly** more expensive —
which is why the last third of a long session can cost far more than the first third while containing the
same number of turns.

That is the entire reason this plugin is worth installing: **its marginal cost is exactly zero.**

- It registers no model-facing tool, injects no prompt section, and sends no extra request ⇒ **it adds no
  tokens to any request** — it does not appear in the ledger at all.
- The only thing it ever costs you is the handoff at the end, and that handoff is not a fee paid to this
  plugin: it is work you would have to do anyway, usually worse (from memory, after the session has
  already been abandoned).
- It speaks **at the turn boundary**. A warning inside a turn is useless — that prompt is already on the
  wire and already paid for; a warning two turns later is an invoice you can no longer avoid.

So the trade is not "spend money to save money". It is: **put a free readout on a bill you are already
paying**, at the only moment when the number can still change the decision.

### Why nothing else already catches it

- **The platform compacts; it does not negotiate.** Every observed session peaked at or below ~80%, which is
  exactly where DSH compacts on its own. Compaction is a safety net for the session, not a warning to you — by
  the time it fires you have already paid for the whole climb.
- **The model cannot be the meter.** `projectedTokens` is computed by `dsh-token-meter` from the real request;
  the model cannot see how large its own prompt is, and a warning is only meaningful **after** a turn ends (that
  turn's prompt is already on the wire). Worse, any mechanism that makes the model "mind the context" has to
  inject a prompt section or register a tool — that is adding context tax to solve a context-tax problem.
- **You have no readout.** Occupancy is observable, but "time to wrap up" is not one reading: it needs
  hysteresis, a cooldown, edge triggering, cross-session counting, and it has to fire when you *open* an
  already-full historical session. Nobody watches a percentage while working.

### What it does instead — and deliberately does not

- **Context tax = 0**: no model-facing tool, no prompt injection, no extra request. A guard against context bloat
  must not itself consume context.
- **It only consumes what the official meter already computed** — it does not re-measure, estimate or guess.
- **It speaks once per level, at the end of a turn**: two levels + hysteresis + edge trigger + cooldown.
- **fail-closed**: with no denominator it does not judge at all, and the badge shows `ctx —` instead of 0%.
- **It turns the sentence into an action**: crossing `warnRatio` drafts a machine-facts handoff block (session,
  occupancy, ledger cost, the files this session wrote, previews of the last few prompts/replies, plus
  "to be filled in" slots) into the session working directory — zero LLM, zero extra request.
- **Outbound push is opt-in** (`pushChannel: 'none'` by default). A prompt plugin has no business messaging your
  phone unless you asked it to.

### What this section does *not* claim

- **The savings are a counterfactual upper bound, not a promise.** Replaying this machine's ledger: the 2741
  calls made at ≥40% occupancy would have saved **¥59 (23%)** had they happened at 0–20%; the ≥60% batch would
  have saved **¥34 (14%)**. Wrapping up is not free — it costs exactly one handoff. The only claim is that this
  decision is better made with the number in front of you.
- **The thresholds are a calibration, not an optimum.** 0.45 / 0.60 come from those 84 sessions; they are
  defaults, and every one of them is configurable.
- **The sample is one machine, one provider, two weeks.** Prices and compaction behaviour change.
- **It does not judge whether your task is worth finishing.** It says one thing: continuing from here costs
  several times more per turn than starting fresh — and here is the handoff draft.

## What it does

| Half | What it does |
|---|---|
| **host** (`lib/index.js`) | Subscribes to `ctx.sessionProjections.onChanged` and feeds `contextPressure` to the pure policy; settles each turn on `turn/end`; owns the settings; judges once immediately on `session/created` (new **or** restored from storage); folds `compaction/end` and `request/header` into the decision; registers `GET /api/context-guard/state`; extrapolates the verdict to WeChat when configured; and **drafts the handoff block** when a threshold is crossed |
| **client** (`lib/client.js`, a hand-written single-file bundle) | Session-header **badge** (live occupancy; numbers only, never speaks) plus a **one-shot banner** on threshold crossing (ratio + next step + pointer to the handoff document); on boot it reads the host settings back from the state route (a three-layer merge of **built-in defaults < host truth < escape hatch**) |

Behaviour notes:

- **Never mid-turn**: that request is already on the wire, so a warning there would be pointless.
- **Speaks once**: two levels + hysteresis (re-armed only after falling back below `warn − hysteresis`) + edge triggering + a cooldown of N turns.
- **fail-closed**: with no denominator (`contextWindow` absent) it does not judge at all, and the badge explicitly shows `ctx —` instead of pretending to be 0%.

## Install

> ⚠️ **Do not run `npm i dsh-context-guard`.** The unscoped name
> `dsh-context-guard` belongs to a **third party** (`greenlv <lgr5945@gmail.com>`; latest `0.2.1`, now
> deprecated in favour of `dsh-completion-guard`). That command installs **their** plugin, not this one.
> This plugin's name is scoped — **`@2jumpsina/dsh-context-guard`** — and is published on npm.

### Install into DSH (recommended)

`dsh plugin` is a thin wrapper around pnpm: it runs package management **inside the profile** and then
registers the new bundle. One command, everything else is automatic:

```powershell
dsh plugin --profile web add @2jumpsina/dsh-context-guard
```

What DSH does for you afterwards (all verified on a live profile): adds the dependency to the
profile's `package.json` · appends the package to `dsh.profile.bundles` — that is what makes it an
actual profile layer · applies the package's `cordis.patch.yml` to mount the host half, and its
`dsh.client` declaration to inject the browser half.

⚠️ **Restart dsh afterwards.** Source changes do not hot-reload, and a newly installed layer is
applied at boot.

Installing the package is *not* the same as mounting it — `npm i` alone only puts files in
`node_modules` and changes no profile.

### Install from this repository instead

```powershell
dsh plugin --profile web add git+ssh://git@github.com/2JumpSinA/dsh-context-guard.git
```

Requires `git` on PATH and a GitHub SSH key. ⛔ The `github:` shorthand
(`dsh plugin --profile web add github:2JumpSinA/dsh-context-guard`) resolves to an **HTTPS** clone,
which is unreliable on some networks (it fails with a confusing git error and no hint about
transport) — prefer the `git+ssh://` form or the npm package above.

### Plain npm (no DSH underneath)

If you are only fetching files and mounting them yourself:

```bash
npm i @2jumpsina/dsh-context-guard
```

**During local development** (not published, mounted into a profile with a junction) this is also common:

```powershell
# junction the repo into the target profile's node_modules (replace the paths for your environment)
New-Item -ItemType Junction `
  -Path   $env:DSH_HOME\profiles\<profile>\node_modules\@2jumpsina\dsh-context-guard `
  -Target <repo path>
```

Then append an `insert` entry to that profile's `cordis.patch.yml` (the user patch layer):

```yaml
- insert:
    - id: context-guard
      name: '@2jumpsina/dsh-context-guard'
```

> ⚠️ Do not put this package into the profile's `dsh.profile.bundles` — that fails with `cannot resolve profile bundle`.
> ⚠️ With a junction, Node resolves `node_modules` upward from the **real path** ⇒ the repo needs its own dependencies (or let DSH resolve them from the install location).

## Configuration

Editable on the settings page, all applied live; every `config` field is volatile ⇒ changing them needs **no restart** (changing **source**, however, does — see below).

| Field | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `true` | bool | Master switch |
| `locale` | `auto` | `auto`\|`zh`\|`en` | Copy language; `auto` detects per half — see [Language](#language) |
| `warnRatio` | `0.45` | 0.1–0.95 | Occupancy (`projectedTokens / contextWindow`) at which "time to wrap up" fires |
| `hardRatio` | `0.60` | 0.1–1 | "Time to start a new session"; must be > `warnRatio` |
| `hysteresisRatio` | `0.05` | 0–0.2 | Hysteresis: re-arm only after falling back below `warn − this value` |
| `cooldownTurns` | `5` | 0–100 | How many turns of silence follow a level change |
| `onResume` | `true` | bool | Also warn when entering an already-high historical session |
| `respectCompaction` | `true` | bool | Stay quiet while automatic compaction is already reducing the level |
| `crossSessionTrend` | `true` | bool | Count how many sessions crossed the line within the window, to escalate wording |
| `trendWindowHours` | `24` | 1–168 | Trend window (hours) |
| `trendEscalateAt` | `3` | 2–20 | Escalate wording when this many sessions hit hard inside the window |
| `pushChannel` | `none` | `none`\|`wechat` | Extrapolation channel (off by default) |
| `pushMinLevel` | `hard` | `warn`\|`hard` | Level from which extrapolation starts |
| `pushCooldownMinutes` | `10` | 0–1440 | Global minimum interval between two extrapolations |
| `handoverOnWarn` | `true` | bool | Auto-draft the handoff block once `warnRatio` is crossed |
| `handoverPath` | `HANDOVER.md` | string | Relative to the **session working directory**, or an absolute path |
| `handoverRefreshPercent` | `5` | 1–25 | Refresh the draft every additional N percentage points of occupancy |
| `handoverTurns` | `6` | 1–20 | How many "prompt / reply" previews the draft carries |
| `handoverFiles` | `12` | 1–50 | How many recently written files the draft carries |

> The schema floor for `warnRatio` is **0.1**: a value like `0.05` stops the entire plugin from mounting
> (`ValidationError: invalid config: $.warnRatio expected number >= 0.1`, and the state route then 404s).

## Language

All user-visible copy is bilingual (Chinese + English): the banner, the handoff draft, host logs and
the badge/banner UI text. Default is `auto`, and the two halves resolve it **separately** — they can see
different clues, and the host side has no locale service to read at all:

| Half | What `auto` looks at | Fallback |
|---|---|---|
| Browser (badge tooltip + banner) | `navigator.language`: `zh…` ⇒ Chinese, anything else ⇒ English | Chinese |
| Host (handoff draft + logs) | whether that session's **first user input** contains Chinese characters (`titleInput`, read from the projection registry's host state via `stateOf`) | Chinese |

- `locale: 'zh'` / `'en'` forces both halves and wins over the detection above.
- **Settings-page field descriptions** are always written as `English / 中文` in one line: the DSH config
  schema is static load-time metadata with no per-locale description mechanism, and the settings page
  has no idea which session you are looking at. (If DSH ever grows per-locale descriptions, those
  strings move into the string table and this note goes away.)
- **Escape hatch**: when there is no session to look at (startup logs, settings page, the state route),
  the host half reads `DSH_CONTEXT_GUARD_LOCALE=zh|en`; any other value is ignored.
- Machine-facing surfaces stay English in every language: JSON keys on the state route, config field
  names, and log `code`s. Only sentences meant for humans get translated.
- The sample draft block further down is what a **Chinese** session produces; an English session renders
  the same structure with English labels.

## Host state route

`GET /api/context-guard/state` — the browser half reads the true thresholds from it, and it doubles as the debugging entry point.

```jsonc
{
  "plugin": "context-guard",
  "at": 1790000000000,
  "config": { /* the table above; handoverPath returns a relative/file name only, never an absolute path */ },
  "trend": { /* cross-session trend summary; undefined when crossSessionTrend=false */ },
  "recent": [ { "sessionId": "…", "level": "warn|hard", "ratioPercent": 52, "title": "…", "body": "…" } ],
  "push": { "channel": "none", "minLevel": "hard", "cooldownMinutes": 10,
            "lastAt": 0, "lastResult": null, "sent": 0, "failed": 0, "skipped": 0, "history": [] },
  "handover": { "enabled": true, "path": "HANDOVER.md", "refreshPercent": 5,
                "written": 1, "failed": 0, "skipped": 0,
                "last": { "status": "appended|replaced|error|skipped", "path": "HANDOVER.md", "bytes": 1234, "error": null },
                "history": [] }
}
```

## Automatic handoff draft

When `warnRatio` is crossed (or a session already above it is opened), the plugin maintains a **marked** draft block in the session working directory:

```markdown
<!-- dsh-context-guard:begin session-… -->
### 🤖 自动交接草稿（dsh-context-guard · 时间 · 占用 52%）
… 机器事实表格 · 改过的文件 · 最近几轮摘要 · 「待补」空槽 …
<!-- dsh-context-guard:end -->
```

(The block's labels are Chinese because that is what the plugin writes today — the facts themselves are language-neutral: a machine-facts table, the files changed, the last few turns, and empty slots.)

- **Idempotent**: one block per session, replaced wholesale on refresh, **never appended twice**; a human can delete the whole block.
- **Machine facts only, no conclusions** — the plugin has no idea what you did. Have your agent fill in the conclusions / pitfalls / next steps in the "to be filled in" slots, or fold the block into your own handoff document and delete it.
- **Where the material comes from (verified on a live machine 2026-09-30; fixed in 0.3.2 — the first version published under the `@2jumpsina` scope)**: the machine facts come from the **host state source of truth** — the registry's `sessionProjections.stateOf(session, key)` — and **not** from the **wire view** pushed by projection changes.
  Why: once the on-demand detail channel is armed, the wire view of `contextTimeline` (registered by plugins such as `dsh-context`) is a **slim head**: occupancy, size, tool mix and cost are all there, but **`fileOps` is not** — the heavy collections exist only in the unit state. v0.3.0 read the wire view only ⇒ "files changed" was always 0 (**identical for a restored session and a running one**; it was never a difference between those two paths); and `turnOutline`'s wire view is an **array** while v0.3.0 read `{turns}` ⇒ "last few turns" always printed "host did not provide". Both are fixed now, each guarded by unit tests and the self-test.
- **Dependencies and degradation**: `fileOps` and the tool mix depend on a plugin that registers `contextTimeline` (e.g. `dsh-context`); cost depends on `tokenCost` (e.g. `dsh-damage-pulse`). When they are absent, those sections render empty — the plugin **invents nothing** and does not fail. And if the host registry has no `stateOf` (older harness), it falls back to the wire view, i.e. v0.3.0 behaviour.

## Thresholds and the reasoning behind them (why 0.45 / 0.60)

- **Occupancy = `projectedTokens / contextWindow`** (the official definition: how large the **next** request's prompt is, output excluded). Always a ratio: switch models and the window switches with it.
- **Cost rises with occupancy**: fitting per-call cost against occupancy using official pricing, a call in the high band costs several times one in an empty session; wrapping up later costs more, and starting a new session earlier saves more at the price of exactly one handoff (so keep it short).
- **The 0.60 hard line deliberately precedes the platform's own move**: observed session peaks never exceed about 80% (the platform compacts around there). Putting hard at 80% would race it for the same moment, and `respectCompaction: true` suppresses the warning after a compaction ⇒ the hard band might **never speak at all**.
- Division of labour: `warnRatio` = start wrapping up / write the handoff; `hardRatio` = start a new session.

## Extrapolation push (WeChat, off by default)

With `pushChannel: 'wechat'` the same verdict is sent to the local `wechatNotify` service (a soft dependency, usually provided by a plugin such as [`dsh-damage-pulse`](https://www.npmjs.com/package/dsh-damage-pulse)). A missing channel or a failed send is recorded as status only (`push.lastResult.code === 'channel-absent'`, `failed++`), and the exception **never escapes**. The push is an explicit choice — this plugin will not message your phone unless you ask it to.

## Security and privacy

- **The state route has no plugin-level authentication**: it is registered on the host webServer (the same access control as DSH Web). What the plugin does defend is: **relative/file names only** (never a local absolute path), `Cache-Control: no-store`, and no CORS headers. Do **not** expose DSH Web on `0.0.0.0`.
- **The side effect of writing files** is the warning at the top; the write path comes from your own settings, never from remote input.
- **The browser half's debug handle** `window.__DSH_CONTEXT_GUARD__` can read state and override levels (`override()`), but `Object.defineProperty` pins it so it **cannot be replaced wholesale**. It is available inside the page only and grants no privilege (that code already runs in your DSH Web page).
- The plugin does not use the network, does not call any LLM, and does not send session content (unless you explicitly enable the WeChat extrapolation).

## Tests and local acceptance

```bash
npm test          # unit tests + the "bundle is byte-identical to source" check
npm run build     # regenerate lib/client.js (required after changing lib/client-source.js or lib/policy.mjs)
```

Requires Node `^22.19.0 || >=24.0.0`.

## Troubleshooting (every one of these was hit for real; written down so they are not repeated)

1. **A `.volatile()` field is a reference, not a value**: reading `config.warnRatio` inside `apply(ctx, config)` is always `undefined` ⇒ it silently falls back to the default. Read each field as `isVolatile(v) ? v.get() : v` (see `plainConfig()` in `lib/policy.mjs`). That is how the settings page can show 0.33 while the plugin judges at 0.45.
2. **Source edits do not self-heal**: a running instance neither re-reads the profile's `cordis.patch.yml` nor reloads already-mounted modules ⇒ after changing config or source, **restart that dsh process** (the browser half is the opposite: the server re-reads the bundle per request, so a page refresh is enough).
3. **`patchReload: live` is not a file watcher**: it governs that one composition, not hot reloading.
4. **With a junction install, Node resolves dependencies from the real path** ⇒ the repo needs its own `node_modules` (or let DSH resolve them from the install location).
5. **`--profile` is a top-level flag**: `dsh --profile <p> --port <n>` is correct; `dsh web --profile <p>` fails with `select a profile only once`.

## Uninstall

**If you installed it with `dsh plugin add`** (the normal path): one command — the bundle entry and the
dependency are reconciled away automatically — then **restart that dsh process**.

```powershell
dsh plugin --profile web remove @2jumpsina/dsh-context-guard
```

**If you mounted it by hand with a junction** (local development): delete that `insert` entry from the
profile's `cordis.patch.yml` (and any `- id: context-guard` config entry the settings page may have
written into the same file), remove the profile's `node_modules\@2jumpsina\dsh-context-guard`, then
**restart that dsh process**. (Remove a junction with `cmd /c rmdir` — that deletes the *link*, not
your repository.)

## License

[MIT](./LICENSE)
