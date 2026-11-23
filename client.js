/**
 * The browser half: an "enhance" button in the composer tool row, plus a revert
 * control that appears once a rewrite has been applied.
 *
 * The interaction mirrors WorkBuddy's: the button rewrites the draft in place,
 * the original is snapshotted first, and a second click restores it. Unlike
 * WorkBuddy this shows the fidelity/shorter warnings the host reports.
 * @module dsh-prompt-enhance-wb/client
 */

const ENDPOINT = '/dsh-prompt-enhance-wb/enhance'

window.__ModuleLoader__.load({
  // Must equal the package name: the manifest package name identifies the
  // browser module, and the boot graph addresses rows by it.
  id: 'dsh-prompt-enhance-wb',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /**
     * Session id the composer belongs to. The slot injects it directly; the
     * `useConversation` read is a fallback for hosts that omit it.
     * @param props - composer slot props.
     */
    function currentSessionId(props) {
      const direct = props?.sessionId
      if (typeof direct === 'string' && direct !== '') return direct
      const derived = props?.useConversation?.(snapshot => snapshot?.sessionId)
      return typeof derived === 'string' && derived !== '' ? derived : undefined
    }

    /**
     * Read the composer draft without assuming the host provides `useInput`.
     *
     * The capability cannot be branched around a hook, so both branches call
     * exactly one hook: the real selector when the host supplies it, and a local
     * `useState` seed otherwise. The local seed is what makes the missing-host
     * case observable — a selector handed to a stand-in would evaluate to junk
     * and silently look like an empty draft.
     * @param props - composer slot props.
     * @returns the current draft text.
     */
    function useDraftText(props) {
      const real = props?.useInput
      const [placeholder] = useState('')
      if (typeof real === 'function') {
        const value = real(state => state?.draft)
        return typeof value === 'string' ? value : ''
      }
      return placeholder
    }

    /**
     * Read the submit phase, paired with {@link useDraftText} for hook order.
     * @param props - composer slot props.
     * @returns the phase, or undefined on a host without the input store.
     */
    function usePhase(props) {
      const real = props?.useInput
      const [placeholder] = useState(undefined)
      if (typeof real === 'function') return real(state => state?.phase)
      return placeholder
    }

    /**
     * One button pair: enhance, and revert once a rewrite is in place.
     * @param props - composer slot props carrying `useInput` and `inputActions`.
     */
    function EnhanceControls(props) {
      const actions = props?.inputActions
      const draft = useDraftText(props)
      const phase = usePhase(props)
      const busy = phase !== undefined && phase !== 'plain'
      const [running, setRunning] = useState(false)
      const [error, setError] = useState('')
      const [backup, setBackup] = useState(null)
      const [warnings, setWarnings] = useState([])
      const abortRef = useRef(null)

      // A draft edited after an enhancement is the user's own text again; keep
      // the backup so revert stays available, but drop the stale warnings.
      useEffect(() => {
        if (backup !== null && draft !== backup.after) setWarnings([])
      }, [draft, backup])

      // Abort an in-flight call when the control unmounts.
      useEffect(() => () => { abortRef.current?.abort() }, [])

      /** Write text back into the composer, ignoring a host without the action. */
      const setDraft = value => {
        if (typeof actions?.setDraft === 'function') actions.setDraft(value)
      }

      const enhance = async () => {
        if (running || busy) return
        const text = draft
        if (text.trim() === '') return
        const controller = new AbortController()
        abortRef.current = controller
        setRunning(true)
        setError('')
        setWarnings([])
        try {
          const sessionId = currentSessionId(props)
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, ...(sessionId === undefined ? {} : { sessionId }) }),
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            setError(payload?.error?.detail ?? payload?.error?.message ?? `HTTP ${response.status}`)
            return
          }
          const value = typeof payload.value === 'string' ? payload.value : ''
          if (value.trim() === '') {
            setError('the model returned nothing')
            return
          }
          setDraft(value)
          setBackup({ before: text, after: value })
          setWarnings(Array.isArray(payload.warnings) ? payload.warnings : [])
        } catch (cause) {
          if (cause instanceof Error && cause.name === 'AbortError') return
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setRunning(false)
          abortRef.current = null
        }
      }

      const revert = () => {
        if (backup === null) return
        setDraft(backup.before)
        setBackup(null)
        setWarnings([])
        setError('')
      }

      // A host that supplies neither the input store nor stable input actions
      // renders nothing: without both, the button has no way to read the draft
      // or write the rewrite back, so it would be dead weight in the tool row.
      const supported = typeof props?.useInput === 'function'
        && typeof actions?.setDraft === 'function'
      if (!supported) return null

      const disabled = running || busy || (backup === null && draft.trim() === '')
      const label = backup !== null ? '恢复原文' : running ? '增强中…' : '增强提示词'
      const title = error !== '' ? `${label} — ${error}` : label

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
        h('button', {
          key: 'action',
          type: 'button',
          title,
          'aria-label': label,
          disabled,
          onClick: backup !== null ? revert : enhance,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 26,
            padding: '0 8px',
            borderRadius: 6,
            border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.25))',
            background: 'transparent',
            color: error !== '' ? 'var(--dsw-alias-text-danger, #d33)' : 'var(--dsw-alias-text-secondary, inherit)',
            fontSize: 12,
            lineHeight: '24px',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            whiteSpace: 'nowrap',
          },
        }, [h('span', { key: 'icon', 'aria-hidden': true }, backup !== null ? '↺' : '✦'), label]),
        warnings.length > 0
          ? h('span', {
              key: 'warn',
              title: warnings.map(warning => warning.detail).join('\n'),
              style: { fontSize: 11, color: 'var(--dsw-alias-text-warning, #b8860b)', cursor: 'help' },
            }, '⚠')
          : null,
      ])
    }

    return {
      name: 'dsh-prompt-enhance-wb',
      inject: ['slots'],
      apply(ctx) {
        // The tool row sits beside the submit button, which is where WorkBuddy
        // puts its own enhance button.
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-prompt-enhance-wb',
          order: 20,
        }, EnhanceControls))
      },
    }
  },
})
