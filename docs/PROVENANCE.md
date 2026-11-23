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
