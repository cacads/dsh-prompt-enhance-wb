# Where the prompt came from

The enhancement prompt in `src/prompts.js` is built on the one WorkBuddy
(Tencent) ships for the "增强提示词" button in its composer. That prompt is not
publicly documented; it was read out of the installed desktop client.

## How it was recovered

- Install root: `C:\Users\cacad\AppData\Local\Programs\WorkBuddy`
- The Electron archive `resources\app.asar` (172,939,770 bytes) holds the code.
  Read-only extraction of its header plus targeted reads of `main/server.js`.
- The enhancement lived in `main/server.js` at a single site:

```js
var Vr = `enhance-prompt`, Hr = `lite`,
    Ur = `You are a Prompt Engineering Expert ...`,   // system prompt
    Wr = `You are a prompt enhancement assistant ...`; // user template with {input}

function renderUserPrompt(e) { return Wr.replace(`{input}`, e) }

async function handleEnhancePrompt(e, t) {
  // empty input → { success:false, code:'empty_input' }
  const r = await e.getSidecarEndpoint()
  const i = await e.createClient(r).runAgent({
    systemPrompt: Ur,
    userPrompt: renderUserPrompt(n),
    agentName: Vr,      // 'enhance-prompt'
    model: Hr,          // 'lite'
  })
  return { success: true, text: stripWrappingQuotes(i.text) }
}
```

Registered as the IPC method `llm:enhancePrompt`.

## What the client actually sends

Two prompts are involved; the **user** template is the one that runs per call.

**System prompt** (`Ur`) — establishes the expert role, the analysis process,
and the constraints. Its distinctive part is the negative list:

> Do NOT request guides/how-tos unless the user asks
> Do NOT ask for code snippets
> Do NOT suggest specific technologies unless mentioned in the user's prompt
> Do NOT explain HOW to do things, focus on WHAT
> Do NOT answer questions — expand/rewrite them to be more detailed
>
> Language matching is the highest priority.
> Keep the enhanced prompt concise — maximum length should be around 800 characters.

It also carries two few-shot pairs (`"A website for my dog"`, and a
tone-conversion request).

**User template** (`Wr`) — a second, longer instruction with its own
language-consistency block (including a BAD/GOOD output pair that forbids
emitting meta notes like "User input is in Chinese"), seven enhancement
requirements, and three language examples (Chinese, English, mixed). Note it
says "Always make a substantive enhancement when possible" — WorkBuddy leans
toward rewriting even a clear draft, which is the opposite of
`dsh-improve-prompt`'s "changing nothing is a correct outcome".

## What this plugin changed

| Aspect | WorkBuddy | Here |
|---|---|---|
| Structure | one 800-char system prompt, one user template | one system prompt; the user message only frames the draft |
| Audience | "for a development code assistant" (inherited from CodeBuddy) | generic assistant; the clause was dropped |
| Negative list | present | **kept verbatim as `[WB]`** |
| Fidelity | "be realistic", no mechanism | `[DIP]` block + `src/fidelity.js` reports losses |
| Length | upper bound only (800 chars) | upper bound from config + a lower bound against no-op rewrites |
| Injection | none | `<raw_prompt>` framing with closing-tag neutralization |
| Model | dedicated `lite` model | the session's own route (config-overridable) |

Blocks are tagged `[WB]` (WorkBuddy original), `[DIP]` (dsh-improve-prompt) and
`[SPE]` (@surfishs/dsh-prompt-enhance) in the source.

## Note on the comparison

The other two DSH plugins were read from their published tarballs
(`dsh-improve-prompt@0.7.3`, `@surfishs/dsh-prompt-enhance@0.1.8`) so the
comparison rests on their actual prompt text, not their listing copy.

## 1.1.0: what came from `dsh-voice-prompt-enhancer`

Version 1.1.0 replaced a competing plugin on this machine
(`dsh-voice-prompt-enhancer@3.5.1`, Apache-2.0, `Fishsb/dsh-voice-prompt-enhancer`),
so its installed copy was read first and its hard-won behaviours were adopted
where they were cheaper to reuse than to rediscover. Blocks taken from it are
tagged `[VPE]` in `src/prompts.js`.

**Adopted (behaviour, re-implemented here):**

| Behaviour | Where it came from |
|---|---|
| Cancel = button click while running; snapshot restored immediately | its `cancelEnhance` (client half) |
| Late-result guard: a reply that lands after the user edited the draft is dropped | its `draftRef.current !== session.backup` check |
| Per-session state keyed by `sessionId` | its `sessionStores` map |
| Progress polling (500 ms) with stage/model/elapsed | its `enhance/progress` RPC |
| Provider retry policy read from `llm.providerRetryPolicy`, same backoff formula | its `computeBackoffDelayMs` / `isRetryableFailure` |
| Model chain: try in order, fall through on failure | its `buildTryChain` |
| `max-tokens` finish means "truncated", not "failed" | its `collectStream` kinds |
| Memory chain: up to 4 accepted rounds as real conversation turns | its `buildChatMessages` |
| Slash command: rewrite the body, keep the prefix | its `splitCommand` |
| Semantics block (pragmatic type, verbatim numbers/ranges, stability) | distilled from its discipline prompt |
| Visible error bar instead of a tooltip | its `EnhanceBar` |

**Deliberately not adopted:** its retrieval pipeline (session rounds, workspace
document scan, web search for the `publish` mode), its five modes and the
templates behind them, its 19 s watchdog and connectivity probe (tuned to one
machine's TTFT), its layered retry (2 passes × backoff), and its dual
localStorage + JSON config sync. Those are either product lines this plugin does
not have, or workarounds for problems the harness has since solved.

The plugin's own prompt text was not copied: the backbone here is still
WorkBuddy's `[WB]` prompt, extended rather than replaced.

