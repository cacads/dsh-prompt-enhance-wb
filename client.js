/**
 * The browser half: one enhance control in the composer tool row.
 *
 * Interaction mirrors WorkBuddy's — the button rewrites the draft in place, the
 * original is snapshotted first, a second click restores it — with the pieces a
 * second-generation enhancer needs:
 *
 * - a **cancel** state: while the model runs the button cancels instead of
 *   ignoring the click, and progress is polled from the host 500 ms at a time;
 * - a **late-result guard**: if the user edits or sends the draft while the
 *   rewrite is in flight, the arriving result is dropped instead of overwriting
 *   what the user typed;
 * - **per-session state**, so two composers never share a snapshot;
 * - visible **warnings** (fidelity loss, a rewrite that is too short) and a
 *   visible **error bar** instead of a tooltip nobody hovers;
 * - a **settings section** that persists through the host.
 *
 * Everything lives inside the factory closure: `require` only exists there, and
 * a plugin client module is a single file by contract (no relative imports).
 * @module dsh-prompt-enhance-wb/client
 */

window.__ModuleLoader__.load({
  // Must equal the package name: it addresses this module in the boot graph.
  id: 'dsh-prompt-enhance-wb',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-enhance-wb'
    const ROUTES = {
      enhance: '/dsh-prompt-enhance-wb/enhance',
      progress: '/dsh-prompt-enhance-wb/progress',
      cancel: '/dsh-prompt-enhance-wb/cancel',
      config: '/dsh-prompt-enhance-wb/config',
    }
    const POLL_MS = 500
    const MEMORY_ROUNDS_MAX = 4

    const ZH = {
      button: '增强提示词',
      buttonContinue: '继续优化',
      buttonResult: '恢复原文',
      busy: '增强中',
      busyModel: '{n}/{total} 增强中',
      busyStage: '校验中',
      busyQueue: '准备中',
      titleIdle: '把当前草稿改写为更有效的提示词',
      titleBusy: '点击取消',
      titleResult: '点击恢复增强前的原文',
      titleContinue: '按上一轮结果继续完善',
      cancel: '取消',
      errorPrefix: '增强失败：',
      dismiss: '知道了',
      warnedFidelity: '有硬事实可能丢失，悬停查看',
      warnedShorter: '改写结果明显短于原文',
      warnedTruncated: '输出触到模型上限，结果可能被截断',
      errEmpty: '草稿为空',
      errTooLong: '草稿超长，请先精简',
      errTooLongResult: '改写结果超出长度上限',
      errUnconfigured: '未配置任何模型路由',
      errLlm: '模型调用失败，请重试',
      errTimeout: '请求超时，已恢复原文',
      errCancelled: '已取消',
      errFidelity: '改写丢失了硬事实，已阻止',
      errEmptyResult: '模型返回空结果',
      errUnknown: '未知错误',
      settingsNav: '提示词增强',
      settingsTitle: '提示词增强（WorkBuddy 式）',
      settingsIntro: '输入框右侧的增强按钮：把草稿改写为更有效的提示词，并检查硬事实是否保真。',
      settingsModels: '模型链（每行 provider/model，留空 = 跟随当前会话）',
      settingsModelsHint: '按顺序尝试，失败自动换下一条。留空时使用会话自己的模型，再退回 Harness 默认。',
      settingsLimits: '长度与预算',
      settingsMaxInput: '草稿上限（字符）',
      settingsMaxOutput: '改写上限（字符）',
      settingsTimeout: '整体超时（毫秒）',
      settingsMinRatio: '过短阈值（0–1）',
      settingsMemory: '记忆链（把已确认的改写带入下一轮，最多 4 轮）',
      settingsFidelity: '硬事实丢失时阻止改写（默认只警告）',
      settingsSave: '保存',
      settingsSaved: '已保存',
      settingsSaving: '保存中…',
      settingsFailed: '保存失败',
    }

    const EN = {
      button: 'Enhance prompt',
      buttonContinue: 'Continue',
      buttonResult: 'Restore',
      busy: 'Enhancing',
      busyModel: '{n}/{total} Enhancing',
      busyStage: 'Checking',
      busyQueue: 'Preparing',
      titleIdle: 'Rewrite the draft into a more effective prompt',
      titleBusy: 'Click to cancel',
      titleResult: 'Click to restore the original draft',
      titleContinue: 'Refine the previous rewrite',
      cancel: 'Cancel',
      errorPrefix: 'Enhance failed: ',
      dismiss: 'Dismiss',
      warnedFidelity: 'Hard facts may have been dropped — hover for detail',
      warnedShorter: 'The rewrite is much shorter than the draft',
      warnedTruncated: 'Output hit the model limit and may be truncated',
      errEmpty: 'The draft is empty',
      errTooLong: 'The draft is too long — shorten it first',
      errTooLongResult: 'The rewrite exceeded the length limit',
      errUnconfigured: 'No model route is configured',
      errLlm: 'The model call failed — try again',
      errTimeout: 'Timed out; the original draft was restored',
      errCancelled: 'Cancelled',
      errFidelity: 'Hard facts were lost — the rewrite was blocked',
      errEmptyResult: 'The model returned nothing',
      errUnknown: 'Unknown error',
      settingsNav: 'Prompt enhance',
      settingsTitle: 'Prompt enhance (WorkBuddy style)',
      settingsIntro: 'The enhance control beside the composer rewrites a draft into a more effective prompt and checks hard facts for fidelity.',
      settingsModels: 'Model chain (one provider/model per line; empty = follow the session)',
      settingsModelsHint: 'Tried in order; a failure moves to the next. Empty uses the session route, then the harness default.',
      settingsLimits: 'Length and budget',
      settingsMaxInput: 'Draft limit (characters)',
      settingsMaxOutput: 'Rewrite limit (characters)',
      settingsTimeout: 'Overall timeout (ms)',
      settingsMinRatio: 'Too-short ratio (0–1)',
      settingsMemory: 'Memory chain (carry accepted rewrites into the next call, up to 4)',
      settingsFidelity: 'Block a rewrite that dropped hard facts (warn only by default)',
      settingsSave: 'Save',
      settingsSaved: 'Saved',
      settingsSaving: 'Saving…',
      settingsFailed: 'Save failed',
    }

    const DICTS = { zh: ZH, en: EN }

    /** Machine error codes mapped onto dictionary keys. */
    const ERROR_KEYS = {
      empty: 'errEmpty',
      'too-long': 'errTooLong',
      'too-long-result': 'errTooLongResult',
      unconfigured: 'errUnconfigured',
      llm: 'errLlm',
      timeout: 'errTimeout',
      cancelled: 'errCancelled',
      fidelity: 'errFidelity',
      'empty-result': 'errEmptyResult',
    }

    const CSS = `
.wb-penh{display:inline-flex;align-items:center;gap:6px}
.wb-penh-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:24px;white-space:nowrap;cursor:pointer}
.wb-penh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.wb-penh-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4c8dff);outline-offset:1px}
.wb-penh-btn:disabled{cursor:default;opacity:.5}
.wb-penh-btn--result{border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.wb-penh-btn--error{color:var(--dsw-alias-state-error,#d33)}
.wb-penh-spin{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;animation:wb-penh-spin .8s linear infinite;display:inline-block}
@keyframes wb-penh-spin{to{transform:rotate(360deg)}}
.wb-penh-warn{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-state-warn,#b8860b);cursor:help}
.wb-penh-bar{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:4px 8px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.25));font-size:12px;color:var(--dsw-alias-state-error,#d33)}
.wb-penh-bar-btn{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;cursor:pointer;padding:2px 4px}
.wb-penh-settings{display:flex;flex-direction:column;gap:14px;max-width:640px;padding:4px 0}
.wb-penh-settings h3{margin:0;font-size:15px}
.wb-penh-settings p{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.wb-penh-field{display:flex;flex-direction:column;gap:4px}
.wb-penh-field label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.wb-penh-field input[type=text],.wb-penh-field input[type=number],.wb-penh-field textarea{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:13px}
.wb-penh-field textarea{min-height:72px;resize:vertical;font-family:ui-monospace,monospace}
.wb-penh-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wb-penh-check{display:flex;align-items:center;gap:8px;font-size:13px}
.wb-penh-actions{display:flex;align-items:center;gap:10px}
.wb-penh-save{padding:5px 14px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-brand-primary,#4c8dff);background:var(--dsw-alias-brand-primary,#4c8dff);color:#fff;font-size:13px;cursor:pointer}
.wb-penh-save:disabled{opacity:.5;cursor:default}
.wb-penh-status{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
`

    // -----------------------------------------------------------------------
    // Module state
    // -----------------------------------------------------------------------

    /** Per-session enhancement state, keyed by session id. */
    const stores = new Map()

    /** Live configuration, as last read from or written to the host. */
    const configState = {
      value: {
        maxInputChars: 8000,
        maxOutputChars: 4000,
        timeoutMs: 90000,
        temperature: 0.3,
        minRatio: 0.6,
        rejectOnFidelityLoss: false,
        memory: false,
        models: [],
      },
      loaded: false,
    }

    /** Translator, replaced once the locale service is read. */
    let translate = key => EN[key] ?? ZH[key] ?? key

    /** Timer service from the client context, when the host provides one. */
    let timerService = null

    /** Locale registrations to dispose on unload. */
    const localeDisposers = []

    /**
     * Read one per-session store, creating it on first use.
     * @param {string} sessionId - session key ('' when unknown).
     * @returns {object} the store.
     */
    function storeFor(sessionId) {
      const key = sessionId === '' ? '(none)' : sessionId
      let store = stores.get(key)
      if (store !== undefined) return store
      store = {
        phase: 'idle',
        backup: '',
        enhanced: '',
        error: '',
        errorDetail: '',
        warnings: [],
        seq: 0,
        optimized: false,
        memoryRounds: [],
        lastModel: '',
        fallbackUsed: false,
        truncated: false,
        progress: null,
        listeners: new Set(),
      }
      stores.set(key, store)
      return store
    }

    /**
     * Re-render every component watching one store.
     * @param {object} store - the store.
     * @returns {void}
     */
    function notify(store) {
      for (const listener of [...store.listeners]) {
        try { listener() } catch { /* one bad subscriber must not stop the others */ }
      }
    }

    /** Interpolate `{name}` placeholders the way the locale service does. */
    function interpolate(template, params) {
      if (params === null || params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) => {
        const value = params[name]
        return value === undefined ? whole : String(value)
      })
    }

    /**
     * Build the translator.
     *
     * The locale service wins when it has the namespace; the built-in
     * dictionaries are the fallback so the control still reads correctly when
     * registration was skipped (a duplicate registration on hot reload throws
     * by design).
     * @param {object|undefined} locale - locale service.
     * @returns {(key: string, params?: object) => string} translator.
     */
    function makeT(locale) {
      let bound = null
      let language = 'en'
      try {
        if (locale !== undefined && locale !== null) {
          if (typeof locale.bind === 'function') bound = locale.bind(NS)
          if (typeof locale.getLocale === 'function') {
            const snapshot = locale.getLocale()
            if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.active === 'string') {
              language = snapshot.active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
            }
          }
        }
      } catch {
        bound = null
      }
      const table = DICTS[language] ?? EN
      return (key, params) => {
        if (bound !== null) {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value !== key) return value
          } catch { /* fall through to the built-in table */ }
        }
        return interpolate(table[key] ?? EN[key] ?? key, params)
      }
    }

    /**
     * fetch + JSON, without throwing.
     * @param {string} url - target.
     * @param {object} [init] - fetch init.
     * @returns {Promise<{response: object|null, payload: object|null, error?: unknown}>} the exchange.
     */
    async function requestJson(url, init) {
      try {
        const response = await fetch(url, init)
        const payload = await response.json().catch(() => null)
        return { response, payload }
      } catch (error) {
        return { response: null, payload: null, error }
      }
    }

    /**
     * Split a slash command off the draft.
     *
     * Only the body is rewritten; `/command ` stays as the user typed it. The
     * snapshot keeps the whole draft so a revert restores the command too.
     * @param {string} draft - composer text.
     * @returns {{prefix: string, body: string}} the split.
     */
    function splitCommand(draft) {
      const match = /^(\/\S+)(\s+)([\s\S]*)$/.exec(draft)
      if (match !== null) return { prefix: match[1] + match[2], body: match[3] }
      return { prefix: '', body: draft }
    }

    /**
     * Whether the draft can be enhanced at all.
     * @param {string} draft - composer text.
     * @returns {boolean} whether enhancement is allowed.
     */
    function canEnhance(draft) {
      if (draft.trim() === '') return false
      if (draft.startsWith('/')) return /^\/\S+\s+\S+/.test(draft)
      return true
    }

    /** Short model label for the busy state. */
    function shortModel(model) {
      if (typeof model !== 'string' || model === '') return ''
      const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
      return tail.length > 24 ? `${tail.slice(0, 22)}…` : tail
    }

    // -----------------------------------------------------------------------
    // Network flows
    // -----------------------------------------------------------------------

    let configPromise = null

    /**
     * Read the effective config once, then share the promise.
     * @returns {Promise<object>} the config.
     */
    function loadConfig() {
      if (configPromise !== null) return configPromise
      configPromise = requestJson(ROUTES.config, { method: 'GET' }).then(({ payload }) => {
        if (payload !== null && payload.ok === true && payload.config !== null && typeof payload.config === 'object') {
          configState.value = payload.config
          configState.loaded = true
        }
        return configState.value
      })
      return configPromise
    }

    /**
     * Save a config patch.
     * @param {object} patch - changed fields.
     * @returns {Promise<boolean>} whether the save was accepted.
     */
    async function saveConfig(patch) {
      const { payload } = await requestJson(ROUTES.config, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: patch }),
      })
      if (payload !== null && payload.ok === true && typeof payload.config === 'object' && payload.config !== null) {
        configState.value = payload.config
        configState.loaded = true
        return true
      }
      return false
    }

    /**
     * Start the 500 ms progress poll for one call.
     * @param {object} store - session store.
     * @param {string} key - `<sessionId>:<seq>`.
     * @returns {() => void} stop function.
     */
    function startProgress(store, key) {
      let disposer = null
      let ticks = 0
      const stop = () => {
        try {
          if (typeof disposer === 'function') disposer()
          else if (disposer !== null) clearInterval(disposer)
        } catch { /* already gone */ }
        disposer = null
      }
      const tick = async () => {
        // A request that never settles must not poll forever: two minutes is
        // past any budget the host would enforce anyway.
        ticks += 1
        if (ticks > 240 || store.phase !== 'running') {
          stop()
          return
        }
        const { payload } = await requestJson(`${ROUTES.progress}?key=${encodeURIComponent(key)}`, { method: 'GET' })
        if (payload === null || payload.ok !== true) return
        if (store.phase !== 'running') return
        store.progress = payload
        notify(store)
      }
      disposer = timerService !== null && typeof timerService.interval === 'function'
        ? timerService.interval(tick, POLL_MS)
        : setInterval(tick, POLL_MS)
      return stop
    }

    /**
     * Run one enhancement for a store.
     * @param {object} store - session store.
     * @param {string} sessionId - session id ('' when unknown).
     * @param {(value: string) => void} setDraft - draft writer.
     * @param {{current: string}} draftRef - live draft ref.
     * @returns {Promise<void>} settles when the store is updated.
     */
    async function enhance(store, sessionId, setDraft, draftRef) {
      const draft = draftRef.current
      if (!canEnhance(draft)) return
      const parts = splitCommand(draft)
      const seq = (store.seq += 1)
      const key = `${sessionId}:${seq}`
      store.backup = draft
      store.phase = 'running'
      store.error = ''
      store.errorDetail = ''
      store.warnings = []
      store.truncated = false
      store.progress = { stage: 'queue', step: 0, total: 0, model: '', elapsedMs: 0 }
      notify(store)
      const stopPoll = startProgress(store, key)
      const body = { text: parts.body, sessionId, seq }
      if (configState.value.memory && store.memoryRounds.length > 0) {
        body.memory = { rounds: store.memoryRounds.slice(-MEMORY_ROUNDS_MAX) }
        if (store.optimized) body.continue = true
      }
      const { response, payload } = await requestJson(ROUTES.enhance, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      stopPoll()
      // A newer click (or a cancel) has already replaced this attempt.
      if (seq !== store.seq) return
      store.progress = null
      if (response === null || payload === null) {
        store.phase = 'idle'
        store.error = 'errLlm'
        notify(store)
        return
      }
      if (payload.ok !== true) {
        const code = typeof payload.error?.code === 'string' ? payload.error.code : ''
        store.phase = 'idle'
        // Cancelling is not a failure the error bar should report.
        store.error = code === 'cancelled' ? '' : (ERROR_KEYS[code] ?? 'errUnknown')
        store.errorDetail = typeof payload.error?.message === 'string' ? payload.error.message : ''
        notify(store)
        return
      }
      // The user kept typing (or sent) while the model was running: their text wins.
      if (draftRef.current !== store.backup) {
        store.phase = 'idle'
        store.enhanced = ''
        store.error = ''
        notify(store)
        return
      }
      const value = typeof payload.value === 'string' ? payload.value : ''
      if (value.trim() === '') {
        store.phase = 'idle'
        store.error = 'errEmptyResult'
        notify(store)
        return
      }
      const finalText = parts.prefix + value
      setDraft(finalText)
      store.enhanced = finalText
      store.phase = 'result'
      store.optimized = true
      store.warnings = Array.isArray(payload.warnings) ? payload.warnings : []
      store.truncated = payload.truncated === true
      store.lastModel = typeof payload.route?.model === 'string' ? payload.route.model : ''
      store.fallbackUsed = payload.chainSource === 'fallback'
      if (configState.value.memory) {
        store.memoryRounds.push({ input: parts.body, output: value })
        if (store.memoryRounds.length > MEMORY_ROUNDS_MAX) store.memoryRounds.shift()
      }
      notify(store)
    }

    /**
     * Cancel the attempt in flight and restore the snapshot immediately.
     * @param {object} store - session store.
     * @param {string} sessionId - session id.
     * @param {(value: string) => void} setDraft - draft writer.
     * @returns {void}
     */
    function cancelEnhance(store, sessionId, setDraft) {
      if (store.phase !== 'running') return
      const key = `${sessionId}:${store.seq}`
      store.seq += 1
      store.phase = 'idle'
      store.progress = null
      store.error = ''
      setDraft(store.backup)
      notify(store)
      requestJson(ROUTES.cancel, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      }).catch(() => {})
    }

    /**
     * Restore the pre-enhancement draft.
     * @param {object} store - session store.
     * @param {(value: string) => void} setDraft - draft writer.
     * @returns {void}
     */
    function revert(store, setDraft) {
      if (store.phase !== 'result') return
      setDraft(store.backup)
      store.phase = 'idle'
      store.enhanced = ''
      store.warnings = []
      store.truncated = false
      store.error = ''
      // The reverted rewrite is no longer a confirmed round, so it must not be
      // carried into the next call as memory.
      store.memoryRounds.pop()
      store.optimized = false
      notify(store)
    }

    // -----------------------------------------------------------------------
    // Slot helpers
    // -----------------------------------------------------------------------

    /**
     * Subscribe a component to one session store.
     * @param {string} sessionId - session key.
     * @returns {object} the live store.
     */
    function useSessionStore(sessionId) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const store = storeFor(sessionId)
        const listener = () => force(n => n + 1)
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      }, [sessionId])
      return storeFor(sessionId)
    }

    /**
     * Read a slice of the composer input state.
     *
     * Both branches call exactly one hook, so the hook order is stable whichever
     * host is in front: the real selector when the slot supplies `useInput`, a
     * local seed otherwise. The seed is what makes a host without the input
     * store observable — the control renders nothing instead of guessing.
     * @param {object} props - slot props.
     * @param {(state: object) => unknown} selector - state projection.
     * @returns {unknown} the selected value.
     */
    function useInputSlice(props, selector) {
      const real = props?.useInput
      const [placeholder] = React.useState(undefined)
      if (typeof real === 'function') return real(selector)
      return placeholder
    }

    /**
     * Resolve the session id from slot props.
     * @param {object} props - slot props.
     * @returns {string} session id, '' when unknown.
     */
    function sessionIdOf(props) {
      const direct = props?.sessionId
      if (typeof direct === 'string' && direct !== '') return direct
      const useSession = props?.useSession
      if (typeof useSession === 'function') {
        const derived = useSession(snapshot => snapshot?.sessionId)
        if (typeof derived === 'string' && derived !== '') return derived
      }
      return ''
    }

    // -----------------------------------------------------------------------
    // Components
    // -----------------------------------------------------------------------

    /**
     * The composer control: enhance, cancel, or restore.
     * @param {object} props - composer slot props.
     * @returns {object|null} the element.
     */
    function EnhanceControl(props) {
      const sessionId = sessionIdOf(props)
      const store = useSessionStore(sessionId)
      // `draft` sits at the top level of the input snapshot in every build
      // checked; the nested read keeps a host that re-roots it working.
      const draft = useInputSlice(props, state => state?.draft ?? state?.input?.draft)
      const phase = useInputSlice(props, state => state?.phase ?? state?.input?.phase)
      const draftRef = React.useRef(typeof draft === 'string' ? draft : '')
      draftRef.current = typeof draft === 'string' ? draft : ''
      const text = draftRef.current
      const actions = props?.inputActions

      React.useEffect(() => { void loadConfig() }, [])

      // A draft that diverges from the applied rewrite ends the "restore"
      // window: the snapshot no longer describes what the user is looking at.
      React.useEffect(() => {
        if (store.phase !== 'result') return
        if (text !== store.enhanced) {
          store.phase = 'idle'
          store.warnings = []
          store.truncated = false
          store.error = ''
          notify(store)
        }
      }, [text, store.phase, store.enhanced, store])

      const supported = typeof props?.useInput === 'function' && typeof actions?.setDraft === 'function'
      if (!supported) return null

      const setDraft = value => {
        try { actions.setDraft(value) } catch { /* composer may be unmounting */ }
      }
      const busyPhase = phase === 'submitting' || phase === 'adjudicating'
      const t = translate
      const running = store.phase === 'running'
      const result = store.phase === 'result' && text === store.enhanced
      const disabled = running ? false : busyPhase || (!result && !canEnhance(text))
      const warnings = result ? store.warnings : []
      const warningText = warnings.map(warning => {
        if (warning?.code === 'fidelity') return t('warnedFidelity')
        if (warning?.code === 'shorter') return t('warnedShorter')
        if (warning?.code === 'truncated') return t('warnedTruncated')
        return typeof warning?.detail === 'string' ? warning.detail : ''
      }).filter(Boolean)
      const warningTitle = warnings.map(warning => warning?.detail ?? '').filter(Boolean).join('\n')

      let label = t('button')
      let title = t('titleIdle')
      let className = 'wb-penh-btn'
      let onClick = () => { void enhance(store, sessionId, setDraft, draftRef) }
      if (running) {
        label = t('busy')
        title = t('titleBusy')
        className += ' wb-penh-btn--busy'
        onClick = () => cancelEnhance(store, sessionId, setDraft)
      } else if (result) {
        label = t('buttonResult')
        title = t('titleResult')
        className += ' wb-penh-btn--result'
        onClick = () => revert(store, setDraft)
      } else if (store.optimized) {
        label = t('buttonContinue')
        title = t('titleContinue')
      }
      if (store.error !== '' && !running) className += ' wb-penh-btn--error'

      const progress = store.progress
      let busyText = ''
      if (running) {
        const step = Number.isFinite(progress?.step) ? progress.step : 0
        const total = Number.isFinite(progress?.total) ? progress.total : 0
        if (progress?.stage === 'llm' && step > 0) {
          busyText = t('busyModel', { n: step, total: total || step })
          const model = shortModel(progress?.model)
          if (model !== '') busyText += ` · ${model}`
        } else if (progress?.stage === 'gate') {
          busyText = t('busyStage')
        } else {
          busyText = t('busyQueue')
        }
        const seconds = Number.isFinite(progress?.elapsedMs) ? Math.floor(progress.elapsedMs / 1000) : 0
        if (seconds >= 3) busyText += ` ${seconds}s`
      }

      const children = []
      if (running) {
        children.push(h('span', { key: 'spin', className: 'wb-penh-spin', 'aria-hidden': true }))
        children.push(h('span', { key: 'label' }, busyText === '' ? label : busyText))
        children.push(h('span', { key: 'cancel', style: { opacity: 0.75 } }, t('cancel')))
      } else {
        children.push(h('span', { key: 'icon', 'aria-hidden': true }, result ? '↺' : '✦'))
        children.push(h('span', { key: 'label' }, label))
      }
      const elements = [
        h('button', {
          key: 'button',
          type: 'button',
          className,
          title: store.error !== '' && !running ? `${label} — ${store.errorDetail}`.trim() : title,
          'aria-label': label,
          disabled,
          onClick,
        }, children),
      ]
      if (warningText.length > 0) {
        elements.push(h('span', { key: 'warn', className: 'wb-penh-warn', title: warningTitle }, '⚠'))
      }
      return h('span', { className: 'wb-penh' }, elements)
    }

    /**
     * The error bar: shown under the composer while an error is pending.
     * @param {object} props - slot props.
     * @returns {object|null} the element.
     */
    function EnhanceBar(props) {
      const sessionId = sessionIdOf(props)
      const store = useSessionStore(sessionId)
      if (store.error === '') return null
      const t = translate
      return h('div', { className: 'wb-penh-bar', role: 'status' },
        h('span', { key: 'text' }, t('errorPrefix') + t(store.error)),
        h('button', {
          key: 'dismiss',
          type: 'button',
          className: 'wb-penh-bar-btn',
          onClick: () => { store.error = ''; store.errorDetail = ''; notify(store) },
        }, t('dismiss')))
    }

    /**
     * Parse the model textarea into chain entries.
     * @param {string} text - one `provider/model` per line.
     * @returns {Array<{provider: string, model: string}>} entries.
     */
    function parseModels(text) {
      const entries = []
      for (const line of String(text).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const slash = trimmed.indexOf('/')
        if (slash <= 0 || slash === trimmed.length - 1) continue
        const provider = trimmed.slice(0, slash).trim()
        const model = trimmed.slice(slash + 1).trim()
        if (provider === '' || model === '') continue
        entries.push({ provider, model })
        if (entries.length >= 6) break
      }
      return entries
    }

    /**
     * Render chain entries back into the textarea format.
     * @param {Array<{provider: string, model: string}>} models - entries.
     * @returns {string} textarea text.
     */
    function formatModels(models) {
      if (!Array.isArray(models)) return ''
      return models
        .filter(entry => entry !== null && typeof entry === 'object')
        .map(entry => `${entry.provider}/${entry.model}`)
        .join('\n')
    }

    /**
     * The settings section.
     * @returns {object} the element.
     */
    function SettingsSection() {
      const [saved, setSaved] = React.useState(configState.value)
      const [models, setModels] = React.useState(formatModels(configState.value.models))
      const [status, setStatus] = React.useState('')
      const t = translate
      React.useEffect(() => {
        void loadConfig().then(value => {
          setSaved(value)
          setModels(formatModels(value.models))
        })
      }, [])
      const update = (key, value) => setSaved(current => ({ ...current, [key]: value }))
      const submit = async () => {
        setStatus('saving')
        const patch = {
          maxInputChars: Number(saved.maxInputChars),
          maxOutputChars: Number(saved.maxOutputChars),
          timeoutMs: Number(saved.timeoutMs),
          minRatio: Number(saved.minRatio),
          memory: saved.memory === true,
          rejectOnFidelityLoss: saved.rejectOnFidelityLoss === true,
          models: parseModels(models),
        }
        const ok = await saveConfig(patch)
        setStatus(ok ? 'saved' : 'failed')
        if (ok) {
          setSaved(configState.value)
          setModels(formatModels(configState.value.models))
        }
      }
      return h('div', { className: 'wb-penh-settings' }, [
        h('h3', { key: 'title' }, t('settingsTitle')),
        h('p', { key: 'intro' }, t('settingsIntro')),
        h('div', { key: 'models', className: 'wb-penh-field' },
          h('label', { htmlFor: 'wb-penh-models' }, t('settingsModels')),
          h('textarea', {
            id: 'wb-penh-models',
            value: models,
            placeholder: 'deepseek-account/deepseek-flash\ndeepseek-official/deepseek-v4-pro',
            onChange: event => setModels(event.target.value),
          }),
          h('p', {}, t('settingsModelsHint'))),
        h('div', { key: 'limits', className: 'wb-penh-field' },
          h('label', {}, t('settingsLimits')),
          h('div', { className: 'wb-penh-row' }, [
            h('div', { key: 'in', className: 'wb-penh-field' },
              h('label', { htmlFor: 'wb-penh-maxin' }, t('settingsMaxInput')),
              h('input', {
                id: 'wb-penh-maxin', type: 'number', min: 200, max: 100000, step: 100,
                value: saved.maxInputChars,
                onChange: event => update('maxInputChars', event.target.value),
              })),
            h('div', { key: 'out', className: 'wb-penh-field' },
              h('label', { htmlFor: 'wb-penh-maxout' }, t('settingsMaxOutput')),
              h('input', {
                id: 'wb-penh-maxout', type: 'number', min: 200, max: 50000, step: 100,
                value: saved.maxOutputChars,
                onChange: event => update('maxOutputChars', event.target.value),
              })),
            h('div', { key: 'timeout', className: 'wb-penh-field' },
              h('label', { htmlFor: 'wb-penh-timeout' }, t('settingsTimeout')),
              h('input', {
                id: 'wb-penh-timeout', type: 'number', min: 5000, max: 600000, step: 5000,
                value: saved.timeoutMs,
                onChange: event => update('timeoutMs', event.target.value),
              })),
            h('div', { key: 'ratio', className: 'wb-penh-field' },
              h('label', { htmlFor: 'wb-penh-ratio' }, t('settingsMinRatio')),
              h('input', {
                id: 'wb-penh-ratio', type: 'number', min: 0, max: 1, step: 0.05,
                value: saved.minRatio,
                onChange: event => update('minRatio', event.target.value),
              })),
          ])),
        h('label', { key: 'memory', className: 'wb-penh-check' },
          h('input', {
            type: 'checkbox',
            checked: saved.memory === true,
            onChange: event => update('memory', event.target.checked),
          }),
          h('span', {}, t('settingsMemory'))),
        h('label', { key: 'fidelity', className: 'wb-penh-check' },
          h('input', {
            type: 'checkbox',
            checked: saved.rejectOnFidelityLoss === true,
            onChange: event => update('rejectOnFidelityLoss', event.target.checked),
          }),
          h('span', {}, t('settingsFidelity'))),
        h('div', { key: 'actions', className: 'wb-penh-actions' },
          h('button', {
            type: 'button',
            className: 'wb-penh-save',
            disabled: status === 'saving',
            onClick: () => { void submit() },
          }, t('settingsSave')),
          h('span', { className: 'wb-penh-status' },
            status === 'saved' ? t('settingsSaved') : status === 'failed' ? t('settingsFailed') : status === 'saving' ? t('settingsSaving') : '')),
      ])
    }

    // -----------------------------------------------------------------------
    // Install
    // -----------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        const locale = ctx.get('locale')
        const timer = ctx.get('timer')
        timerService = timer !== undefined ? timer : null
        translate = makeT(locale)

        // Name the control in every configured language. A duplicate
        // registration on hot reload throws by design, so failing here only
        // means the built-in dictionary keeps serving.
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          for (const [language, dict] of Object.entries(DICTS)) {
            try {
              const dispose = locale.register(NS, language, dict)
              if (typeof dispose === 'function') localeDisposers.push(dispose)
            } catch { /* another instance of this plugin already registered it */ }
          }
        }

        // Styles are owned by this plugin: a deduplicated <style> tag removed on
        // unload (the documented lifecycle for plugin CSS).
        if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${NS}"]`) === null) {
          const tag = document.createElement('style')
          tag.dataset.pluginCss = NS
          tag.textContent = CSS
          document.head.appendChild(tag)
          ctx.effect(() => () => {
            try { document.querySelector(`style[data-plugin-css="${NS}"]`)?.remove() } catch { /* already gone */ }
          }, 'dsh-prompt-enhance-wb: styles')
        }

        slots.inject('conversation.input.right', () => slots.register(
          { name: 'conversation.input.right', id: 'dsh-prompt-enhance-wb', order: 20, label: () => translate('button'), locale: NS },
          EnhanceControl,
        ))
        slots.inject('conversation.input.overlay', () => slots.register(
          { name: 'conversation.input.overlay', id: 'dsh-prompt-enhance-wb-bar' },
          EnhanceBar,
        ))
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-prompt-enhance-wb', order: 60, label: () => translate('settingsNav'), locale: NS },
          SettingsSection,
        ))
        ctx.effect(() => () => {
          for (const dispose of localeDisposers.splice(0)) {
            try { dispose() } catch { /* ignore */ }
          }
        }, 'dsh-prompt-enhance-wb: locale')
      },
    }
  },
})

