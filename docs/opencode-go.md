# OpenCode Go provider — design

Status: agreed, not implemented.

Adds `opencode-go` as a fourth provider: your OpenCode Go subscription
(`$10/month`, API key from <https://opencode.ai/auth>) driving an agent topic
with the same tools, permissions and `/btw` behaviour OpenRouter already has.

The hard part is that **one provider serves three wire formats**, and the
catalog does not say which model speaks which.

---

## Verified API facts

Everything below was probed against `https://opencode.ai/zen/go/v1` while
writing this document. Treat it as the source of truth over the public docs,
which lag the catalog.

| Probe | Result | Consequence |
|---|---|---|
| `GET /v1/models` (no auth) | `200`, bare OpenAI list `{id, object, created, owned_by}` | Catalog is **names only** — no dialect, no context window, no `supported_parameters`, no price. |
| `GET /v1/models` | also returns `glm-5`, `kimi-k2.5`, `deepseek-flash`, `mimo-v2-pro`, `mimo-v2-omni`, `qwen3.5-plus`, `grok-4.5`, `hy3-preview` | Eight ids the public docs table does not list. Do not hardcode the docs list. |
| `POST …/chat/completions` `model=grok-4.7` | `400/401 ModelError: "Model grok-4.7 is not supported for format oa-compat"` | Dialect is **server-enforced, named, and discoverable for free** — the model is validated before the key. |
| any POST without `x-opencode-session` | `400 MissingSessionID` | The header is **mandatory**, not advisory. |
| `GET /v1/usage` with a real key | `200 {"usage":{"rolling":…,"weekly":…,"monthly":…}}`, each `{status, percent, resetsAt}` | Plan limits are **already available**. No pricing table needed. |
| `GET /v1/usage` with no/bad key | `401 AuthError` (not 404) | Route exists and authenticates with `Authorization: Bearer`. |
| `GET /v1/models/<id>` | `404` (site HTML) | No per-model metadata endpoint. Capabilities are not discoverable from the catalog. |
| any error, any route | `{"type":"error","error":{"type":…,"message":…}}` | Anthropic-shaped envelope **on every route**, including `oa-compat`. `errorFromResponse` (`src/openrouter.ts:94`) must read `error.type` as the code. |

### Three dialects

| Dialect | Endpoint | Models | Auth header |
|---|---|---|---|
| `oa-compat` | `/v1/chat/completions` | GLM, Kimi, **Qwen**, **MiniMax**, LongCat, DeepSeek, MiMo, Hy | `Authorization: Bearer` |
| `messages` | `/v1/messages` | *not needed — see below* | **`x-api-key`** |
| `responses` | `/v1/responses` | Grok, GPT‑5.6 Luna, Muse Spark | `Authorization: Bearer` |

**Correction from live verification.** The table above is what the docs imply
and what a first pass implemented; sending real requests showed it is wrong in
one direction and needs care in the other.

- `qwen3.8-max` and `minimax-m3` are listed under `@ai-sdk/anthropic` in the
  docs and both answer `chat/completions` with **200**. That column describes
  how *OpenCode's own client* calls a model, not what the gateway accepts. So
  there is no Anthropic `messages` dialect to build: **the whole `messages`
  branch is dead**, and a rule that excluded Qwen and MiniMax would have hidden
  six working models from the picker.
- What does *not* answer `chat/completions` is exactly the `responses`
  families — `grok-4.7`, `grok-4.6`, `gpt-5.6-luna`,
  `muse-spark-1.3-contributor` all return
  `503 {"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}`.
  Without a key the gateway says it plainly instead:
  `401 ModelError … not supported for format oa-compat`.

So the real partition is one rule, not three: **everything is `oa-compat`
except `^(grok|gpt|muse)-`**, and only `responses` was left to build — which
it now is.

### The `responses` dialect, verified

Grok, GPT‑5.6 Luna and Muse answer only here. It is the one dialect whose state
cannot be rebuilt from the normalized transcript, so `ChatMessage.wire` earns
its place:

- **Tools are flat**, `{type:"function", name, description, parameters}`,
  unlike `chat/completions` where they nest under `function`.
- **Function calls are keyed by `call_id`**, and a tool result is a
  first-class `{type:"function_call_output", call_id, output}` item rather
  than a `role: "tool"` message.
- **`store: false` returns `reasoning` items encrypted**, and they must be
  replayed *before* the items they produced or the model loses its chain. The
  dialect stores them on the assistant message's `wire` and re-emits them in
  order; the sequence it builds is `reasoning → message → function_call →
  function_call_output`.
- The system prompt becomes top-level `instructions`, not a message.
- A failure can arrive inside a **200 body** as `error`, so `readResponse` may
  throw and the loop now turns that into an ordinary turn failure.

| Probe | Result |
|---|---|
| `input` + `tools` on `grok-4.7` | **200**, `output: [reasoning, function_call]`, `call_id` present |
| reasoning + `function_call` + `function_call_output` echoed back | **200**, model answers from the tool output |
| `instructions` (the system prompt) | **200** |
| `reasoning: {effort}` | **200** — an out-of-range value is accepted silently, so `/effort` cannot break a turn |
| `usage` | `input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens`, again **no `cost`** |

Error envelopes are mixed rather than uniformly Anthropic: `401` answers with
`{"type":"error","error":{…}}` and `503` with OpenAI's `{"error":{…}}`. The
parser reads `error.type` / `error.message` off either shape, which is why
classification works at all.

`x-api-key` remains the header `/v1/messages` wants — documented here because
if that dialect is ever built, a `Bearer` token produces a confusing
`401 Missing API key` while `Authorization` is clearly present.

**Verified directly:**

| Probe | Result |
|---|---|
| `chat/completions` + `reasoning: {effort:"low"}` on `kimi-k3` | **200** — `/effort` is wire-legal here, so the ladder stands as designed |
| `chat/completions` + a `tools` array on `kimi-k3` | **200**, `finish_reason: "tool_calls"` — function calling works end to end |
| response `usage` | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` — **no `cost`**, so `costUsd` comes back `null` and `/usage` must not invent dollars |

### Required headers on every request

```
User-Agent: ai-telegram-forum/<version>
x-opencode-session: <the topic's session UUID>
```

`x-opencode-session` must be stable per conversation. Every topic already owns
a session UUID (`AgentSettings.sessionId`), so this maps directly.

---

## Architecture

### The seam: `AgentLoop` (dialect-free) × `Dialect` (wire-only)

The loop is everything `src/openrouter-session.ts` already does well and must
not change: tool execution, the Telegram permission flow, context compaction,
`/btw`, interrupt, `tg_send`, history persistence.

It speaks a normalized message model:

```ts
ChatMessage =
  | { role: "system";  text: string }
  | { role: "user";    blocks: (TextBlock | ImageBlock)[] }
  | { role: "assistant"; text: string; calls: ToolCall[]; wire?: unknown }
  | { role: "tool";    callId: string; name: string; output: string }
```

`wire` is an **opaque per-dialect round-trip blob**. It exists because two of
the three dialects carry state that must be replayed:

- `responses` needs its `reasoning` items echoed back on the next request, or
  the model loses the chain and pays for it again.
- `messages` carries `cache_control` breakpoints for prompt caching.

`wire` is a cache, never a source of truth: the normalized history is
canonical, and changing dialect invalidates every `wire` blob.

### Dialect interface

```ts
interface Dialect {
  readonly format: "oa-compat" | "messages" | "responses";
  buildRequest(args: { model, messages, tools, effort, limits, sessionId }): Request;
  readResponse(json: unknown): { message: ChatMessage; usage: Usage; resolvedModel: string };
  toolResult(call: ToolCall, output: string): ChatMessage;
}
```

Three implementations. `src/openrouter.ts` collapses into `oa-compat` plus a
provider descriptor carrying the base URL, key and header set — so **OpenRouter
and OpenCode Go become two configurations of one dialect**, which is a
consolidation rather than duplication.

### Cross-dialect model switching

**Decision 1: allowed.** `/model` may move a topic to a model speaking a
different dialect.

The normalized transcript re-serializes cleanly into any of the three; only
`wire` blobs are dropped. The user loses prompt-cached prefixes and reasoning
continuity for the next turn, nothing else. Pinning the dialect at launch
would be simpler but would make "all models" false the moment someone runs
`/model grok-4.7` inside a topic that started on Kimi.

---

## Model profile resolution

The catalog cannot tell us a model's dialect, context window or capabilities,
so resolve a `ModelProfile` in three layers:

```ts
ModelProfile {
  dialect, contextWindow?, inputModalities?, supportsTools?,
  temperature?, reasoningShape?, price?
}
```

1. **Prefix rules (cold start).** The documented thirty models partition
   exactly by family name, and the rule also covers every undocumented id:

   | Rule | Dialect |
   |---|---|
   | `grok-`, `gpt-`, `muse-` | `responses` |
   | everything else | `oa-compat` |

2. **Per-id overrides** in `.env`, for when a rule is wrong.

3. **Error-driven correction.** `ModelError … not supported for format X` is
   free, unambiguous, and names the right format. Cache the answer in SQLite
   (`src/db.ts`) per model id. This is what keeps "all models" true as their
   catalog churns — the API tells us when we guessed wrong instead of the user
   seeing a broken turn.

`inputModalities` and `supportsTools` follow the same path: default by rule,
corrected by the server's answer. Reuse the job
`openRouterCapabilityError` (`src/openrouter.ts:227`) already does.

---

## `/usage`

**Decision 2: fetch, do not compute.**

`GET /v1/usage` already returns `percent` + `resetsAt` for three windows, which
is exactly the `LimitWindow { label, utilization, resetsAt }` shape
(`src/limits.ts:7`) that `planLimitsText` (`src/limits.ts:84`) already renders
with `bar()` and `humanUntil()`. The live response:

```json
{"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"…"},
          "weekly": {"status":"ok","percent":1,"resetsAt":"…"},
          "monthly":{"status":"ok","percent":0,"resetsAt":"…"}}}
```

So the Go `/usage` path is one HTTP request and an existing renderer:
`src/go-limits.ts` maps `rolling → "5h"`, `weekly → "Week"`, `monthly →
"Month"`. Everything is labelled as *the provider's own accounting*, never as a
number the bot derived.

```
rolling → "5h"     weekly → "Week"    monthly → "Month"
```

The local pricing table discussed earlier is **out of scope** — the endpoint
makes it redundant for plan limits. Token counts per topic still come from each
response's `usage`, as OpenRouter does today.

Known limits of this endpoint, to be reflected in copy rather than hidden:

- It is aggregate, not per-model, so a model-level breakdown is not available.
- It reports percentages, not dollars spent or remaining.
- Hitting 100% does not necessarily mean blocked: the Zen **"Use balance"**
  fallback can absorb further requests. Never render 100% as a hard stop.
- The percent reflects the subscription's own accounting; label it as reported
  by OpenCode rather than computed by the bot.

---

## `/effort`

**Decision 3: numeric budget with examples for `messages` dialect models.**

Three dialects express reasoning differently:

| | `oa-compat` | `messages` | `responses` |
|---|---|---|---|
| request | `reasoning: {effort}` | `thinking: {type:"enabled", budget_tokens}` | `reasoning: {effort, summary}` |
| values | `low/medium/high` | integer token budget | `low/medium/high` |

A four-level ladder cannot map onto a token budget without a lossy step, so
rather than hiding it, expose the number and show the ladder as examples:

```
🧠 Размышление — budget_tokens
Qwen3.7 Plus ожидает число токенов

[ 1024 — быстро ]   [ 4096 — сбалансированно ]
[ 8192 — глубоко ]  [ 16384 — максимум ]

Своё число:  /effort 12000
Сбросить:    /effort default
```

The command surface stays `/effort <arg>` everywhere; only the picker differs.
Show the numeric picker when the profile declares a budget-shaped
`reasoningShape`, the ordinary ladder otherwise.

---

## Command surface

| Command | Go behaviour |
|---|---|
| `/model` | picker rendered from `GET /v1/models`, curated ordering on top, `/model <id>` for anything else |
| `/effort` | numeric budget (above) for `messages` dialect, ladder otherwise |
| `/usage` | fetched plan windows, rendered by the existing `planLimitsText` |
| `/btw`, `/stop`, `/progress`, `/toolcalls`, `/id` | unchanged |
| `/resume` | **hidden** — see below |
| `/telegramify` / `/codexify` | **hidden for Go** — see below |
| `/export` | **new** — dump the topic's normalized transcript as Markdown |

### Why `/resume` and `/telegramify` are hidden

Both depend on a **native CLI transcript on disk**: Claude Code keeps
`~/.claude/projects/**.jsonl`, Codex keeps `~/.codex/sessions/**`. `telegramify`
writes a topic row pointing at a session id that already exists ("adoption
binds, it doesn't copy", `AGENTS.md`), and `/resume` prints the terminal
command that reopens that same session.

OpenCode Go has no CLI and no provider-side transcript. The bot's own JSONL
under `data/` is the entire record, so there is nothing to bind to and nothing
to `--resume`. Printing an `opencode --model opencode-go/…` command would start
a conversation sharing nothing with the topic — worse than not offering it.

`/export` is the replacement: the repo's rule is that a transcript is the
user's work and outlives its topic, and Go topics need some portability.

---

## Model warnings

**Decision 4: warn on Muse Spark.** The Muse Spark Contributor tier trains on
your prompts and completions and is not zero-data-retention. Show a ⚠️ marker
in the model picker for `muse-spark-*` ids so the choice stays deliberate.

---

## Configuration

Hidden from `/provider` while empty, exactly like OpenRouter
(`src/config.ts:49`):

```ini
# OpenCode Go subscription (https://opencode.ai/auth)
OPENCODE_GO_API_KEY=oc_sk_...
OPENCODE_GO_MODEL=glm-5.2
OPENCODE_GO_PRESETS={"Kimi":{"model":"kimi-k3"},"Cheap":{"model":"glm-5.3-flash"}}
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
```

`PROVIDER=opencode-go` with an empty key is a startup error, matching the
existing `PROVIDER=openrouter` guard (`src/config.ts:60`).

Go presets join the shared launch picker (`src/launch-preset.ts:27`); choosing
one switches the new topic to `opencode-go`, the way an OpenRouter preset does
today.

### Files touched

| File | Change |
|---|---|
| `src/provider.ts` | add `"opencode-go"`, label, picker option |
| `src/config.ts` | new env keys, enablement guard |
| `src/openrouter.ts` | split into `AgentLoop` + `Dialect`; OpenRouter becomes a descriptor |
| `src/openrouter-session.ts` | dialect-driven loop; drop OpenRouter-specific strings |
| `src/openrouter-tools.ts` | unchanged behaviour, provider-neutral naming |
| `src/agent-session.ts` | `createAgentSession` branch |
| `src/model.ts` | `defaultModel` / `modelGroup` / `parseModel` branches |
| `src/launch-preset.ts` | Go presets in the launcher group |
| `src/limits.ts` | accept an HTTP-fetched `PlanLimits` alongside the CLI query |
| `src/index.ts` | `/export`, hide `/resume` for Go |
| `src/db.ts` | model → profile cache, `/export` needs nothing new |
| `.env.example`, `README.md`, `AGENTS.md`, `package.json` | docs |

No new runtime dependency; the project stays dependency-light as `AGENTS.md`
requires.

---

## Delivery — Variant A, one more commit than planned

One PR. Every commit must pass `npm run typecheck` and `npm test`, so any
point in the history is buildable. The live probes above split commit 2 in two:
the `messages` dialect turned out not to exist, so the remaining work after
the provider was a single family rather than two.

1. ✅ `docs: design the OpenCode Go provider`
2. ✅ `refactor: split the OpenRouter turn runner into Dialect and AgentLoop`
3. ✅ `feat: add the opencode-go provider` — transport, `oa-compat` dialect,
   family rule, catalog-driven picker, presets, `/provider`, and the refusal
   path for models this build cannot serve.
4. ✅ `feat: speak the responses dialect for Grok, GPT-5.6 Luna and Muse` —
   flat tools, `call_id` tool results, top-level `instructions`, and the
   encrypted `reasoning` items replayed in order through `ChatMessage.wire`.
5. ✅ `feat: report OpenCode plan limits from /v1/usage` — one HTTP call mapped
   onto the meter `planLimitsText` already renders, so no pricing table was
   ever needed.
6. `feat: /export, hide resume for opencode-go, warn on Muse Spark`

Merged only when all four land and the bot has been exercised live.

---

## Open risks

- **Their catalog churns.** The family rule is a default, not a contract — and
  it has already been wrong once, in the direction that would have hidden
  working models. Keep the error-driven correction in mind even though the
  rule now only excludes one family.
- **Both wire formats are implemented**, so every catalog family resolves to a
  dialect and the refusal path is now reserved for a format nobody has seen.
  That path is still worth keeping: the family rule has already been wrong
  once, in the direction that would have hidden working models.
- **Go reports no dollars.** `usage` carries tokens and cached tokens only, on
  both routes, so `costUsd` is always `null` and the turn summary shows tokens
  alone. `/usage` must not synthesise a price.
- **The bot has never been run against Telegram.** Everything here is
  typecheck, unit tests and direct calls to the gateway; the message → topic →
  agent → reply path has not been exercised once. Do that before calling the
  integration done.
- **Key handling.** The key never leaves `.env`.
