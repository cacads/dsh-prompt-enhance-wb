import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * A minimal React stand-in: just enough hook runtime to render one component
 * and drive it across renders. It is not a renderer — it calls the component
 * once per `render()` and hands back the element tree, so the test can assert on
 * labels and invoke handlers directly.
 */
const hooks = { cursor: 0, effects: [] }
/** Per-component hook storage, so a re-render keeps its own state and refs. */
const componentState = new Map()

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = child => {
      if (Array.isArray(child)) child.forEach(push)
      else if (child !== null && child !== undefined && child !== false) flat.push(child)
    }
    children.forEach(push)
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    const index = hooks.cursor++
    const store = hooks.current
    if (index >= store.state.length) {
      store.state[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = store.state[index]
    return [slot.value, next => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }]
  },
  useRef(initial) {
    const index = hooks.cursor++
    const store = hooks.current
    if (index >= store.refs.length) store.refs[index] = { current: initial }
    return store.refs[index]
  },
  useEffect(fn) {
    hooks.effects.push(fn)
  },
}

/** Render one component, running its effects, and return its tree. */
function render(Component, props) {
  hooks.cursor = 0
  hooks.effects = []
  if (!componentState.has(Component)) componentState.set(Component, { state: [], refs: [] })
  hooks.current = componentState.get(Component)
  const tree = Component(props)
  for (const effect of hooks.effects) {
    try { effect() } catch { /* an effect that rejects is asserted on elsewhere */ }
  }
  return tree
}

/** Let every pending promise and zero-delay timer settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 25))

// --- browser surface, installed before the module is imported -------------
const registered = []
const loadCalls = []
/** Handler for the next fetch call; tests replace it. */
let fetchHandler = async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'no-record' } }) })

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loadCalls.push(entry)
    },
  },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild() {} },
}
globalThis.fetch = (url, init) => fetchHandler(url, init)

await import('../client.js')

const entry = loadCalls[0]
assert.equal(entry.id, 'dsh-prompt-enhance-wb')

/** Build the plugin object exactly as the module loader would. */
const plugin = entry.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

/** A locale stub that forces Chinese and declines to serve keys. */
const zhLocale = {
  getLocale: () => ({ active: 'zh-CN' }),
  bind: () => key => key,
  register: () => () => {},
}

/** Mount the plugin against a recording slots service. */
function mount() {
  registered.length = 0
  const slots = {
    inject(name, callback) {
      callback()
      return () => {}
    },
    register(options, Component) {
      registered.push({ options, Component })
      return () => {}
    },
  }
  plugin.apply({
    get: service => (service === 'slots' ? slots : service === 'locale' ? zhLocale : undefined),
    effect: fn => fn(),
  })
}

/** Find the first element of a type in the tree. */
function find(tree, type) {
  if (tree === null || tree === undefined) return null
  if (tree.type === type) return tree
  for (const child of tree.children ?? []) {
    const hit = find(child, type)
    if (hit !== null) return hit
  }
  return null
}

/** Flatten an element's text children into one string. */
function textOf(element) {
  if (element === null || element === undefined) return ''
  if (typeof element === 'string') return element
  return (element.children ?? []).map(textOf).join('')
}

/** Props for a composer that reports the given draft and records writes. */
function composer(holder) {
  return {
    sessionId: holder.sessionId,
    useInput: selector => selector({ draft: holder.draft, phase: holder.phase ?? 'plain' }),
    inputActions: {
      setDraft(value) { holder.writes.push(value); holder.draft = value },
    },
  }
}

test('apply registers the control, the error bar and a settings section', () => {
  mount()
  const names = registered.map(item => item.options.name)
  assert.deepEqual(names, ['conversation.input.right', 'conversation.input.overlay', 'settings.section'])
  assert.equal(registered[0].options.id, 'dsh-prompt-enhance-wb')
  assert.equal(typeof registered[0].options.label(), 'string')
})

// Every later test reads the components registered here.
mount()

test('a host without the input store renders nothing', () => {
  const tree = render(registered[0].Component, {})
  assert.equal(tree, null)
})

test('an empty draft renders a disabled control', () => {
  const holder = { sessionId: 'empty', draft: '', writes: [] }
  const tree = render(registered[0].Component, composer(holder))
  const button = find(tree, 'button')
  assert.ok(button !== null)
  assert.equal(button.props.disabled, true)
  assert.ok(textOf(button).includes('增强提示词'))
})

test('a slash command without a body cannot be enhanced', () => {
  const holder = { sessionId: 'slash', draft: '/clear', writes: [] }
  const tree = render(registered[0].Component, composer(holder))
  assert.equal(find(tree, 'button').props.disabled, true)
})

test('clicking enhances in place and a second click restores the draft', async () => {
  const holder = { sessionId: 'happy', draft: '写个脚本', writes: [] }
  fetchHandler = async url => {
    if (url.includes('/config')) return { ok: true, json: async () => ({ ok: true, config: { memory: false, minRatio: 0.6 } }) }
    if (url.includes('/progress')) return { ok: true, json: async () => ({ ok: false }) }
    if (url.includes('/enhance')) {
      return { ok: true, json: async () => ({ ok: true, value: '请编写一个脚本', route: { provider: 'p', model: 'm' } }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  let tree = render(registered[0].Component, composer(holder))
  find(tree, 'button').props.onClick()
  // The busy state must be visible immediately, before the model answers.
  const busyLabel = textOf(find(render(registered[0].Component, composer(holder)), 'button'))
  assert.ok(busyLabel.includes('取消'), busyLabel)
  await flush()
  tree = render(registered[0].Component, composer(holder))
  assert.deepEqual(holder.writes, ['请编写一个脚本'])
  const resultButton = find(tree, 'button')
  assert.ok(textOf(resultButton).includes('恢复原文'), textOf(resultButton))
  resultButton.props.onClick()
  assert.equal(holder.writes[1], '写个脚本')
})

test('a slash command prefix survives the rewrite and the restore', async () => {
  const holder = { sessionId: 'prefix', draft: '/skill 写个脚本', writes: [] }
  fetchHandler = async url => {
    if (url.includes('/enhance')) return { ok: true, json: async () => ({ ok: true, value: '请编写一个脚本' }) }
    return { ok: true, json: async () => ({ ok: false }) }
  }
  render(registered[0].Component, composer(holder))
  find(render(registered[0].Component, composer(holder)), 'button').props.onClick()
  await flush()
  assert.deepEqual(holder.writes, ['/skill 请编写一个脚本'])
})

test('a result that arrives after the user edited the draft is dropped', async () => {
  const holder = { sessionId: 'race', draft: '原始草稿', writes: [] }
  let answer = null
  fetchHandler = async url => {
    if (url.includes('/config')) return { ok: true, json: async () => ({ ok: true, config: { memory: false } }) }
    if (url.includes('/enhance')) {
      return new Promise(resolve => { answer = () => resolve({ ok: true, json: async () => ({ ok: true, value: '增强结果' }) }) })
    }
    return { ok: true, json: async () => ({ ok: false }) }
  }
  render(registered[0].Component, composer(holder))
  find(render(registered[0].Component, composer(holder)), 'button').props.onClick()
  // The user keeps typing while the model is running.
  holder.draft = '我自己改过的草稿'
  render(registered[0].Component, composer(holder))
  answer()
  await flush()
  const tree = render(registered[0].Component, composer(holder))
  assert.deepEqual(holder.writes, [])
  assert.ok(textOf(find(tree, 'button')).includes('增强提示词'))
})

test('cancelling restores the draft and leaves no error behind', async () => {
  const holder = { sessionId: 'cancel', draft: '原始草稿', writes: [] }
  fetchHandler = async url => {
    if (url.includes('/enhance')) return new Promise(() => {}) // never settles
    return { ok: true, json: async () => ({ ok: false }) }
  }
  render(registered[0].Component, composer(holder))
  find(render(registered[0].Component, composer(holder)), 'button').props.onClick()
  const busy = find(render(registered[0].Component, composer(holder)), 'button')
  assert.ok(textOf(busy).includes('取消'))
  busy.props.onClick()
  assert.deepEqual(holder.writes, ['原始草稿'])
  const tree = render(registered[0].Component, composer(holder))
  assert.ok(textOf(find(tree, 'button')).includes('增强提示词'))
  assert.equal(find(tree, 'div'), null)
})

test('a failure surfaces an error bar that can be dismissed', async () => {
  const holder = { sessionId: 'failure', draft: '草稿', writes: [] }
  fetchHandler = async url => {
    if (url.includes('/enhance')) {
      return { ok: false, json: async () => ({ ok: false, error: { code: 'unconfigured', message: 'no route' } }) }
    }
    return { ok: true, json: async () => ({ ok: false }) }
  }
  render(registered[0].Component, composer(holder))
  find(render(registered[0].Component, composer(holder)), 'button').props.onClick()
  await flush()
  const bar = registered.find(item => item.options.name === 'conversation.input.overlay').Component
  let tree = render(bar, composer(holder))
  assert.ok(textOf(tree).includes('未配置任何模型路由'), textOf(tree))
  const dismiss = find(tree, 'button')
  dismiss.props.onClick()
  tree = render(bar, composer(holder))
  assert.equal(tree, null)
})

test('the settings section renders the effective values', () => {
  const Section = registered.find(item => item.options.name === 'settings.section').Component
  const tree = render(Section, { close() {} })
  assert.ok(textOf(tree).includes('提示词增强'), textOf(tree))
  assert.ok(textOf(tree).includes('模型链'))
})

