# dsh-prompt-enhance-wb

An "enhance prompt" button in the DSH composer, built on the prompt WorkBuddy
(Tencent) ships for its own enhance button — read out of the installed client,
not reconstructed from observation. See [PROVENANCE](docs/PROVENANCE.md) for the
extraction.

## What it does

Click **✦ 增强提示词** beside the submit button and the draft is rewritten into a
more effective prompt. The original is snapshotted first, the button flips to
**↺ 恢复原文**, and clicking it restores exactly what you typed.

The rewrite goes through the harness LLM service, so it needs no API key and
costs the same model your session already uses.

## What it adds over WorkBuddy's own prompt

WorkBuddy's prompt is a strong backbone with two holes. Both are filled here:

| | WorkBuddy | Here |
|---|---|---|
| Upper length bound | 800 chars | `maxOutputChars` (default 4000) |
| Lower length bound | none — the model may "rephrase" and call it done | a rewrite markedly shorter than the draft raises a warning |
| Fidelity of hard facts | "be realistic", no mechanism | every path, URL, number, identifier and code span is extracted and compared; losses are reported |
| Injection | none | the draft is framed in `<raw_prompt>` with closing-tag neutralization |
| Model | a dedicated cheap `lite` model | the session's own route |

The negative list WorkBuddy is unusual for — *don't ask for code snippets, don't
suggest stacks, don't explain HOW, don't answer the question* — is kept verbatim.

## Configuration

Edit the row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-prompt-enhance-wb
      name: dsh-prompt-enhance-wb
      config:
        maxInputChars: 8000        # refuse longer drafts
        maxOutputChars: 4000       # upper length bound in the instruction
        timeoutMs: 60000
        minRatio: 0.6              # below this the rewrite is flagged as too short
        rejectOnFidelityLoss: false  # true = block the rewrite instead of warning
        provider: ''               # blank = session route, then harness default
        model: ''
```

`rejectOnFidelityLoss` is the reserved seam: the fidelity report is already
computed on every call, so enforcing it is a config flip rather than a code
change.

## Verifying it works

1. Open a session, put a rough sentence in the composer.
2. Click **✦ 增强提示词** — it should be replaced, and the button becomes **恢复原文**.
3. Click **恢复原文** — the original text returns.

A `⚠` next to the button means the rewrite was flagged: hover it to see whether
hard facts went missing or the result came back too short.

## Limitations

- The button writes the result back with `setDraft`, which replaces the whole
  draft and drops inline `@` reference chips. Drafts that are mostly chips will
  lose them; the original text is still one click away.
- No streaming: the rewrite appears once the model finishes.
- The fidelity check is regex-based. It catches paths, URLs, numbers, code spans
  and identifiers, not paraphrased requirements.
