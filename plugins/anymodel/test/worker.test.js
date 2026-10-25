// usage: node --test plugins/anymodel/test/*.test.js
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  agentList, agentSpec, agentsConfig, answerIn, answeredAsks, asks, checkAnswer, checkBody, checkReport, cleanupCommands, commandArgs, contextFrom, contextText,
  errorLine, formKeys, freshAsks, handbackRequired, interruptLine, mcpServers, NETWORK_VARS, permissionAnswer, permissionAsk, permissionSettings,
  readContext, guarded, localHost, readResult, redact, removeAgent, responseLine, resultLine, resumable, saveAgent, sessionOf, sessionRecord, takeEvents, taskText, toolLine, usageLine, userLine, WITHHELD_TOOLS,
  workerArgv,
} from '../hooks/worker.js'

// The agents as anymodel keeps them ($.store "agents"), and the keys of their servers, as the settings form's API key
// field holds them once anymodel wrote them back.
const saved = {
  jimmy3: { url: 'https://openrouter.ai/api', model: 'moonshotai/kimi-k3' },
  olga3: { url: 'https://api.moonshot.ai/anthropic', model: 'kimi-k3', context: 262144 },
  gem: { url: 'http://127.0.0.1:1234', model: 'gemma-4-26b-a4b-it-mlx' },
  q: { url: 'http://127.0.0.1:1234', model: 'qwen2.5-7b-instruct@q4_k_m', context: 49152 },
}
const keys = { 'https://openrouter.ai/api': 'sk-or-secret', 'https://api.moonshot.ai/anthropic': 'sk-moon=secret' }
const config = agentsConfig(saved, keys)
const gem = config.agents.get('gem')
const jimmy3 = config.agents.get('jimmy3')
// The settings form as register() gets it: an unset field is "".
const form = (agent, url = '', model = '', context = '') => ({ agent, url, model, context })

test('agentsConfig ties each saved agent to its server, model, key and context size', () => {
  assert.deepEqual(config.errors, [])
  assert.deepEqual(config.names, ['jimmy3', 'olga3', 'gem', 'q'])
  assert.deepEqual(jimmy3, { name: 'jimmy3', provider: 'openrouter.ai', baseUrl: 'https://openrouter.ai/api', model: 'moonshotai/kimi-k3', apiKey: 'sk-or-secret', contextSize: undefined })
  assert.deepEqual(config.agents.get('olga3'), { name: 'olga3', provider: 'api.moonshot.ai', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k3', apiKey: 'sk-moon=secret', contextSize: 262144 })
  assert.equal(gem.apiKey, undefined)
  assert.deepEqual(config.secrets, ['sk-or-secret', 'sk-moon=secret'])
  assert.deepEqual(agentsConfig({}, {}), { names: [], agents: new Map(), errors: [], problems: new Map(), secrets: [] })
})

test('agentsConfig still registers a saved agent that no longer holds, so calling it answers its problem', () => {
  const c = agentsConfig({ ok: saved.gem, nourl: { model: 'm' }, junk: 5, check: saved.gem, tiny: { ...saved.gem, context: 8 }, plain: { url: 'http://api.example.com', model: 'm' } }, { 'http://api.example.com': 'sk-1' })
  assert.deepEqual(c.names, ['ok', 'nourl', 'junk', 'check', 'tiny', 'plain'])
  assert.deepEqual([...c.agents.keys()], ['ok'])
  assert.deepEqual(c.problems.get('ok'), [])
  assert.deepEqual(c.errors, [
    'nourl: the server URL must start with http:// or https://',
    'junk: its saved settings are unreadable',
    'check: "check" is taken by /anymodel check',
    "tiny: the context size must be 49152 to 10000000 tokens (an agent's its own prompt takes about 13k and Claude Code keeps about 33k free for compaction)",
    'plain: http://api.example.com is plain http:// on another network, so its key would cross it unencrypted: use https://',
  ])
})

test('formKeys reads the keys anymodel wrote back, or a key typed over them', () => {
  assert.deepEqual(formKeys(JSON.stringify(keys), undefined), { keys })
  assert.deepEqual(formKeys('', undefined), { keys: {} })
  assert.deepEqual(formKeys(undefined, keys), { keys })
  // The dialog saves the field whole: a typed key replaces the keys there, which the session still holds.
  assert.deepEqual(formKeys(' sk-new ', keys), { keys, typed: 'sk-new' })
  // Right after anymodel's own write the field can still read as the key typed before it: that is no new key.
  assert.deepEqual(formKeys('sk-or-secret', keys), { keys })
  // A key that happens to be JSON, but no keys object, is a typed key.
  assert.deepEqual(formKeys('["a"]', {}), { keys: {}, typed: '["a"]' })
})

test('saveAgent adds the agent the form names, or updates it with the fields filled in', () => {
  const added = saveAgent(form('kimi', 'https://openrouter.ai/api/v1/', 'moonshotai/kimi-k3'), {}, {}, 'sk-or-1')
  // An OpenAI-style base URL ends in /v1: the worker adds /v1/messages, so it goes.
  assert.deepEqual(added, { agents: { kimi: { url: 'https://openrouter.ai/api', model: 'moonshotai/kimi-k3' } }, keys: { 'https://openrouter.ai/api': 'sk-or-1' } })
  // An agent on a server another one uses shares its key.
  const two = saveAgent(form('k2', 'https://openrouter.ai/api', 'deepseek/deepseek-v4', '131072'), added.agents, added.keys)
  assert.deepEqual(two.agents.k2, { url: 'https://openrouter.ai/api', model: 'deepseek/deepseek-v4', context: 131072 })
  assert.deepEqual(two.keys, added.keys)
  // A blank field keeps the agent's own.
  assert.deepEqual(saveAgent(form('k2', '', 'deepseek/deepseek-v4-flash'), two.agents, two.keys).agents.k2, { url: 'https://openrouter.ai/api', model: 'deepseek/deepseek-v4-flash', context: 131072 })
  // A key typed for an agent becomes its server's key, for every agent there.
  assert.deepEqual(saveAgent(form('kimi'), two.agents, two.keys, 'sk-or-2').keys, { 'https://openrouter.ai/api': 'sk-or-2' })
  // A server's key goes once no agent uses the server.
  assert.deepEqual(saveAgent(form('kimi', 'http://127.0.0.1:8888/v1'), added.agents, added.keys), { agents: { kimi: { url: 'http://127.0.0.1:8888', model: 'moonshotai/kimi-k3' } }, keys: {} })
})

test('saveAgent refuses what an agent cannot run with, and never quotes the key', () => {
  assert.deepEqual(saveAgent(form('new', 'https://x'), {}, {}), { error: 'new is a new agent: give its server URL and model' })
  assert.deepEqual(saveAgent(form('a b', 'https://x', 'm'), {}, {}), { error: '"a b" is not a name: letters, digits, _ and -, up to 64' })
  assert.deepEqual(saveAgent(form('remove', 'https://x', 'm'), {}, {}), { error: '"remove" is taken by /anymodel remove' })
  assert.deepEqual(saveAgent(form('a', 'ftp://x', 'm'), {}, {}), { error: 'the server URL must start with http:// or https://' })
  assert.deepEqual(saveAgent(form('a', 'https://x', 'm', 'lots'), {}, {}), { error: 'the context size is a number of tokens, not "lots"' })
  assert.deepEqual(saveAgent(form('a', 'https://x', 'm', '8'), {}, {}), { error: "the context size must be 49152 to 10000000 tokens (an agent's its own prompt takes about 13k and Claude Code keeps about 33k free for compaction)" })
  const refused = saveAgent(form('a', 'http://api.example.com', 'm'), {}, {}, 'sk-or-v1-0123456789abcdef')
  assert.deepEqual(refused, { error: 'http://api.example.com is plain http:// on another network, so its key would cross it unencrypted: use https://' })
})

test('saveAgent sends a key over plain http only within this machine or a private network', () => {
  const local = ['http://127.0.0.1:8888', 'http://localhost:1234', 'http://192.168.1.20:8080', 'http://10.0.0.5', 'http://172.20.0.2:1', 'http://gpu.local:8000', 'http://[::1]:8888', 'http://[fd12:3456::1]:8000', 'http://[fe80::1]', 'https://api.example.com']
  for (const url of local) assert.equal(saveAgent(form('a', url, 'm'), {}, {}, 'sk-1').error, undefined, url)
  // The host as the request would reach it, not text that only looks local.
  for (const url of ['http://api.example.com', 'http://8.8.8.8:80', 'http://172.32.0.1', 'http://api.example.com?.local', 'http://evil.com#.local', 'http://127.0.0.1.nip.io', 'http://[fc::1]', 'http://[fcd::1]', 'http://[2001:db8::1]']) {
    assert.match(saveAgent(form('a', url, 'm'), {}, {}, 'sk-1').error, /is plain http:\/\/ on another network/, url)
  }
  // Without a key, plain http anywhere is the user's call.
  assert.equal(saveAgent(form('a', 'http://api.example.com', 'm'), {}, {}).error, undefined)
})

test('removeAgent drops the agent, and its server key once no agent uses that server', () => {
  const two = { kimi: { url: 'https://openrouter.ai/api', model: 'm' }, k2: { url: 'https://openrouter.ai/api', model: 'n' } }
  const k = { 'https://openrouter.ai/api': 'sk-or-1' }
  assert.deepEqual(removeAgent('kimi', two, k), { agents: { k2: two.k2 }, keys: k })
  assert.deepEqual(removeAgent('k2', { k2: two.k2 }, k), { agents: {}, keys: {} })
})

test('redact replaces every configured key where it stands as a token of its own', () => {
  assert.equal(redact('Invalid API key: sk-or-secret (sk-or-secret)', config.secrets), 'Invalid API key: <key> (<key>)')
  assert.equal(redact('fine', []), 'fine')
  // A short key is masked too, but not inside a longer word.
  const short = agentsConfig({ a: { url: 'http://127.0.0.1:1234', model: 'm' } }, { 'http://127.0.0.1:1234': 'local' })
  assert.deepEqual(short.secrets, ['local'])
  assert.equal(redact('http://localhost:1234 refused key "local" (local_key, local-1)', short.secrets), 'http://localhost:1234 refused key "<key>" (local_key, local-1)')
  // A key with regex characters is matched as text.
  assert.equal(redact('bad key a.b+c, not axb+c', ['a.b+c']), 'bad key <key>, not axb+c')
  // A key of 8 or more characters is masked inside a longer token too.
  assert.equal(redact('credential="prefix-sk-or-secret-suffix"', config.secrets), 'credential="prefix-<key>-suffix"')
  // A key inside another key, or overlapping it, never leaves part of either shown, whatever the order of the keys.
  for (const keys of [['abcdefgh', 'abcdefgh-SECRETTAIL'], ['abcdefgh-SECRETTAIL', 'abcdefgh']]) assert.equal(redact('credential=abcdefgh-SECRETTAIL', keys), 'credential=<key>')
  for (const keys of [['local', 'prefix.local.SECRETTAIL'], ['prefix.local.SECRETTAIL', 'local']]) assert.equal(redact('x prefix.local.SECRETTAIL y', keys), 'x <key> y')
  assert.equal(redact('k=abcdXYZW1234efgh', ['abcdXYZW1234', 'XYZW1234efgh']), 'k=<key>')
  // A key that overlaps itself in the text leaves no fragment either.
  assert.equal(redact('k=ababababab', ['abababab']), 'k=<key>')
})

test('contextFrom reads the loaded context of LM Studio, else the model window OpenRouter or vLLM lists', () => {
  const lmstudio = JSON.stringify({ data: [{ id: 'gemma', state: 'loaded', loaded_context_length: 131072, max_context_length: 262144 }, { id: 'cold', state: 'not-loaded', max_context_length: 262144 }] })
  assert.equal(contextFrom(lmstudio, 'gemma'), 131072)
  // An unloaded LM Studio model would be loaded at its own default, not its maximum.
  assert.equal(contextFrom(lmstudio, 'cold'), undefined)
  assert.equal(contextFrom(JSON.stringify({ data: [{ id: 'moonshotai/kimi-k3', context_length: 1048576 }] }), 'moonshotai/kimi-k3'), 1048576)
  assert.equal(contextFrom(JSON.stringify({ data: [{ id: 'qwen', max_model_len: 65536 }] }), 'qwen'), 65536)
  assert.equal(contextFrom(JSON.stringify({ data: [{ id: 'other', context_length: 5 }] }), 'qwen'), undefined)
  assert.equal(contextFrom('<html>not json</html>', 'qwen'), undefined)
  // An OpenRouter variant (:nitro, :free) has the window of its model.
  assert.equal(contextFrom(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-flash', context_length: 1048576 }] }), 'deepseek/deepseek-v4-flash:nitro'), 1048576)
  // llama-server's /props: the window each slot is loaded with, only for the model it serves; its /v1/models has only
  // the training window (n_ctx_train), which is not the one loaded.
  const props = JSON.stringify({ default_generation_settings: { n_ctx: 65536 }, model_alias: 'qwen', model_path: '/m/qwen.gguf' })
  assert.equal(contextFrom(props, 'qwen'), 65536)
  assert.equal(contextFrom(props, '/m/qwen.gguf'), 65536)
  assert.equal(contextFrom(props, 'other'), undefined)
  assert.equal(contextFrom(JSON.stringify({ data: [{ id: 'qwen', meta: { n_ctx_train: 262144 } }] }), 'qwen'), undefined)
})

test('readContext tries LM Studio, then the OpenAI-style list, and says what each answered', async () => {
  const replies = { 'http://h/api/v0/models': { ok: false, status: 404, text: '' }, 'http://h/v1/models': { ok: true, status: 200, text: JSON.stringify({ data: [{ id: 'm', context_length: 65536 }, { id: 'tiny', context_length: 4096 }] }) }, 'http://h/props': { ok: false, status: 404, text: '' } }
  const fetch = async url => replies[url]
  assert.deepEqual(await readContext(fetch, { provider: 'p', baseUrl: 'http://h', model: 'm' }), { size: 65536, source: 'read from p' })
  await assert.rejects(readContext(fetch, { baseUrl: 'http://h', model: 'other' }),
    /cannot read the context size of other from http:\/\/h \(\/api\/v0\/models: HTTP 404, \/v1\/models: not listed \(it lists m, tiny\), \/props: HTTP 404\): check the model id, load the model \(LM Studio\), or set its Context size in \/plugin configure anymodel/)
  await assert.rejects(readContext(async () => { throw new Error('ECONNREFUSED') }, { provider: 'lmstudio', baseUrl: 'http://h', model: 'm' }),
    /^Error: cannot reach http:\/\/h \(\/api\/v0\/models: ECONNREFUSED, \/v1\/models: ECONNREFUSED, \/props: ECONNREFUSED\): is its server running\?$/)
  // A model id the provider does not list: what it lists instead.
  await assert.rejects(readContext(fetch, { baseUrl: 'http://h', model: 'gemma' }), /\/v1\/models: not listed \(it lists m, tiny\), \/props: HTTP 404\): check the model id/)
  // A window read from the provider must hold the worker's own prompt too, as one set with @ must.
  await assert.rejects(readContext(fetch, { baseUrl: 'http://h', model: 'tiny' }), /tiny at http:\/\/h has a context of 4096 tokens, under the 49152 an agent needs/)
})

test('readContext sends the provider key in both headers, only when there is one', async () => {
  const seen = []
  const fetch = async (url, init) => (seen.push(init?.headers), { ok: true, status: 200, text: JSON.stringify({ data: [{ id: 'm', context_length: 262144 }] }) })
  assert.equal((await readContext(fetch, { baseUrl: 'http://h', model: 'm', apiKey: 'sk-1' })).size, 262144)
  assert.deepEqual(seen, [{ authorization: 'Bearer sk-1', 'x-api-key': 'sk-1' }])
  seen.length = 0
  await readContext(fetch, { baseUrl: 'http://h', model: 'm' })
  assert.deepEqual(seen, [{}])
})

test('readContext: the window the server reports wins over @, which counts only when the server reports none', async () => {
  const listing = text => async url => (url.endsWith('/v1/models') ? { ok: true, status: 200, text } : { ok: false, status: 404, text: '' })
  const agent = { provider: 'p', baseUrl: 'http://h', model: 'm', contextSize: 131072 }
  const reports = listing(JSON.stringify({ data: [{ id: 'm', context_length: 262144 }] }))
  assert.deepEqual(await readContext(reports, agent), { size: 262144, source: 'read from p', ignored: 131072 })
  assert.deepEqual(await readContext(reports, { ...agent, contextSize: 262144 }), { size: 262144, source: 'read from p' })
  assert.deepEqual(await readContext(listing(JSON.stringify({ data: [{ id: 'm' }] })), agent), { size: 131072, source: 'set in the settings' })
  // A server that does not answer is no reason to trust @: the run would fail there anyway.
  await assert.rejects(readContext(async () => { throw new Error('ECONNREFUSED') }, agent), /^Error: cannot reach http:\/\/h \(/)
  // A window too small for the worker's own prompt is refused, whatever @ says.
  await assert.rejects(readContext(listing(JSON.stringify({ data: [{ id: 'm', context_length: 4096 }] })), agent), /has a context of 4096 tokens/)
  // llama-server reports its window only in /props.
  const llama = async url => url.endsWith('/props') ? { ok: true, status: 200, text: JSON.stringify({ default_generation_settings: { n_ctx: 65536 }, model_alias: 'm' }) }
    : url.endsWith('/v1/models') ? { ok: true, status: 200, text: JSON.stringify({ data: [{ id: 'm', meta: { n_ctx_train: 262144 } }] }) } : { ok: false, status: 404, text: '' }
  assert.deepEqual(await readContext(llama, { provider: 'p', baseUrl: 'http://h', model: 'm' }), { size: 65536, source: 'read from p' })
})

test('localHost tells a provider on this machine or a private network from a remote one', () => {
  for (const url of ['http://127.0.0.1:8888', 'http://localhost:1234', 'http://192.168.1.5:8000', 'http://box.lan:8000']) assert.equal(localHost(url), true, url)
  for (const url of ['https://openrouter.ai/api', 'https://api.moonshot.ai/anthropic', 'not a url']) assert.equal(localHost(url), false, url)
})

test('commandArgs splits /anymodel arguments into the agent and its task, keeping the task as typed', () => {
  assert.deepEqual(commandArgs('jimmy3 review src/auth\n  and the tests '), { name: 'jimmy3', task: 'review src/auth\n  and the tests' })
  assert.deepEqual(commandArgs('  gem'), { name: 'gem', task: '' })
  assert.deepEqual(commandArgs('   '), { name: '', task: '' })
})

test('guarded tells a definition whose model only anymodel serves', () => {
  assert.equal(guarded('---\nname: r\nmodel: anymodel\n---\nYou review.\n'), true)
  assert.equal(guarded('---\nname: r\nmodel: "anymodel"\n---\n'), true)
  assert.equal(guarded('---\nname: r\nmodel: sonnet\n---\nmodel: anymodel\n'), false)
  assert.equal(guarded('---\nname: r\n---\nYou review.\n'), false)
})

test('agentList shows each agent with its model, server, context and key, never the key itself', () => {
  const contexts = new Map([['olga3', { size: 262144, source: 'set in the settings' }], ['gem', { size: 131072, source: 'read from 127.0.0.1:1234' }], ['q', { error: 'cannot read it' }]])
  assert.equal(agentList(config, contexts), [
    'jimmy3  moonshotai/kimi-k3 at https://openrouter.ai/api, context being read from the provider, key set',
    'olga3   kimi-k3 at https://api.moonshot.ai/anthropic, context 262144 (set in the settings), key set',
    'gem     gemma-4-26b-a4b-it-mlx at http://127.0.0.1:1234, context 131072 (read from 127.0.0.1:1234), no key',
    'q       qwen2.5-7b-instruct@q4_k_m at http://127.0.0.1:1234, context unknown: cannot read it, no key',
    '',
    'Run one: /anymodel <agent> <task>. Test them: /anymodel check [agent]. Add one: /plugin configure anymodel. Change one: /plugin configure anymodel <agent>. Remove one: /anymodel remove <agent>',
  ].join('\n'))
  assert.ok(!agentList(config, contexts).includes('sk-'))
  // An agent that runs as a Claude Code agent definition says which, and how to keep the definition off Claude.
  const listed = agentList(config, contexts, new Map([['gem', { file: '.claude/agents/gem.md', guarded: true }], ['q', { file: 'q.md', guarded: false }]]))
  assert.match(listed, /^gem {5}gemma-4-26b-a4b-it-mlx at .*, no key, runs as \.claude\/agents\/gem\.md$/m)
  assert.match(listed, /^q {7}.*, runs as q\.md \(without model: anymodel in it, it runs on Claude when anymodel is off\)$/m)
  assert.equal(contextText(undefined), 'context being read from the provider')
  assert.equal(contextText({ size: 262144, source: 'read from 127.0.0.1:8888', ignored: 131072 }), 'context 262144 (read from 127.0.0.1:8888; 131072 in the settings ignored)')
  assert.match(agentList(agentsConfig({}, {}), new Map()), /^No agents yet: add them with \/plugin configure anymodel/)
  const broken = agentsConfig({ a: { url: 'nowhere', model: 'm' }, b: { url: 'http://x', model: 'm', context: 50000 } }, {})
  assert.equal(agentList(broken, new Map()), [
    'a  needs fixing (below)',
    'b  m at http://x, context being read from the provider, no key',
    '',
    'Run one: /anymodel <agent> <task>. Test them: /anymodel check [agent]. Add one: /plugin configure anymodel. Change one: /plugin configure anymodel <agent>. Remove one: /anymodel remove <agent>',
    '',
    'These agents need fixing: save them again in /plugin configure anymodel, or /anymodel remove them:',
    '- a: the server URL must start with http:// or https://',
  ].join('\n'))
})

test('agentSpec names the model and provider first, runs on that model, and falls back to a stub that runs nothing', () => {
  const spec = agentSpec('jimmy3', jimmy3)
  assert.equal(spec.name, 'jimmy3')
  assert.match(spec.description, /^moonshotai\/kimi-k3 via openrouter\.ai \(not a Claude model\): /)
  // It sits in main's agent listing on every request, once per agent.
  assert.ok(spec.description.length < 400, spec.description.length)
  assert.match(spec.description, /"jimmy3"/)
  assert.deepEqual(spec.tools, ['SendMessage'])
  // The agent view names its model; a step that reached the session's backend fails on a model it does not have.
  assert.equal(spec.model, 'moonshotai/kimi-k3')
  assert.match(spec.prompt, /Do not do the task and do not call any tool/)
  assert.match(agentSpec('b', undefined).description, /settings need fixing/)
  assert.equal(agentSpec('b', undefined).model, 'haiku')
})

// Main's values of NETWORK_VARS; it has none of them set.
const host = {}
const mainSettings = { permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' }, sandbox: { enabled: true } }
const run = {
  claude: '/opt/node/bin/claude', dataDir: '/data', tmpDir: '/tmp/anymodel-501', backend: { ...gem, contextSize: 131072 }, hasKey: false, mode: 'default',
  permissions: permissionSettings(mainSettings, { rules: [], directories: [] }), session: [], host,
}

test('workerArgv starts a full Claude Code in main environment, pointed only at the agent backend', () => {
  const argv = workerArgv(run)
  // Main's environment as a subagent has it (bridge.sh drops main's Claude Code variables), these over it.
  assert.equal(argv[0], '/usr/bin/env')
  const env = argv.slice(1, argv.indexOf('/opt/node/bin/claude'))
  assert.ok(env.every(kv => /^[A-Za-z_]+=/.test(kv)))
  assert.ok(!env.some(kv => /^(PATH|HOME|SHELL|USER|LANG)=/.test(kv)))
  // A server that needs no key gets the placeholder as x-api-key, never as a bearer (Unsloth Studio rejects that).
  for (const kv of ['ANTHROPIC_BASE_URL=http://127.0.0.1:1234', 'ANTHROPIC_API_KEY=local', 'ANTHROPIC_AUTH_TOKEN=',
    // One process, one backend: every alias inside the worker names its model.
    'ANTHROPIC_MODEL=gemma-4-26b-a4b-it-mlx', 'ANTHROPIC_DEFAULT_HAIKU_MODEL=gemma-4-26b-a4b-it-mlx', 'ANTHROPIC_DEFAULT_SONNET_MODEL=gemma-4-26b-a4b-it-mlx', 'ANTHROPIC_DEFAULT_OPUS_MODEL=gemma-4-26b-a4b-it-mlx',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS=131072', 'HTTPS_PROXY=', 'CLAUDE_CODE_TMPDIR=/tmp/anymodel-501', 'CLAUDE_CONFIG_DIR=/data/config',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1']) assert.ok(env.includes(kv), kv)
  // No key on fd 4 for a server that needs none; and no retry or timeout of our own: the native defaults apply.
  assert.ok(!env.some(kv => /^(CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_MAX_RETRIES|API_TIMEOUT_MS)=/.test(kv)))
  assert.ok(!argv.includes('--bare'))
  assert.ok(argv.includes('--setting-sources=project,local'))
  for (const [flag, value] of [['--input-format', 'stream-json'], ['--output-format', 'stream-json'], ['--permission-prompt-tool', 'stdio'], ['--permission-mode', 'default'], ['--disallowedTools', WITHHELD_TOOLS.join(',')]]) {
    assert.equal(argv[argv.indexOf(flag) + 1], value, flag)
  }
  assert.ok(argv.includes('--replay-user-messages'))
  // No tool list of its own: the worker has every tool a subagent has, less WITHHELD_TOOLS.
  assert.ok(!argv.includes('--tools'))
  assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--mcp-config'))
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
  // CLI settings outrank the project's env: nothing there can send the requests, or other credentials, elsewhere.
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234')
  for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: 'local', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })) {
    assert.equal(settings.env[k], v, k)
  }
  // Main's rules and sandbox, never its default mode: the mode comes in --permission-mode.
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'], ask: [], additionalDirectories: [] })
  assert.deepEqual(settings.sandbox, { enabled: true })
  assert.ok(!('apiKeyHelper' in settings))
})

test('workerArgv runs in main permission mode as it is, resumes a session, and takes main MCP servers from a file', () => {
  for (const mode of ['acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk']) {
    const argv = workerArgv({ ...run, mode })
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], mode)
  }
  const argv = workerArgv({ ...run, mcpConfig: '/tmp/anymodel-501/run-a/mcp.json', session: ['--resume', 'abc'] })
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], '/tmp/anymodel-501/run-a/mcp.json')
  assert.deepEqual(argv.slice(-2), ['--resume', 'abc'])
})

test('workerArgv runs the worker as a Claude Code agent definition only when one is named', () => {
  const as = workerArgv({ ...run, asAgent: 'reviewer' })
  assert.equal(as[as.indexOf('--agent') + 1], 'reviewer')
  // Only the agent's model: a definition's own (model: anymodel) gives way to it.
  assert.deepEqual(JSON.parse(as[as.indexOf('--settings') + 1]).availableModels, [run.backend.model])
  assert.equal(workerArgv(run).includes('--agent'), false)
})

test('workerArgv takes a provider key on fd 4 only, never in argv or env', () => {
  const argv = workerArgv({ ...run, backend: { ...jimmy3, contextSize: 1048576 }, hasKey: true })
  assert.ok(!argv.some(a => a.includes('sk-or')))
  assert.ok(argv.includes('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=4'))
  assert.ok(argv.includes('ANTHROPIC_API_KEY='))
  assert.ok(argv.includes('ANTHROPIC_AUTH_TOKEN='))
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, '')
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
  assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576')
  // Inside the worker every alias names its own model.
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'moonshotai/kimi-k3')
})

test('workerArgv pins where requests go and whom they trust to main values, and request logs off, against the project', () => {
  const argv = workerArgv({ ...run, host: { https_proxy: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', ANTHROPIC_UNIX_SOCKET: '/main.sock', BUN_CONFIG_VERBOSE_FETCH: 'curl' } })
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
  assert.equal(settings.env.https_proxy, 'http://proxy:3128')
  assert.equal(settings.env.NODE_EXTRA_CA_CERTS, '/etc/ca.pem')
  assert.ok(argv.includes('https_proxy=http://proxy:3128'))
  // Unset in main, still pinned: a project's settings cannot set them.
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy', 'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'CLAUDE_CODE_CLIENT_CERT']) {
    assert.equal(settings.env[k], '', k)
  }
  assert.ok(NETWORK_VARS.every(k => k in settings.env))
  // Never main's: its socket would take the worker's requests to main's backend, a fetch log would hold the key.
  for (const k of ['ANTHROPIC_UNIX_SOCKET', 'ANTHROPIC_LOG', 'BUN_CONFIG_VERBOSE_FETCH', 'NODE_DEBUG']) assert.equal(settings.env[k], '', k)
})

test('bridge.sh starts the worker in main environment less its Claude Code variables, the key on fd 4 only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anymodel-bridge-'))
  try {
    execFileSync('/usr/bin/mkfifo', [join(dir, 'in'), join(dir, 'key')])
    const out = execFileSync('/bin/sh', [new URL('../hooks/bridge.sh', import.meta.url).pathname, dir, '/bin/sh', '-c', 'env; echo "fd4=$(cat <&4)"'], {
      input: 'sk-test\n{"type":"user"}\n',
      env: { PATH: process.env.PATH, KEEP: 'yes', ANTHROPIC_API_KEY: 'main-key', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: 'main-token', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/main' },
    }).toString()
    assert.match(out, /^KEEP=yes$/m)
    assert.doesNotMatch(out, /^(ANTHROPIC|CLAUDE)/m)
    assert.match(out, /^fd4=sk-test$/m)
    assert.doesNotMatch(out.replace(/^fd4=.*$/m, ''), /sk-test/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('permissionSettings passes main permission settings but its default mode, with the session grants, and no sandbox main has none of', () => {
  const p = permissionSettings({ permissions: { allow: ['Read'], additionalDirectories: ['/x'], defaultMode: 'plan', disableBypassPermissionsMode: 'disable' } }, { rules: ['Bash(ls:*)'], directories: ['/y'] })
  assert.deepEqual(p, { permissions: { disableBypassPermissionsMode: 'disable', allow: ['Read', 'Bash(ls:*)'], deny: [], ask: [], additionalDirectories: ['/x', '/y'] } })
  assert.deepEqual(permissionSettings(undefined, { rules: [], directories: [] }).permissions.allow, [])
})

test('the worker stream-json lines: a message with its uuid, a control response, an interrupt', () => {
  assert.deepEqual(JSON.parse(userLine('hi', 'u1')), { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, session_id: '' })
  assert.deepEqual(JSON.parse(responseLine('r1', { behavior: 'allow' })), { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow' } } })
  assert.deepEqual(JSON.parse(interruptLine('i1')), { type: 'control_request', request_id: 'i1', request: { subtype: 'interrupt', cancel_queued: true } })
  assert.deepEqual(JSON.parse(errorLine('r2', 'no')), { type: 'control_response', response: { subtype: 'error', request_id: 'r2', error: 'no' } })
  assert.ok(!userLine('a\nb', 'u').includes('\n'))
})

test('takeEvents reads whole lines and keeps a cut one for the next piece', () => {
  assert.deepEqual(takeEvents('{"a":1}\nnoise\n{"b":'), { events: [{ a: 1 }], rest: '{"b":' })
  assert.deepEqual(takeEvents('{"b":'), { events: [], rest: '{"b":' })
})

test('resultLine shows a tool result by its first line of output, cut to one short line', () => {
  assert.equal(resultLine({ type: 'tool_result', content: '\n  41 statement.csv\nmore' }), '⎿ 41 statement.csv')
  assert.equal(resultLine({ type: 'tool_result', content: [{ type: 'text', text: 'first-done' }] }), '⎿ first-done')
  assert.equal(resultLine({ type: 'tool_result', content: '' }), '⎿ (no output)')
  assert.equal(resultLine({ type: 'tool_result', content: 'x'.repeat(200) }), `⎿ ${'x'.repeat(119)}…`)
})

test('toolLine shows a tool call by the argument a person reads first, cut to one short line', () => {
  assert.equal(toolLine('Bash', { command: 'npm\n test', description: 'run' }), 'Bash(npm test)')
  assert.equal(toolLine('Read', { file_path: '/a/b.js' }), 'Read(/a/b.js)')
  assert.equal(toolLine('TaskStop', {}), 'TaskStop')
  assert.equal(toolLine('Grep', { pattern: 'x'.repeat(300) }).length, 'Grep()'.length + 120)
  // A file in the project shows by its path in it, as Claude Code's own tool calls do; one outside it stays absolute.
  assert.equal(toolLine('Write', { file_path: '/w/src/a.test.ts' }, '/w'), 'Write(src/a.test.ts)')
  assert.equal(toolLine('Read', { file_path: '/wx/a.js' }, '/w'), 'Read(/wx/a.js)')
  assert.equal(toolLine('Bash', { command: '/w/run.sh' }, '/w'), 'Bash(/w/run.sh)')
})

const readOut = {
  tool_name: 'Read', display_name: 'Read', input: { file_path: '/p/../out.txt' }, tool_use_id: 't1', decision_reason: 'Path is outside allowed working directories',
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//p/**' }], behavior: 'allow', destination: 'session' }],
}
const bash = {
  tool_name: 'Bash', input: { command: 'make' }, tool_use_id: 't2',
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make' }], behavior: 'allow', destination: 'userSettings' }, { type: 'addDirectories', directories: ['/w'], destination: 'session' }],
}

test('permissionAsk asks as the permission dialog does, naming the agent, its model and what allowing again covers', () => {
  const asked = permissionAsk({ name: 'gem', model: 'gemma' }, readOut)
  assert.equal(asked.question, "gem (gemma) wants to use Read(/p/../out.txt) (Path is outside allowed working directories). Don't ask again allows Read(//p/**). Allow it?")
  assert.deepEqual(asked.options, ['Yes', "Yes, don't ask again", 'No'])
  assert.equal(asked.header, 'gem')
  assert.match(permissionAsk({ name: 'gem', model: 'm' }, { tool_name: 'Write', input: { file_path: '/w/src/a.ts' } }, '/w').question, /wants to use Write\(src\/a\.ts\)\. Allow it\?$/)
  assert.deepEqual(permissionAsk({ name: 'a-very-long-agent-name', model: 'm' }, { tool_name: 'Edit', input: {} }), { question: 'a-very-long-agent-name (m) wants to use Edit. Allow it?', options: ['Yes', 'No'], header: 'a-very-long-' })
})

test('permissionAnswer allows once, allows with the grants, or refuses with what the person said', () => {
  const asked = permissionAsk({ name: 'gem', model: 'm' }, bash)
  assert.deepEqual(permissionAnswer(bash, asked, 'Yes'), { response: { behavior: 'allow', updatedInput: { command: 'make' }, toolUseID: 't2' }, grants: { rules: [], directories: [] } })
  const again = permissionAnswer(bash, asked, "Yes, don't ask again")
  // A user-settings rule would land in the worker's own config: it goes to the project's local settings, which main reads.
  assert.deepEqual(again.response.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['/w'], destination: 'session' },
  ])
  // Session grants go to later workers too.
  assert.deepEqual(again.grants, { rules: [], directories: ['/w'] })
  assert.deepEqual(permissionAnswer(readOut, permissionAsk({ name: 'gem', model: 'm' }, readOut), "Yes, don't ask again").grants, { rules: ['Read(//p/**)'], directories: [] })
  assert.deepEqual(permissionAnswer(bash, asked, 'No').response, { behavior: 'deny', message: 'The user refused this tool use.', interrupt: false, toolUseID: 't2' })
  assert.equal(permissionAnswer(bash, asked, 'use gmake instead').response.message, 'The user refused this tool use and said: use gmake instead')
  // "Don't ask again" typed where it was not offered is just text.
  assert.equal(permissionAnswer({ tool_name: 'Edit', input: {} }, { options: ['Yes', 'No'] }, "Yes, don't ask again").response.behavior, 'deny')
})

test('mcpServers takes main servers by scope, a closer one winning, and only those main has tools from', () => {
  const user = { mcpServers: { a: { command: 'a-user' }, 'b.x': { command: 'b' }, off: { command: 'o' } }, projects: { '/p': { mcpServers: { a: { command: 'a-local' } } } } }
  const project = { mcpServers: { c: { command: 'c' }, unapproved: { command: 'u' } } }
  const tools = ['Read', 'mcp__a__t', 'mcp__b_x__t', 'mcp__c__t']
  assert.deepEqual(mcpServers(user, '/p', project, tools), { a: { command: 'a-local' }, 'b.x': { command: 'b' }, c: { command: 'c' } })
  assert.deepEqual(mcpServers(undefined, '/p', undefined, tools), {})
})

test('resumable resumes a worker session only on the backend it ran on', () => {
  const record = sessionRecord('s1', gem)
  assert.equal(resumable(record, gem), 's1')
  for (const moved of [{ ...gem, model: 'other' }, { ...gem, baseUrl: 'http://elsewhere' }]) assert.equal(resumable(record, moved), undefined)
  // The bare session id of 0.1.0, or anything else, starts a new worker.
  assert.equal(resumable('s1', gem), undefined)
})

test('checkAnswer passes a call of the check tool and names any other answer', () => {
  assert.equal(JSON.parse(checkBody('m')).model, 'm')
  assert.equal(checkAnswer(200, JSON.stringify({ content: [{ type: 'tool_use', name: 'report_ok', input: { ok: true } }] })), undefined)
  assert.equal(checkAnswer(200, JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })), 'no report_ok tool call in the answer (stop_reason end_turn)')
  assert.equal(checkAnswer(401, JSON.stringify({ error: { message: 'invalid key' } })), 'HTTP 401: invalid key')
  assert.equal(checkAnswer(502, '<html>'), 'HTTP 502, not JSON: <html>')
  assert.equal(checkReport([{ name: 'gem', steps: [{ step: 'reach', ms: 3 }, { step: 'tool call', error: 'HTTP 401: invalid key' }] }, { name: 'k', steps: [] }]),
    'gem  reach ok (3 ms), tool call FAILED: HTTP 401: invalid key\nk    ')
})

test('cleanupCommands keep the current session records and the agent marks', () => {
  const [sessions, transcripts, runs] = cleanupCommands('/data', '/tmp/anymodel-501', 'S1', 30)
  assert.deepEqual(sessions, ['/usr/bin/find', '/data/sessions', '-type', 'f', '-mtime', '+30', '!', '-name', 'S1-*', '-print', '-delete'])
  assert.equal(transcripts[1], '/data/config/projects')
  assert.deepEqual(runs.slice(-2), ['sh', '/tmp/anymodel-501'])
  assert.ok(!JSON.stringify([sessions, transcripts, runs]).includes('agents'))
})

test('taskText drops a message the engine repeats inside its own block, nothing else', () => {
  const msg = 'what is the largest debit?'
  const block = `The coordinator sent a message while you were working:\n${msg}\nAddress this before completing your current task.`
  assert.equal(taskText([{ text: `${msg}\n` }, { text: block }]), block)
  assert.equal(taskText([{ text: 'yes' }, { text: 'yes, and the max' }]), 'yes\n\nyes, and the max')
  assert.equal(taskText([{ text: 'sum it' }, { text: 'sum it' }]), 'sum it\n\nsum it')
})

const user = (...texts) => ({ role: 'user', content: texts.map(t => (typeof t === 'string' ? { type: 'text', text: t } : t)) })
const said = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
const handedBack = message => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message } }] })
const reminder = '<system-reminder>\nToday is a day.\n</system-reminder>'
const texts = blocks => blocks.map(b => b.text.trim())

test('asks drops the engine reminders and nudges', () => {
  const nudge = '[handback-send-enforce] Your report has not been delivered.'
  assert.deepEqual(texts(asks([user(reminder, 'sum it\n'), said('42'), user(nudge)])), ['sum it'])
})

test('freshAsks finds what the worker has not had, from the state or, without it, from the last answer', () => {
  const messages = [user(reminder, 'sum it'), handedBack('42'), user({ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, 'now the max')]
  assert.deepEqual(answeredAsks(messages), ['sum it'])
  for (const given of [['sum it'], answeredAsks(messages)]) assert.deepEqual(texts(freshAsks(messages, given)), ['now the max'])
  assert.deepEqual(freshAsks([user('sum it'), said('42')], ['sum it']), [])
  assert.deepEqual(answeredAsks([user('sum it')]), [])
})

test('freshAsks finds messages queued while the worker ran, wherever the engine filed them', () => {
  const q1 = 'The coordinator sent a message while you were working:\nAlso count the rows.'
  const q2 = 'The coordinator sent a message while you were working:\nAnd the max.'
  const first = [user(reminder, 'sum it', q1), said('42')]
  assert.deepEqual(texts(freshAsks(first, ['sum it'])), [q1])
  // q2 arrived during the run that answered q1: it sits alone before that answer.
  const second = [user(reminder, 'sum it', q1), said('42'), user(q2), said('37')]
  assert.deepEqual(texts(freshAsks(second, asks(first).map(b => b.text))), [q2])
  // Filing q1 after the task, the engine can end the task's block with a newline it did not have at the first run.
  assert.deepEqual(texts(freshAsks([user(reminder, 'sum it\n', q1), said('42')], ['sum it'])), [q1])
  // The same text sent twice is two messages.
  assert.deepEqual(texts(freshAsks([user('sum it'), said('42'), user('sum it')], ['sum it'])), ['sum it'])
})

test('answerIn reads text or a SubagentHandback report', () => {
  assert.equal(answerIn(said(' 7 ')), '7')
  assert.equal(answerIn(handedBack('7')), '7')
  assert.equal(answerIn({ role: 'assistant', content: [] }), '')
})

test('handbackRequired reads only the engine reminder, not the task', () => {
  const r = { type: 'text', text: '<system-reminder>\nYour final report is delivered through SubagentHandback: ...' }
  assert.equal(handbackRequired([{ role: 'user', content: [{ type: 'text', text: 'task' }, r] }]), true)
  assert.equal(handbackRequired([{ role: 'user', content: [{ type: 'text', text: 'Use SubagentHandback if possible' }] }]), false)
})

const events = text => takeEvents(`${text}\n`).events
const stream = result => events([
  { type: 'system', subtype: 'init', session_id: 's-1' },
  'not json',
  { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result },
].map(ev => (typeof ev === 'string' ? ev : JSON.stringify(ev))).join('\n'))

test('sessionOf reads the worker session from its init event', () => {
  assert.equal(sessionOf(stream('7')), 's-1')
  assert.equal(sessionOf([]), undefined)
})

test('readResult strips reasoning at the start, closed or not, and fails on errors that say success', () => {
  assert.equal(readResult(stream('<|channel>thought\n<channel|>7964.25'), ''), '7964.25')
  assert.equal(readResult(stream('<think>hmm</think>7964.25'), ''), '7964.25')
  assert.equal(readResult(stream('  <think>a</think><think>b</think>\n7964.25'), ''), '7964.25')
  assert.throws(() => readResult(stream('<|channel>thought cut off'), ''), /empty answer/)
  // A close with no opener before it: the chat template sent the opener, the reasoning is before it.
  assert.throws(() => readResult(stream('fine</think>7964.25'), ''), /set the server to return reasoning separately/)
  // A report may quote the tags.
  for (const report of ['Found 2 bugs. 1) parser drops <think> blocks. 2) off-by-one', 'Wrap it in <think>x</think> tags; <channel|> closes Gemma.']) {
    assert.equal(readResult(stream(report), ''), report)
  }
  const down = events(JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'API Error: Connection refused (ECONNREFUSED)' }))
  assert.throws(() => readResult(down, ''), /the model failed: API Error: Connection refused/)
  assert.throws(() => readResult([], 'killed'), /the worker ended without a result. killed/)
  // An error result without text (a --resume of a session that is gone) says what stderr said.
  const gone = events(JSON.stringify({ type: 'result', is_error: true }))
  assert.throws(() => readResult(gone, 'No conversation found with session ID: abc\n'), /the model failed: No conversation found/)
})

test('usageLine adds up the turns and tokens of a run', () => {
  const r = (turns, usage) => ({ type: 'result', num_turns: turns, usage })
  // As the provider counts them: some count cache reads in the input, some apart.
  assert.equal(usageLine([r(2, { input_tokens: 11470, cache_read_input_tokens: 11388, output_tokens: 346 }), r(1, { input_tokens: 900, output_tokens: 20 })]), '3 turns, tokens: 12.4k input, 11.4k cache read, 366 output')
  assert.equal(usageLine([r(1, undefined)]), '1 turn, tokens: 0 input, 0 output')
})

test('readResult takes the last answer text of a turn whose result is empty (a thinking block after it)', () => {
  const said = content => ({ type: 'assistant', message: { content } })
  const empty = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: '' }
  assert.equal(readResult([said([{ type: 'text', text: 'not this' }]), said([{ type: 'text', text: '40' }]), said([{ type: 'redacted_thinking' }]), empty], ''), '40')
  assert.throws(() => readResult([said([{ type: 'redacted_thinking' }]), empty], ''), /empty answer/)
})

test('readResult reports every turn of the run, as a message taken after an answer starts another', () => {
  const result = text => ({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: text })
  assert.equal(readResult([result('first'), result('<think>x</think>second')], ''), 'first\n\nsecond')
  assert.throws(() => readResult([result('first'), { type: 'result', is_error: true, terminal_reason: 'api_error', result: 'API Error: 500' }], ''), /the model failed: API Error: 500/)
})
