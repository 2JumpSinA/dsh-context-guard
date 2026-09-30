# dsh-context-guard

English | [中文](README.zh.md)

A [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) plugin that **tells you to wrap up and start a new session before the session gets too long**.

It consumes the `contextPressure` projection that the official `dsh-token-meter` has already computed, and **after a turn has ended** it speaks up on two thresholds: "write the handoff into a document first, then start a new session." It then helps turn that sentence **into an action** — once the threshold is crossed it drafts a handoff block into the session working directory.

**Context tax = 0**: it registers no model-facing tool, injects no prompt section, and sends no extra request. The host does the arithmetic, the UI does the talking.

![Session-header badge (ctx 48%) and the one-shot banner — redacted screenshot, session content masked](docs/badge-and-banner.png)

---

## ⚠️ It writes to your working directory (read this before installing)

- **On by default** (`handoverOnWarn: true`). When a session's occupancy crosses `warnRatio` (default 45%), the plugin creates/rewrites `handoverPath` (default `HANDOVER.md`) in **that session's working directory**, and then refreshes it every further 5 percentage points.
- What it writes are **machine facts**: session id, title, working directory, occupancy, turn/call counts, **ledger cost**, **the files this session wrote**, **previews of the last few prompts and replies**, plus empty "to be filled in" slots for the agent.
  ⇒ **It may contain sensitive content** (file paths, fragments of your questions and replies), and **it may end up committed by git**.
- Suggestions: add `HANDOVER.md` to your `.gitignore`; or point `handoverPath` at a location **outside any repository**; or simply set `handoverOnWarn: false`.
- Boundaries: a missing parent directory is refused; an existing target that is not a text file (`.json`/`.yml`/…) is refused; a **symlink** pointing elsewhere is refused; writes are atomic (temp file + rename) with tight permissions (`0o600`). Any failure is recorded as status only — it **never affects** the badge, the banner, or the push.

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

```bash
npm i dsh-context-guard
```

DSH mounts the host half through the package's `dsh.bundle.patch` (`cordis.patch.yml`); the browser half is declared for injection by `dsh.client`.

**During local development** (not published, mounted into a profile with a junction) this is also common:

```powershell
# junction the repo into the target profile's node_modules (replace the paths for your environment)
New-Item -ItemType Junction `
  -Path   $env:DSH_HOME\profiles\<profile>\node_modules\dsh-context-guard `
  -Target <repo path>
```

Then append an `insert` entry to that profile's `cordis.patch.yml` (the user patch layer):

```yaml
- insert:
    - id: context-guard
      name: dsh-context-guard
```

> ⚠️ Do not put this package into the profile's `dsh.profile.bundles` — that fails with `cannot resolve profile bundle`.
> ⚠️ With a junction, Node resolves `node_modules` upward from the **real path** ⇒ the repo needs its own dependencies (or let DSH resolve them from the install location).

## Configuration

Editable on the settings page, all applied live; every `config` field is volatile ⇒ changing them needs **no restart** (changing **source**, however, does — see below).

| Field | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `true` | bool | Master switch |
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
- **Where the material comes from (verified on a live machine 2026-09-30; fixed in v0.3.1)**: the machine facts come from the **host state source of truth** — the registry's `sessionProjections.stateOf(session, key)` — and **not** from the **wire view** pushed by projection changes.
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

Delete that `insert` entry from the profile's `cordis.patch.yml` (and any `- id: context-guard` config entry the settings page may have written into the same file), remove the profile's `node_modules/dsh-context-guard`, then **restart that dsh process**.

## License

[MIT](./LICENSE)
