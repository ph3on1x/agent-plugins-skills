import { atom, read, update } from 'claude-code'

import ARTIFACTS from '../scanner/artifacts.js'
import { findings, hide, mask, reserved, restore, summary, withheldNotice } from './pii.js'

// personal-computer: every tool output is scanned for personal data on this machine before Claude reads it. Output
// with personal data is withheld (mode private: Claude asks the user's private anymodel agent instead), masked (mode
// mask) or left to the user (mode ask); so is a file the engine attaches itself (an @-mention, a changed file). Answers
// Claude gets, an anymodel agent's (where anymodel delivers it) and a background task's notification, are masked. A
// prompt the person sends is checked too (setting prompts): they choose, mask, or send it unchecked. Until
// /personal-computer setup has passed its check, the plugin is off and checks nothing.

const MODES = ['private', 'mask', 'ask']
const PROMPTS = ['off', 'ask', 'mask']
// Files the engine reads into a request itself, with no tool call: one the user names after an @, and one Claude wrote
// that changed on disk since (seen in an interactive session; never raised for a file Claude only read).
const FILE_ATTACHMENTS = ['file', 'edited_text_file']
// How the notice Claude reads names each: the user's @-mention, or a file Claude wrote that changed since.
const ATTACHMENT_SOURCE = { file: 'A file the user mentioned', edited_text_file: 'A file that changed on disk' }
const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i
// The detectors setting, and each model's name for the person. What each runtime fetches of it, where it keeps it and
// its size: scanner/artifacts.js, which the scanner reads too.
const DETECTORS = { both: ['opf', 'pii-tracer'], opf: ['opf'], 'pii-tracer': ['pii-tracer'] }
const MODEL_LABEL = { opf: 'OpenAI Privacy Filter', 'pii-tracer': 'PII-Tracer' }
// The runtime setting: auto is MLX on a Mac with Apple silicon, ONNX Runtime elsewhere; gguf is PII-Tracer on llama.cpp.
const RUNTIMES = ['auto', 'mlx', 'onnx', 'onnx-int8', 'gguf']
// A model's artifact for a runtime; a runtime it has none for names the one it uses instead (scan.py's artifact()).
const pick = (m, rt) => typeof ARTIFACTS[m][rt] === 'string' ? ARTIFACTS[m][ARTIFACTS[m][rt]] : ARTIFACTS[m][rt]
let chosen = 'auto'
// What the check scans: one name and one IBAN, so a scanner that finds less is not working.
const SELF_TEST = 'Account holder: Johanna Vexley-Canary, IBAN DE29 3704 0044 9172 6048 15'
// The detectors this session uses, and those found whole in the cache: a download is not undone, so one found is not
// looked up again.
let models = DETECTORS.both
const ready = new Set()
// What the footer and the pane draw (types/index.d.ts); a pane's setting change reloads the plugin, and these stay.
const isOn = atom({ plugin: 'personal-computer', key: 'isOn' }, false, { shape: 'isOn-1' })
const checked = atom({ plugin: 'personal-computer', key: 'checks' }, [], { shape: 'checks-1' })
const agentNames = atom({ plugin: 'personal-computer', key: 'agents' }, [], { shape: 'agents-1' })
const progress = atom({ plugin: 'personal-computer', key: 'progress' }, '', { shape: 'progress-1' })
const PANE = 'personal-computer'
// The toast that says how to turn the plugin on, shown once per install.
const HINTED = 'hinted'
// Set up: read once per load, so a reload never leaves a gap where outputs pass unchecked.
let active
// Whether the warning line is up: set up, a check that fails withholds, and the line says so on every surface.
let warned = false
const WARNING = 'can\'t check for personal data, so outputs are withheld · /personal-computer'
const MODELS_MISSING = absent => `the detection models are missing (${labels(absent)}), so outputs are withheld · /personal-computer setup`
// Placeholders of mask mode for the session: [PERSON_1] → the value, restored in files Claude writes. Loaded once per
// load from the session's file (loadTable), so a resumed session or a reload keeps them.
let table
// The user's own name and email, from git config and the account's full name: their commits, signatures and files
// are no one else's data.
let allow = []
const OWN = [['git', 'config', '--get', 'user.name'], ['git', 'config', '--get', 'user.email'], ['/usr/bin/id', '-F']]
const PLACEHOLDERS = 'personal-computer replaced the personal data in this output with placeholders such as [PERSON_1]. ' +
  'Use them as they are: files you write get the real values back.'
const PROMPT_PLACEHOLDERS = 'personal-computer replaced the personal data in the user\'s prompt with placeholders such as ' +
  '[PERSON_1]. Use them as they are: files you write get the real values back.'

const nap = $ => $.process.run(['/bin/sleep', '0.5'])
// When a scanner start last failed to come up: for a minute after, a check fails at once rather than wait again, so a
// scanner that cannot start (its environment does not build) costs one wait, not one per tool call.
let startFailedAt = 0
const RETRY_MS = 60_000

// The file /personal-computer setup leaves once its check passed; without it the plugin is off.
async function setupFile($) {
  return `${await stateDir($)}/setup.json`
}

// Native Windows has none of the POSIX programs the plugin runs, so it stays off there; Claude Code inside WSL 2 is
// Linux.
const NATIVE_WINDOWS = 'native Windows isn\'t supported yet, run Claude Code inside WSL 2'
const isNativeWindows = async $ => (await $.env.get('OS')) === 'Windows_NT'

// The OS and CPU, as uname -sm says them (Darwin arm64, Linux x86_64), read once per load.
let uname
async function machine($) {
  if (await isNativeWindows($)) return 'Windows'
  return (uname ??= (await $.process.run(['/usr/bin/uname', '-sm'])).stdout.trim())
}

const runtime = async $ => chosen !== 'auto' ? chosen : (await machine($)) === 'Darwin arm64' ? 'mlx' : 'onnx'
const artifact = async ($, m) => pick(m, await runtime($))
const RUNTIME_LABEL = { mlx: 'MLX', onnx: 'ONNX Runtime', 'onnx-int8': 'ONNX Runtime, 8-bit models', gguf: 'llama.cpp for PII-Tracer, ONNX Runtime for OpenAI Privacy Filter' }

// Off while the setup file is missing. A state that cannot be read (EACCES) may hide a setup, so it raises and every
// output is withheld until it reads.
async function isSetUp($) {
  if (await isNativeWindows($)) return false
  return $.fs.stat(await setupFile($)).then(() => true, err => {
    if (/\bENOENT$/.test(err.message)) return false
    throw new Error(`cannot tell whether personal-computer is set up: ${err.message}`)
  })
}

const isActive = async $ => (active ??= await isSetUp($))

async function stateDir($) {
  const dir = `${(await $.env.get('XDG_STATE_HOME')) ?? `${await $.env.get('HOME')}/.local/state`}/personal-computer`
  const made = await $.process.run(['/bin/mkdir', '-p', '-m', '700', dir, `${dir}/withheld`])
  if (made.exitCode !== 0) throw new Error(`cannot create ${dir}: ${made.stderr.trim()}`)
  return dir
}

// The scanner's base URL once it answers its health check; undefined while it is not running.
async function scannerUrl($) {
  try {
    const { port } = JSON.parse(await $.fs.read(`${await stateDir($)}/scanner.json`))
    const r = await $.http.fetch(`http://127.0.0.1:${port}/health`)
    return r.ok ? `http://127.0.0.1:${port}` : undefined
  } catch {
    return undefined
  }
}

// One scanner serves every session, so it is started detached: it outlives this session, and exits by itself after
// 30 minutes without a request. Its lock makes a second start exit at once. It loads this session's detectors at
// once, and another session's when that one asks.
async function startScanner($) {
  if ((await scannerUrl($)) !== undefined) return
  const dir = await stateDir($)
  const started = await $.process.run(['/bin/sh', '-c',
    'command -v uv >/dev/null || { echo "uv is not installed (https://docs.astral.sh/uv/)" >&2; exit 127; }; nohup uv run --script "$0" --state "$1" "$3" "$4" "$5" "$6" >"$2" 2>&1 &',
    `${$.plugin.root}/scanner/scan.py`, `${dir}/scanner.json`, `${dir}/scanner.log`, '--models', models.join(','), '--runtime', await runtime($)])
  if (started.exitCode !== 0) throw new Error(`cannot start the PII scanner: ${started.stderr.trim()}`)
}

// Hugging Face's home, as huggingface_hub finds it; scan.py finds it alike.
const hfHome = async $ => (await $.env.get('HF_HOME')) ?? `${(await $.env.get('XDG_CACHE_HOME')) ?? `${await $.env.get('HOME')}/.cache`}/huggingface`

async function hubDir($) {
  const hub = await $.env.get('HF_HUB_CACHE')
  return hub ? hub : `${await hfHome($)}/hub`
}

// Where a model is kept: an MLX one in the Hugging Face cache; an ONNX one as plain files in a folder of its own, since
// ONNX Runtime refuses external data behind the cache's symlinks.
const where = async ($, a) => a.store === 'local' ? `${await hfHome($)}/personal-computer/${a.repo.replace('/', '--')}@${a.revision}` : `${await hubDir($)}/models--${a.repo.replace('/', '--')}`

// Whether a model is whole: in the cache, its weights and tokenizer appear in its snapshot once their download
// completed; in its own folder, each of its files.
async function isFetched($, a) {
  const dir = await where($, a)
  if (a.store === 'hub') return (await $.process.run(['/bin/sh', '-c', 'ls "$0"/snapshots/*/model.safetensors "$0"/snapshots/*/tokenizer.json >/dev/null 2>&1', dir])).exitCode === 0
  for (const f of a.files) if (!(await $.fs.exists(`${dir}/${f}`))) return false
  return true
}

// The detectors of this session not yet fetched whole for its runtime.
async function missing($) {
  const absent = []
  for (const m of models) {
    if (ready.has(m)) continue
    if (await isFetched($, await artifact($, m))) ready.add(m)
    else absent.push(m)
  }
  return absent
}

const labels = ms => ms.map(m => MODEL_LABEL[m]).join(', ')
const sizes = async ($, ms) => (await Promise.all(ms.map(m => artifact($, m)))).map(a => a.size).join(' + ')

// The scanner's spans for a text, or for a PDF it reads itself (its text comes back with them). Missing models are
// fetched by /personal-computer setup, never here: a download takes minutes. A scanner that exited (idle) is started
// again; it waits up to a minute for one still loading, and a start that never came up is not waited for again within
// the minute after.
async function scan($, body) {
  try {
    const answer = await scanOnce($, body)
    if (warned) {
      warned = false
      $.ui.status(undefined)
    }
    return answer
  } catch (err) {
    if (active) {
      warned = true
      $.ui.status(err.absent === undefined ? WARNING : MODELS_MISSING(err.absent))
    }
    throw err
  }
}

async function scanOnce($, body) {
  const absent = await missing($)
  if (absent.length > 0) throw Object.assign(new Error(`the detection models are not downloaded (${labels(absent)}): run /personal-computer setup`), { absent })
  let url = await scannerUrl($)
  if (url === undefined) {
    const failed = new Error(`the PII scanner did not start (its log: ${await stateDir($)}/scanner.log)`)
    if (Date.now() - startFailedAt < RETRY_MS) throw failed
    await startScanner($)
    for (let i = 0; i < 120 && (url = await scannerUrl($)) === undefined; i++) await nap($)
    if (url === undefined) {
      startFailedAt = Date.now()
      throw failed
    }
  }
  const r = await $.http.fetch(`${url}/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, models, runtime: await runtime($) }) })
  const answer = JSON.parse(r.text)
  if (!r.ok || !Array.isArray(answer.spans)) throw new Error(`the PII scanner failed: ${answer.error ?? r.status}`)
  return answer
}

// A PDF reaches the model as a document or as page images: the scanner reads the file's text instead.
const pdfPath = (e, r) => e.tool === 'Read' && ['pdf', 'parts'].includes(r.result?.type) ? r.result.file.filePath : undefined
// An image reaches the model as pixels, which the scanner cannot read: it counts as unchecked. Read gives one as
// {type: 'image'}, Bash marks it isImage, an MCP tool returns image blocks.
const hasImage = v => v !== null && typeof v === 'object' && (v.type === 'image' || v.isImage === true || Object.values(v).some(hasImage))
const isImage = (e, r) => pdfPath(e, r) === undefined && hasImage(r.result)

// What the model would read of a tool's output (its text and any hook's context), and the personal data in it.
// `image` is set for an output the scanner cannot read.
async function inspect($, e, r) {
  if (isImage(e, r)) return { text: '', found: [], image: true }
  const path = pdfPath(e, r)
  if (path !== undefined) {
    const { spans, text } = await scan($, { path })
    return { text, found: findings(text, spans, allow) }
  }
  const text = [r.text ?? '', ...(r.context ?? [])].join('\n\n')
  if (text.trim() === '') return { text, found: [] }
  const { spans } = await scan($, { text })
  return { text, found: findings(text, spans, allow) }
}

// The output kept on this machine, for the private agent to read instead of running the tool again.
async function keep($, name, text) {
  const file = `${await stateDir($)}/withheld/${name.replace(/[^\w.-]/g, '_')}.txt`
  await $.fs.write(file, text)
  await $.process.run(['/bin/chmod', '600', file])
  return file
}

// The session's placeholders, kept beside its withheld outputs: resumed (a new process) or reloaded (a setting changed
// in the pane), the session restores them, and numbers new values after them rather than give [PERSON_1] again.
async function tableFile($) {
  return `${await stateDir($)}/withheld/${String(await $.session.id()).replace(/[^\w.-]/g, '_')}.placeholders.json`
}

async function loadTable($) {
  if (table !== undefined) return
  const file = await tableFile($)
  const r = await $.process.run(['/bin/test', '-e', file])
  if (r.exitCode > 1) throw new Error(`cannot tell whether ${file} exists: ${r.stderr.trim()}`)
  // None kept for this session id: a new session, or a fork, whose history keeps its parent's placeholders.
  const loaded = r.exitCode === 0 ? JSON.parse(await $.fs.read(file)) : reserved(JSON.stringify(await $.session.messages()))
  // A load that ran alongside may have set it, and a mask since extended it.
  table ??= loaded
}

// Saves run one after another, each with the table as it is then: parallel masks never interleave their writes.
let saving = Promise.resolve()
function saveTable($) {
  const save = saving.then(async () => {
    const file = await tableFile($)
    await $.fs.write(file, JSON.stringify(table))
    await $.process.run(['/bin/chmod', '600', file])
  })
  saving = save.catch(() => {})
  return save
}

// `text` with `found` masked by the session's placeholders, saved before Claude gets it.
async function maskSession($, text, found) {
  await loadTable($)
  const m = mask(text, found, table)
  table = m.table
  await saveTable($)
  return m.text
}

// What it keeps (withheld outputs, masked answers, placeholders) past Claude Code's own cleanup period, when the
// transcripts that name them are gone too: removed at each start and by /personal-computer cleanup [days]. The
// session's own placeholders stay, however old.
async function cleanup($, days) {
  const dir = `${await stateDir($)}/withheld`
  const r = await $.process.run(['/usr/bin/find', dir, '-type', 'f', '-mtime', `+${days}`, '!', '-path', await tableFile($), '-print', '-delete'])
  if (r.exitCode !== 0) throw new Error(`cannot clean up ${dir}: ${r.stderr.trim()}`)
  return `Removed ${r.stdout.split('\n').filter(Boolean).length} file(s) older than ${days} days from ${dir}.`
}

const cleanupDays = async $ => Number((await $.settings.read({ key: 'cleanupPeriodDays' })) ?? 30)

// A Read result of text, as the Read tool gives one for a text file: how a masked PDF reaches the model.
const textRead = (filePath, content) => {
  const lines = content.split('\n').length
  return { type: 'text', file: { filePath, content, numLines: lines, startLine: 1, totalLines: lines } }
}

// An answer Claude gets (an anymodel agent's, a background task's notification) with its personal data masked, the
// full text kept on this machine for the user. `what` names it in the person's notice.
async function screen($, text, name, what) {
  const { spans } = await scan($, { text })
  const found = findings(text, spans, allow)
  if (found.length === 0) return text
  const file = await keep($, name, text)
  $.ui.toast(`personal-computer: ${what} had personal data (${summary(found)}). Claude got it masked; the full text: ${file}`)
  return maskSession($, text, found)
}

// The person's choice for something about to reach Claude: what it holds in words, never its values. With no one to
// ask, `otherwise`.
const choose = ($, source, what, options, otherwise) => $.ui.ask(`${source} holds ${what}. What should Claude get?`,
  { header: 'Personal', options }).catch(() => otherwise)

// How an output with personal data reaches Claude, by the mode or by the person's choice.
const decide = ($, mode, source, found) => mode === 'ask'
  ? choose($, source, `personal data (${summary(found)})`, ['Process privately', 'Mask', 'Share as-is', 'Leave out'], 'Process privately')
  : mode === 'mask' ? 'Mask' : 'Process privately'

const noAgent = (source, found) => `${source} contains personal data (${summary(found)}), so it was withheld. No private agent is set up to ` +
  'work with it: the user can add one with /plugin configure personal-computer.'

const local = url => ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(new URL(url).hostname)

// Each part the gate needs, as /personal-computer check prints it and the pane lists it. Never a value: the test text
// is reported by counts.
async function checks($, settings) {
  const { mode, agent } = settings
  if (await isNativeWindows($)) return [{ label: 'platform', status: 'failed', text: NATIVE_WINDOWS }]
  const list = []
  const add = (label, status, text) => list.push({ label, status, text })
  const os = await machine($)
  const rt = await runtime($)
  const mac = os === 'Darwin arm64'
  const platformOk = mac || (os.startsWith('Linux ') && rt !== 'mlx')
  if (platformOk) add('platform', 'ok', `${mac ? 'macOS on Apple silicon' : os}, ${RUNTIME_LABEL[rt]}`)
  else if (os.startsWith('Linux ')) add('platform', 'failed', `${os}: MLX needs a Mac with Apple silicon; set the runtime to auto or onnx`)
  else add('platform', 'failed', `${os}: personal-computer runs on a Mac with Apple silicon, on Linux, and on Windows inside WSL 2`)
  const uv = await $.process.run(['/bin/sh', '-c', 'command -v uv'])
  if (uv.exitCode === 0) add('uv', 'ok', uv.stdout.trim())
  else add('uv', 'missing', 'install it: https://docs.astral.sh/uv/')
  const absent = await missing($)
  if (absent.length === 0) add('models', 'ok', labels(models))
  else add('models', 'missing', `${labels(absent)}. Run /personal-computer setup (about ${await sizes($, absent)})`)
  if (!platformOk || uv.exitCode !== 0 || absent.length > 0) add('scanner', 'skipped', 'not started: fix the lines above first')
  // Off, the scanner is not started for a look: it loads the models, gigabytes of memory.
  else if (!active) add('scanner', 'skipped', 'starts with setup')
  else list.push(await selfTest($))
  if (agent === '' && mode === 'mask') add('agent', 'skipped', 'not needed in mask mode')
  else if (agent === '') add('agent', 'missing', 'none set. Add one in /plugin configure personal-computer')
  else {
    const agents = await $.anymodel.agents()
    const a = agents.find(x => x.name === agent)
    if (a === undefined) add('agent', 'missing', `no anymodel agent named "${agent}"; yours are ${agents.map(x => x.name).join(', ') || 'none yet'}. Set it in /plugin configure personal-computer`)
    else if (a.problems.length > 0) add('agent', 'failed', `${agent}: ${a.problems.join('; ')}; fix it in /plugin configure anymodel ${agent}`)
    else {
      const where = local(a.url) ? ' (this machine)' : `: not this machine, so personal data goes to ${new URL(a.url).hostname}`
      add('agent', 'ok', `${agent}, ${a.model} at ${a.url}${where}. /anymodel check ${agent} tests it`)
    }
  }
  return list
}

// The scanner's check: it must find the name and the IBAN in the test text.
async function selfTest($) {
  try {
    const t = Date.now()
    const found = findings(SELF_TEST, (await scan($, { text: SELF_TEST })).spans, [])
    const types = new Set(found.map(f => f.type))
    const status = `found ${summary(found) || 'nothing'} in a test text`
    return types.has('private_person') && types.has('iban')
      ? { label: 'scanner', status: 'ok', text: `${status} (${Date.now() - t} ms)` }
      : { label: 'scanner', status: 'failed', text: `${status} that holds 1 name, 1 IBAN` }
  } catch (err) {
    return { label: 'scanner', status: 'failed', text: err.message }
  }
}

// The parts the gate cannot work without: what setup needs passed before the plugin is on.
const GATE = ['platform', 'uv', 'models', 'scanner']
const working = list => list.filter(c => GATE.includes(c.label)).every(c => c.status === 'ok')

const WORD = { ok: 'ok: ', failed: 'FAILED: ', missing: 'MISSING: ', skipped: '' }

// /personal-computer check as text: the state and settings, then a line per part.
function report(list, settings) {
  const { mode, prompts, detectors } = settings
  const lines = [`personal computer ${active ? 'on' : 'off'}: mode ${mode}, prompts ${prompts}, detectors ${detectors}`,
    ...list.map(c => `${c.label.padEnd(9)} ${WORD[c.status]}${c.text}`)]
  return { text: lines.join('\n'), ...(list.some(c => c.status === 'failed' || c.status === 'missing') ? { exitCode: 1 } : {}) }
}

// Fetches the missing models, saying as each starts; undefined once all are in the cache, else why not.
async function download($, absent, say) {
  let stdout = ''
  let stderr = ''
  const done = new Set()
  const rt = await runtime($)
  for await (const piece of $.process.spawn({ argv: ['/bin/sh', '-c', 'exec uv run --script "$0" "$@"', `${$.plugin.root}/scanner/scan.py`, '--download', '--models', absent.join(','), '--runtime', rt] })) {
    if (piece.stream !== 'stdout') {
      stderr = (stderr + piece.text).slice(-4000)
      continue
    }
    stdout += piece.text
    const lines = stdout.split('\n')
    stdout = lines.pop()
    for (const l of lines.filter(Boolean)) {
      const { model, status } = JSON.parse(l)
      if (status === 'downloading') await say(`Downloading ${MODEL_LABEL[model]} (about ${pick(model, rt).size}), ${absent.indexOf(model) + 1} of ${absent.length}…`)
      if (status === 'done') done.add(model)
    }
  }
  const failed = absent.filter(m => !done.has(m))
  if (failed.length > 0) return `${labels(failed)} did not download: ${stderr.trim().split('\n').at(-1) ?? 'no reason given'}`
  const left = await missing($)
  return left.length === 0 ? undefined : `the download ended, but ${labels(left)} is not whole in ${await where($, await artifact($, left[0]))}`
}

// /personal-computer setup and the pane's Set up: fetch what is missing, start the scanner and check it. Once the
// check passes, the plugin is on: the setup file says so to every later session. `say` tells the person each step.
async function setUp($, settings, say) {
  const before = await checks($, settings)
  if (before.some(c => (c.label === 'platform' || c.label === 'uv') && c.status !== 'ok')) return { list: before }
  const absent = await missing($)
  if (absent.length > 0) {
    const failed = await download($, absent, say)
    if (failed !== undefined) return { list: before, error: failed }
  }
  await say('Starting the scanner…')
  await startScanner($)
  const test = await selfTest($)
  if (test.status === 'ok') {
    await $.fs.write(await setupFile($), JSON.stringify({ detectors: settings.detectors, at: new Date().toISOString() }))
    active = true
    await update($, isOn, () => true)
  }
  return { list: (await checks($, settings)).map(c => (c.label === 'scanner' && test.status !== 'ok' ? test : c)) }
}

// The pane's Set up: its steps shown in the headline, then the checks as setup left them.
async function paneSetup($, settings) {
  await update($, progress, () => 'Checking…')
  const { list, error } = await setUp($, settings, text => update($, progress, () => text))
  await update($, checked, () => list)
  await update($, progress, () => '')
  if (error !== undefined) $.ui.toast(`personal-computer: ${error}`)
}

// What the pane shows: the checks and anymodel's agents, read again.
async function refresh($, settings) {
  const list = await checks($, settings)
  const names = (await $.anymodel.agents()).map(a => a.name)
  await update($, checked, () => list)
  await update($, agentNames, () => names)
}

const MODE_OPTIONS = [{ value: 'private', label: 'Process privately' }, { value: 'mask', label: 'Replace with placeholders' }, { value: 'ask', label: 'Ask me each time' }]
const PROMPT_OPTIONS = [{ value: 'ask', label: 'Ask me' }, { value: 'mask', label: 'Replace with placeholders' }, { value: 'off', label: 'Don\'t check' }]
// The detectors with their download for the runtime: 3.7 GB both on MLX, 8 GB on ONNX Runtime.
const gb = (ms, rt) => `${ms.reduce((n, m) => n + parseFloat(pick(m, rt).size), 0).toFixed(1)} GB`
const detectorOptions = rt => [{ value: 'both', label: `Both (${gb(DETECTORS.both, rt)})` }, { value: 'opf', label: `OpenAI Privacy Filter (${gb(['opf'], rt)})` }, { value: 'pii-tracer', label: `PII-Tracer (${gb(['pii-tracer'], rt)})` }]
const LABEL = { platform: 'Platform', uv: 'uv', models: 'Detection models', scanner: 'Scanner', agent: 'Private agent' }
const MARK = { ok: '✓', failed: '✗', missing: '✗', skipped: '·' }

// A pane setting's choice, written as the person's own /plugin configure would; the plugin reloads with it.
const setOption = ($, key) => value => $.config.set({ key: `${$.plugin.name}.${key}`, value })

// The pane's headline: on, off, setting up, or on but unable to check.
function headline(isSetOn, list, step) {
  if (step !== '') return `◌ ${step}`
  if (!isSetOn) return '○ Off: not set up yet. Nothing is checked.'
  return list.length > 0 && !working(list) ? '⚠ On, but it cannot check: outputs are withheld' : '● On: what reaches Claude is checked first'
}

export function register(on, options) {
  const mode = MODES.includes(options.mode) ? options.mode : 'private'
  const agent = String(options.agent ?? '').trim()
  const prompts = PROMPTS.includes(options.prompts) ? options.prompts : 'ask'
  const detectors = Object.hasOwn(DETECTORS, options.detectors) ? options.detectors : 'both'
  models = DETECTORS[detectors]
  chosen = RUNTIMES.includes(options.runtime) ? options.runtime : 'auto'
  const settings = { mode, prompts, detectors, agent }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const own = []
    for (const argv of OWN) {
      const r = await $.process.run(argv).catch(() => ({ exitCode: 1 }))
      if (r.exitCode === 0 && r.stdout.trim() !== '') own.push(r.stdout.trim())
    }
    // Linux keeps the account's full name in its passwd entry (GECOS, before the first comma); id -F is macOS's.
    const pw = await $.process.run(['getent', 'passwd', String(await $.env.get('USER'))]).catch(() => ({ exitCode: 1 }))
    const gecos = pw.exitCode === 0 ? (pw.stdout.split(':')[4] ?? '').split(',')[0].trim() : ''
    if (gecos !== '') own.push(gecos)
    allow = own
    try {
      await $.command.register({ name: 'personal-computer', description: 'Turn personal-computer on, see how it stands, and change its settings', argumentHint: '[check | setup | cleanup [days]]' })
    } catch (err) {
      $.ui.toast(`personal-computer: cannot add /personal-computer: ${err.message}`)
    }
    try {
      active = await isSetUp($)
    } catch (err) {
      // Each gate asks again, and withholds until the state reads.
      warned = true
      $.ui.status(`${err.message}, so outputs are withheld · /personal-computer`)
      return started
    }
    await update($, isOn, () => active)
    // A pane in use is read again after a reload (a setting changed in it), once this start is done.
    if ((await read($, checked)).length > 0) $.clock.after(0, () => refresh($, settings))
    if (!active) {
      if ((await $.store.get(HINTED)) !== true) {
        $.ui.toast(`personal-computer is off: ${(await isNativeWindows($)) ? NATIVE_WINDOWS : '/personal-computer sets it up'}`)
        await $.store.set(HINTED, true)
      }
      return started
    }
    if (agent === '' && mode !== 'mask') $.ui.toast('personal-computer: set your private agent with /personal-computer')
    await cleanup($, await cleanupDays($)).catch(err => $.ui.toast(`personal-computer: ${err.message}`))
    const absent = await missing($)
    if (absent.length > 0) {
      warned = true
      $.ui.status(MODELS_MISSING(absent))
    } else await startScanner($).catch(err => $.ui.toast(`personal-computer: ${err.message}`))
    return started
  })

  // The footer's mode labels, beside the engine's own (focus, memory paused): there while personal-computer is on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) =>
    (await read($, isOn)) ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, 'personal computer'] } }) : next(e))

  // The pane /personal-computer opens: how it stands, its settings (each written through $.config.set, which reloads
  // the plugin), each part checked, and Set up.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select, Button } = $.ui.resolve(e)
    const isSetOn = await read($, isOn)
    const list = await read($, checked)
    const agents = await read($, agentNames)
    const step = await read($, progress)
    const choices = [...new Set([...agents, ...(agent === '' ? [] : [agent])])]
    // While setup runs a setting is shown, not offered: a change reloads the plugin and would cut the download off.
    const row = (key, label, value, options) => step !== ''
      ? Text({ dimColor: true, children: `${label}: ${options.find(o => o.value === value)?.label ?? 'none'}` })
      : Select({ key, label, value, options, onSelect: setOption($, key) })
    const settingRows = [
      row('mode', 'When personal data is found', mode, MODE_OPTIONS),
      ...(mode === 'mask' ? []
        : choices.length > 0 ? [row('agent', 'Private agent', agent === '' ? undefined : agent, choices.map(n => ({ value: n, label: n })))]
        : [Text({ dimColor: true, children: 'Private agent: none yet. Add one with /plugin configure anymodel' })]),
      row('prompts', 'Your prompts', prompts, PROMPT_OPTIONS),
      row('detectors', 'Detection models', detectors, detectorOptions(await runtime($))),
    ]
    const checkRows = list.map(c => Text({ children: [`${MARK[c.status]} ${LABEL[c.label]}  `, Text({ dimColor: true, children: c.text })] }))
    const needsSetup = !isSetOn || list.some(c => GATE.includes(c.label) && c.status !== 'ok')
    const buttons = step !== '' ? [] : [
      // Setup takes minutes, so it runs as a timer of its own and the press returns at once.
      ...(needsSetup ? [Button({ key: 'setup', label: 'Set up', hotkey: 's', variant: 'primary', onPress: () => {
        $.clock.after(0, () => paneSetup($, settings))
      } })] : []),
      Button({ key: 'check', label: 'Check again', hotkey: 'c', onPress: () => refresh($, settings) }),
    ]
    return Box({ flexDirection: 'column', children: [
      Text({ bold: true, children: headline(isSetOn, list, step) }),
      Text({ children: ' ' }),
      ...settingRows,
      Text({ children: ' ' }),
      ...checkRows,
      ...(checkRows.length > 0 ? [Text({ children: ' ' })] : []),
      Box({ flexDirection: 'row', gap: 2, children: buttons }),
    ] })
  })

  on('command.run', { command: 'personal-computer' }, async ($, e) => {
    const verb = e.args.trim()
    if (verb === 'check') return report(await checks($, settings), settings)
    if (verb.split(/\s+/)[0] === 'cleanup') {
      const given = verb.slice('cleanup'.length).trim()
      const days = given === '' ? await cleanupDays($) : Number(given)
      if (!Number.isInteger(days) || days < 0) return { text: 'give the days as a whole number, e.g. /personal-computer cleanup 30', exitCode: 1 }
      return { text: await cleanup($, days) }
    }
    if (verb === 'setup') {
      const { list, error } = await setUp($, settings, text => $.ui.toast(`personal-computer: ${text}`))
      return error === undefined ? report(list, settings) : { text: error, exitCode: 1 }
    }
    if (verb !== '') return { text: 'use /personal-computer, /personal-computer check, /personal-computer setup or /personal-computer cleanup [days]', exitCode: 1 }
    await refresh($, settings)
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Personal computer', focus: true, closeOnEscape: true })
    return isPlaced ? {} : report(await read($, checked), settings)
  })


  // Mask mode: a file Claude writes gets the real values back, so a letter to [PERSON_1] names the person on disk.
  const restored = e => Object.keys(table).length === 0 ? e
    : e.tool === 'Write' ? { ...e, content: restore(e.content, table) }
    : e.tool === 'Edit' ? { ...e, old_string: restore(e.old_string, table), new_string: restore(e.new_string, table) }
    : e

  // The gate: every output, in main and in-process subagents, before the model reads it.
  on('tool.call', async ($, e, next) => {
    if (!(await isActive($))) return next(e)
    await loadTable($)
    const r = await next(restored(e))
    if ('deny' in r && r.deny !== undefined) return r
    // anymodel's report is screened where anymodel delivers it (anymodel.screen below); the person's answer to a
    // question ($.ui.ask's own tool call, this mod's included) is theirs to give; SendMessage answers delivery status
    // with the agent's id, which masked could no longer be addressed (the agent's reply comes as a notification).
    if (e.tool === 'Agent' && String(e.subagent_type ?? '').startsWith('anymodel:')) return r
    if (e.tool === 'AskUserQuestion' || e.tool === 'SendMessage') return r
    const { text, found, image } = await inspect($, e, r)
    if (image) {
      if (mode === 'ask' && (await choose($, `The output of ${e.tool}`, 'an image, which cannot be checked for personal data', ['Share as-is', 'Leave out'], 'Leave out')) === 'Share as-is') return r
      return { deny: `The output of ${e.tool} is an image, which cannot be checked for personal data, so it was withheld. If you need what it shows, ask the user to describe it.` }
    }
    if (found.length === 0) return r
    const choice = await decide($, mode, `The output of ${e.tool}`, found)
    if (choice === 'Share as-is') return r
    if (choice === 'Leave out') return { deny: `The output of ${e.tool} contains personal data, and the user chose to leave it out.` }
    if (choice === 'Mask') {
      const masked = await maskSession($, text, found)
      // An error keeps reading as one. A result is the tool's own, its strings masked: a shape its schema refuses
      // would fail the call. A PDF reads as the text the scanner found in it.
      if (r.isError) return { deny: masked }
      const path = pdfPath(e, r)
      const result = path === undefined ? hide(r.result, table) : textRead(path, masked)
      return { result, context: [...(r.context ?? []).map(c => hide(c, table)), PLACEHOLDERS] }
    }
    if (agent === '') return { deny: noAgent(`The output of ${e.tool}`, found) }
    const file = await keep($, e.tool_use_id ?? `${e.tool}-${Date.now()}`, text)
    return { deny: `${withheldNotice(`The output of ${e.tool}`, found, agent)} The withheld output is saved at ${file} for it.` }
  }).catch(($, e, next) => ({ deny: `personal-computer could not check this output for personal data (${next.error.message ?? next.error.kind}), so it was withheld.` }))

  // The private agent's answer, or any anymodel agent's.
  on('anymodel.screen', async ($, e, next) => {
    if (!(await isActive($))) return next(e)
    const below = await next(e)
    if (!('value' in below)) return below
    return { value: { text: await screen($, below.value.text, `answer-${e.name}-${e.agentId}`, `${e.name}'s answer`) } }
  }).catch(($, e, next) => ({ value: { text: `personal-computer could not check this answer for personal data (${next.error.message ?? next.error.kind}), so it was withheld.` } }))

  // A background task's notification (a subagent's answer, in the background by default, or a background command's
  // end) reaches Claude as a prompt of its own, not as a tool result: masked as an answer. A prompt someone sends
  // (typed, through Remote Control, claude -p, a schedule, a channel) is checked by the prompts setting. A slash
  // command's text cannot be rewritten, and the engine's own meta prompts are none of the person's.
  on('prompt.submit', async ($, e, next) => {
    if (!(await isActive($))) return next(e)
    if (e.origin.kind === 'task-notification') {
      const text = await screen($, e.text, `notification-${Date.now()}`, 'A background task\'s notification')
      return next(text === e.text ? e : { ...e, text, ...(e.context === undefined ? {} : { context: e.context.map(c => hide(c, table)) }) })
    }
    if (prompts === 'off' || e.command !== undefined || e.isMeta) return next(e)
    // An @-mention names a file, checked when the engine reads it: masked, the mention would not resolve.
    const mentions = [...e.text.matchAll(/(?<!\S)@\S+/g)].map(m => [m.index, m.index + m[0].length])
    const found = (e.text.trim() === '' ? [] : findings(e.text, (await scan($, { text: e.text })).spans, allow))
      .filter(f => !mentions.some(([a, b]) => f.start < b && f.end > a))
    const media = e.attachments?.length ?? 0
    if (found.length === 0 && (media === 0 || prompts === 'mask')) return next(e)
    const what = [found.length > 0 ? `personal data (${summary(found)})` : '', media > 0 ? `${media} pasted file(s), which cannot be checked` : '']
      .filter(Boolean).join(' and ')
    const choice = prompts === 'mask' ? 'Mask'
      : await choose($, 'Your prompt', what, [...(found.length > 0 ? ['Mask'] : []), 'Send as is', 'Cancel'], found.length > 0 ? 'Mask' : 'Send as is')
    if (choice === 'Cancel') return { drop: 'personal-computer: the prompt was not sent.' }
    if (choice !== 'Mask' || found.length === 0) return next(e)
    return next({ ...e, text: await maskSession($, e.text, found), context: [...(e.context ?? []), PROMPT_PLACEHOLDERS] })
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    const why = next.error.message ?? next.error.kind
    if (e.origin.kind === 'task-notification') return next({ ...e, text: `A background task finished, but personal-computer could not check its notification for personal data (${why}), so it was withheld.` })
    // The person wrote the prompt and knows what it holds: in ask mode it is theirs to send unchecked.
    const choice = prompts !== 'ask' ? 'Cancel'
      : await $.ui.ask(`personal-computer could not check your prompt for personal data (${why}). Send it unchecked?`,
        { header: 'Personal', options: ['Send unchecked', 'Cancel'] }).catch(() => 'Cancel')
    return choice === 'Send unchecked' ? next(e) : { drop: `personal-computer could not check the prompt for personal data (${why}), so it was not sent. /personal-computer shows what is wrong.` }
  })

  // A machine-made prompt (a background task's notification) is recorded as queued, the transcript's queue-operation
  // entry, before prompt.submit masks it: the record is masked too, with the same placeholders; one that cannot be
  // checked is kept without its text. A person's prompt is recorded as prompt.submit left it. Claude never reads the
  // record. shortcut: a check over a second (a scanner still starting) is passed by and the record written as
  // raised; a deadline of its own if that shows up.
  on('session.append', { door: 'queue' }, async ($, e, next) => {
    if (e.origin.kind !== 'engine' || !(await isActive($))) return next(e)
    const content = []
    for (const b of e.message.content) {
      if (b.type !== 'text') continue
      const found = findings(b.text, (await scan($, { text: b.text })).spans, allow)
      content.push(found.length === 0 ? b : { ...b, text: await maskSession($, b.text, found) })
    }
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next.called ? next(e) : next({ ...e, message: { ...e.message, content: [] } }))

  // A file the engine attaches itself reaches Claude with no tool call: checked as a tool's output is.
  on('prompt.attachment', async ($, e, next) => {
    if (!FILE_ATTACHMENTS.includes(e.type) || !(await isActive($))) return next(e)
    const source = ATTACHMENT_SOURCE[e.type]
    const found = findings(e.text, (await scan($, { text: e.text })).spans, allow)
    if (found.length === 0) return next(e)
    const choice = await decide($, mode, source, found)
    if (choice === 'Share as-is') return next(e)
    if (choice === 'Leave out') return next({ ...e, text: `${source} contains personal data, and the user chose to leave it out.` })
    if (choice === 'Mask') {
      return next({ ...e, text: await maskSession($, e.text, found) })
    }
    if (agent === '') return next({ ...e, text: noAgent(source, found) })
    const file = await keep($, `attachment-${Date.now()}`, e.text)
    return next({ ...e, text: `${withheldNotice(source, found, agent)} Its text is saved at ${file} for it.` })
  }).catch(($, e, next) => next.called ? next(e)
    : next({ ...e, text: `personal-computer could not check this attachment for personal data (${next.error.message ?? next.error.kind}), so it was withheld.` }))

  // An @-mentioned image reaches Claude as pixels the scanner cannot read; text files go on to prompt.attachment.
  on('prompt.mention', async ($, e, next) => {
    if (!IMAGE.test(e.path) || !(await isActive($))) return next(e)
    if (mode === 'ask' && (await choose($, `The file @${e.mention}`, 'an image, which cannot be checked for personal data', ['Share as-is', 'Leave out'], 'Leave out')) === 'Share as-is') return next(e)
    return { deny: `personal-computer: @${e.mention} is an image, which cannot be checked for personal data` }
  }).catch(($, e, next) => next.called ? next(e) : { deny: `personal-computer could not check @${e.mention}` })
}
