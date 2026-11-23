# dsh-prompt-enhance-wb

An "enhance prompt" button in the DSH composer, built on the prompt WorkBuddy
(Tencent) ships for its own enhance button — read out of the installed client,
not reconstructed from observation. See [PROVENANCE](docs/PROVENANCE.md) for the
extraction, and for what 1.1.0 adopted from `dsh-voice-prompt-enhancer`.

## What it does

Click **✦ 增强提示词** beside the submit button and the draft is rewritten into a
more effective prompt. The original is snapshotted first, the button flips to
**↺ 恢复原文**, and clicking it restores exactly what you typed.

While the model runs the same button becomes **取消**: a click stops the call and
restores the draft immediately. Progress is read from the host every 500 ms, so
the button shows which model is being tried (`1/2 · deepseek-flash`) and, after a
few seconds, how long it has been running.

The rewrite goes through the harness LLM service, so it needs no API key and
costs the same model your session already uses.

## What it adds over WorkBuddy's own prompt

WorkBuddy's prompt is a strong backbone with two holes. Both are filled here:

| | WorkBuddy | Here |
|---|---|---|
| Upper length bound | 800 chars | `maxOutputChars` (default 4000) |
| Lower length bound | none — the model may "rephrase" and call it done | a rewrite markedly shorter than the draft raises a warning |
| Fidelity of hard facts | "be realistic", no mechanism | every path, URL, number, identifier and code span is extracted and compared; losses are reported (and can block) |
| Semantics | not stated | question stays a question; numbers, ranges and versions are copied, never "tidied"; restatement is deterministic |
| Injection | none | the draft is framed in `<raw_prompt>` with closing-tag neutralization |
| Model | a dedicated cheap `lite` model | the session's own route, or a configured chain |

The negative list WorkBuddy is unusual for — *don't ask for code snippets, don't
suggest stacks, don't explain HOW, don't answer the question* — is kept verbatim.

## Beyond the single call (1.1.0)

| Behaviour | Detail |
|---|---|
| Cancel | button click while running aborts the host call and restores the draft |
| Late results | a reply that lands after you edited or sent the draft is dropped |
| Per-session state | two composers never share a snapshot or a memory chain |
| Model chain | configured models are tried in order; a failure falls through to the next |
| Retry | reads `llm.providerRetryPolicy(provider)` and applies the harness's own backoff formula, capped at 3 attempts per model |
| Truncation | a `max-tokens` finish is accepted, reported as `⚠`, and never mistaken for a failure |
| Slash commands | `/command ` prefix is preserved; only the body is rewritten |
| Memory chain | optional; carries up to 4 accepted rewrites as real conversation turns |
| Errors | a visible bar under the composer (dismissable), not only a tooltip |
| Settings | a **设置 → 提示词增强** section that saves through the host |

## Configuration

Two layers. The **settings page** is the normal way; it writes
`$DSH_HOME/.dsh-prompt-enhance-wb/config.json` (atomic write, outside the package
directory so a reinstall cannot reset it). The row in the profile's
`cordis.patch.yml` is only a seed, and the saved file wins over it.

| Field | Default | Meaning |
|---|---|---|
| `maxInputChars` | 8000 | refuse longer drafts |
| `maxOutputChars` | 4000 | upper bound in the instruction, and the hard cap on the answer |
| `timeoutMs` | 90000 | whole-call budget across every model attempt |
| `temperature` | 0.3 | sampling temperature; negative leaves the provider default |
| `minRatio` | 0.6 | below this the rewrite is flagged as too short |
| `rejectOnFidelityLoss` | false | true = block the rewrite instead of warning |
| `memory` | false | carry accepted rewrites into the next call |
| `models` | `[]` | `[{provider, model}]` tried in order; empty = session route, then harness default |

```yaml
- insert:
    - id: dsh-prompt-enhance-wb
      name: dsh-prompt-enhance-wb
      config:
        maxOutputChars: 4000
        memory: true
        models:
          - { provider: deepseek-account, model: deepseek-flash }
```

## Verifying it works

1. Open a session, put a rough sentence in the composer.
2. Click **✦ 增强提示词** — the draft is replaced and the button becomes **恢复原文**.
   While it runs, the button reads **取消**; clicking it restores your text.
3. Click **恢复原文** — the original text returns.

A `⚠` next to the button means the rewrite was flagged: hover it to see whether
hard facts went missing, the result came back too short, or the output hit the
model's limit. An error bar under the composer names the failure and can be
dismissed.

## Tests

```sh
npm test        # node --test test — 82 assertions over the pure modules,
                # the host routes (with a stubbed llm/webServer) and the client
                # components (with a stubbed React)
```

## Limitations

- The button writes the result back with `setDraft`, which replaces the whole
  draft and drops inline `@` reference chips. Drafts that are mostly chips will
  lose them; the original text is still one click away.
- No token streaming: the rewrite appears once the model finishes. Progress shows
  the stage and model, not partial text.
- The fidelity check is regex-based. It catches paths, URLs, numbers, code spans
  and identifiers, not paraphrased requirements.
- No retrieval: unlike `dsh-voice-prompt-enhancer`, this plugin does not pull
  session history, workspace documents or web results into the prompt.
