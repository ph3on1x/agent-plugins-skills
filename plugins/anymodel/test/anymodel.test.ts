// usage: claude plugin test (from plugins/anymodel). The mod's hooks, with Claude Code, the worker and the provider
// stubbed; worker.test.js covers the helpers.
import { expect, test } from 'claude-code/testing'
import { NETWORK_VARS } from '../hooks/worker.js'

const LOCAL = 'http://127.0.0.1:9'
// The settings form as register() gets it: one agent's fields (blank once saved), and the API key field holding every
// key by server URL, as anymodel writes it back.
const form = (keys: Record<string, string>, fields = {}) => ({ agent: '', url: '', model: '', context: '', api_key: JSON.stringify(keys), ...fields })
const options = form({ [LOCAL]: 'sk-local' })
// The agents anymodel keeps ($.store "agents").
const gem = { url: LOCAL, model: 'gemma', context: 49152 }
// The plugin's folder, as claude plugin list names it.
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

const task = (text: string) => [{ role: 'user', content: [{ type: 'text', text }] }]

async function drain(stream: AsyncIterator<unknown>) {
  const chunks: unknown[] = []
  let step = await stream.next()
  while (step.done !== true) {
    chunks.push(step.value)
    step = await stream.next()
  }
  return { chunks, result: step.value as { answer: string; toolUses: { name: string; input: { message: string } }[]; stopReason: string } }
}

// What a test sets up: the agents $.agent.list() has, the subagent's messages, main's verdict on a tool, the person's
// answer to a question, the worker's stdout (an event; 'echo task' or 'echo message', the worker taking the task or
// the last message written to it; a function it waits on), where claude is, how a write to the worker goes; and what
// the mod did: files, lines written to the worker, its argv and input, whether it killed the worker.
type World = {
  rows: { id: string; type: string; status: string; spawnedBy?: string; name?: string }[]
  messages: unknown[] | 'deny'
  verdict: 'allow' | 'ask' | 'deny'
  answer?: string
  worker: unknown[]
  claudePath: string
  write: () => Promise<boolean>
  files: Map<string, string>
  written: unknown[]
  argv: string[]
  input: string
  asked: string[]
  claude: boolean
  // Messages the engine queued for the agent.
  queued: string[]
  killed: boolean
  onKill: () => void
  // The mod sleeps (its waits between polls).
  onSleep: () => void
  // Every command the mod ran, by argv.
  ran: string[][]
  // The provider's answer to the mod's $.http.fetch, as a hook answers it.
  fetch: (...a: any[]) => unknown
  // Core's agent.spawn: by default it starts a1 at once.
  spawn: (e: { model?: string; subagentType?: string }) => Promise<{ model: string; agentId: string }>
  // The saved agents, the keys the session holds ($.state), the settings form fields it set, its toasts, and the keys
  // written to the API key field (claude plugin configure).
  agents: Record<string, unknown>
  keys?: Record<string, string>
  // claude plugin list leaves this plugin out (a --plugin-dir session).
  unlisted?: boolean
  cleared: string[]
  toasts: string[]
  saved: unknown[]
  // The settings form's agent fields as $.config.list reads them, each write to them, the args /plugin opened with,
  // the form each time it opened, and what the person leaves in it as the dialog closes.
  form: Record<string, string>
  sets: [string, string][]
  opened: string[]
  opening: Record<string, string>[]
  dialog: (form: Record<string, string>) => Record<string, string>
}

function world(over: Partial<World> = {}): World {
  return {
    rows: [], messages: task('sum the debits'), verdict: 'allow', worker: [], claudePath: '/bin/claude', write: async () => true, files: new Map(),
    written: [], argv: [], input: '', asked: [], claude: false, queued: [], killed: false, onKill: () => {}, onSleep: () => {}, ran: [], fetch: () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'gemma' }] }) } }), spawn: async e => ({ model: e.model ?? 'gemma', agentId: 'a1' }),
    agents: { gem }, cleared: [], toasts: [], saved: [], form: { agent: '', url: '', model: '', context: '' }, sets: [], opened: [], opening: [], dialog: form => form, ...over,
  }
}

// A point the worker stops at until the test opens it; `reached` once it got there.
function gate() {
  let open = () => {}
  let arrive = () => {}
  const opened = new Promise<void>(r => (open = r))
  const reached = new Promise<void>(r => (arrive = r))
  return { reached, open, wait: async () => (arrive(), await opened) }
}

function stubs(on: any, w: World) {
  on('session.start', () => ({ cwd: '/work' }))
  on('agent.register', ($: unknown, e: { name: string }) => ({ value: { agent: `anymodel:${e.name}` } }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($: unknown, e: { text: string }) => (w.toasts.push(e.text), { value: undefined }))
  on('store.get', ($: unknown, e: { key: string }) => ({ value: e.key === 'agents' ? w.agents : undefined }))
  on('store.set', ($: unknown, e: { key: string; value: Record<string, unknown> }) => ((w.agents = e.value), { value: undefined }))
  on('state.get', () => ({ value: { value: w.keys, version: w.keys === undefined ? 0 : 1 } }))
  on('state.set', ($: unknown, e: { value: Record<string, string> }) => ((w.keys = e.value), { value: { isSet: true, version: 1 } }))
  on('config.set', ($: unknown, e: { key: string; value: string }) => {
    w.cleared.push(e.key)
    w.sets.push([e.key, e.value])
    w.form[e.key.replace(/^anymodel\./, '')] = e.value
    return { value: e.value }
  })
  on('config.list', () => ({ value: Object.entries(w.form).map(([k, value]) => ({ key: `anymodel.${k}`, label: k, kind: 'text', value, provider: { plugin: 'anymodel', tier: 'user' }, isLocked: false })) }))
  // Core's /plugin: it opens the settings form.
  on('command.run', { command: 'plugin' }, ($: unknown, e: { args: string }) => {
    w.opened.push(e.args)
    w.opening.push({ ...w.form })
    w.form = w.dialog(w.form)
    return { text: 'Configuration saved.' }
  })
  on('ui.log', () => ({ value: undefined }))
  on('env.get', ($: unknown, e: { name: string }) => ({ value: NETWORK_VARS.includes(e.name) ? `main:${e.name}` : { HOME: '/home/u', PATH: '/usr/bin:/bin' }[e.name] }))
  on('fs.exists', ($: unknown, e: { path: string }) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($: unknown, e: { path: string }) => ({ value: w.files.get(e.path) }))
  on('fs.write', ($: unknown, e: { path: string; text?: string; content?: string; data?: string }) => {
    w.files.set(e.path, e.text ?? e.content ?? e.data ?? '')
    return { value: undefined }
  })
  on('process.run', async ($: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (e.argv[0] === '/usr/bin/which') return { value: { exitCode: w.claudePath ? 0 : 1, stdout: `${w.claudePath}\n`, stderr: '' } }
    if (e.argv[0] === '/usr/bin/id') return { value: { exitCode: 0, stdout: '501\n', stderr: '' } }
    if (e.argv[1] === 'plugin' && e.argv[2] === 'list') return { value: { exitCode: 0, stdout: JSON.stringify([{ id: 'other@x', installPath: '/elsewhere' }, ...(w.unlisted ? [] : [{ id: 'anymodel@test', installPath: ROOT }])]), stderr: '' } }
    if (e.argv[1] === 'plugin' && e.argv[2] === 'configure') {
      w.saved.push({ id: e.argv[3], values: JSON.parse(e.init?.stdin ?? 'null') })
      return { value: { exitCode: 0, stdout: 'Configuration saved.', stderr: '' } }
    }
    if (e.argv[0] === '/bin/sleep') w.onSleep()
    w.ran.push(e.argv)
    if (e.argv[2] === 'cat >> "$1"') {
      if (!(await w.write())) return { value: { exitCode: 1, stdout: '', stderr: 'timed out' } }
      w.written.push(JSON.parse(e.init?.stdin ?? 'null'))
    }
    if (e.argv[2]?.startsWith('kill ')) {
      w.killed = true
      w.onKill()
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* ($: unknown, e: { argv: string[]; input?: string }) {
    w.argv = e.argv
    w.input = e.input ?? ''
    const line = (ev: unknown) => ({ stream: 'stdout', text: `${JSON.stringify(ev)}\n` })
    for (const ev of w.worker) {
      if (w.killed) break
      if (typeof ev === 'function') await ev()
      else if (ev === 'echo task') yield line({ type: 'user', uuid: JSON.parse(w.input.split('\n')[1]).uuid })
      else if (ev === 'echo message') yield line({ type: 'user', uuid: (w.written.findLast((l: any) => l?.type === 'user') as { uuid: string }).uuid })
      else yield line(ev)
    }
    return { value: w.killed ? { code: null, signal: 'SIGTERM' } : { code: 0, signal: null } }
  })
  // The provider: by default it lists the model without its window, so the agent's context size (gem: 49152) counts.
  on('http.fetch', (...a: any[]) => w.fetch(...a))
  on('agent.list', () => ({ value: w.rows }))
  on('session.send', ($: unknown, e: { text: string }) => (w.queued.push(e.text), { isDelivered: true }))
  on('agent.spawn', ($: unknown, e: { model?: string; subagentType?: string }) => w.spawn(e))
  on('session.messages', () => (w.messages === 'deny' ? { value: { deny: 'unreadable' } } : { value: w.messages }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('settings.read', () => ({ value: { permissions: { allow: ['Bash(ls:*)'] } } }))
  on('tool.list', () => ({ value: [] }))
  // The question dialog is a tool call of its own, which the person answers.
  on('tool.check', ($: unknown, e: { tool: string }) => ({ decision: e.tool === 'AskUserQuestion' ? 'allow' : w.verdict }))
  on('tool.call', ($: unknown, e: { tool: string; questions: { question: string }[] }) => {
    w.asked.push(e.questions[0].question)
    return w.answer === undefined ? { deny: 'no one to ask' } : { result: { answers: { [e.questions[0].question]: w.answer } } }
  })
  on('turn.step', async function* ($: unknown, e: { turnId: string; index: number }) {
    w.claude = true
    yield { kind: 'text', index: 0, text: 'claude' }
    return { turnId: e.turnId, index: e.index, answer: 'claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

async function start($: any, mode = 'default') {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return $.agent.spawn({ subagentType: 'anymodel:gem', prompt: 'sum the debits', description: 'sum', permissionMode: mode })
}

const step = ($: any, index = 0) => drain($.turn.step({ turnId: 't', index, model: 'gemma', messageCount: 1, agentId: 'a1' }))

const init = { type: 'system', subtype: 'init', session_id: 'w1' }
// The agent as $.agent.list() lists it, named as the Agent call named it; and main's SendMessage to it.
const row = { id: 'a1', type: 'anymodel:gem', status: 'running', name: 'ledger' }
const send = ($: any, to: string, text: string) => $.session.send({ to, text, origin: { kind: 'model' } })
const done = (result: string) => ({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result })
const RECORD = '/home/u/.local/state/anymodel/sessions/S1-a1'

test('a step of no anymodel agent goes on to the session backend', { options }, async ($, on) => {
  const w = world({ rows: [{ id: 'a1', type: 'general-purpose', status: 'running' }] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await step($)).result.answer).toBe('claude')
})

test('an agent of settings with errors answers them and never reaches Claude', { options }, async ($, on) => {
  const w = world({ agents: { gem: { url: 'nowhere', model: 'gemma' } } })
  stubs(on, w)
  await start($)
  const { result } = await step($)
  expect(w.claude).toBe(false)
  expect(result.answer).toBe('anymodel: the settings need fixing (/plugin configure anymodel): the server URL must start with http:// or https://')
})

test('a worker run answers the step, its tool calls shown and asked of main, its session kept with its backend', { options }, async ($, on) => {
  const permission = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' } }
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
  const w = world({ worker: [init, tool, permission, done('7964.25')] })
  stubs(on, w)
  await start($)
  const { result } = await step($)
  expect(result.answer).toBe('7964.25')
  expect(w.claude).toBe(false)
  // Main's verdict answers the worker's question.
  expect(w.written).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tu1' } } }])
  // The bridge, in main's mode, with main's rules, the key on bridge.sh's stdin only.
  expect(w.argv[0]).toBe('/bin/sh')
  expect(w.argv[1]).toMatch(/\/hooks\/bridge\.sh$/)
  expect(w.argv[w.argv.indexOf('--permission-mode') + 1]).toBe('default')
  expect(w.argv.includes('--resume')).toBe(false)
  const settings = JSON.parse(w.argv[w.argv.indexOf('--settings') + 1])
  expect(settings.permissions.allow).toEqual(['Bash(ls:*)'])
  // Main's proxies and trust, each by name, pinned over the project's.
  for (const k of NETWORK_VARS) expect(settings.env[k]).toBe(`main:${k}`)
  expect(w.argv.some(a => a.includes('sk-local'))).toBe(false)
  expect(JSON.parse(w.files.get(RECORD) ?? '')).toEqual({ sessionId: 'w1', baseUrl: 'http://127.0.0.1:9', model: 'gemma' })
})

test('another plugin screens the answer before main gets it, through anymodel.screen', { options }, async ($, on) => {
  const w = world({ worker: [init, done('Paid Johanna Vexley 7964.25')] })
  stubs(on, w)
  const seen: unknown[] = []
  on('anymodel.screen', ($: unknown, e: { agentId: string; name: string; text: string }) => {
    seen.push(e)
    return { value: { text: e.text.replace('Johanna Vexley', '[PERSON_1]') } }
  })
  await start($)
  expect((await step($)).result.answer).toBe('Paid [PERSON_1] 7964.25')
  expect(seen).toEqual([{ agentId: 'a1', name: 'gem', text: 'Paid Johanna Vexley 7964.25' }])
})

// A plugin that reads $.anymodel.agents(), as personal-computer's check does.
const reader = {
  name: 'reader',
  register(on: any) {
    on('command.run', { command: 'peek' }, async ($: any) => ({ text: JSON.stringify(await $.anymodel.agents()) }))
  },
}

test('another plugin reads the agents through $.anymodel.agents(): names, models, URLs and problems, never a key', { options, plugins: [reader] }, async ($, on) => {
  const w = world({ agents: { gem, broken: { url: 'nowhere', model: 'x' } } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const { text } = await $.command.run({ command: 'peek' })
  expect(JSON.parse(text)).toEqual([
    { name: 'gem', model: 'gemma', url: LOCAL, problems: [] },
    { name: 'broken', problems: ['the server URL must start with http:// or https://'] },
  ])
  expect(text).not.toMatch(/sk-local/)
})

// A screen hook that throws is skipped, as any hook is, and the answer would pass unscreened: the screening plugin's
// own .catch is what withholds it.
test("a screen that fails withholds the answer through the screening plugin's .catch", { options }, async ($, on) => {
  const w = world({ worker: [init, done('Paid Johanna Vexley 7964.25')] })
  stubs(on, w)
  on('anymodel.screen', () => {
    throw new Error('scanner down')
  }).catch(() => ({ value: { text: 'withheld: could not be checked' } }))
  await start($)
  const { result } = await step($)
  expect(result.answer).toBe('withheld: could not be checked')
})

test('a tool use main would ask about goes to the person, and their no refuses it', { options }, async ($, on) => {
  const permission = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: '/work/a' }, tool_use_id: 'tu1' } }
  const w = world({ verdict: 'ask', answer: 'No', worker: [init, permission, done('ok')] })
  stubs(on, w)
  await start($)
  await step($)
  // The project's file by its path in the project, as Claude Code's own dialog names it.
  expect(w.asked).toEqual(['gem (gemma) wants to use Edit(a). Allow it?'])
  expect((w.written[0] as any).response.response).toEqual({ behavior: 'deny', message: 'The user refused this tool use.', interrupt: false, toolUseID: 'tu1' })
})

test('with no one to ask (claude -p) a tool use main would ask about is refused', { options }, async ($, on) => {
  const permission = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: '/work/a' }, tool_use_id: 'tu1' } }
  const w = world({ verdict: 'ask', worker: [init, permission, done('ok')] })
  stubs(on, w)
  await start($)
  await step($)
  expect((w.written[0] as any).response.response.behavior).toBe('deny')
})

test('a worker session is resumed only on the backend it ran on', { options }, async ($, on) => {
  const w = world({ worker: [init, done('ok')], messages: [...task('first'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...task('second')] })
  w.files.set(RECORD, JSON.stringify({ sessionId: 'old', baseUrl: 'http://x', model: 'other' }))
  stubs(on, w)
  await start($)
  await step($)
  expect(w.argv.includes('--resume')).toBe(false)
  // The new worker has none of the old one's session: it gets all of main's messages.
  const spawned = w.argv.join(' ')
  expect(spawned.includes('old')).toBe(false)
})

test('in auto mode an answer is handed back even when the messages cannot be read', { options }, async ($, on) => {
  const w = world({ messages: 'deny' })
  stubs(on, w)
  await start($, 'auto')
  const { result } = await step($)
  expect(result.toolUses[0].name).toBe('SubagentHandback')
  expect(result.toolUses[0].input.message).toMatch(/^anymodel: cannot read the subagent's messages/)
})

test('a step that comes before its spawn resolves waits for it instead of going to Claude', { options }, async ($, on) => {
  let release: () => void = () => {}
  const held = new Promise<void>(r => (release = r))
  const w = world({ worker: [init, done('ok')], spawn: async () => (await held, { model: 'gemma', agentId: 'a1' }) })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const spawned = $.agent.spawn({ subagentType: 'anymodel:gem', prompt: 'sum', description: 'sum', permissionMode: 'default' })
  const stepped = step($)
  release()
  await spawned
  expect((await stepped).result.answer).toBe('ok')
  expect(w.claude).toBe(false)
})

test('a control request the mod does not handle is refused, so the worker never waits on it', { options }, async ($, on) => {
  const elicit = { type: 'control_request', request_id: 'r2', request: { subtype: 'elicitation', message: 'sign in' } }
  const w = world({ worker: [init, 'echo task', elicit, done('ok')] })
  stubs(on, w)
  await start($)
  expect((await step($)).result.answer).toBe('ok')
  expect(w.written).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'r2', error: 'anymodel does not handle elicitation requests' } }])
})

test('a message reaches the worker once it took its task, and the run waits for the answer to it', { options }, async ($, on) => {
  const [early, later, again] = [gate(), gate(), gate()]
  const w = world({ rows: [row], worker: [init, early.wait, 'echo task', later.wait, done('first'), again.wait, 'echo message', done('second')] })
  stubs(on, w)
  await start($)
  const stepped = step($)
  await early.reached
  // Before the worker took its task a line could mix with it: the message goes to the agent as usual.
  expect(await send($, 'ledger', 'too early')).toEqual({ isDelivered: true })
  expect(w.queued).toEqual(['too early'])
  early.open()
  await later.reached
  expect(await send($, 'ledger', 'also count the rows')).toEqual({ isDelivered: true })
  expect(w.queued).toEqual(['too early'])
  expect((w.written[0] as { message: { content: string } }).message.content).toBe('also count the rows')
  later.open()
  await again.reached
  again.open()
  // The answer that came before the worker took the message, and the one after.
  expect((await stepped).result.answer).toBe('first\n\nsecond')
})

test('a message that cannot reach a worker which already answered ends the run with that answer', { options }, async ($, on) => {
  const [writing, answered, idle] = [gate(), gate(), gate()]
  const w = world({ rows: [row], worker: [init, 'echo task', answered.wait, done('first'), idle.wait], onKill: idle.open })
  w.write = async () => (await writing.wait(), false)
  stubs(on, w)
  await start($)
  const stepped = step($)
  await answered.reached
  const received = send($, 'a1', 'also this')
  await writing.reached
  // The worker answers while the message is being written, and the run waits on for it; then the write fails.
  answered.open()
  await idle.reached
  writing.open()
  await received
  expect(w.queued).toEqual(['also this'])
  expect((await stepped).result.answer).toBe('first')
  expect(w.killed).toBe(true)
})

test('a task that never reached a worker goes to it again with the next message', { options }, async ($, on) => {
  const w = world({ claudePath: '', worker: [init, 'echo task', done('ok')] })
  w.files.set(RECORD, JSON.stringify({ sessionId: 'w0', baseUrl: 'http://127.0.0.1:9', model: 'gemma' }))
  stubs(on, w)
  await start($)
  expect((await step($)).result.answer).toBe('anymodel: claude is not on PATH')
  w.claudePath = '/bin/claude'
  w.messages = [...task('sum the debits'), { role: 'assistant', content: [{ type: 'text', text: 'anymodel: claude is not on PATH' }] }, ...task('retry')]
  expect((await step($)).result.answer).toBe('ok')
  expect(JSON.parse(w.input.split('\n')[1]).message.content).toBe('sum the debits\n\nretry')
  expect(w.argv.slice(-2)).toEqual(['--resume', 'w0'])
})

test('a message the worker never took, as it died first, goes to the agent as usual', { options }, async ($, on) => {
  const taking = gate()
  const w = world({ rows: [row], worker: [init, 'echo task', taking.wait] })
  stubs(on, w)
  await start($)
  const stepped = step($)
  await taking.reached
  expect(await send($, 'ledger', 'and the max')).toEqual({ isDelivered: true })
  expect(w.queued).toEqual([])
  taking.open()
  expect((await stepped).result.answer).toMatch(/the worker ended without a result/)
  expect(w.queued).toEqual(['and the max'])
})

test('a message written as the worker dies goes to the agent once', { options }, async ($, on) => {
  const taking = gate()
  const writing = gate()
  const w = world({ rows: [row], worker: [init, 'echo task', taking.wait], write: async () => (await writing.wait(), false) })
  stubs(on, w)
  await start($)
  const stepped = step($)
  await taking.reached
  const sent = send($, 'ledger', 'do this once')
  await writing.reached
  taking.open()
  expect((await stepped).result.answer).toMatch(/the worker ended without a result/)
  writing.open()
  expect(await sent).toEqual({ isDelivered: true })
  expect(w.queued).toEqual(['do this once'])
})

test('an agent whose context size cannot be read answers why, and /anymodel lists it', { options }, async ($, on) => {
  const w = world({ worker: [init, 'echo task', done('ok')], agents: { gem: { url: LOCAL, model: 'gemma' } } })
  stubs(on, w)
  w.fetch = () => ({ value: { status: 404, ok: false, headers: {}, text: 'not found' } })
  await start($)
  expect((await step($)).result.answer).toMatch(/^anymodel: cannot read the context size of gemma from http:\/\/127\.0\.0\.1:9 \(\/api\/v0\/models: HTTP 404, \/v1\/models: HTTP 404, \/props: HTTP 404\)/)
  expect(w.argv).toEqual([])
  expect((await $.command.run({ command: 'anymodel', args: '' })).text).toMatch(/^gem {2}gemma at .*cannot read the context size/)
})

test('a server started after the session start runs the agent: a failed context read is read again first', { options }, async ($, on) => {
  const w = world({ worker: [init, 'echo task', done('ok')], agents: { gem: { url: LOCAL, model: 'gemma' } } })
  stubs(on, w)
  let up = false
  w.fetch = () => ({ value: up ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'gemma', context_length: 49152 }] }) } : { status: 404, ok: false, headers: {}, text: 'not found' } })
  await start($)
  up = true
  expect((await step($)).result.answer).toBe('ok')
  expect(w.argv.length > 0).toBe(true)
})

test('a run while the session start still reads the context size waits for that read, not a second one', { options }, async ($, on) => {
  const g = gate()
  // The read ends once the run waits for it.
  const w = world({ worker: [init, 'echo task', done('ok')], onSleep: g.open, agents: { gem: { url: LOCAL, model: 'gemma' } } })
  stubs(on, w)
  let reads = 0
  w.fetch = async ($: unknown, e: { url: string }) => {
    if (e.url.endsWith('/api/v0/models')) (reads++, await g.wait())
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'gemma', context_length: 49152 }] }) } }
  }
  await start($)
  await g.reached
  expect((await step($)).result.answer).toBe('ok')
  expect(reads).toBe(1)
})

test("a local provider's window is read again before each run, a remote one's only at the start", { options: form({ [LOCAL]: 'sk-local', 'https://cloud.example': 'sk-cloud' }) }, async ($, on) => {
  const w = world({ worker: [init, 'echo task', done('ok')], agents: { gem: { url: LOCAL, model: 'gemma' }, far: { url: 'https://cloud.example', model: 'gemma' } } })
  stubs(on, w)
  let size = 49152
  const hosts: string[] = []
  w.fetch = ($: unknown, e: { url: string }) => (hosts.push(new URL(e.url).host), { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'gemma', context_length: size }] }) } })
  await start($)
  expect((await step($)).result.answer).toBe('ok')
  expect(w.argv).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=49152')
  // The model is reloaded with another window between two runs.
  size = 65536
  w.messages = [...task('sum the debits'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...task('and the credits')]
  expect((await step($)).result.answer).toBe('ok')
  expect(w.argv).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536')
  expect(hosts.filter(h => h === 'cloud.example')).toEqual(['cloud.example'])
})

test('/anymodel says when the window the server reports overrides the context size in the settings', { options }, async ($, on) => {
  const w = world()
  stubs(on, w)
  w.fetch = () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'gemma', context_length: 262144 }] }) } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await $.command.run({ command: 'anymodel', args: '' })).text).toMatch(/^gem {2}gemma at http:\/\/127\.0\.0\.1:9, context 262144 \(read from 127\.0\.0\.1:9; 49152 in the settings ignored\), key set/)
})

test("the agent's view shows its text, its tool calls and their first line of output, and its answer once", { options }, async ($, on) => {
  const said = (content: unknown[]) => ({ type: 'assistant', message: { content } })
  const output = { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '41 statement.csv\n' }] } }
  const w = world({ worker: [init, 'echo task', said([{ type: 'text', text: 'Counting the rows.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'wc -l statement.csv' } }]), output, said([{ type: 'text', text: '40' }]), done('40')] })
  stubs(on, w)
  const notices: string[] = []
  on('session.append', ($: unknown, e: { message: { content: { text: string }[] } }, next: (e: unknown) => unknown) => (notices.push(e.message.content[0].text), next(e)))
  await start($)
  expect((await step($)).result.answer).toBe('40')
  expect(notices.filter(n => !n.startsWith('Done:'))).toEqual(['Counting the rows.', 'Bash(wc -l statement.csv)', '⎿ 41 statement.csv'])
})

// A Claude Code agent definition of the agent's name, where `file` puts it; what its worker then ran with.
async function runWith($: any, on: any, file?: string) {
  const files = new Map(file === undefined ? [] : [[file, '---\nname: gem\ndescription: Reviews code\ntools: Read\n---\nYou review code.\n']])
  const w = world({ worker: [init, 'echo task', done('ok')], files })
  stubs(on, w)
  await start($)
  expect((await step($)).result.answer).toBe('ok')
  // The worker's own config directory sees the user's agents.
  return { asAgent: w.argv.join(' ').includes('--agent gem'), linked: w.ran.some(a => a.join(' ').includes('/home/u/.claude/agents /home/u/.local/state/anymodel/config/agents')) }
}

test('an agent with a project agent definition of its name runs as it', { options }, async ($, on) => {
  expect(await runWith($, on, '/work/.claude/agents/gem.md')).toEqual({ asAgent: true, linked: false })
})

test('an agent with a user agent definition of its name runs as it, its worker seeing the user\'s agents', { options }, async ($, on) => {
  expect(await runWith($, on, '/home/u/.claude/agents/gem.md')).toEqual({ asAgent: true, linked: true })
})

test('/anymodel names a project agent definition by its path in the project', { options }, async ($, on) => {
  const w = world({ files: new Map([['/work/.claude/agents/gem.md', '---\nname: gem\nmodel: anymodel\n---\nYou review code.\n']]) })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await $.command.run({ command: 'anymodel', args: '' })).text).toMatch(/^gem .*, runs as \.claude\/agents\/gem\.md$/m)
})

test('an agent with no agent definition of its name runs as a plain Claude Code session', { options }, async ($, on) => {
  expect(await runWith($, on)).toEqual({ asAgent: false, linked: false })
})

test('a call of the definition by its own name runs on the agent\'s model, never on Claude', { options }, async ($, on) => {
  const spawned: { model?: string; subagentType?: string }[] = []
  const files = new Map([['/work/.claude/agents/gem.md', '---\nname: gem\ndescription: Reviews code\n---\nYou review code.\n']])
  const w = world({ worker: [init, 'echo task', done('ok')], files, spawn: async e => (spawned.push(e), { model: e.model ?? 'gemma', agentId: 'a1' }) })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ subagentType: 'gem', prompt: 'review src', description: 'review', permissionMode: 'default' })
  expect(spawned).toEqual([expect.objectContaining({ subagentType: 'anymodel:gem', model: 'gemma' })])
  expect((await step($)).result.answer).toBe('ok')
})

test('an agent named like a built-in, with no definition file, leaves the built-in on Claude', { options }, async ($, on) => {
  const spawned: { model?: string; subagentType?: string }[] = []
  const w = world({ agents: { Explore: gem }, spawn: async e => (spawned.push(e), { model: e.model ?? 'sonnet', agentId: 'a1' }) })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ subagentType: 'Explore', prompt: 'find x', description: 'find', permissionMode: 'default' })
  expect(spawned).toEqual([expect.objectContaining({ subagentType: 'Explore' })])
  expect(spawned[0].model).not.toBe('gemma')
})

test('a model list that quotes the key shows it replaced, in the answer and in /anymodel', { options }, async ($, on) => {
  const w = world({ agents: { gem: { url: LOCAL, model: 'gemma' } } })
  stubs(on, w)
  w.fetch = () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'invalid key: sk-local' }] }) } })
  await start($)
  const { answer } = (await step($)).result
  const list = (await $.command.run({ command: 'anymodel', args: '' })).text
  for (const text of [answer, list]) {
    expect(text).toMatch(/not listed \(it lists invalid key: <key>\)/)
    expect(text.includes('sk-local')).toBe(false)
  }
})

test('a provider error that quotes the key reaches main with the key replaced', { options }, async ($, on) => {
  const refused = { type: 'result', is_error: true, terminal_reason: 'api_error', result: 'API Error: 401 invalid x-api-key: sk-local' }
  const w = world({ worker: [init, 'echo task', refused] })
  stubs(on, w)
  await start($)
  const { result } = await step($)
  expect(result.answer).toMatch(/invalid x-api-key: <key>$/)
  expect(result.answer.includes('sk-local')).toBe(false)
})

test('an agent with a settings problem answers it, and the others still run', { options }, async ($, on) => {
  const w = world({ worker: [init, 'echo task', done('ok')], agents: { gem, typo: { url: 'nowhere', model: 'm' } } })
  stubs(on, w)
  await start($)
  expect((await step($)).result.answer).toBe('ok')
  const list = await $.command.run({ command: 'anymodel', args: '' })
  expect(list.text).toMatch(/^gem {3}gemma at .*\ntypo  needs fixing \(below\)\n/)
  expect(list.exitCode).toBe(1)
})

test('a message for an agent with no worker running goes to it as usual', { options }, async ($, on) => {
  const w = world({ rows: [row] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await send($, 'a1', 'also this')
  expect(w.queued).toEqual(['also this'])
})

test('the hand-back of an agent /anymodel ran is dropped only when it handed back', { options }, async ($, on) => {
  const w = world({ worker: [init, done('ok')], rows: [{ id: 'a1', type: 'anymodel:gem', status: 'running', spawnedBy: 'anymodel' }] })
  stubs(on, w)
  on('prompt.submit', ($: unknown, e: { text: string }) => ({ text: e.text }))
  await start($)
  await step($)
  // Not in auto mode: no hand-back came, so a later one (a resume in auto mode) reaches main.
  const later = await $.prompt.submit({ text: '<agent-message from="a1">ok</agent-message>', isMeta: true, origin: { kind: 'peer' } })
  expect(later.text).toBe('<agent-message from="a1">ok</agent-message>')
})

test('a spawn of an agent no longer in the settings is refused, and a spawn runs on the agent model', { options }, async ($, on) => {
  let model: string | undefined
  const w = world({ spawn: async e => ((model = e.model), { model: e.model ?? 'gemma', agentId: 'a1' }) })
  stubs(on, w)
  w.files.set('/home/u/.local/state/anymodel/agents/old1', 'gone')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const refused = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'x', resume: { agentId: 'old1' } }).catch((err: Error) => ({ deny: err.message }))
  expect(JSON.stringify(refused)).toMatch(/no longer in the settings/)
  await $.agent.spawn({ subagentType: 'anymodel:gem', prompt: 'x', description: 'x', model: 'haiku' })
  expect(model).toBe('gemma')
})

test('/anymodel lists the agents, and /anymodel check names the step that failed', { options }, async ($, on) => {
  const w = world()
  stubs(on, w)
  w.fetch = ($: unknown, e: { url: string }) =>
    e.url.endsWith('/v1/messages') ? { value: { status: 401, ok: false, headers: {}, text: JSON.stringify({ error: { message: 'invalid key' } }) } } : { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const list = await $.command.run({ command: 'anymodel', args: '' })
  expect(list.text).toMatch(/^gem {2}gemma at http:\/\/127\.0\.0\.1:9, context 49152 \(set in the settings\), key set/)
  const checked = await $.command.run({ command: 'anymodel', args: 'check' })
  expect(checked.text).toMatch(/^gem {2}context 49152 \(set in the settings\) ok \(\d+ ms\), tool call FAILED: HTTP 401: invalid key$/)
  expect(checked.exitCode).toBe(1)
})

test('/anymodel check sends a server without a key the placeholder as x-api-key, never a bearer', { options: form({}) }, async ($, on) => {
  const w = world()
  stubs(on, w)
  const sent: Record<string, string>[] = []
  w.fetch = ($: unknown, e: { url: string, init?: { headers?: Record<string, string> } }) => {
    if (e.url.endsWith('/v1/messages')) sent.push(e.init?.headers ?? {})
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  }
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'anymodel', args: 'check' })
  expect(sent.length).toBe(1)
  expect(sent[0]['x-api-key']).toBe('local')
  expect(sent[0].authorization).toBeUndefined()
})

const OR = 'https://openrouter.ai/api'

test('a save of the settings form adds the agent, writes its key with the others, and clears the form, its name last', { options: form({}, { agent: 'kimi', url: `${OR}/v1`, model: 'moonshotai/kimi-k3', api_key: 'sk-or-1' }) }, async ($, on) => {
  // The session held the keys before the dialog saved the typed key over them.
  const w = world({ keys: { [LOCAL]: 'sk-local' } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(w.agents).toEqual({ gem, kimi: { url: OR, model: 'moonshotai/kimi-k3' } })
  expect(w.saved).toEqual([{ id: 'anymodel@test', values: { api_key: JSON.stringify({ [LOCAL]: 'sk-local', [OR]: 'sk-or-1' }) } }])
  expect(w.keys).toEqual({ [LOCAL]: 'sk-local', [OR]: 'sk-or-1' })
  expect(w.cleared).toEqual(['anymodel.url', 'anymodel.model', 'anymodel.agent'])
  expect(w.toasts).toEqual(['anymodel: saved kimi, call it as @anymodel:kimi'])
  // Clearing the form reloads the plugin, and that load registers kimi: this one, replaced, registers nothing.
  expect((await $.command.run({ command: 'anymodel', args: '' })).text).not.toMatch(/kimi/)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(w.saved.length).toBe(1)
  expect((await $.command.run({ command: 'anymodel', args: '' })).text).toMatch(/\nkimi {2}moonshotai\/kimi-k3 at https:\/\/openrouter\.ai\/api, .*, key set\n/)
})

test('a reload while the form clears makes the same save again, which changes nothing', { options: form({}, { agent: 'kimi', model: 'moonshotai/kimi-k3', api_key: 'sk-or-1' }) }, async ($, on) => {
  // The URL is cleared already, and the key field still reads as the key typed before anymodel's write.
  const w = world({ agents: { gem, kimi: { url: OR, model: 'moonshotai/kimi-k3' } }, keys: { [LOCAL]: 'sk-local', [OR]: 'sk-or-1' } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect([w.saved, w.cleared, w.toasts]).toEqual([[], [], []])
})

test('a save the form cannot hold is refused, never quoting the key, and the other keys go back', { options: form({}, { agent: 'far', url: 'http://api.example.com', model: 'm', api_key: 'sk-typed-secret' }) }, async ($, on) => {
  const w = world({ keys: { [LOCAL]: 'sk-local' } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(w.agents).toEqual({ gem })
  expect(w.saved).toEqual([{ id: 'anymodel@test', values: { api_key: JSON.stringify({ [LOCAL]: 'sk-local' }) } }])
  expect(w.cleared).toEqual([])
  expect(w.toasts).toEqual(['anymodel: far not saved: http://api.example.com is plain http:// on another network, so its key would cross it unencrypted: use https://, and type its API key again'])
})

test('a form with no agent name saves nothing and says so', { options: form({ [LOCAL]: 'sk-local' }, { model: 'm' }) }, async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect([w.agents, w.saved, w.toasts]).toEqual([{ gem }, [], ['anymodel: nothing saved: give the agent a name']])
})

test('/anymodel remove drops the agent, and its server key once no agent uses it', { options: form({ [LOCAL]: 'sk-local', [OR]: 'sk-or-1' }) }, async ($, on) => {
  const w = world({ agents: { gem, kimi: { url: OR, model: 'moonshotai/kimi-k3' } } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await $.command.run({ command: 'anymodel', args: 'remove kimi' })).text).toBe('Removed kimi.')
  expect(w.agents).toEqual({ gem })
  expect(w.saved).toEqual([{ id: 'anymodel@test', values: { api_key: JSON.stringify({ [LOCAL]: 'sk-local' }) } }])
  const refused = await $.agent.spawn({ subagentType: 'anymodel:kimi', prompt: 'x', description: 'x' }).catch((err: Error) => ({ deny: err.message }))
  expect(JSON.stringify(refused)).toMatch(/no longer in the settings/)
  expect((await $.command.run({ command: 'anymodel', args: 'remove kimi' })).exitCode).toBe(1)
})

const kimi = { url: OR, model: 'moonshotai/kimi-k3' }
const filled = { agent: 'gem', url: LOCAL, model: 'gemma', context: '49152' }

test('/plugin configure anymodel <agent> opens the form holding the agent, its name written first', { options }, async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await $.command.run({ command: 'plugin', args: 'configure anymodel gem' })).text).toBe('Configuration saved.')
  expect(w.opened).toEqual(['configure anymodel'])
  expect(w.opening).toEqual([filled])
  // Closed unchanged: what the agent already has goes, its name stays.
  expect(w.sets).toEqual([['anymodel.agent', 'gem'], ['anymodel.url', LOCAL], ['anymodel.model', 'gemma'], ['anymodel.context', '49152'], ['anymodel.url', ''], ['anymodel.model', ''], ['anymodel.context', '']])
  expect(w.form).toEqual({ agent: 'gem', url: '', model: '', context: '' })
})

test('/plugin configure anymodel <agent> closed with a change keeps the change for the save, and empties only the rest', { options }, async ($, on) => {
  const w = world({ dialog: form => ({ ...form, model: 'gemma-2' }) })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'plugin', args: 'configure anymodel gem' })
  expect(w.form).toEqual({ agent: 'gem', url: '', model: 'gemma-2', context: '' })
})

for (const [what, dialog] of [['the save emptied it', () => ({ agent: '', url: '', model: '', context: '' })], ['it names another agent', (form: Record<string, string>) => ({ ...form, agent: 'gem2' })]] as const) {
  test(`/plugin configure anymodel <agent> leaves the form alone as it closes once ${what}`, { options }, async ($, on) => {
    const w = world({ dialog })
    stubs(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.command.run({ command: 'plugin', args: 'configure anymodel gem' })
    expect(w.sets.length).toBe(4)
  })
}

test("/plugin configure anymodel <agent> over another agent's settings takes them out before the name changes", { options: form({ [LOCAL]: 'sk-local', [OR]: 'sk-or-1' }) }, async ($, on) => {
  const w = world({ agents: { gem, kimi }, form: { agent: 'kimi', url: OR, model: kimi.model, context: '' } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'plugin', args: 'configure anymodel@ph3on1x gem' })
  expect(w.sets.slice(0, 6)).toEqual([['anymodel.url', ''], ['anymodel.model', ''], ['anymodel.agent', 'gem'], ['anymodel.url', LOCAL], ['anymodel.model', 'gemma'], ['anymodel.context', '49152']])
  expect([w.opened, w.opening]).toEqual([['configure anymodel@ph3on1x'], [filled]])
})

test('/plugin configure anymodel empties a form an agent was left in unchanged, its name last', { options }, async ($, on) => {
  const w = world({ form: { ...filled } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'plugin', args: 'configure anymodel' })
  expect(w.sets).toEqual([['anymodel.url', ''], ['anymodel.model', ''], ['anymodel.context', ''], ['anymodel.agent', '']])
  expect(w.opened).toEqual(['configure anymodel'])
})

test('/plugin configure anymodel keeps an agent the form holds unsaved, and opens no other agent over it', { options }, async ($, on) => {
  const w = world({ form: { agent: 'new1', url: LOCAL, model: '', context: '' } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'plugin', args: 'configure anymodel' })
  const refused = await $.command.run({ command: 'plugin', args: 'configure anymodel gem' })
  expect(refused.text).toBe('The form holds new1, not saved yet: save it or empty its fields in /plugin configure anymodel first.')
  expect(refused.exitCode).toBe(1)
  expect([w.sets, w.opened]).toEqual([[], ['configure anymodel']])
})

test('/plugin configure anymodel <name> of no agent says so, and other /plugin commands pass through', { options }, async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const missing = await $.command.run({ command: 'plugin', args: 'configure anymodel nope' })
  expect([missing.text, missing.exitCode]).toEqual(['no agent named "nope"; yours are gem', 1])
  await $.command.run({ command: 'plugin', args: 'configure other gem' })
  await $.command.run({ command: 'plugin', args: 'install anymodel@ph3on1x' })
  expect([w.sets, w.opened]).toEqual([[], ['configure other gem', 'install anymodel@ph3on1x']])
})

test('/anymodel remove empties the form holding the agent while it is still saved', { options: form({ [LOCAL]: 'sk-local', [OR]: 'sk-or-1' }) }, async ($, on) => {
  const w = world({ agents: { gem, kimi }, form: { agent: 'kimi', url: OR, model: kimi.model, context: '' } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await $.command.run({ command: 'anymodel', args: 'remove kimi' })).text).toBe('Removed kimi.')
  expect(w.sets).toEqual([['anymodel.url', ''], ['anymodel.model', ''], ['anymodel.agent', '']])
  expect(w.agents).toEqual({ gem })
})

test('/anymodel remove that cannot write the keys back removes nothing and says why', { options: form({ [LOCAL]: 'sk-local', [OR]: 'sk-or-1' }) }, async ($, on) => {
  const w = world({ agents: { gem, kimi: { url: OR, model: 'moonshotai/kimi-k3' } }, unlisted: true })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const removed = await $.command.run({ command: 'anymodel', args: 'remove kimi' })
  expect(removed.exitCode).toBe(1)
  expect(removed.text).toMatch(/^kimi not removed: anymodel can save keys only when it is installed from a marketplace/)
  expect(w.agents).toEqual({ gem, kimi: { url: OR, model: 'moonshotai/kimi-k3' } })
})
