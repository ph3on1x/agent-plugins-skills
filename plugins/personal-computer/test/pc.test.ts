// usage: claude plugin test (from plugins/personal-computer). The mod's hooks, with Claude Code, the tools and the PII
// scanner stubbed; pii.test.js covers the helpers.
import { expect, test } from 'claude-code/testing'

const STATE = '/home/u/.local/state/personal-computer'
// What /personal-computer setup leaves once its check passed: without it the plugin is off.
const SET_UP: [string, string] = [`${STATE}/setup.json`, '{"detectors":"both"}']
const statement = 'Account holder: Johanna Vexley, IBAN DE29 3704 0044 9172 6048 15. Total 2996.38'
const span = (text: string, type: string, value: string, score = 0.95) => ({ type, start: text.indexOf(value), end: text.indexOf(value) + value.length, score, model: 'opf' })

// What a test sets up: the tools' outputs by tool, the scanner's spans by text, the person's choice; and what the mod
// did: files it wrote, toasts, what core's tools got.
type World = {
  outputs: Record<string, string>
  // A tool's output as core gives it, where it is more than its text (Read of an image or PDF, a hook's context).
  results: Record<string, Record<string, unknown>>
  spans: (text: string) => unknown[]
  scanner: 'up' | 'down'
  choice?: string
  files: Map<string, string>
  toasts: string[]
  ran: string[][]
  got: Record<string, unknown>[]
  scanned: unknown[]
  submitted: string[]
  // What reached the model of the files the engine attached itself, and the paths it read for @-mentions.
  attached: string[]
  mentioned: string[]
  // The machine: its OS and CPU (uname -sm), whether uv is installed, which models the Hugging Face cache holds; and
  // the lines the model download prints.
  uname: string
  uv: boolean
  cached: string[]
  download: string[]
  // The engine's side of the interface: the mod's warning line, the panes it opened (placed or not), the settings it
  // wrote, and its store. Its session state is the test engine's own, which redraws what reads it.
  status: string | undefined
  placed: boolean
  opened: string[]
  configured: { key: string; value: string }[]
  store: Map<string, unknown>
}

function world(over: Partial<World> = {}): World {
  return {
    outputs: { Read: statement, Bash: 'Total: 2996.38' }, results: {},
    spans: text => (text.includes('Johanna Vexley') ? [span(text, 'private_person', 'Johanna Vexley')] : []),
    scanner: 'up', files: new Map([[`${STATE}/scanner.json`, JSON.stringify({ port: 4321, pid: 1 })], SET_UP]), toasts: [], ran: [], got: [], scanned: [], submitted: [], attached: [], mentioned: [],
    uname: 'Darwin arm64', uv: true, cached: ['mlx-community--openai-privacy-filter-bf16', 'perplexity-ai--PII-Tracer'],
    download: ['{"model": "opf", "status": "downloading"}', '{"model": "opf", "status": "done"}', '{"model": "pii-tracer", "status": "downloading"}', '{"model": "pii-tracer", "status": "done"}'],
    status: undefined, placed: true, opened: [], configured: [], store: new Map(), ...over,
  }
}

// anymodel, as far as this mod uses it: $.anymodel.screen, whose bottom passes an answer on unchanged, raised as
// anymodel raises it before it delivers an agent's answer: here every agent step answers ANSWER. An inline plugin
// loads from its source, so register() names the answer itself.
const ANSWER = 'Johanna Vexley spent 2996.38'
const anymodel = {
  name: 'anymodel',
  register(on: any) {
    const agents = async () => [
      { name: 'qwen', model: 'Qwen3.8-27B', url: 'http://127.0.0.1:8888', problems: [] },
      { name: 'kimi', model: 'moonshotai/kimi-k3', url: 'https://openrouter.ai/api', problems: [] },
      { name: 'broken', problems: ['the server URL must start with http:// or https://'] },
    ]
    on('engine.create', async ($: unknown, e: unknown, next: (e: unknown) => Promise<Record<string, unknown>>) => ({ ...(await next(e)), anymodel: { screen: async (a: { text: string }) => ({ text: a.text }), agents } }))
    on('turn.step', async function* ($: any, e: { turnId: string; index: number; agentId: string }) {
      const { text } = await $.anymodel.screen({ agentId: e.agentId, name: 'qwen', text: 'Johanna Vexley spent 2996.38' })
      yield { kind: 'text', index: 0, text }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    })
  },
}
// An agent's step, and the answer it delivers.
async function delivered($: any) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'qwen', messageCount: 1, agentId: 'a1' })
  let r = await stream.next()
  while (r.done !== true) r = await stream.next()
  return r.value.answer as string
}
const opts = (mode: string, prompts = 'ask', more: Record<string, string> = {}) => ({ plugins: [anymodel], options: { agent: 'qwen', mode, prompts, ...more } })

function stubs(on: any, w: World) {
  on('session.start', () => ({ cwd: '/work' }))
  // Core's prompt.submit: what entered for the model.
  on('prompt.submit', ($: unknown, e: { text: string; context?: string[] }) => (w.submitted.push(e.text), { text: e.text, context: e.context }))
  // Core's attachments: what the model reads; and core's @-mention read.
  on('prompt.attachment', ($: unknown, e: { text: string }) => (w.attached.push(e.text), { text: e.text }))
  on('prompt.mention', ($: unknown, e: { path: string }) => (w.mentioned.push(e.path), { type: 'file' }))
  on('ui.toast', ($: unknown, e: { text: string }) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('env.get', ($: unknown, e: { name: string }) => ({ value: { HOME: '/home/u' }[e.name] }))
  on('fs.read', ($: unknown, e: { path: string }) => ({ value: w.files.get(e.path) }))
  on('fs.write', ($: unknown, e: { path: string; text?: string }) => (w.files.set(e.path, e.text ?? ''), { value: undefined }))
  on('process.run', ($: unknown, e: { argv: string[] }) => {
    w.ran.push(e.argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (e.argv[0] === 'git') return ok(e.argv[3] === 'user.name' ? 'Dennis Nasarov\n' : 'dennis@example.org\n')
    if (e.argv[0] === '/usr/bin/uname') return ok(`${w.uname}\n`)
    if (e.argv[0] === '/bin/test') return { value: { exitCode: w.files.has(e.argv[2]) ? 0 : 1, stdout: '', stderr: '' } }
    if (e.argv[2] === 'command -v uv') return w.uv ? ok('/opt/homebrew/bin/uv\n') : { value: { exitCode: 1, stdout: '', stderr: '' } }
    // Starting the scanner: it writes its state file once it listens.
    if (e.argv[2]?.includes('uv run --script')) w.files.set(`${STATE}/scanner.json`, JSON.stringify({ port: 4321, pid: 1 }))
    if (e.argv[2]?.startsWith('ls ')) return { value: { exitCode: w.cached.some(m => e.argv[3].endsWith(`models--${m}`)) ? 0 : 1, stdout: '', stderr: '' } }
    return ok('')
  })
  // The model download: its lines, as uv run scan.py --download prints them.
  on('process.spawn', async function* ($: unknown, e: { argv: string[] }) {
    w.ran.push(e.argv)
    const repos: Record<string, string> = { opf: 'mlx-community--openai-privacy-filter-bf16', 'pii-tracer': 'perplexity-ai--PII-Tracer' }
    for (const line of w.download) {
      const { model, status } = JSON.parse(line)
      if (status === 'done') w.cached.push(repos[model])
      yield { stream: 'stdout', text: `${line}\n` }
    }
    if (w.download.every(l => !l.includes('pii-tracer", "status": "done'))) yield { stream: 'stderr', text: 'OSError: no space left on device\n' }
    return { value: { code: 0, signal: null } }
  })
  on('command.register', () => ({ value: undefined }))
  // The engine's timers: one fires as its dispatch resolves, after its wait.
  on('clock.after', async ($: unknown, e: { ms: number }) => (await new Promise(r => setTimeout(r, e.ms)), { value: undefined }))
  on('ui.status', ($: unknown, e: { text: string | undefined }) => ((w.status = e.text), { value: undefined }))
  on('ui.open', ($: unknown, e: { id: string }) => (w.opened.push(e.id), { value: { isPlaced: w.placed } }))
  on('config.set', ($: unknown, e: { key: string; value: string }) => (w.configured.push({ key: e.key, value: e.value }), { value: e.value }))
  on('store.get', ($: unknown, e: { key: string }) => ({ value: w.store.get(e.key) }))
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => (w.store.set(e.key, e.value), { value: undefined }))
  on('http.fetch', ($: unknown, e: { url: string; init?: { body?: string } }) => {
    if (w.scanner === 'down') return { value: { status: 502, ok: false, headers: {}, text: '{"error":"down"}' } }
    if (e.url.endsWith('/health')) return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    const body = JSON.parse(e.init?.body ?? '{}')
    w.scanned.push(body)
    const text = body.path !== undefined ? w.outputs.Read : body.text
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ spans: w.spans(text), ms: 1, ...(body.path !== undefined ? { text } : {}) }) } }
  })
  // Core's tools: each answers its output as the model reads it. The question dialog ($.ui.ask) is a tool call of its
  // own, which the person answers.
  on('tool.call', ($: unknown, e: { tool: string; questions?: { question: string }[] }) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions?.[0]?.question ?? ''
      return w.choice === undefined ? { deny: 'no one to ask' } : { result: { answers: { [question]: w.choice } } }
    }
    w.got.push(e as Record<string, unknown>)
    if (w.results[e.tool] !== undefined) return w.results[e.tool]
    const text = w.outputs[e.tool] ?? 'ok'
    return { result: { text }, text }
  })
}

const read = ($: any, file_path = '/home/u/Downloads/statement.csv') => $.tool.call({ tool: 'Read', file_path, tool_use_id: 'tu1' })

test('an output without personal data reaches Claude unchanged', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'Bash', command: 'python3 sum.py', tool_use_id: 'tu2' })
  expect(r.text).toBe('Total: 2996.38')
})

test('private mode withholds an output with personal data, names the private agent, and keeps the output locally', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await read($)
  expect(r.deny).toMatch(/1 name, 1 IBAN/)
  expect(r.deny).toMatch(/anymodel:qwen/)
  expect(r.deny).not.toMatch(/Johanna|DE29/)
  expect(r.deny).toMatch(`${STATE}/withheld/tu1.txt`)
  expect(w.files.get(`${STATE}/withheld/tu1.txt`)).toBe(statement)
})

test('mask mode gives Claude placeholders, and a file Claude writes gets the real values', opts('mask'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await read($)
  // The tool's own result, its strings masked: it reads as a normal result, not an error.
  expect(r.deny).toBeUndefined()
  expect(r.result).toEqual({ text: 'Account holder: [PERSON_1], IBAN [IBAN_1]. Total 2996.38' })
  expect(r.context?.at(-1)).toMatch(/placeholders such as \[PERSON_1\]/)
  await $.tool.call({ tool: 'Write', file_path: '/work/letter.md', content: 'Dear [PERSON_1], about [IBAN_1].', tool_use_id: 'tu3' })
  expect(w.got.at(-1)?.content).toBe('Dear Johanna Vexley, about DE29 3704 0044 9172 6048 15.')
})

test('mask mode gives a PDF as the text the scanner found in it, masked', opts('mask'), async ($, on) => {
  const w = world({ results: { Read: { result: { type: 'pdf', file: { filePath: '/home/u/statement.pdf', base64: 'JVBERi0', originalSize: 9 } }, text: '' } } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await read($, '/home/u/statement.pdf')
  expect(r.result).toEqual({ type: 'text', file: { filePath: '/home/u/statement.pdf', content: 'Account holder: [PERSON_1], IBAN [IBAN_1]. Total 2996.38', numLines: 1, startLine: 1, totalLines: 1 } })
})

test('ask mode lets the person share the output as it is', opts('ask'), async ($, on) => {
  const w = world({ choice: 'Share as-is' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await read($)).text).toBe(statement)
})

test('ask mode with no one to ask processes the output privately', opts('ask'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await read($)).deny).toMatch(/anymodel:qwen/)
})

test('an output the scanner cannot check is withheld, never passed on', opts('private'), async ($, on) => {
  const w = world({ scanner: 'down' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'Bash', command: 'cat statement.csv', tool_use_id: 'tu4' })
  expect(r.deny).toMatch(/could not check this output for personal data/)
  // Started at the session start, and again for the output: a scanner that exited when idle comes back.
  expect(w.ran.filter(a => a[0] === '/bin/sh' && a[2].includes('uv run --script')).length).toBe(2)
})

const PDF = '/home/u/Downloads/statement.pdf'
const PDF_READS = {
  whole: { type: 'pdf', file: { filePath: PDF, base64: 'JVBERi0', originalSize: 9 } },
  'as page images': { type: 'parts', file: { filePath: PDF, originalSize: 9, count: 1, outputDir: '/tmp/p' }, pages: [{ base64: 'iVBOR', mediaType: 'image/png' }] },
}
for (const [how, result] of Object.entries(PDF_READS)) {
  test(`a PDF read ${how} is scanned through the text the scanner reads from it`, opts('private'), async ($, on) => {
    const w = world({ results: { Read: { result, text: '' } } })
    stubs(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const r = await read($, PDF)
    expect(w.scanned).toContainEqual({ path: PDF, models: ['opf', 'pii-tracer'] })
    expect(r.deny).toMatch(/1 name, 1 IBAN/)
  })
}

test('an image cannot be checked for personal data, so it is withheld', opts('private'), async ($, on) => {
  const w = world({ results: { Read: { result: { type: 'image', file: { base64: 'iVBOR', type: 'image/png', originalSize: 9 } }, text: '' } } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await read($, '/home/u/Desktop/screenshot.png')
  expect(r.deny).toMatch(/is an image, which cannot be checked/)
  expect(w.scanned).toEqual([])
})

test('an image an MCP tool returns is withheld as well', opts('private'), async ($, on) => {
  const w = world({ results: { mcp__shots__capture: { result: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }], text: '' } } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'mcp__shots__capture', tool_use_id: 'tu8' } as any)
  expect(r.deny).toMatch(/is an image, which cannot be checked/)
})

test("personal data a hook added to an output's context counts too", opts('private'), async ($, on) => {
  const w = world({ results: { Bash: { result: { stdout: 'done' }, text: 'done', context: ['Last row: Johanna Vexley'] } } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'tu7' })
  expect(r.deny).toMatch(/1 name/)
})

test("the user's own name in an output does not count as personal data", opts('private'), async ($, on) => {
  const log = 'a3f9 Dennis Nasarov fix the parser'
  const w = world({ outputs: { Bash: log }, spans: text => [span(text, 'private_person', 'Dennis Nasarov')] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await $.tool.call({ tool: 'Bash', command: 'git log -1', tool_use_id: 'tu5' })).text).toBe(log)
})

test("an anymodel agent's answer is screened by anymodel.screen, not withheld again at its Agent call", opts('private'), async ($, on) => {
  const w = world({ outputs: { Agent: statement } })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'Agent', subagent_type: 'anymodel:qwen', description: 'sum', prompt: 'sum it', tool_use_id: 'tu6' })
  expect(r.text).toBe(statement)
})

test("an anymodel answer with personal data reaches Claude masked, the full answer kept locally", opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await delivered($)).toBe('[PERSON_1] spent 2996.38')
  expect(w.files.get(`${STATE}/withheld/answer-qwen-a1.txt`)).toBe(ANSWER)
  expect(w.toasts.some(t => t.includes('qwen') && t.includes('1 name'))).toBe(true)
})

test('an anymodel answer the scanner cannot check is withheld', opts('private'), async ($, on) => {
  const w = world({ scanner: 'down' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(await delivered($)).toMatch(/could not check this answer/)
})

const notification = '<task-notification><status>completed</status><result>Johanna Vexley spent 2996.38</result></task-notification>'

test("a background task's notification with personal data reaches Claude masked, the full text kept locally", opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: notification, origin: { kind: 'task-notification' }, wait: false } as any)
  expect(w.submitted).toEqual(['<task-notification><status>completed</status><result>[PERSON_1] spent 2996.38</result></task-notification>'])
  expect([...w.files.values()]).toContain(notification)
})

const typed = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as any

test('with prompts off, a prompt the person typed is not checked', opts('private', 'off'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to Johanna Vexley'])
  expect(w.scanned).toEqual([])
})

test('a typed prompt with personal data asks first, by default: masked, it goes with a note on the placeholders', opts('private'), async ($, on) => {
  const w = world({ choice: 'Mask' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to [PERSON_1]'])
})

test('a typed prompt the person sends as is goes unchanged, and one they cancel does not go', opts('private'), async ($, on) => {
  const w = world({ choice: 'Send as is' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  w.choice = 'Cancel'
  const r = await $.prompt.submit(typed('Call Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to Johanna Vexley'])
  expect(r.drop).toMatch(/not sent/)
})

test('a typed prompt with no one to ask is masked', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to [PERSON_1]'])
})

test('with prompts mask, a typed prompt is masked without asking', opts('private', 'mask'), async ($, on) => {
  const w = world({ choice: 'Send as is' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to [PERSON_1]'])
})

test('an @-mention in a prompt is left for the file check: masked, it would not resolve', opts('private'), async ($, on) => {
  const w = world({ choice: 'Mask', spans: text => [span(text, 'private_person', '@statement.csv'), ...(text.includes('Johanna Vexley') ? [span(text, 'private_person', 'Johanna Vexley')] : [])] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('@statement.csv What is in this file?'))
  await $.prompt.submit(typed('@statement.csv Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['@statement.csv What is in this file?', '@statement.csv Write to [PERSON_1]'])
})

test('a typed prompt without personal data goes unchanged', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit(typed('Sum the debits'))
  expect(w.submitted).toEqual(['Sum the debits'])
})

test('a typed prompt the scanner cannot check does not go', opts('private'), async ($, on) => {
  const w = world({ scanner: 'down' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual([])
  expect(r.drop).toMatch(/could not check/)
})

// A file the engine attaches itself, with no tool call: one the user names after an @, or one Claude read that changed.
const attach = (type: string, text: string) => ({ type, text, origin: { kind: 'engine' } }) as any

test('a file the user @-mentions with personal data is withheld in private mode, and kept locally', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.attachment(attach('file', statement))
  expect(w.attached).toHaveLength(1)
  expect(w.attached[0]).toMatch(/A file the user mentioned contains personal data \(1 name, 1 IBAN\)/)
  expect(w.attached[0]).toMatch(/anymodel:qwen/)
  expect(w.attached[0]).not.toMatch(/Johanna|DE29/)
  expect([...w.files.values()]).toContain(statement)
})

test('a changed file the engine shows Claude is withheld in private mode, named as a changed file', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.attachment(attach('edited_text_file', statement))
  expect(w.attached[0]).toMatch(/^A file that changed on disk contains personal data \(1 name, 1 IBAN\)/)
  expect(w.attached[0]).not.toMatch(/Johanna|DE29/)
})

test('a changed file the engine shows Claude is masked in mask mode', opts('mask'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.attachment(attach('edited_text_file', statement))
  expect(w.attached).toEqual(['Account holder: [PERSON_1], IBAN [IBAN_1]. Total 2996.38'])
})

test("the engine's own attachments are not checked", opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.attachment(attach('todo_reminder', 'Call Johanna Vexley'))
  expect(w.attached).toEqual(['Call Johanna Vexley'])
  expect(w.scanned).toEqual([])
})

test('an attached file the scanner cannot check is withheld', opts('private'), async ($, on) => {
  const w = world({ scanner: 'down' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.attachment(attach('file', statement))
  expect(w.attached).toHaveLength(1)
  expect(w.attached[0]).toMatch(/could not check/)
})

test('an @-mentioned image is not read, unless the person shares it in ask mode', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.prompt.mention({ mention: 'shot.png', path: '/work/shot.png' })
  const t = await $.prompt.mention({ mention: 'notes.md', path: '/work/notes.md' })
  expect(r.deny).toMatch(/image/)
  expect(t.type).toBe('file')
  expect(w.mentioned).toEqual(['/work/notes.md'])
})

test('in ask mode the person can share an @-mentioned image', opts('ask'), async ($, on) => {
  const w = world({ choice: 'Share as-is' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.prompt.mention({ mention: 'shot.png', path: '/work/shot.png' })
  expect(r.type).toBe('file')
})

const command = ($: any, args: string) => $.command.run({ command: 'personal-computer', args })

test('/personal-computer check reports every part working, the private agent on this machine', opts('private'), async ($, on) => {
  const w = world({ spans: text => [span(text, 'private_person', 'Johanna Vexley-Canary')] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'check')
  expect(r.exitCode).toBeUndefined()
  expect(r.text).toMatch(/mode private, prompts ask, detectors both/)
  expect(r.text).toMatch(/platform +ok: macOS on Apple silicon/)
  expect(r.text).toMatch(/uv +ok: \/opt\/homebrew\/bin\/uv/)
  expect(r.text).toMatch(/models +ok: OpenAI Privacy Filter, PII-Tracer/)
  expect(r.text).toMatch(/scanner +ok: found 1 name, 1 IBAN in a test text/)
  expect(r.text).toMatch(/agent +ok: qwen, Qwen3.8-27B at http:\/\/127\.0\.0\.1:8888 \(this machine\)\. \/anymodel check qwen tests it/)
  expect(r.text).not.toMatch(/Johanna|DE29/)
})

test('/personal-computer check names each gap and how to fix it', opts('private', 'ask', { agent: 'nobody' }), async ($, on) => {
  const w = world({ uname: 'Linux x86_64', uv: false, cached: ['mlx-community--openai-privacy-filter-bf16'] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'check')
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/platform +FAILED: .*Apple silicon/)
  expect(r.text).toMatch(/uv +MISSING: .*docs\.astral\.sh\/uv/)
  expect(r.text).toMatch(/models +MISSING: PII-Tracer\. Run \/personal-computer setup/)
  expect(r.text).toMatch(/scanner +not started/)
  expect(r.text).toMatch(/agent +MISSING: no anymodel agent named "nobody"; yours are qwen, kimi, broken/)
})

test('/personal-computer check warns when the private agent is not on this machine, or has a problem', opts('private', 'ask', { agent: 'kimi' }), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await command($, 'check')).text).toMatch(/agent +ok: kimi, moonshotai\/kimi-k3 at https:\/\/openrouter\.ai\/api: not this machine, so personal data goes to openrouter\.ai/)
})

test('/personal-computer check reports an agent with a problem', opts('private', 'ask', { agent: 'broken' }), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'check')
  expect(r.text).toMatch(/agent +FAILED: broken: the server URL must start with http:\/\/ or https:\/\/; fix it in \/plugin configure anymodel broken/)
  expect(r.exitCode).toBe(1)
})

test('in mask mode no private agent is needed', opts('mask', 'ask', { agent: '' }), async ($, on) => {
  const w = world({ spans: text => [span(text, 'private_person', 'Johanna Vexley-Canary')] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'check')
  expect(r.text).toMatch(/agent +not needed in mask mode/)
  expect(r.exitCode).toBeUndefined()
})

test('a scanner that misses the test text fails the check', opts('private'), async ($, on) => {
  const w = world({ spans: () => [] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'check')
  expect(r.text).toMatch(/scanner +FAILED: found 1 IBAN in a test text that holds 1 name, 1 IBAN/)
  expect(r.exitCode).toBe(1)
})

test('with the models missing, an output is withheld at once, naming setup, and no download starts', opts('private'), async ($, on) => {
  const w = world({ cached: [] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'Bash', command: 'cat statement.csv', tool_use_id: 'tu9' })
  expect(r.deny).toMatch(/models are not downloaded.*\/personal-computer setup/)
  expect(w.status).toMatch(/models are missing.*withheld.*\/personal-computer setup/)
  expect(w.ran.some(a => a[0] === '/bin/sh' && a[2]?.includes('uv run --script'))).toBe(false)
})

test('/personal-computer setup downloads the chosen models, starts the scanner and checks it', opts('private', 'ask', { detectors: 'opf' }), async ($, on) => {
  const w = world({ cached: [], spans: text => [span(text, 'private_person', 'Johanna Vexley-Canary')],
    download: ['{"model": "opf", "status": "downloading"}', '{"model": "opf", "status": "done"}'] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'setup')
  const download = w.ran.find(a => a.includes('--download'))
  expect(download?.slice(-3)).toEqual(['--download', '--models', 'opf'])
  expect(w.toasts.some(t => /Downloading OpenAI Privacy Filter/.test(t))).toBe(true)
  expect(r.text).toMatch(/scanner +ok: found 1 name, 1 IBAN/)
  expect(r.text).toMatch(/detectors opf/)
})

test('/personal-computer setup that fails says why', opts('private'), async ($, on) => {
  const w = world({ cached: [], download: ['{"model": "opf", "status": "downloading"}', '{"model": "opf", "status": "done"}', '{"model": "pii-tracer", "status": "downloading"}'] })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'setup')
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/PII-Tracer did not download: OSError: no space left on device/)
})

test('detectors opf scans with OPF alone', opts('private', 'ask', { detectors: 'opf' }), async ($, on) => {
  const w = world({ files: new Map([SET_UP]) })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'tu10' })
  expect(w.scanned).toEqual([{ text: 'Total: 2996.38', models: ['opf'] }])
  expect(w.ran.find(a => a[0] === '/bin/sh' && a[2]?.includes('uv run --script'))?.slice(-2)).toEqual(['--models', 'opf'])
})

// The plugin before /personal-computer setup: installed, no setup file.
const fresh = () => new Map([[`${STATE}/scanner.json`, JSON.stringify({ port: 4321, pid: 1 })]])

test('before setup nothing is checked: outputs, prompts and mentioned files reach Claude unchanged, and no scanner starts', opts('private'), async ($, on) => {
  const w = world({ files: fresh() })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await read($)
  expect(r.deny).toBeUndefined()
  expect(r.text).toBe(statement)
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to Johanna Vexley'])
  await $.prompt.attachment(attach('file', statement))
  expect(w.attached).toEqual([statement])
  expect(w.scanned).toEqual([])
  expect(w.ran.some(a => a[2]?.includes('uv run --script'))).toBe(false)
  expect(w.status).toBeUndefined()
})

test('before setup the first session says once how to turn it on', opts('private'), async ($, on) => {
  const w = world({ files: fresh() })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(w.toasts.filter(t => /off.*\/personal-computer/.test(t))).toHaveLength(1)
  expect(w.toasts.some(t => /private agent|not downloaded/.test(t))).toBe(false)
})

// The engine's own footer: it draws the mode labels it is handed.
const footer = (on: any) => on('ui.render', ($: any, e: { props: { modes: string[] } }) => {
  const { Text } = $.ui.resolve(e)
  return Text({ children: e.props.modes.join(' & ') })
})
const MODES = { plugin: 'personal-computer', component: 'SessionMode', requestId: 'footer', props: { modes: ['focus'] } } as const

test('set up, the footer shows personal computer beside the other modes', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  footer(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...MODES, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('focus & personal computer')
  await ui.unmount()
})

test('not set up, the footer shows nothing of it', opts('private'), async ($, on) => {
  const w = world({ files: fresh() })
  stubs(on, w)
  footer(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...MODES, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('focus')
  await ui.unmount()
})

test('set up but unable to check, a warning line says outputs are withheld, and it clears once a check works', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  w.scanner = 'down'
  expect((await read($)).deny).toMatch(/could not check/)
  expect(w.status).toMatch(/can't check for personal data.*withheld.*\/personal-computer/)
  w.scanner = 'up'
  await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'tu11' })
  expect(w.status).toBeUndefined()
})

test('a prompt that cannot be checked asks to send it unchecked or cancel; with no one to ask it is not sent', opts('private'), async ($, on) => {
  const w = world({ choice: 'Send unchecked' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  w.scanner = 'down'
  await $.prompt.submit(typed('Write to Johanna Vexley'))
  expect(w.submitted).toEqual(['Write to Johanna Vexley'])
  w.choice = 'Cancel'
  expect((await $.prompt.submit(typed('again'))).drop).toMatch(/not sent/)
  w.choice = undefined
  expect((await $.prompt.submit(typed('once more'))).drop).toMatch(/could not check the prompt/)
  expect(w.submitted).toEqual(['Write to Johanna Vexley'])
})

test('with prompts mask, a prompt that cannot be checked is not sent', opts('private', 'mask'), async ($, on) => {
  const w = world({ choice: 'Send unchecked' })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  w.scanner = 'down'
  expect((await $.prompt.submit(typed('Write to Johanna Vexley'))).drop).toMatch(/could not check the prompt/)
  expect(w.submitted).toEqual([])
})

test('/personal-computer opens its pane; where no pane can be placed it prints the check', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await command($, '')
  expect(w.opened).toEqual(['personal-computer'])
  w.placed = false
  expect((await command($, '')).text).toMatch(/platform +ok/)
})

const PANE = {
  plugin: 'personal-computer', component: 'Pane', requestId: 'personal-computer',
  props: { title: 'Personal computer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// Waits for the pane to show `text`: a press's handler runs on after the press resolves.
async function shows(ui: any, text: RegExp) {
  for (let i = 0; i < 50; i++) {
    if ((await ui.findAll({ type: 'Text' })).some((t: { text: string }) => text.test(t.text))) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return false
}

test('the pane before setup: off, the settings, what is missing, and Set up, which turns it on', opts('private'), async ($, on) => {
  const w = world({ files: fresh(), cached: [], spans: text => [span(text, 'private_person', 'Johanna Vexley-Canary')] })
  stubs(on, w)
  footer(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await command($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shows(ui, /^○ Off/)).toBe(true)
  expect(await shows(ui, /✗ Detection models/)).toBe(true)
  expect(await ui.find({ key: 'mode' })).toBeDefined()
  expect(await ui.find({ key: 'agent' })).toBeDefined()
  await ui.press({ key: 'setup' })
  expect(await shows(ui, /^● On/)).toBe(true)
  expect(w.files.has(`${STATE}/setup.json`)).toBe(true)
  await ui.unmount()
  const bar = await $.ui.mount({ ...MODES, surface: 'terminal' })
  expect((await bar.find({ type: 'Text' }))?.text).toBe('focus & personal computer')
  await bar.unmount()
})

test('the pane\'s choices write the plugin\'s settings, and its agents are anymodel\'s', opts('private'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await command($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shows(ui, /^● On/)).toBe(true)
  await ui.select({ key: 'mode', value: 'mask' })
  await ui.select({ key: 'agent', value: 'kimi' })
  await ui.select({ key: 'prompts', value: 'off' })
  await ui.select({ key: 'detectors', value: 'opf' })
  expect(w.configured).toEqual([
    { key: 'personal-computer.mode', value: 'mask' },
    { key: 'personal-computer.agent', value: 'kimi' },
    { key: 'personal-computer.prompts', value: 'off' },
    { key: 'personal-computer.detectors', value: 'opf' },
  ])
  await ui.unmount()
})

test('in mask mode the pane asks for no agent', opts('mask'), async ($, on) => {
  const w = world()
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await command($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await shows(ui, /^● On/)).toBe(true)
  expect(await ui.find({ key: 'agent' })).toBeUndefined()
  await ui.unmount()
})

test('off, the check does not start the scanner: it starts with setup', opts('private'), async ($, on) => {
  const w = world({ files: fresh() })
  stubs(on, w)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await command($, 'check')
  expect(r.text).toMatch(/^personal computer off/)
  expect(r.text).toMatch(/scanner +starts with setup/)
  expect(w.scanned).toEqual([])
  expect(w.ran.some(a => a[2]?.includes('uv run --script'))).toBe(false)
})
