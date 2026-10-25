import {
  agentList, agentSpec, agentsConfig, answeredAsks, answerIn, asks, checkAnswer, checkBody, checkReport, cleanupCommands, commandArgs,
  errorLine, formKeys, freshAsks, handbackRequired, interruptLine, mcpServers, permissionAnswer, removeAgent, saveAgent,
  contextText, guarded, localHost, permissionAsk, permissionSettings, readContext, readResult, redact, responseLine, resultLine, resumable, sessionOf, sessionRecord,
  takeEvents, taskText, toolLine, usageLine, userLine, workerArgv,
} from './worker.js'

// The agent name of each registered type (anymodel:<name> → name), and per spawned agent the name it runs as: a
// finished agent can leave $.agent.list() before a SendMessage resumes it.
const types = new Map()
const names = new Map()

// Main's permission mode per agent, as agent.spawn saw it: turn.step does not carry it. agent.spawn resolves only
// after the subagent started, so its first step can come first, before $.agent.list() lists it: `spawning` counts
// the anymodel spawns not resolved yet, and such a step waits for them.
const modes = new Map()
let spawning = 0

// Waits in a $ call: a hook's own time is limited (10 s), and time inside $ does not count, awaiting a promise or
// $.clock.sleep does.
const nap = $ => $.process.run(['/bin/sleep', '0.5'])
// A notice in an agent's view: the person sees it, no model reads it.
const notice = ($, agentId, text) => $.session.append({ agentId, message: { type: 'system', content: [{ type: 'text', text }] } }).catch(() => {})

async function modeOf($, agentId) {
  for (let i = 0; !modes.has(agentId); i++) {
    if (i === 20) throw new Error('agent.spawn did not report the permission mode of this subagent')
    await nap($)
  }
  return modes.get(agentId)
}

// Per agent, the texts of main's messages its worker had, as of the last run it took a task in (see freshAsks).
const given = new Map()

// The answers of agents /anymodel started ({ text, usage }), until the command shows them; the agents whose first run it was (only
// that run's answer is the command's); and those whose hand-back to main is still to drop: the command already shows
// the answer, so main would only start a Claude turn to repeat it.
const answers = new Map()
const served = new Set()
const handBacks = new Set()
const ENDED = ['completed', 'failed', 'killed']

// Each running worker by agent id, once it took its task: its run directory and input FIFO, the messages written to it
// that it has not taken yet (by uuid), whether it answered with none taken since, and whether its run is over (a later
// message then goes to the agent as any other).
const workers = new Map()

// The agents Esc on /anymodel stopped while their step runs: a worker that could not take an interrupt yet stops at
// its first output.
const stopped = new Set()

// Rules and directories the person allowed for this session in a worker's permission question: the next worker of
// any agent gets them too, as main's subagents share main's session grants.
const grants = { rules: [], directories: [] }

// Context windows per agent name, read in the background at session.start: { size, source } or { error }.
const contexts = new Map()
// Each agent's context read under way: a run waits for it instead of starting another.
const reads = new Map()

const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))
const message = err => (err instanceof Error ? err.message : String(err)).replace(/^anymodel: /, '')

// Every agent id that ran as an anymodel agent, on disk: a settings change reloads the plugin and drops the old
// types, so after a rename, a removal or a restart only this still tells such an agent's step from a Claude one.
async function markAgent($, dataDir, agentId, name) {
  const made = await $.process.run(['/bin/mkdir', '-p', '-m', '700', `${dataDir}/agents`])
  if (made.exitCode !== 0) throw new Error(`cannot create ${dataDir}/agents: ${made.stderr.trim()}`)
  await $.fs.write(`${dataDir}/agents/${agentId}`, name)
}

async function markedName($, dataDir, agentId) {
  const file = `${dataDir}/agents/${agentId}`
  return (await $.fs.exists(file)) ? (await $.fs.read(file)).trim() : undefined
}

// The anymodel agent name a step belongs to, or undefined for any other agent.
async function nameOf($, dataDir, agentId, type) {
  return names.get(agentId) ?? types.get(type) ?? (await markedName($, dataDir, agentId))
}

// A provider's model list can quote anything, the key too: the error is kept redacted. Resolves once read.
function readContextOf($, agent, secrets) {
  contexts.delete(agent.name)
  // Only the latest read writes: one started before a settings change or a check is obsolete.
  const read = readContext((url, init) => $.http.fetch(url, init), agent).then(
    c => reads.get(agent.name) === read && contexts.set(agent.name, c),
    err => reads.get(agent.name) === read && contexts.set(agent.name, { error: redact(message(err), secrets) }),
  ).finally(() => reads.get(agent.name) === read && reads.delete(agent.name))
  reads.set(agent.name, read)
  return read
}

// The agent's context window for a run. A local provider's is read again first: its model may have been loaded with
// another window since. A remote one's stands, unless its read failed (its server may be up now). A run joins a read
// under way.
async function contextOf($, agent, secrets) {
  if (!reads.has(agent.name) && (localHost(agent.baseUrl) || contexts.get(agent.name)?.size === undefined)) readContextOf($, agent, secrets)
  for (let i = 0; !contexts.has(agent.name); i++) {
    // shortcut: $.http.fetch has no timeout, so a provider that never answers is cut here, after about a minute.
    if (i === 120) throw new Error(`${agent.baseUrl} did not answer for the context size of ${agent.model}`)
    await nap($)
  }
  const c = contexts.get(agent.name)
  if (c.error !== undefined) throw new Error(c.error)
  return c.size
}

async function apiMessages($, agentId) {
  const messages = await $.session.messages({ agentId, as: 'api' })
  if (!Array.isArray(messages)) throw new Error(`cannot read the subagent's messages: ${messages.deny}`)
  return messages
}

// The worker's own Claude Code config, home and sessions.
async function stateDir($) {
  return `${(await $.env.get('XDG_STATE_HOME')) ?? `${await $.env.get('HOME')}/.local/state`}/anymodel`
}

// The short directory the worker's sandboxed tools write in, and its run directories (see workerArgv).
async function tmpDirOf($) {
  const tmpDir = `/tmp/anymodel-${(await $.process.run(['/usr/bin/id', '-u'])).stdout.trim()}`
  const made = await $.process.run(['/bin/mkdir', '-p', '-m', '700', tmpDir])
  if (made.exitCode !== 0) throw new Error(`cannot create ${tmpDir}: ${made.stderr.trim()}`)
  // On a shared host another user could have made /tmp/anymodel-<uid> first.
  const own = await $.process.run(['/bin/sh', '-c', '[ -O "$1" ] && chmod 700 "$1"', 'sh', tmpDir])
  if (own.exitCode !== 0) throw new Error(`${tmpDir} belongs to another user`)
  return tmpDir
}

// Where an agent's worker session is kept, per main session: a fork of main gets its own workers.
async function sessionFile($, dataDir, agentId) {
  return `${dataDir}/sessions/${await $.session.id()}-${agentId}`
}

// The Claude Code agent definition named like the agent, which its worker runs as: the project's, else the user's,
// as Claude Code itself prefers them. `dir` is the agents directory it is in.
async function definitionOf($, name, cwd) {
  const user = `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`}/agents`
  for (const dir of [`${cwd}/.claude/agents`, user]) if (await $.fs.exists(`${dir}/${name}.md`)) return { dir, file: `${dir}/${name}.md`, user: dir === user }
  return undefined
}

// The worker's own config directory sees the user's agents through a link.
async function linkAgents($, dir, dataDir) {
  const linked = await $.process.run(['/bin/sh', '-c', '[ -L "$2" ] || [ ! -e "$2" ] && ln -sfn "$1" "$2"', 'sh', dir, `${dataDir}/config/agents`])
  if (linked.exitCode !== 0) throw new Error(`cannot show your agents to the worker: ${dataDir}/config/agents is in the way`)
}

// Main's MCP servers for the worker, in a file of the run's private directory; undefined when main has none.
async function mcpConfig($, run, cwd) {
  const json = async file => ((await $.fs.exists(file)) ? JSON.parse(await $.fs.read(file)) : undefined)
  const user = await json(`${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))}/.claude.json`)
  const servers = mcpServers(user, cwd, await json(`${cwd}/.mcp.json`), (await $.tool.list()).map(t => t.name))
  if (Object.keys(servers).length === 0) return undefined
  await $.fs.write(`${run}/mcp.json`, JSON.stringify({ mcpServers: servers }))
  return `${run}/mcp.json`
}

// Writes one line to a running worker, after the ones before it: a long line written beside another would mix.
function writeLine($, worker, line) {
  const done = worker.queue.then(async () => {
    const r = await $.process.run(['/bin/sh', '-c', 'cat >> "$1"', 'sh', worker.fifo], { stdin: `${line}\n`, timeoutMs: 5000 })
    if (r.exitCode !== 0) throw new Error(`cannot write to the worker: ${r.stderr.trim()}`)
  })
  worker.queue = done.catch(() => {})
  return done
}

// Ends a worker's run from outside its loop: bridge.sh exec'd it, so its pid file names it.
function killWorker($, worker) {
  return $.process.run(['/bin/sh', '-c', 'kill "$(cat "$1/pid")"', 'sh', worker.run])
}

// A worker's permission request, answered as main answers its own subagent's: main's rules and mode decide, and
// what they would ask the person goes to the person, in the engine's question dialog (no one to ask, in -p: refused).
async function answerPermission($, worker, agent, ev, cwd) {
  const request = ev.request
  const check = await $.tool.check({ tool: request.tool_name, input: request.input }).catch(err => ({ decision: 'ask', reason: message(err) }))
  let response
  if (check.decision === 'allow') response = { behavior: 'allow', updatedInput: request.input, toolUseID: request.tool_use_id }
  else if (check.decision === 'deny') response = { behavior: 'deny', message: check.reason ?? 'Your permission settings refuse this tool use.', interrupt: false, toolUseID: request.tool_use_id }
  else {
    const asked = permissionAsk(agent, request, cwd)
    const answer = await $.ui.ask(asked.question, { header: asked.header, options: asked.options }).catch(() => undefined)
    if (answer === undefined) response = { behavior: 'deny', message: 'No one approved this tool use.', interrupt: false, toolUseID: request.tool_use_id }
    else {
      const answered = permissionAnswer(request, asked, answer)
      grants.rules.push(...answered.grants.rules)
      grants.directories.push(...answered.grants.directories)
      response = answered.response
    }
  }
  $.ui.log(`anymodel: permission agent=${worker.agentId} tool=${request.tool_name} check=${check.decision} answer=${response.behavior}`, { to: 'debug' })
  await writeLine($, worker, responseLine(ev.request_id, response))
}

async function claudePath($) {
  const claude = (await $.process.run(['/usr/bin/which', 'claude'])).stdout.trim()
  if (claude === '') throw new Error('claude is not on PATH')
  return claude
}

// The saved agents, by name (see saveAgent), and the keys as this session last knew them: a save writes the keys and
// clears the settings form, and each field cleared reloads the plugin, which may read the API key field as it was
// before the write (see formKeys). Any plugin can read $.state, as any plugin can read the Keychain through
// $.process: it shows a mod no key it could not reach anyway.
const AGENTS = 'agents'
const KEYS = { plugin: 'anymodel', key: 'keys' }

// Writes the keys into the settings form's API key field, which keeps them in the Keychain. Only `claude plugin
// configure` writes a sensitive option; it takes them on standard input, and the plugin by its id, as `claude plugin
// list` names this plugin's folder (a local marketplace folder's own, or the cache copy of any other).
async function writeKeys($, keys) {
  const claude = await claudePath($)
  const listed = await $.process.run([claude, 'plugin', 'list', '--json'], { timeoutMs: 60000 })
  const id = listed.exitCode === 0 ? JSON.parse(listed.stdout).find(p => [p.installPath, p.readFromFolder].includes($.plugin.root))?.id : undefined
  if (id === undefined) throw new Error('anymodel can save keys only when it is installed from a marketplace (claude plugin list does not list it)')
  const saved = await $.process.run([claude, 'plugin', 'configure', id, '--values-stdin'], { stdin: JSON.stringify({ api_key: JSON.stringify(keys) }), timeoutMs: 60000 })
  if (saved.exitCode !== 0) throw new Error(`claude plugin configure failed: ${(saved.stdout + saved.stderr).trim()}`)
}

// The agents, once the save the settings form holds is made; undefined once a save cleared the form. The form names
// one agent: saved, it is cleared, its name last, so a reload while the other fields clear makes the same save again,
// which changes nothing.
async function settings($, options) {
  const { value: held } = await $.state.get(KEYS)
  const { keys, typed } = formKeys(options.api_key, held)
  await $.state.set(KEYS, keys)
  const agents = (await $.store.get(AGENTS)) ?? {}
  const field = k => String(options[k] ?? '').trim()
  const name = field('agent')
  const saved = name === '' ? { error: 'give the agent a name' } : saveAgent(options, agents, keys, typed)
  const refuse = async error => {
    // The dialog saved the typed key over the other keys: they go back, and the key is typed again with a save that holds.
    if (typed !== undefined) await writeKeys($, keys).catch(() => {})
    $.ui.toast(redact(`anymodel: ${name === '' ? 'nothing saved' : `${name} not saved`}: ${error}${typed === undefined ? '' : ', and type its API key again'}`, [...Object.values(keys), ...(typed === undefined ? [] : [typed])]))
    return agentsConfig(agents, keys)
  }
  if (saved.error !== undefined) return typed !== undefined || ['agent', 'url', 'model', 'context'].some(k => field(k) !== '') ? refuse(saved.error) : agentsConfig(agents, keys)
  if (JSON.stringify(saved) === JSON.stringify({ agents, keys })) return agentsConfig(agents, keys)
  if (JSON.stringify(saved.keys) !== JSON.stringify(keys)) {
    try {
      await writeKeys($, saved.keys)
    } catch (err) {
      return refuse(message(err))
    }
  }
  await $.state.set(KEYS, saved.keys)
  await $.store.set(AGENTS, saved.agents)
  $.ui.toast(`anymodel: saved ${name}, call it as @anymodel:${name}`)
  for (const k of ['url', 'model', 'context', 'agent']) if (field(k) !== '') await $.config.set({ key: `${$.plugin.name}.${k}`, value: '' })
}

// Runs the task on the agent's model in a separate Claude Code and returns its report and usage. The worker keeps one session
// per agent, so a SendMessage resume continues it with its earlier tool results. While it runs, its permission
// requests, its tool calls (as notices in the agent's view) and main's messages to the agent go through the bridge.
// `asked` are the texts of main's messages, which the worker has once it takes the task.
async function runWorker($, e, agent, task, mode, dataDir, resume, recordFile, asked) {
  // Read inside the hook: it is the subagent's own directory.
  const cwd = await $.session.cwd()
  const claude = await claudePath($)
  const made = await $.process.run(['/bin/mkdir', '-p', '-m', '700', `${dataDir}/config`, `${dataDir}/sessions`])
  if (made.exitCode !== 0) throw new Error(`cannot create the worker's directories: ${made.stderr.trim()}`)
  const tmpDir = await tmpDirOf($)
  const run = `${tmpDir}/run-${e.agentId}-${Date.now()}`
  const fifos = await $.process.run(['/bin/sh', '-c', 'mkdir -m 700 "$1" && mkfifo -m 600 "$1/in" "$1/key"', 'sh', run])
  if (fifos.exitCode !== 0) throw new Error(`cannot create the worker's run directory: ${fifos.stderr.trim()}`)
  // Main's values of NETWORK_VARS, by literal name: the loader lists the variables a module reads.
  const host = {
    HTTPS_PROXY: await $.env.get('HTTPS_PROXY'), https_proxy: await $.env.get('https_proxy'),
    HTTP_PROXY: await $.env.get('HTTP_PROXY'), http_proxy: await $.env.get('http_proxy'),
    ALL_PROXY: await $.env.get('ALL_PROXY'), all_proxy: await $.env.get('all_proxy'),
    NO_PROXY: await $.env.get('NO_PROXY'), no_proxy: await $.env.get('no_proxy'),
    NODE_USE_ENV_PROXY: await $.env.get('NODE_USE_ENV_PROXY'), CLAUDE_CODE_PROXY_RESOLVES_HOSTS: await $.env.get('CLAUDE_CODE_PROXY_RESOLVES_HOSTS'),
    NODE_TLS_REJECT_UNAUTHORIZED: await $.env.get('NODE_TLS_REJECT_UNAUTHORIZED'), NODE_EXTRA_CA_CERTS: await $.env.get('NODE_EXTRA_CA_CERTS'),
    SSL_CERT_FILE: await $.env.get('SSL_CERT_FILE'), SSL_CERT_DIR: await $.env.get('SSL_CERT_DIR'),
    CLAUDE_CODE_CERT_STORE: await $.env.get('CLAUDE_CODE_CERT_STORE'), CLAUDE_CODE_CLIENT_CERT: await $.env.get('CLAUDE_CODE_CLIENT_CERT'),
    CLAUDE_CODE_CLIENT_KEY: await $.env.get('CLAUDE_CODE_CLIENT_KEY'), CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: await $.env.get('CLAUDE_CODE_CLIENT_KEY_PASSPHRASE'),
  }
  const taskId = uuid()
  const worker = { agentId: e.agentId, run, fifo: `${run}/in`, queue: Promise.resolve(), pending: new Map(), answered: false, ended: false, interrupted: false }
  let stdout = ''
  let stderr = ''
  const events = []
  let said
  try {
    const definition = await definitionOf($, agent.name, cwd)
    if (definition?.user) await linkAgents($, definition.dir, dataDir)
    const argv = workerArgv({
      claude, dataDir, tmpDir, backend: agent, hasKey: agent.apiKey !== undefined, mode,
      permissions: permissionSettings(await $.settings.read(), grants), mcpConfig: await mcpConfig($, run, cwd),
      session: resume === undefined ? [] : ['--resume', resume], host, asAgent: definition && agent.name,
    })
    $.ui.log(`anymodel: task agent=${e.agentId} name=${agent.name} model=${agent.model} url=${agent.baseUrl} mode=${mode} resume=${resume ?? '-'} cwd=${cwd} chars=${task.length}: ${task}`, { to: 'debug' })
    // The key on the first line, for bridge.sh, then the task. Leaving this loop, or next.signal aborting (Esc, the
    // agent stopped), kills the worker.
    stream: for await (const piece of $.process.spawn({ argv: ['/bin/sh', `${$.plugin.root}/hooks/bridge.sh`, run, ...argv], cwd, input: `${agent.apiKey ?? ''}\n${userLine(task, taskId)}\n` })) {
      if (stopped.has(e.agentId)) {
        worker.interrupted = true
        worker.ended = true
        break
      }
      if (piece.stream !== 'stdout') {
        stderr = (stderr + piece.text).slice(-20000)
        continue
      }
      const taken = takeEvents(stdout + piece.text)
      stdout = taken.rest
      for (const ev of taken.events) {
        if (ev.type === 'system' && ev.subtype === 'init') {
          events.push(ev)
          await $.fs.write(recordFile, sessionRecord(ev.session_id, agent))
        } else if (ev.type === 'user') {
          for (const b of ev.message?.content ?? []) if (b.type === 'tool_result') notice($, e.agentId, resultLine(b))
          if (ev.uuid === undefined) continue
          // The worker took its task (its session has it now) or a message. Only after the task can the mod's lines
          // follow it into the FIFO without mixing with bridge.sh's copy of it.
          if (ev.uuid === taskId) {
            given.set(e.agentId, asked)
            workers.set(e.agentId, worker)
          }
          worker.pending.delete(ev.uuid)
          worker.answered = false
        } else if (ev.type === 'assistant') {
          // Only its text is kept, for a result that comes without one.
          events.push({ type: 'assistant', message: { content: (ev.message?.content ?? []).filter(b => b.type === 'text') } })
          // Its text shows once a text or a tool call follows it: the last one is its answer, shown as the report.
          for (const b of ev.message?.content ?? []) {
            if (b.type !== 'text' && b.type !== 'tool_use') continue
            if (said !== undefined) notice($, e.agentId, said)
            said = b.type === 'text' && b.text.trim() !== '' ? b.text.trim() : undefined
            if (b.type === 'tool_use') notice($, e.agentId, toolLine(b.name, b.input, cwd))
          }
        } else if (ev.type === 'control_request') {
          if (ev.request?.subtype === 'can_use_tool') await answerPermission($, worker, agent, ev, cwd)
          // Anything else (an MCP elicitation) the worker would wait on for good: refused.
          else await writeLine($, worker, errorLine(ev.request_id, `anymodel does not handle ${ev.request?.subtype} requests`))
        } else if (ev.type === 'result') {
          events.push(ev)
          said = undefined
          // A message written while it ran and not taken yet starts another turn of the worker: its answer is part of
          // the report.
          if (worker.pending.size === 0) {
            worker.ended = true
            break stream
          }
          worker.answered = true
        }
      }
    }
  } finally {
    worker.ended = true
    if (workers.get(e.agentId) === worker) workers.delete(e.agentId)
    await $.process.run(['/bin/rm', '-rf', run])
    // A message written to the worker that it never took (it died first) goes to the agent as any other, so it is
    // not lost; Esc cancels them, as for a subagent. Taken out of pending, so a write that fails later does not send
    // it too.
    const untaken = [...worker.pending.values()]
    worker.pending.clear()
    if (!worker.interrupted) {
      for (const text of untaken) {
        const sent = await $.session.send({ to: { agentId: e.agentId }, text }).catch(err => ({ isDelivered: false, reason: message(err) }))
        $.ui.log(`anymodel: message sent on agent=${e.agentId} delivered=${sent.isDelivered}`, { to: 'debug' })
        if (!sent.isDelivered) $.ui.toast(`anymodel: a message for ${agent.name} was lost (${sent.reason}): send it again`)
      }
    }
  }
  if (worker.interrupted) throw new Error(`${agent.name} was stopped`)
  if (resume !== undefined && /No conversation found/.test(stderr)) {
    // Gone (cleaned up, or the state dir wiped): forget it, so the next message starts a new worker with all of main's.
    await $.process.run(['/bin/rm', '-f', recordFile])
    throw new Error(`the worker session ${resume} no longer exists; send the message again to start a new one`)
  }
  if (sessionOf(events) === undefined && resume === undefined) $.ui.log(`anymodel: no worker session agent=${e.agentId}`, { to: 'debug' })
  let text
  try {
    text = readResult(events, stderr)
  } catch (err) {
    throw new Error(`${agent.model} at ${agent.baseUrl}: ${message(err)}`)
  }
  const usage = usageLine(events)
  notice($, e.agentId, `Done: ${usage}`)
  return { text, usage }
}

// The step's whole response, made here with no model request: the report as one text block and end_turn.
async function* answer(e, text) {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

// The same report as a SubagentHandback call, for a subagent whose plain text the engine would not deliver.
async function* handBack(e, text) {
  const input = { message: text }
  yield { kind: 'tool', index: 0, id: `toolu_anymodel_${`${e.turnId}_${e.index}`.replace(/[^\w-]/g, '')}`, name: 'SubagentHandback' }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SubagentHandback', input }], stopReason: 'tool_use', usage: null }
}

// A turn's first step delivers through SubagentHandback when the engine asks for it (its reminder, or auto mode when
// the messages could not be read). A later step only follows up the facade's own answer (a refused handback, the
// engine's reminder to hand back): it gets plain text, so the engine ends the turn after its few reminders instead of
// looping on a handback that keeps being refused.
function deliverer(e, messages, mode) {
  const required = messages === undefined ? mode === 'auto' : handbackRequired(messages)
  return e.index === 0 && required ? handBack : answer
}

// /anymodel check [agent]: each agent's context read (which reaches its provider), and one tool call of its model.
async function check($, agent) {
  const steps = []
  // A step's fn may answer what it found, which then names the step.
  const step = async (label, fn) => {
    const t = Date.now()
    try {
      const found = await fn()
      steps.push({ step: found ?? label, ms: Date.now() - t })
    } catch (err) {
      steps.push({ step: label, error: message(err) })
    }
  }
  // As the worker sends them: the key as x-api-key, or the placeholder bearer of a server that needs none.
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(agent.apiKey === undefined ? { authorization: 'Bearer local' } : { 'x-api-key': agent.apiKey }) }
  await step('context', async () => {
    const c = await readContext((url, init) => $.http.fetch(url, init), agent)
    reads.delete(agent.name)
    contexts.set(agent.name, c)
    return contextText(c)
  })
  await step('tool call', async () => {
    const res = await $.http.fetch(`${agent.baseUrl}/v1/messages`, { method: 'POST', headers, body: checkBody(agent.model) }).catch(err => {
      throw new Error(`cannot reach ${agent.baseUrl} (${message(err)}): is its server running?`)
    })
    const problem = checkAnswer(res.status, res.text)
    if (problem !== undefined) throw new Error(problem)
  })
  return { name: agent.name, steps }
}

// /anymodel cleanup [days]: what the workers keep (see cleanupCommands), past Claude Code's own cleanup period.
async function cleanup($, args) {
  const days = args === '' ? Number((await $.settings.read({ key: 'cleanupPeriodDays' })) ?? 30) : Number(args)
  if (!Number.isInteger(days) || days < 0) return { text: 'give the days as a whole number, e.g. /anymodel cleanup 30', exitCode: 1 }
  const dataDir = await stateDir($)
  const counts = []
  for (const argv of cleanupCommands(dataDir, await tmpDirOf($), await $.session.id(), days)) {
    const r = await $.process.run(argv)
    // find fails on a directory not made yet: nothing to remove there.
    counts.push(r.stdout.split('\n').filter(Boolean).length)
  }
  return { text: `Removed ${counts[0]} worker session record(s) and ${counts[1]} worker transcript file(s) older than ${days} days, and ${counts[2]} leftover run directories.` }
}

export function register(on, options) {
  // The agents, read at session.start: this fires again after every settings change.
  let config = agentsConfig({}, {})

  // Each agent becomes the type anymodel:<name>, which the Agent tool, @-mentions and the @ list offer; each one's
  // context window is read now, in the background.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const saved = await settings($, options)
    // A save cleared the form, which reloads the plugin: the next load registers the agents, as this one is replaced.
    if (saved === undefined) return started
    config = saved
    for (const name of config.names) {
      try {
        const { agent } = await $.agent.register(agentSpec(name, config.problems.get(name).length ? undefined : config.agents.get(name)))
        types.set(agent, name)
      } catch (err) {
        $.ui.toast(`anymodel: cannot add the agent ${name}: ${message(err)}`)
      }
    }
    try {
      await $.command.register({ name: 'anymodel', description: 'Run one of your anymodel agents on a task; list, check or remove them', argumentHint: `<${config.names.join('|') || 'agent'}> <task> | check [agent] | remove <agent> | cleanup [days]` })
    } catch (err) {
      $.ui.toast(`anymodel: cannot add /anymodel: ${message(err)}`)
    }
    if (config.errors.length) $.ui.toast(`anymodel: ${config.errors.length} settings problem(s): /anymodel shows them`)
    for (const agent of config.agents.values()) {
      if (config.problems.get(agent.name).length) continue
      readContextOf($, agent, config.secrets).then(() => {
        const { error } = contexts.get(agent.name) ?? {}
        if (error !== undefined) $.ui.toast(`anymodel: ${agent.name}: ${error}`)
      })
    }
    $.ui.log(`anymodel: registered ${JSON.stringify([...types.keys()])} errors=${JSON.stringify(config.errors)}`, { to: 'debug' })
    return started
  })

  // /anymodel <agent> <task> starts the agent through $.agent.spawn, so it runs in main's permission mode as when Claude
  // starts it, and shows its answer with no Claude turn; /anymodel alone lists the agents.
  on('command.run', { command: 'anymodel' }, async ($, e, next) => {
    // The engine shows a command's text under the plugin's name, so it carries no "anymodel:" of its own.
    const fail = text => ({ text, exitCode: 1 })
    const { name, task } = commandArgs(e.args)
    if (name === '') {
      // The context sizes session.start is still reading, for up to 10 s: a local provider answers in well under that.
      const reading = () => [...config.agents.keys()].some(n => config.problems.get(n).length === 0 && !contexts.has(n))
      for (let i = 0; i < 20 && reading(); i++) await nap($)
      const cwd = await $.session.cwd()
      const definitionsOf = async n => {
        const d = await definitionOf($, n, cwd)
        // A project's definition by its path in the project, a user's one in full.
        return d && { file: d.user ? d.file : d.file.slice(cwd.length + 1), guarded: guarded(await $.fs.read(d.file)) }
      }
      const definitions = new Map(await Promise.all(config.names.map(async n => [n, await definitionsOf(n)])))
      return { text: agentList(config, contexts, definitions), ...(config.errors.length ? { exitCode: 1 } : {}) }
    }
    if (name === 'cleanup') return cleanup($, task.trim())
    if (name === 'remove') {
      const target = task.trim()
      if (!config.names.includes(target)) return fail(`no agent named "${target}"; yours are ${config.names.join(', ') || 'none yet'}`)
      const { value: keys = {} } = await $.state.get(KEYS)
      const left = removeAgent(target, (await $.store.get(AGENTS)) ?? {}, keys)
      if (JSON.stringify(left.keys) !== JSON.stringify(keys)) {
        try {
          await writeKeys($, left.keys)
        } catch (err) {
          return fail(`${target} not removed: ${message(err)}`)
        }
      }
      await $.state.set(KEYS, left.keys)
      await $.store.set(AGENTS, left.agents)
      // Its type stays until the plugin reloads: agent.offer hides it, agent.spawn refuses it.
      config = agentsConfig(left.agents, left.keys)
      return { text: `Removed ${target}.` }
    }
    if (name === 'check') {
      const picked = task.trim() === '' ? config.names : [task.trim()]
      if (!config.names.includes(picked[0] ?? '')) return fail(picked.length ? `no agent named "${picked[0]}"; yours are ${config.names.join(', ') || 'none yet'}` : 'No agents yet: add them with /plugin configure anymodel.')
      const results = []
      for (const n of picked) {
        const problems = config.problems.get(n)
        results.push(problems.length ? { name: n, steps: [{ step: 'settings', error: problems.join('; ') }] } : await check($, config.agents.get(n)))
      }
      return { text: redact(checkReport(results), config.secrets), ...(results.some(r => r.steps.some(s => s.error !== undefined)) ? { exitCode: 1 } : {}) }
    }
    const type = [...types].find(([, n]) => n === name)?.[0]
    if (type === undefined) return fail(`no agent named "${name}"; yours are ${config.names.join(', ') || 'none yet'} (/anymodel lists them)`)
    if (task === '') return fail(`give ${name} a task: /anymodel ${name} <task>`)
    const { agentId, deny } = await $.agent.spawn({ subagentType: type, prompt: task, description: `/anymodel ${name}` })
      .catch(err => ({ deny: message(err) }))
    if (deny !== undefined) return fail(deny.replace(/^anymodel: /, ''))
    // Awaiting a promise counts against the hook's 10 s, time inside a $ call does not: wait in short sleeps.
    while (!answers.has(agentId)) {
      try {
        await nap($)
      } catch (err) {
        if (!next.signal.aborted) throw err
        // Esc stops the agent, as for a subagent running in the foreground: an interrupt to its worker, and before
        // the worker could take one, at its first output (runWorker).
        if (!answers.has(agentId)) stopped.add(agentId)
        const worker = workers.get(agentId)
        if (worker !== undefined && !worker.ended) {
          worker.interrupted = true
          await writeLine($, worker, interruptLine(uuid())).catch(() => {})
        }
        return fail(`stopped ${name}`)
      }
      const status = (await $.agent.list()).find(a => a.id === agentId)?.status
      if (!answers.has(agentId) && ENDED.includes(status)) return fail(`${name} ended (${status}) without an answer`)
    }
    const { text, usage } = answers.get(agentId)
    answers.delete(agentId)
    const agent = config.agents.get(name)
    const via = agent === undefined ? '' : ` (${agent.model} via ${agent.provider})`
    return { text: `${name}${via}:\n\n${text}${usage === undefined ? '' : `\n\n(${usage})`}`, ...(text.startsWith('anymodel: ') ? { exitCode: 1 } : {}) }
  })

  // In auto mode the agent also hands its answer back to main, as a message from it (the facade's SubagentHandback).
  on('prompt.submit', ($, e, next) => {
    const id = e.isMeta && e.origin?.kind === 'peer' ? [...handBacks].find(a => e.text.startsWith(`<agent-message from="${a}">`)) : undefined
    if (id === undefined) return next(e)
    handBacks.delete(id)
    return { drop: '' }
  })

  // A message for an agent whose worker runs goes to the worker, which takes it at its next step, as a subagent takes
  // a queued message: queued, it would wait for the facade's step, which lasts the whole run. The agent's view shows
  // it as a notice. A message the worker cannot take goes as usual, and resumes the agent once its run is over.
  on('session.send', async ($, e, next) => {
    const rows = (await $.agent.list()).filter(a => a.id === e.to || a.name === e.to)
    const worker = rows.length === 1 ? workers.get(rows[0].id) : undefined
    if (worker === undefined || worker.ended) return next(e)
    const id = uuid()
    worker.pending.set(id, e.text)
    try {
      await writeLine($, worker, userLine(e.text, id))
    } catch {
      // Gone from pending: the run ended and sent it on already.
      if (!worker.pending.delete(id)) return { isDelivered: true }
      // The worker answered while this was written: with nothing left to wait for, its run ends with that answer.
      if (worker.answered && worker.pending.size === 0) {
        worker.ended = true
        await killWorker($, worker)
      }
      return next(e)
    }
    notice($, worker.agentId, toolLine('Message', { description: e.text }))
    $.ui.log(`anymodel: message to the running worker agent=${worker.agentId} chars=${e.text.length}`, { to: 'debug' })
    return { isDelivered: true }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const dataDir = await stateDir($)
    let row
    let name
    // Until the agent is known or no anymodel spawn is pending: its step must never reach Claude as an unknown one.
    for (let i = 0; ; i++) {
      const agents = await $.agent.list()
      row = agents.find(a => a.id === e.agentId)
      name = await nameOf($, dataDir, e.agentId, row?.type)
      if (name !== undefined || row !== undefined || spawning === 0) break
      if (i === 120) {
        name = '?'
        break
      }
      await nap($)
    }
    $.ui.log(`anymodel: step agent=${e.agentId} type=${row?.type} name=${name ?? '-'} index=${e.index} model=${e.model}`, { to: 'debug' })
    if (name === undefined) return yield* next(e)
    if (!names.has(e.agentId) && name !== '?') {
      names.set(e.agentId, name)
      await markAgent($, dataDir, e.agentId, name)
    }
    const started = Date.now()
    const file = await sessionFile($, dataDir, e.agentId)
    // The first run of an agent /anymodel started is the command's: its answer goes to the command.
    const forCommand = e.index === 0 && row?.spawnedBy === $.plugin.name && !served.has(e.agentId) && !(await $.fs.exists(file))
    let text
    let usage
    // Read once: delivery decides from these too, so a finished report is never lost to a second read failing.
    let messages
    try {
      if (name === '?') throw new Error('this agent was not recognised in time, so it was not run')
      messages = await apiMessages($, e.agentId)
      const agent = config.agents.get(name)
      const resume = agent !== undefined && (await $.fs.exists(file)) ? resumable(await $.fs.read(file), agent) : undefined
      // What the worker had: none of main's messages with no worker session to resume (a first run, every earlier run
      // failed, or the agent moved to another provider or model); else as of its last run that took a task, or, when
      // this process saw none (Claude Code restarted), up to the facade's last answer. Kept until a worker takes this
      // task, so a run that fails before then leaves it to send again.
      const had = resume === undefined ? [] : given.get(e.agentId) ?? answeredAsks(messages)
      given.set(e.agentId, had)
      // Only a turn's first step can carry a new message from main; a later one follows up the facade's own answer.
      const fresh = e.index !== 0 ? [] : freshAsks(messages, had)
      if (fresh.length > 0) {
        const problems = config.problems.get(name) ?? []
        if (problems.length) throw new Error(`the settings need fixing (/plugin configure anymodel): ${problems.join('; ')}`)
        if (agent === undefined) throw new Error(`the agent "${name}" is no longer in the settings, so this was not run; call one of the configured agents instead`)
        const backend = { ...agent, contextSize: await contextOf($, agent, config.secrets) }
        ;({ text, usage } = await runWorker($, e, backend, taskText(fresh), await modeOf($, e.agentId), dataDir, resume, file, asks(messages).map(b => b.text)))
        $.ui.log(`anymodel: answer agent=${e.agentId} ms=${Date.now() - started} chars=${text.length}: ${text}`, { to: 'debug' })
      } else {
        text = answerIn(messages.findLast(m => m.role === 'assistant') ?? { content: [] })
        if (text === '') throw new Error('the subagent has no new message and no earlier answer')
      }
    } catch (err) {
      // Errors raised by $ calls already carry the plugin's name. A provider's error can quote the key it refused.
      text = redact(`anymodel: ${message(err)}`, config.secrets)
      $.ui.log(`anymodel: error agent=${e.agentId} ms=${Date.now() - started}: ${text}`, { to: 'debug' })
    }
    stopped.delete(e.agentId)
    const deliver = deliverer(e, messages, modes.get(e.agentId))
    if (forCommand) {
      served.add(e.agentId)
      answers.set(e.agentId, { text, usage })
      if (deliver === handBack) handBacks.add(e.agentId)
    }
    // Never next(e) for an anymodel agent: that would send its step to the session's Claude backend.
    return yield* deliver(e, text)
  }).catch(async function* ($, e, next) {
    // Without this handler a hook that throws or overruns is skipped and the step goes to the cloud.
    if (next.called) return yield* next(e)
    const agent = e.agentId === undefined ? undefined : await $.agent.list().then(l => l.find(a => a.id === e.agentId), () => undefined)
    const anymodel = e.agentId !== undefined && (spawning > 0 || (await stateDir($).then(d => nameOf($, d, e.agentId, agent?.type)).catch(() => '?')) !== undefined)
    if (anymodel) {
      const messages = await apiMessages($, e.agentId).catch(() => undefined)
      const text = redact(`anymodel: the step failed (${next.error.kind}: ${next.error.message ?? 'no message'})`, config.secrets)
      if (agent?.spawnedBy === $.plugin.name && e.index === 0 && !served.has(e.agentId)) {
        served.add(e.agentId)
        answers.set(e.agentId, { text })
      }
      return yield* deliverer(e, messages, modes.get(e.agentId))(e, text)
    }
    return yield* next(e)
  })

  // A removed agent's type lasts until the plugin reloads: the model is not offered it.
  on('agent.offer', ($, e, next) => (types.has(e.agent) && !config.names.includes(types.get(e.agent)) ? { isOffered: false } : next(e)))

  // A workflow's agents are missing from $.agent.list() and a teammate can run in another process, so turn.step could
  // not recognise them: refuse to start them. Every other spawn of an anymodel agent, resumes included, records main's
  // mode and the agent's name, and runs on the agent's own model, so the agent view names it whatever the call asked.
  on('agent.spawn', async ($, e, next) => {
    const dataDir = await stateDir($)
    // A Claude Code agent definition of an agent's name runs as that agent, on its model: never on Claude. Only a
    // definition file: a built-in of the name (Explore, Plan) stays Claude Code's.
    const defined = config.names.includes(e.subagentType) && (await definitionOf($, e.subagentType, await $.session.cwd())) !== undefined
    const name = types.get(e.subagentType) ?? (defined ? e.subagentType : undefined) ??
      (e.resume ? await markedName($, dataDir, e.resume.agentId) : undefined)
    if (name === undefined) return next(e)
    if (!config.names.includes(name)) return { deny: `anymodel: the agent "${name}" is no longer in the settings` }
    if (e.workflow || e.isTeammate) return { deny: `${e.subagentType} cannot run as a teammate or in a workflow, only as a subagent` }
    const mode = e.permissionMode ?? 'default'
    if (e.resume) {
      names.set(e.resume.agentId, name)
      modes.set(e.resume.agentId, mode)
    }
    spawning++
    let started
    try {
      started = await next({ ...e, ...(e.resume ? {} : { subagentType: `anymodel:${name}` }), model: config.agents.get(name)?.model ?? e.model })
    } finally {
      spawning--
    }
    if (started.agentId !== undefined) {
      names.set(started.agentId, name)
      modes.set(started.agentId, mode)
      await markAgent($, dataDir, started.agentId, name)
    }
    return started
  }).catch(($, e, next) =>
    next.called || !(types.has(e.subagentType) || (e.resume && names.has(e.resume.agentId))) ? next(e) : { deny: `anymodel could not start ${e.subagentType}: ${next.error.message ?? next.error.kind}` })
}
