# Changelog

## 1.1.0 — 2026-11-23

Made this plugin good enough to replace `dsh-voice-prompt-enhancer@3.5.1` on this
machine (see `docs/PROVENANCE.md` §1.1.0 for what was adopted and what was not).

### Added

- **Cancel**: the busy button cancels the host call and restores the snapshot.
- **Progress**: a 500 ms poll against `GET /progress` reports stage, model index
  and elapsed time; the poll stops itself if a call hangs.
- **Model chain** with per-model retry: order comes from `models[]`, then the
  session route, then the harness default; backoff follows
  `llm.providerRetryPolicy`, capped at 3 attempts per model.
- **Truncation reporting**: a `max-tokens` finish is accepted and flagged.
- **Output cap**: a rewrite longer than `maxOutputChars` is refused, not cut.
- **Per-session state**, a dismissable **error bar**, **i18n** (zh/en) through the
  locale service, and a **settings section** that persists to
  `$DSH_HOME/.dsh-prompt-enhance-wb/config.json`.
- **Optional memory chain**: up to 4 accepted rewrites carried as conversation
  turns; a revert pops the round it belonged to.
- **Slash-command handling**: only the body is rewritten; the prefix is restored
  verbatim.
- **Semantics block** in the prompt: pragmatic type is preserved, numbers/ranges/
  versions are copied, restatement is deterministic.
- **Host routes**: `POST /enhance`, `GET /progress`, `POST /cancel`,
  `GET|POST /config` with a same-origin fence and a bounded body.
- **82 tests** (`npm test`): pure modules, host routes against a stubbed
  `llm`/`webServer`, and the client components against a stubbed React.

### Changed

- Fidelity: rewrapped code spans are no longer reported as losses; paths stop at
  CJK punctuation instead of swallowing it; camelCase identifiers are enforced.
- `minRatio` no longer fires on a rewrite that is merely a little shorter.
- The bundle row is documented as a **seed**; the saved config wins over it.

### Fixed

- Late results no longer overwrite text typed while the model was running.
- A failure no longer leaves the control stuck in its busy state.
- The plugin no longer assumes the session's `requestHeader` is a property.
