# dsh-codebuddy

> ⚠️ **Unofficial third-party plugin.** This project is **not affiliated with, endorsed by, sponsored by, or connected to** Tencent Holdings Ltd. or any of its affiliates.
> "CodeBuddy" and "Tencent" are trademarks of their respective owners and are used here only **descriptively** (nominative use) to identify the service this plugin connects to.
> This project contains **no** Tencent code, assets, or credentials, and circumvents no authentication.

Connects models from the [Tencent CodeBuddy open platform](https://copilot.tencent.com) to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
**Zero source patches** — it modifies no DSH files, touches no `node_modules`, and is a plain plugin.

---

## What it is / is not

| ✅ Is | ❌ Is not |
|---|---|
| A standard DSH plugin (`package.json` + `cordis.patch.yml` + host entry + settings page) | Not an official DSH provider |
| Uses **your own** CodeBuddy API key against the official OpenAI-compatible gateway | Does not provide, resell, or share any API key |
| Ships a GUI settings page: paste key → test → fetch models → select | Not a CLI tool; no config-file editing needed |
| Probe-based model discovery (the gateway exposes no model-list endpoint) | Does not proxy, relay, or route through any third-party server |

---

## Requirements

| Item | Requirement |
|---|---|
| DSH | Verified on `0.1.7-rc.2` and `0.2.0-rc.2` (depends on the `@deepseek-ai/dsh-llm` `LlmAdapter` contract). `peerDependencies` range: `>=0.1.7-rc.2 \|\| >=0.2.0-rc.1 <3.0.0-0` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Account | A [Tencent CodeBuddy open platform](https://www.codebuddy.cn) account and API key (starts with `sk-` or `ck-`) |

> This plugin needs no DSH account and no other credentials.

---

## Installation

### ⚠️ Read this first: **do not use `link:`**

`lib/index.js` statically imports `@deepseek-ai/dsh-llm` at the top level. That package is provided by DSH itself and is only resolvable inside the profile's `node_modules` tree.

- `link:` install → the plugin exists as a **symlink** → cannot resolve `@deepseek-ai/dsh-llm` → **throws `ERR_MODULE_NOT_FOUND` at load time**, which looks like "installed, but nothing shows up in settings"
- `file:` install → pnpm **physically copies** the plugin into the profile's `node_modules` → upward resolution reaches DSH's packages → ✅ works

**So: use an absolute `file:` path, or just copy the directory manually.**

### Option A: `file:` dependency (recommended)

1. Put this repository somewhere **permanent**, e.g. `E:\WorkBuddy\dsh-codebuddy`
2. In the DSH profile's `package.json`:
   - add the dependency: `"dsh-codebuddy": "file:E:/WorkBuddy/dsh-codebuddy"` (forward slashes on Windows)
   - add it to the `dsh.profile.bundles` list
3. Let the profile install dependencies (the DSH desktop "Settings → Plugins" page can add a local path, or follow whatever install flow your profile type uses)
4. **Restart DSH** (required — the plugin registers at startup)

### Option B: manual copy

Copy `lib/`, `cordis.patch.yml`, and `package.json` from this repository into:

```
<DSH profile directory>/node_modules/dsh-codebuddy/
```

Then restart DSH.

### Option C: npm / GitHub (if published)

```bash
dsh plugin --profile <your-profile> add dsh-codebuddy
# or
dsh plugin --profile <your-profile> add github:<owner>/dsh-codebuddy
```

> Both forms still require the plugin to resolve `@deepseek-ai/dsh-llm` from the profile. If you get `Cannot find module '@deepseek-ai/dsh-llm'`, use Option A or B instead.

---

## Configuration

After restarting, open **Settings → CodeBuddy**:

| Step | Action |
|---|---|
| 1 | Paste your key into **API Key** (starts with `sk-` / `ck-`) and click **Save key** (stored in the DSH credential store, never written to a config file) |
| 2 | Click **Test connection** — you should see "✅ Connection OK, key is valid" |
| 3 | Click **Fetch models** — probes the gateway and lists available models (see cost notes below) |
| 4 | Go to **Settings → Models**, pick provider `CodeBuddy (unofficial)`, and select your model |

**The endpoint field is read-only.** It comes from `baseURL` in `cordis.patch.yml`; to change it, edit the config or set the `CODEBUDDY_BASE_URL` environment variable, then restart DSH. The settings page deliberately offers no editor (an earlier "Save endpoint" button showed "Saved" while persisting nothing — it has been removed).

### How many requests does one "Fetch models" cost?

Every candidate is a **real, billable** completion request.

| Mode | Requests | Notes |
|---|---|---|
| Default (shallow) | 22 (worst 44) | Probes the known list only; "worst" is one retry round for inconclusive results |
| "Deep probe" checked | 60 (worst 120) | Adds 38 guessed future version IDs |

Built-in protections:

- **In-session cache** (30 min, keyed by endpoint + key fingerprint) → repeat clicks cost 0 requests
- **Rate-limit breaker**: ≥3 HTTP 429s in one batch, or 3 consecutive batches with any 429 → stop immediately
- **Quota breaker**: on `code 14018` (quota exhausted) → **stops after the first batch**, wasting nothing further
- **60-second overall deadline**: aborts in-flight probes (including backoff) — never hangs for minutes
- **Cancellable**: the button turns into "Cancel" while probing, and it **actually** propagates the abort server-side

---

## Built-in model list

Fallback list used when probing fails (22 entries, calibrated against the live gateway on 2026-10-01; contextWindow/maxTokens revised 2026-10-04). `contextWindow` is pinned to 1000000 (local preference); the gateway's hard cap was measured at 1048576 tokens.

| ID | Name | Context | Max output | Input |
|---|---|---|---|---|
| `auto` | Auto router | 1000000 | 8192 | text |
| `hy4-preview` | Hy4 Preview | 1000000 | 8192 | text / image |
| `hy3` | Hy3 | 1000000 | 8192 | text / image |
| `hy3-preview` | Hy3 Preview | 1000000 | 8192 | text |
| `hy3-preview-agent` | Hy3 Preview Agent | 1000000 | 8192 | text |
| `deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1000000 | 128000 | text / image |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1000000 | 32768 | text / image |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1000000 | 8192 | text / image |
| `glm-5.3` | GLM 5.3 | 1000000 | 8192 | text / image |
| `glm-5.3-flash` | GLM 5.3 Flash | 1000000 | 8192 | text / image |
| `glm-5.3-flashx` | GLM 5.3 FlashX | 1000000 | 8192 | text / image |
| `glm-5.2` | GLM 5.2 | 1000000 | 8192 | text / image |
| `glm-5.1` | GLM 5.1 | 1000000 | 8192 | text / image |
| `glm-5v-turbo` | GLM 5V Turbo (vision) | 1000000 | 8192 | text / image |
| `minimax-m3` | MiniMax M3 | 1000000 | 8192 | text |
| `minimax-m3-pay` | MiniMax M3 Pay | 1000000 | 8192 | text |
| `kimi-k3` | Kimi K3 | 1000000 | 8192 | text |
| `kimi-k2.8-preview` | Kimi K2.8 Preview | 1000000 | 8192 | text / image |
| `kimi-k2.7` | Kimi K2.7 | 1000000 | 8192 | text / image |
| `kimi-k2.6` | Kimi K2.6 | 1000000 | 8192 | text / image |
| `kimi-k2.5` | Kimi K2.5 | 1000000 | 8192 | text / image |
| `step-5-preview` | Step-5 Preview | 1000000 | 8192 | text / image |

> The catalog drifts with official changes. **This list is only a fallback — the "Fetch models" probe is authoritative**, and discovered models enter the model picker for the current session.

---

## Data and privacy

Please read this before use.

| Item | Detail |
|---|---|
| **Where your API key goes** | Only as an `Authorization: Bearer` header to `https://copilot.tencent.com/v2`. It **never** passes through the author or any server belonging to this plugin (there is none) |
| **Conversation content** | Your prompts, code, system prompt, and tool-call arguments are **fully uploaded** to that Tencent gateway and handled under its privacy policy; may cross borders |
| **Telemetry** | **None.** This plugin contains no analytics, reporting, or callbacks |
| **Request identity** | Each request carries the standard DSH framework User-Agent (`deepseek-harness/<version>`). That is a DSH contract requirement, not something this plugin adds |
| **Key storage** | Stored in the DSH credential store (`~/.dsh/.credentials.yaml`), **never** written in plaintext to a config file. If the credential store is unavailable it degrades to a process environment variable (session-only) |
| **Deleting the key** | The settings page has **Delete key**. If your key comes from a **read-only source** (e.g. `~/.dsh/.env`), the plugin **tells you it cannot delete it** instead of pretending success |
| **Filing an issue** | Never paste your API key, full request logs, or screenshots containing credentials |

---

## Troubleshooting

| Symptom | Meaning | What to do |
|---|---|---|
| **HTTP 400 · `code 11102`** | Model does not exist | Click "Fetch models" and pick from the list |
| **HTTP 400 · `code 11115`** `prompt is too long` | Context overflow | Classified as `CONTEXT_WINDOW_EXCEEDED`; DSH auto-compacts and retries. If it persists, trim the session |
| **HTTP 429 · `code 14018`** quota exhausted | **Account quota exhausted** (permanent, not rate limiting) | Top up at [codebuddy.cn](https://www.codebuddy.cn/profile/usage). Retrying will not help |
| **HTTP 429 (no 14018)** | Genuine rate limiting | Retry later; the plugin honors `Retry-After` and trips a breaker |
| **HTTP 401 / 403** | Invalid or expired key | Re-enter the key |
| **`cannot resolve credential "CODEBUDDY_API_KEY"`** | No key saved yet | Enter and save one in settings |
| **`gateway returned an empty response`** | HTTP 200 with no content blocks | Retried automatically as `EMPTY_RESPONSE` |
| **`response stream was truncated`** | Connection dropped mid-stream (proxy / gateway restart) | Retried as `TRANSPORT`; partial output is never committed as a complete answer |
| **`stream idle timeout`** | Connected, but the gateway then sends **nothing at all** (silent proxy drop / gateway hang) | Aborts after 60 s of silence and retries as `TRANSPORT`. **It no longer waits ~5 minutes** (Node `fetch`'s default `bodyTimeout`) to throw a bare, non-retryable error |
| **No CodeBuddy section after install** | Most likely installed with `link:` | Reinstall with `file:` or a manual copy (see Installation) |
| **New models missing from the picker** | Discovery results are **session-scoped** | Click "Fetch models" again after restarting |
| **`Cannot find module '@deepseek-ai/dsh-llm'`** | Plugin is not inside the profile's `node_modules` tree | Install with `file:` or a manual copy |

---

## Known limitations

1. **Discovered models do not persist across sessions.** Newly discovered models enter the picker immediately for the current session, but a DSH restart falls back to the built-in list — click "Fetch models" again.
   (Cross-session persistence would require a `Config` schema plus a `@deepseek-ai/schemastery` dependency, which would churn the profile lockfile. Not done.)
2. **The endpoint cannot be edited from the settings page.** It comes from config / environment.
3. **The deep-probe guess list goes stale.** The 38 guessed version IDs (e.g. `hy5`, `deepseek-v5`) age with each official release, and are **off by default**.
4. **Model metadata (context window / max output) is statically declared.** Official changes require editing `cordis.patch.yml`; probing does not correct metadata for already-listed models.
5. **One "Fetch models" issues real billable requests** (see the cost table above).
6. **The stream idle timeout counts bytes, so keep-alives defeat it.** The watchdog measures silence *between*
   received data. As long as the gateway keeps emitting **any** byte (e.g. an SSE comment `: keepalive`, a partial
   frame), the timer resets — even if that response is effectively dead. Measured: no bytes at all → times out at
   60 s; a keep-alive every 200 ms → never times out.
   (Node `fetch`'s own 300 s `bodyTimeout` is fooled the same way, so this is the guard's scope, not a regression.)
   If it spins forever while the gateway is sending keep-alives, interrupt and resend.
7. **The failure ceiling is about 5.5 minutes.** A 60 s idle timeout × up to 5 retries plus backoff (~30 s total).
   That is the trade for turning "always fails" into "usually self-heals": transient drops recover, and a truly
   dead gateway waits slightly longer than before.

---

## Uninstall and rollback

1. Remove the `dsh-codebuddy` dependency and the `dsh.profile.bundles` entry from the profile's `package.json`
2. Delete `<profile>/node_modules/dsh-codebuddy/`
3. Restart DSH — the CodeBuddy section in settings should disappear
4. To clear credentials: click "Delete key" in settings, or remove `CODEBUDDY_API_KEY` from the credential store manually
5. To roll back to the old binary-patch approach: restore your `selfheal` scripts and the old provider block in the profile

---

## Development

```bash
npm test        # zero-network, zero-quota regression tests (node --test)
```

CI: every push and pull request runs the full suite (`.github/workflows/ci.yml`).

**Why this works in CI**: `lib/index.js` imports `@deepseek-ai/dsh-llm`, and that package **is published to npm** — CI installs it directly instead of a whole DSH installation:

```bash
npm i -D @deepseek-ai/dsh-llm@0.2.0-rc.2   # ⚠️ pin the version: this package's dist-tag `latest` is a stale 0.0.1-rc.1
node --test "test/*.test.mjs"
```

> Note the glob (and keep the quotes) rather than `node --test test/`: Node's `--test` only accepts
> **files/globs** as test entries. A bare directory name is treated as a CJS entry module, which fails
> with `MODULE_NOT_FOUND` and is counted as one failing test.

Coverage: SSE parsing edge cases (CRLF split across chunks, multi-line `data:`, trailing frame), block lifecycle and index allocation, tool-call argument assembly, mutually-exclusive `usage` accounting, error classification (11102 / 11115 / 14018 / 401 / 5xx), stream-truncation guard, **stream idle timeout**, catalog merging (add / remove / scope), probe breaker and overall deadline, **dual-copy model manifest consistency**, plus an end-to-end run against a **local mock gateway**.

> When developing locally, run tests inside an **installed copy** — the `@deepseek-ai/dsh-llm` that `lib/index.js` resolves comes from the DSH profile. Sync `lib/` and `test/` into `<profile>/node_modules/dsh-codebuddy/` first. (CI does not need this step, since it installs the dependency from npm.)

---

## License

[MIT](LICENSE). The upstream `@deepseek-ai/dsh-llm` family is MIT as well; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — plugin framework and the `LlmAdapter` contract
- `@deepseek-ai/dsh-llm-deepseek` — reference adapter implementation
