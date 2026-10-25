// Pure helpers for the anymodel facade: its settings, the worker's command line and stream-json messages, its
// permission questions, its task and its result.

// Tools a Claude Code subagent does not get, which the worker, a session of its own, would; and WebSearch, which runs
// on Anthropic's servers.
export const WITHHELD_TOOLS = ['Workflow', 'ScheduleWakeup', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'WebSearch']

const SUBAGENT_RULE =
  'You run as a subagent of another Claude Code session. Your final message is your report to it: ' +
  'give the answer or findings the task asks for.'

// Reasoning a model writes inline as text before its answer (Gemma 4's channel, <think>), cut to its close or,
// unclosed, to the end. Only at the start: a report may quote these tags.
const REASONING = /^\s*(?:<\|channel>[\s\S]*?(?:<channel\|>|$)|<think>[\s\S]*?(?:<\/think>|$))/
// A close with no opener before it (the chat template sent the opener) fails the run: the reasoning is before it.
const OPENER = /<\|channel>|<think>/
const CLOSER = /<channel\|>|<\/think>/

const NAME = /^[A-Za-z0-9_-]{1,64}$/
// /anymodel's own words, which no agent can be called.
export const SUBCOMMANDS = ['check', 'cleanup', 'remove']
// From what an agent needs (its own prompt, about 13k tokens, and the 33k Claude Code keeps free for compaction; with
// less it compacts over and over and loses its task) up to any model's window.
const MIN_CONTEXT = 49152
const MAX_CONTEXT = 10000000

// A host a key may reach over plain http: this machine or a private network. Matched against the URL's parsed
// hostname: a raw match would take "http://api.example.com?.local" for a .local host.
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|169\.254(\.\d+){2}|\[(::1|f[cd][0-9a-f]{2}:[0-9a-f:]*|fe[89ab][0-9a-f]:[0-9a-f:]*)\]|[^/:]+\.(local|lan|internal|home\.arpa))$/i
export const localHost = url => {
  try {
    return LOCAL_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

// The settings form (plugin.json userConfig) takes one agent at a time: its name, server URL, model, API key and context
// size. anymodel keeps the agents ($.store "agents": name -> { url, model, context? }) and writes every key back into
// the form's API key field as one JSON object of server URL -> key, so the field holds them all, in the Keychain.

const text = v => (typeof v === 'string' ? v.trim() : '')
const isKeys = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(k => typeof k === 'string')

// What the form's API key field holds: the keys anymodel wrote back, or a key typed over them (the dialog saves the
// field whole). `held`: the keys as this session last knew them. A typed value among them is a stale read of
// anymodel's own write, which comes right after it, not a new key.
export function formKeys(raw, held) {
  const value = text(raw)
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {}
  if (isKeys(parsed)) return { keys: parsed }
  const keys = held ?? {}
  return value === '' || Object.values(keys).includes(value) ? { keys } : { keys, typed: value }
}

// What keeps a saved agent from running, or undefined. `key`: its server's key, if any.
function agentProblem(name, a, key) {
  if (!NAME.test(name)) return `"${name}" is not a name: letters, digits, _ and -, up to 64`
  if (SUBCOMMANDS.includes(name)) return `"${name}" is taken by /anymodel ${name}`
  if (!/^https?:\/\/[^\s/]+\S*$/.test(a.url ?? '') || !URL.canParse(a.url)) return 'the server URL must start with http:// or https://'
  if (text(a.model) === '') return 'it has no model'
  if (a.context !== undefined && !(Number.isInteger(a.context) && a.context >= MIN_CONTEXT && a.context <= MAX_CONTEXT)) {
    return `the context size must be ${MIN_CONTEXT} to ${MAX_CONTEXT} tokens (an agent's its own prompt takes about 13k and Claude Code keeps about 33k free for compaction)`
  }
  if (key !== undefined && /^http:/.test(a.url) && !localHost(a.url)) return `${a.url} is plain http:// on another network, so its key would cross it unencrypted: use https://`
}

// The keys of the servers some agent uses.
const usedKeys = (agents, keys) => Object.fromEntries(Object.entries(keys).filter(([url]) => Object.values(agents).some(a => a?.url === url)))

// One save of the form: the agent it names added, or updated with the fields filled in (a blank one keeps the agent's
// own). A key typed in the form becomes the key of the agent's server, which every agent there shares. Returns the new
// { agents, keys }, or { error }, which never quotes the key.
export function saveAgent(form, agents, keys, typed) {
  const name = text(form.agent)
  const was = Object.hasOwn(agents, name) ? agents[name] : undefined
  if (was === undefined && (text(form.url) === '' || text(form.model) === '')) return { error: `${name} is a new agent: give its server URL and model` }
  const context = text(form.context)
  if (context !== '' && !/^\d+$/.test(context)) return { error: `the context size is a number of tokens, not "${context}"` }
  const agent = {
    // An OpenAI-style base URL ends in /v1: the worker adds /v1/messages, so it goes.
    url: text(form.url) === '' ? was.url : text(form.url).replace(/(\/v1)?\/*$/, ''),
    model: text(form.model) || was.model,
    ...(context !== '' ? { context: Number(context) } : was?.context !== undefined ? { context: was.context } : {}),
  }
  const problem = agentProblem(name, agent, typed ?? keys[agent.url])
  if (problem !== undefined) return { error: problem }
  const saved = { ...agents, [name]: agent }
  return { agents: saved, keys: usedKeys(saved, typed === undefined ? keys : { ...keys, [agent.url]: typed }) }
}

// The agents without `name`; its server's key goes with the server's last agent.
export function removeAgent(name, agents, keys) {
  const { [name]: _, ...rest } = agents
  return { agents: rest, keys: usedKeys(rest, keys) }
}

// The saved agents as the hooks use them. One that no longer holds (the store edited by hand) is still registered and
// answers its problem, so calling it never silently does nothing.
export function agentsConfig(agents, keys) {
  const names = Object.keys(agents)
  const problems = new Map()
  const usable = new Map()
  for (const name of names) {
    const a = agents[name]
    const problem = a === null || typeof a !== 'object' ? 'its saved settings are unreadable' : agentProblem(name, a, keys[a.url])
    problems.set(name, problem === undefined ? [] : [problem])
    if (problem === undefined) usable.set(name, { name, provider: new URL(a.url).host, baseUrl: a.url, model: a.model, apiKey: keys[a.url], contextSize: a.context })
  }
  return { names, agents: usable, errors: names.flatMap(n => problems.get(n).map(p => `${n}: ${p}`)), problems, secrets: [...new Set(Object.values(keys))] }
}

// `text` with every key replaced: a provider's error can quote the key it refused, and the text goes on to main. A
// short key ("local") only where it stands as a token of its own, so "localhost" is left alone. Every key is found in
// the original text and the matches merge, so a key inside or overlapping another is never left half shown.
export const redact = (text, secrets) => {
  const hidden = new Uint8Array(text.length)
  for (const k of secrets) for (const m of text.matchAll(keyPattern(k))) hidden.fill(1, m.index, m.index + k.length)
  if (!hidden.includes(1)) return text
  return text.replace(/[\s\S]/g, (c, i) => (!hidden[i] ? c : hidden[i - 1] ? '' : '<key>'))
}

// A lookahead, so a key that overlaps itself in the text ("abab" in "ababab") is found at every place.
const keyPattern = (k) => {
  const exact = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(k.length >= 8 ? `(?=${exact})` : `(?<![\\w-])(?=${exact}(?![\\w-]))`, 'g')
}

// A model's context window in what a provider answers: LM Studio's /api/v0/models (the length it is loaded with; an
// unloaded model has none, as LM Studio would load it at its own default), the /v1/models of Unsloth Studio (the
// window it runs), OpenRouter or vLLM, or llama-server's /props (the window of each slot, for the model it serves; its
// /v1/models has only the training window).
export function contextFrom(text, model) {
  let list
  try {
    list = JSON.parse(text)
  } catch {
    return undefined
  }
  const props = list?.default_generation_settings
  if (props !== undefined) return [list.model_alias, list.model_path].includes(model) && Number.isInteger(props.n_ctx) && props.n_ctx > 0 ? props.n_ctx : undefined
  const data = Array.isArray(list?.data) ? list.data : []
  // An OpenRouter variant (deepseek/deepseek-v4-flash:nitro) is listed under its model.
  const m = data.find(x => x?.id === model) ?? data.find(x => x?.id === model.replace(/:[^/:]+$/, ''))
  return [m?.loaded_context_length, m?.context_length, m?.max_model_len].find(v => Number.isInteger(v) && v > 0)
}

// The model ids a provider's model list holds, or undefined when the text is no such list.
function listedIds(text) {
  try {
    const data = JSON.parse(text)?.data
    return Array.isArray(data) ? data.map(x => x?.id).filter(id => typeof id === 'string') : undefined
  } catch {
    return undefined
  }
}

// The agent model's context window read from its provider with `fetch` ($.http.fetch): LM Studio's list first, then
// the OpenAI-style one, then llama-server's /props; what each answered goes into the error. The window the server
// reports wins over the agent's context size in the settings, which counts only when the server reports none:
// { size, source, ignored }.
// A server with a key (Unsloth Studio) lists models only for it: it goes in both headers, the bearer one included,
// which Unsloth Studio reads.
export async function readContext(fetch, backend) {
  const tried = []
  let reached = false
  const headers = backend.apiKey === undefined ? {} : { authorization: `Bearer ${backend.apiKey}`, 'x-api-key': backend.apiKey }
  for (const path of ['/api/v0/models', '/v1/models', '/props']) {
    const res = await fetch(`${backend.baseUrl}${path}`, { headers }).catch(err => ({ failed: err instanceof Error ? err.message : String(err) }))
    if (res.failed !== undefined) {
      tried.push(`${path}: ${res.failed}`)
      continue
    }
    reached = true
    const size = res.ok ? contextFrom(res.text, backend.model) : undefined
    if (size !== undefined && size < MIN_CONTEXT) {
      throw new Error(`${backend.model} at ${backend.baseUrl} has a context of ${size} tokens, under the ${MIN_CONTEXT} an agent needs (its own prompt takes about 13k and Claude Code keeps about 33k free for compaction): load it with a longer context`)
    }
    if (size !== undefined) return { size, source: `read from ${backend.provider}`, ...(backend.contextSize !== undefined && backend.contextSize !== size ? { ignored: backend.contextSize } : {}) }
    const ids = res.ok ? listedIds(res.text) : undefined
    const listed = ids?.some(id => id === backend.model || id === backend.model.replace(/:[^/:]+$/, ''))
    tried.push(`${path}: ${!res.ok ? `HTTP ${res.status}` : ids === undefined || listed ? 'no context size for this model' : `not listed (it lists ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''})`}`)
  }
  if (!reached) throw new Error(`cannot reach ${backend.baseUrl} (${tried.join(', ')}): is its server running?`)
  if (backend.contextSize !== undefined) return { size: backend.contextSize, source: 'set in the settings' }
  throw new Error(`cannot read the context size of ${backend.model} from ${backend.baseUrl} (${tried.join(', ')}): check the model id, load the model (LM Studio), or set its Context size in /plugin configure anymodel`)
}

// The agent type registered for a named agent; `backend` is undefined while the settings have errors. It names the
// agent's own model, so the agent view shows it, and a step that reached the session's backend (the mod not
// answering, a bug) fails there on a model it does not have. Its prompt only runs if one were answered all the same:
// then it says so instead of doing the task.
export function agentSpec(name, backend) {
  const what = backend === undefined
    ? `anymodel agent "${name}": its settings need fixing (/plugin configure anymodel).`
    : `${backend.model} via ${backend.provider} (not a Claude model): a Claude Code agent with a subagent's tools. Use it when the user names "${name}".`
  return {
    name,
    // In main's agent listing on every request, once per agent: kept short.
    description: `${what} It sees only your brief: give a self-contained task. Check its answers; a reply starting "anymodel:" is a plugin error.`,
    prompt: 'The anymodel plugin answers this agent with the model configured for it, so this prompt is only read when the plugin did not answer and the task reached a Claude model instead.\n\nDo not do the task and do not call any tool. Reply with exactly this line and nothing else:\n\nanymodel: the plugin did not answer this agent, so the task was not run. Check that the anymodel plugin is enabled and that hooks are not disabled.',
    tools: ['SendMessage'],
    model: backend?.model ?? 'haiku',
    omitClaudeMd: true,
  }
}

// /anymodel's arguments: the agent's name, then its task as typed.
export function commandArgs(args) {
  const [, name, task] = args.trim().match(/^(\S*)\s*([\s\S]*)$/)
  return { name, task }
}

// An agent's context window as /anymodel shows it, from its latest read: readContext's { size, source, ignored } or
// { error }; undefined while it is being read.
export function contextText(c) {
  if (c === undefined) return 'context being read from the provider'
  if (c.error !== undefined) return `context unknown: ${c.error}`
  return `context ${c.size} (${c.source}${c.ignored === undefined ? '' : `; ${c.ignored} in the settings ignored`})`
}

// What /anymodel shows alone: each agent with its model, provider, context size and whether it has a key (never the
// key), or that it needs fixing; then the settings' problems.
// Whether a Claude Code agent definition names the model only anymodel serves: without anymodel, the agent then fails
// at Anthropic (model_not_found) instead of running on Claude.
export const guarded = text => /^model:\s*["']?anymodel["']?\s*$/m.test(text.split(/^---\s*$/m)[1] ?? '')

// `definitions`: per agent, the definition it runs as ({ file, guarded }).
export function agentList(config, contexts, definitions = new Map()) {
  const problems = config.errors.length ? ['', 'These agents need fixing: save them again in /plugin configure anymodel, or /anymodel remove them:', ...config.errors.map(e => `- ${e}`)] : []
  if (config.names.length === 0) return [config.errors.length ? 'No usable agents.' : 'No agents yet: add them with /plugin configure anymodel.', ...problems].join('\n')
  const width = Math.max(...config.names.map(n => n.length))
  return [
    ...config.names.map(n => {
      const a = config.agents.get(n)
      if (config.problems.get(n).length || a === undefined) return `${n.padEnd(width)}  needs fixing (below)`
      const d = definitions.get(n)
      const as = d === undefined ? '' : `, runs as ${d.file}${d.guarded ? '' : ' (without model: anymodel in it, it runs on Claude when anymodel is off)'}`
      return `${n.padEnd(width)}  ${a.model} at ${a.baseUrl}, ${contextText(contexts.get(n))}, ${a.apiKey === undefined ? 'no key' : 'key set'}${as}`
    }),
    '',
    'Run one: /anymodel <agent> <task>. Test them: /anymodel check [agent]. Add one: /plugin configure anymodel. Change one: /plugin configure anymodel <agent>. Remove one: /anymodel remove <agent>',
    ...problems,
  ].join('\n')
}

// Main's permission settings and sandbox for the worker's --settings, from its merged settings: the worker's own config
// directory holds none of main's user settings. `grants` are the rules and directories the person allowed for this
// session in an earlier worker's permission question. The mode comes in --permission-mode, not from here.
export function permissionSettings(settings, grants) {
  const { defaultMode, ...p } = settings?.permissions ?? {}
  const list = v => (Array.isArray(v) ? v : [])
  return {
    permissions: {
      ...p,
      allow: [...list(p.allow), ...grants.rules],
      deny: list(p.deny),
      ask: list(p.ask),
      additionalDirectories: [...list(p.additionalDirectories), ...grants.directories],
    },
    ...(settings?.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
  }
}

// Variables that decide where the worker's requests go and whom they trust on the way: each is pinned to main's value
// (or to unset, '') over the project's settings, so none of them can take the key elsewhere.
export const NETWORK_VARS = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
]
// Never main's: its socket would take the worker's requests to main's backend, a request log would hold the key.
const UNSET_VARS = ['ANTHROPIC_UNIX_SOCKET', 'ANTHROPIC_LOG', 'BUN_CONFIG_VERBOSE_FETCH', 'NODE_DEBUG']

// The worker starts in main's environment, as main's own subagents run in it, less main's Claude Code variables (its
// login, config directory, backend), which bridge.sh drops; these come over it.
// Sandboxed Bash may write to <CLAUDE_CODE_TMPDIR>/claude-<uid>, but only when that path is at most 44 bytes; a longer
// one falls back to the shared /tmp/claude-<uid> that holds other sessions' files. So tmpDir must be short (/tmp/anymodel-<uid>).
// `host` holds main's values of NETWORK_VARS. `backend` is the agent's, with its context size; with `hasKey` its key
// comes on fd 4 (bridge.sh). `mode` is main's permission mode, `permissions` main's rules (permissionSettings),
// `mcpConfig` a file of main's MCP servers. `asAgent` names the Claude Code agent definition the worker runs as.
export function workerArgv({ claude, dataDir, tmpDir, backend, hasKey, mode, permissions, mcpConfig, session, host, asAgent }) {
  // One process has one backend: every alias inside the worker names its own model.
  const env = {
    ANTHROPIC_BASE_URL: backend.baseUrl, ANTHROPIC_MODEL: backend.model, ANTHROPIC_SMALL_FAST_MODEL: backend.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: backend.model, ANTHROPIC_DEFAULT_SONNET_MODEL: backend.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: backend.model, ANTHROPIC_DEFAULT_FABLE_MODEL: backend.model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(backend.contextSize),
    // Pinned with the rest, so a project's env cannot send the key through a proxy of its own, other credentials
    // with it, or the requests to another cloud.
    ...Object.fromEntries(NETWORK_VARS.map(k => [k, host[k] ?? ''])), ...Object.fromEntries(UNSET_VARS.map(k => [k, ''])),
    // A server that needs no key still gets a placeholder, since Claude Code starts with none only by asking for a
    // login. It goes as x-api-key, which a server without auth ignores; Unsloth Studio rejects a bearer it cannot decode.
    ANTHROPIC_API_KEY: hasKey ? '' : 'local', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  }
  // The project's settings load (with its CLAUDE.md); these CLI settings outrank them, so its env cannot point the
  // worker at another backend. availableModels swaps any other model, such as a definition's model: anymodel, for the agent's.
  const settings = { env, ...permissions, availableModels: [backend.model] }
  return [
    '/usr/bin/env',
    `TMPDIR=${tmpDir}`, `CLAUDE_CODE_TMPDIR=${tmpDir}`, `CLAUDE_CONFIG_DIR=${dataDir}/config`,
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ...(hasKey ? ['CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=4'] : []),
    // The worker lives for one turn of the agent: background work would be cut off when it ends.
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
    claude, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    // Its permission questions come to the mod, which asks main's rules and the person (see permissionAsk).
    '--permission-prompt-tool', 'stdio', '--permission-mode', mode,
    '--setting-sources=project,local', '--settings', JSON.stringify(settings),
    '--strict-mcp-config', ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig]),
    '--disallowedTools', WITHHELD_TOOLS.join(','),
    // Its prompt and tools, on the agent's model (availableModels above).
    ...(asAgent === undefined ? [] : ['--agent', asAgent]),
    '--append-system-prompt', SUBAGENT_RULE,
    ...session,
  ]
}

// The stream-json lines the mod writes to the worker: a user message (its uuid comes back when the worker takes it,
// --replay-user-messages), the answer to a control request, an interrupt.
export const userLine = (text, uuid) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
export const responseLine = (requestId, response) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
export const interruptLine = id => JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt', cancel_queued: true } })
export const errorLine = (requestId, error) => JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })

// stdout of the worker as it comes: the whole lines in `buffer` as events, and the start of the next line.
export function takeEvents(buffer) {
  const end = buffer.lastIndexOf('\n')
  if (end === -1) return { events: [], rest: buffer }
  const events = buffer.slice(0, end).split('\n').flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  return { events, rest: buffer.slice(end + 1) }
}

// A worker's tool call as one line of the agent's view: the tool and the argument a person reads first.
export function toolLine(name, input, cwd) {
  const file = input?.file_path ?? input?.notebook_path ?? input?.path
  // A file in the project shows by its path in it, as Claude Code's own tool calls do.
  const shown = cwd !== undefined && typeof file === 'string' && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file
  const arg = String(input?.command ?? shown ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? '')
  const one = arg.replace(/\s+/g, ' ').trim()
  return one === '' ? name : `${name}(${one.length > 120 ? `${one.slice(0, 119)}…` : one})`
}

// A worker's tool result in the agent's view, as Claude Code shows one folded: its first line of output.
export function resultLine(block) {
  const text = typeof block.content === 'string' ? block.content : (block.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  const first = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '(no output)'
  return `⎿ ${first.length > 120 ? `${first.slice(0, 119)}…` : first}`
}

// The worker's suggested permission updates, as its "don't ask again" grants: a rule or directory for the session,
// or a rule for the project's local settings. A user-settings one would land in the worker's own config directory,
// which nothing reads: it goes to the project's local settings, which main reads too.
const updatesOf = request => (request.permission_suggestions ?? [])
  .filter(s => (s.type === 'addRules' && s.behavior === 'allow') || s.type === 'addDirectories')
  .map(s => (s.destination === 'userSettings' ? { ...s, destination: 'localSettings' } : s))
const rulesOf = updates => updates.flatMap(s => (s.type === 'addRules' ? s.rules.map(r => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`)) : s.directories))

// A worker's permission request as a question in the engine's question dialog, with the choices of Claude Code's own
// permission dialog: yes, yes and don't ask again (what the worker suggests), no; free text refuses with the reason.
export function permissionAsk(agent, request, cwd) {
  const updates = updatesOf(request)
  const rules = rulesOf(updates)
  const why = request.decision_reason ? ` (${request.decision_reason})` : ''
  return {
    question: `${agent.name} (${agent.model}) wants to use ${toolLine(request.display_name ?? request.tool_name, request.input, cwd)}${why}.${rules.length ? ` Don't ask again allows ${rules.join(', ')}.` : ''} Allow it?`,
    options: ['Yes', ...(rules.length ? ["Yes, don't ask again"] : []), 'No'],
    header: agent.name.slice(0, 12),
  }
}

// The worker's control response for the person's answer to permissionAsk, and the session grants it adds.
export function permissionAnswer(request, asked, answer) {
  const allow = { behavior: 'allow', updatedInput: request.input, toolUseID: request.tool_use_id }
  const none = { rules: [], directories: [] }
  if (answer === 'Yes') return { response: allow, grants: none }
  if (answer === "Yes, don't ask again" && asked.options.includes(answer)) {
    const updates = updatesOf(request)
    const session = updates.filter(s => s.destination === 'session')
    return {
      response: { ...allow, updatedPermissions: updates },
      grants: { rules: rulesOf(session.filter(s => s.type === 'addRules')), directories: rulesOf(session.filter(s => s.type === 'addDirectories')) },
    }
  }
  const message = answer === 'No' ? 'The user refused this tool use.' : `The user refused this tool use and said: ${answer}`
  return { response: { behavior: 'deny', message, interrupt: false, toolUseID: request.tool_use_id }, grants: none }
}

// Main's MCP servers for the worker's --mcp-config: from its user config (`~/.claude.json`: user scope, and local scope
// under the project), and the project's .mcp.json, a closer scope winning a name; only those main has tools from, so
// a server main turned off or did not approve stays off. `mainTools` are main's tool names (mcp__<server>__<tool>).
export function mcpServers(userConfig, cwd, projectConfig, mainTools) {
  const live = new Set(mainTools.filter(t => t.startsWith('mcp__')).map(t => t.split('__')[1]))
  const servers = { ...userConfig?.mcpServers, ...projectConfig?.mcpServers, ...userConfig?.projects?.[cwd]?.mcpServers }
  return Object.fromEntries(Object.entries(servers).filter(([name]) => live.has(name.replace(/[^A-Za-z0-9_-]/g, '_'))))
}

// The worker session a run of the agent resumes, kept as JSON with the backend it ran on: after the agent moved to
// another provider or model, its transcript must not go there.
export const sessionRecord = (sessionId, agent) => JSON.stringify({ sessionId, baseUrl: agent.baseUrl, model: agent.model })
export function resumable(text, agent) {
  let r
  try {
    r = JSON.parse(text)
  } catch {
    return undefined
  }
  return r?.baseUrl === agent.baseUrl && r.model === agent.model && typeof r.sessionId === 'string' ? r.sessionId : undefined
}

const REMINDER = /^\s*(<system-reminder>|\[handback-send-enforce\])/
// What main wrote into a user message: its text blocks less the engine's system reminders and handback nudges.
const asksIn = m => (m.role === 'user' ? m.content.filter(b => b.type === 'text' && b.text.trim() && !REMINDER.test(b.text)) : [])

// The facade's answer in an assistant message: its text, or the report it handed back through SubagentHandback.
export function answerIn(m) {
  const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  return text || String(m.content.find(b => b.type === 'tool_use' && b.name === 'SubagentHandback')?.input?.message ?? '')
}

// Every text block main wrote into the subagent's messages, in order.
export const asks = apiMessages => apiMessages.flatMap(asksIn)

// The texts of the asks before the facade's last answer: what a resumed worker had, when this process saw none of
// its runs (Claude Code restarted).
export const answeredAsks = apiMessages => asks(apiMessages.slice(0, apiMessages.findLastIndex(m => m.role === 'assistant') + 1)).map(b => b.text)

// The blocks of `asks` the worker has not had yet. `given` holds the texts of the asks it had, once each (from the
// run it last took a task in, else answeredAsks): a SendMessage that arrives while the worker runs is filed before
// that run's answer. Texts compare trimmed: the engine can add a newline to a block when it files the next one after it.
export function freshAsks(apiMessages, given) {
  const left = given.map(t => t.trim())
  return asks(apiMessages).filter(b => {
    const i = left.indexOf(b.text.trim())
    if (i !== -1) left.splice(i, 1)
    return i === -1
  })
}

// The worker's task: the fresh blocks, less one repeated as whole lines inside a longer one (a SendMessage to a
// finished subagent is filed on its own and again inside the engine's "sent a message while you were working").
export function taskText(fresh) {
  const texts = fresh.map(b => b.text.trim())
  const within = (outer, t) => outer.length > t.length && `\n${outer}\n`.includes(`\n${t}\n`)
  return texts.filter((t, i) => !texts.some((o, j) => j !== i && within(o, t))).join('\n\n')
}

// In auto mode the engine tells each subagent in a system reminder that only a SubagentHandback call delivers its
// report; plain text at the end is dropped. Main's task text cannot trigger this: it is not a system reminder.
export function handbackRequired(apiMessages) {
  return apiMessages.some(m => m.role === 'user' && m.content.some(b =>
    b.type === 'text' && b.text.startsWith('<system-reminder>') && b.text.includes('SubagentHandback')))
}

// The worker session the run used, which a later run resumes.
export const sessionOf = events => events.find(ev => ev.type === 'system' && ev.subtype === 'init')?.session_id

// A result's text less the reasoning at its start; a close of reasoning left with no opener fails the run.
function answerText(result) {
  let text = String(result ?? '')
  while (REASONING.test(text)) text = text.replace(REASONING, '')
  const close = text.search(CLOSER)
  if (close !== -1 && !OPENER.test(text.slice(0, close))) {
    throw new Error('the report starts with reasoning whose opening tag the server sent elsewhere: set the server to return reasoning separately (its reasoning parser), or turn thinking off')
  }
  return text.trim()
}

// How much a run took, from its results: turns and tokens as the provider counted them (some count cache reads in the
// input, some apart).
export function usageLine(events) {
  const results = events.filter(ev => ev.type === 'result')
  const sum = f => results.reduce((n, r) => n + (Number(f(r)) || 0), 0)
  const k = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const cached = sum(r => r.usage?.cache_read_input_tokens)
  const turns = sum(r => r.num_turns)
  return `${turns} turn${turns === 1 ? '' : 's'}, tokens: ${k(sum(r => r.usage?.input_tokens))} input${cached ? `, ${k(cached)} cache read` : ''}, ${k(sum(r => r.usage?.output_tokens))} output`
}

// The worker's report: the answer of each turn of its run (a message it took after an answer starts another turn);
// `subtype` reads "success" even on API errors, so check the rest. A result is the turn's last message, empty when a
// thinking block came after the answer (Gemini through OpenRouter): then its last text is the answer.
export function readResult(events, stderr) {
  if (!events.some(ev => ev.type === 'result')) throw new Error(`the worker ended without a result. ${stderr.trim().slice(-500)}`.trim())
  const texts = []
  let said = ''
  for (const ev of events) {
    const text = ev.type === 'assistant' ? (ev.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('') : ''
    if (text.trim()) said = text
    if (ev.type !== 'result') continue
    if (ev.is_error || ev.terminal_reason !== 'completed') {
      throw new Error(`the model failed: ${String(ev.result ?? '').trim() || stderr.trim().slice(-500) || ev.terminal_reason}`)
    }
    texts.push(answerText(ev.result) || answerText(said))
    said = ''
  }
  const text = texts.filter(Boolean).join('\n\n')
  if (text === '') throw new Error('the model returned an empty answer')
  return text
}

// /anymodel check's report: one line per agent, its steps in order, each with how long it took or why it failed.
export function checkReport(results) {
  const width = Math.max(...results.map(r => r.name.length))
  return results.map(r => `${r.name.padEnd(width)}  ${r.steps.map(s => (s.error === undefined ? `${s.step} ok (${s.ms} ms)` : `${s.step} FAILED: ${s.error}`)).join(', ')}`).join('\n')
}

// The tool call /anymodel check asks the model for: a model that cannot call tools cannot run Claude Code.
export const CHECK_TOOL = { name: 'report_ok', description: 'Report that the check worked.', input_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }
// Asked as Claude Code asks, with no forced tool_choice; room for a model that reasons before it calls.
export const checkBody = model => JSON.stringify({
  model, max_tokens: 4096, tools: [CHECK_TOOL],
  messages: [{ role: 'user', content: 'Call the report_ok tool with ok set to true. Do not reply with text.' }],
})
// Why a /v1/messages answer is not a call of CHECK_TOOL, or undefined when it is.
export function checkAnswer(status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return `HTTP ${status}, not JSON: ${text.slice(0, 200)}`
  }
  if (status !== 200) return `HTTP ${status}: ${String(body?.error?.message ?? text).slice(0, 300)}`
  return body?.content?.some(b => b.type === 'tool_use' && b.name === CHECK_TOOL.name) ? undefined : `no ${CHECK_TOOL.name} tool call in the answer (stop_reason ${body?.stop_reason})`
}

// The commands /anymodel cleanup runs, each printing what it removes: worker session records and worker transcripts
// older than `days`, never the current main session's; run directories a killed main left, never one whose worker
// (its pid file, bridge.sh) still runs, in any session. The agents/ marks stay: without its mark a renamed agent's
// resume could run on Claude.
export function cleanupCommands(dataDir, tmpDir, sessionId, days) {
  const old = ['-type', 'f', '-mtime', `+${days}`]
  return [
    ['/usr/bin/find', `${dataDir}/sessions`, ...old, '!', '-name', `${sessionId}-*`, '-print', '-delete'],
    ['/usr/bin/find', `${dataDir}/config/projects`, ...old, '-print', '-delete'],
    ['/bin/sh', '-c', 'for d in "$1"/run-*; do [ -f "$d/pid" ] || continue; kill -0 "$(cat "$d/pid")" 2>/dev/null && continue; echo "$d"; rm -rf "$d"; done', 'sh', tmpDir],
  ]
}
