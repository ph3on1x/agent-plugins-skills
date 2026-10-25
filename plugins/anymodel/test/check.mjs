// Verdict for one run: what reached the recorder ("cloud"), what the facade did, and whether the answers are right.
// usage: node check.mjs <tag> [--expect <regex>]... [--expect-main <regex>]... [--locals <n>] [--others <n>]
//   --expect   must match a local subagent's report (numbers compared with thousands separators removed)
//   --expect-main  must match what main received from its agents (its Agent and SendMessage results, background task
//              notifications) or its final answer, the same way: the plugin's job ends at the delivered report, and a
//              weak local main can still misquote it
//   --error    must match the error text a local subagent answered with
//   --locals   minimum number of anymodel agents the facade answered
//   --resumes  minimum number of local subagents that ran again on a SendMessage (same agent id, a later task that
//              resumed the worker session)
//   --others   minimum number of other subagents whose requests reached the recorder
//   --mod-off  the mod is off: a plugin agent's request at the recorder is expected, not a leak
//   --canary-ok    the task asks for the canary row's text: it reaching main is expected
//   --task-model   a worker ran on this model (repeatable)
//   --task-name    a worker ran as this anymodel agent (repeatable)
//   --task-mode    every worker ran in this permission mode
//   --task-lacks   no task the facade sent a worker matches this regex
//   --worker-tool  some worker transcript has a call of this tool (repeatable)
//   --nested   some worker ran a subagent of its own
//   --wrec     logs/<tag>.wrec.jsonl (a recorder as the workers' base_url) saw requests, each with the agent's key as
//              x-api-key (the recorder's own upstream key) and no other credential or added header
//   --wrec-model   that recorder saw a request for this model (repeatable)
//   --sent     a task the user gave an agent directly (/anymodel), not through main (repeatable)
//   --max-main     at most this many model requests of main's own loop at the recorder
//   --notice   a notice in a local agent's own transcript (its worker's tool calls) matches this regex (repeatable)
import fs from 'node:fs'
import path from 'node:path'

const D = process.env.ANYMODEL_TEST_DIR || `${process.env.TMPDIR || '/tmp'}/anymodel-test`
const [tag, ...args] = process.argv.slice(2)
const opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []))
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const jsonl = (f) => read(f).split('\n').filter(Boolean).map(l => JSON.parse(l))
const fixture = read(path.join(import.meta.dirname, 'fixtures/statement.csv')).trim().split('\n').slice(1)

// The debug log writes a multi-line entry as one JSON string.
const debug = read(`${D}/logs/${tag}.debug.txt`).split('\n').map(l => l.replace(/^\S+ \[\w+\] /, '')).map(l => (l.startsWith('"') ? JSON.parse(l) : l))
const mod = (re) => debug.map(l => l.match(re)).filter(Boolean)
const locals = [...new Set(mod(/anymodel: step agent=(\S+) type=\S+ name=(?!-\s)\S+/).map(m => m[1]))]
const firstSteps = mod(/anymodel: step agent=(\S+) type=\S+ name=(?!-\s)\S+ index=0 /).map(m => m[1])
const reports = mod(/anymodel: answer agent=(\S+) ms=(\d+) chars=\d+: ([\s\S]*)/).map(m => ({ agent: m[1], ms: +m[2], text: m[3] }))
const tasks = mod(/anymodel: task agent=(\S+) name=(\S+) model=(\S+) url=(\S+) mode=(\S+) resume=(\S+) cwd=\S+ chars=\d+: ([\s\S]*)/)
  .map(m => ({ agent: m[1], name: m[2], model: m[3], url: m[4], mode: m[5], resume: m[6], text: m[7] }))
const errors = mod(/anymodel: error agent=(\S+) ms=(\d+): ([\s\S]*)/).map(m => ({ agent: m[1], ms: +m[2], text: m[3] }))
const recs = jsonl(`${D}/logs/recorder.jsonl`).filter(r => r.run === tag)
const bodies = recs.map(r => read(`${D}/logs/recorder.jsonl.bodies/${r.n}.json`))
// The header names a plugin's agent type `custom`; with the mod on the only plugin agents are anymodel's, so this also
// catches a local agent the facade did not recognise (and so never logged).
// The TUI's progress summary of a local subagent running over ~30 s goes to main's backend under its id: a documented
// limit (README), listed apart.
const summary = (r, i) => locals.includes(r.agent) && bodies[i].includes('Describe your most recent action in 3-5 words')
const summaries = recs.filter(summary)
const leaked = recs.filter((r, i) => !summary(r, i) && (locals.includes(r.agent) || (!args.includes('--mod-off') && r.atype === 'custom')))
const others = [...new Set(recs.filter(r => r.agent && !locals.includes(r.agent)).map(r => r.agent))]
const rawRows = fixture.filter(row => bodies.some(b => b.includes(row)))
// Headless runs have stream-json; an interactive run has only its transcript, found by the session id the recorder saw.
const sess = recs.find(r => r.sess)?.sess
const projects = `${D}/cfg/projects`
const transcript = sess && fs.existsSync(projects) ? fs.readdirSync(projects).map(p => `${projects}/${p}/${sess}.jsonl`).find(fs.existsSync) : undefined
const events = (read(`${D}/logs/${tag}.jsonl`) || read(transcript ?? '')).split('\n').filter(Boolean).map(l => JSON.parse(l))
const lastText = events.findLast(m => m.type === 'assistant' && m.message.content.some(b => b.type === 'text'))
const result = events.findLast(m => m.type === 'result') ?? (lastText && { subtype: 'transcript', result: lastText.message.content.filter(b => b.type === 'text').map(b => b.text).join('') })
const tools = events.filter(m => m.type === 'assistant').flatMap(m => m.message.content.filter(b => b.type === 'tool_use').map(b => `${m.parent_tool_use_id ? 'sub:' : ''}${b.name} ${JSON.stringify(b.input).slice(0, 160)}`))
// Each task the facade read must contain what main wrote: the Agent prompt, or the SendMessage message on a resume.
const sent = events.filter(m => m.type === 'assistant' && !m.parent_tool_use_id).flatMap(m => m.message.content.filter(b => b.type === 'tool_use')).map(b => b.input.prompt ?? b.input.message).filter(s => typeof s === 'string').concat(opt('--sent'))
const mainRequests = recs.filter(r => !r.agent && r.cls === 'main').length
const plain = (s) => s.replace(/(\d),(\d{3})/g, '$1$2')
const missing = opt('--expect').filter(re => !reports.some(r => new RegExp(re).test(plain(r.text))))
const agentCalls = new Set(events.filter(m => m.type === 'assistant' && !m.parent_tool_use_id).flatMap(m => m.message.content).filter(b => b.type === 'tool_use' && ['Agent', 'SendMessage'].includes(b.name)).map(b => b.id))
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b.type === 'text' ? b.text : textOf(b.content))).join('\n') : '')
const received = events.flatMap(m => {
  if (m.type === 'system' && m.subtype === 'task_notification') return [String(m.summary ?? '')]
  if (m.type !== 'user' || m.parent_tool_use_id) return []
  const c = m.message?.content
  // An interactive transcript has a background agent's result as a <task-notification> message.
  if (typeof c === 'string') return c.includes('<task-notification>') ? [c] : []
  return (c ?? []).filter(b => (b.type === 'tool_result' && agentCalls.has(b.tool_use_id)) || (b.type === 'text' && b.text.includes('<task-notification>'))).map(b => textOf(b.type === 'text' ? b.text : b.content))
})
const mainText = [String(result?.result ?? ''), ...received].join('\n')
const missingMain = opt('--expect-main').filter(re => !new RegExp(re).test(plain(mainText)))
const resumed = locals.filter(a => {
  const mine = tasks.filter(t => t.agent === a)
  return mine.length > 1 && mine.slice(1).every(t => t.resume !== '-')
})

// The workers' own sessions, under the state dir the mod derives from the session's HOME: per local agent its
// transcript cut at each prompt (the tools each prompt led to) and the subagents it ran.
const state = `${D}/home/.local/state/anymodel`
const wprojects = `${state}/config/projects`
const toolsOf = (entries) => entries.filter(e => e.type === 'assistant').flatMap(e => e.message.content.filter(b => b.type === 'tool_use').map(b => b.name))
const workers = Object.fromEntries(locals.map(a => {
  // One file per main session and local agent: <main session id>-<agent id>.
  const sessions = `${state}/sessions`
  const id = (fs.existsSync(sessions) ? fs.readdirSync(sessions).filter(f => f.endsWith(`-${a}`)) : []).map(f => JSON.parse(read(`${sessions}/${f}`)).sessionId)[0] ?? ''
  const dir = id && fs.existsSync(wprojects) ? fs.readdirSync(wprojects).map(p => `${wprojects}/${p}`).find(p => fs.existsSync(`${p}/${id}.jsonl`)) : undefined
  if (dir === undefined) return [a, { session: id || null }]
  const entries = jsonl(`${dir}/${id}.jsonl`)
  const isPrompt = e => e.type === 'user' && !e.isMeta && !e.toolUseResult &&
    (typeof e.message.content === 'string' || e.message.content.some(b => b.type === 'text'))
  const cuts = entries.flatMap((e, i) => (isPrompt(e) ? [i] : []))
  const prompts = cuts.map((c, k) => {
    const c0 = entries[c].message.content
    return { prompt: (typeof c0 === 'string' ? c0 : c0.filter(b => b.type === 'text').map(b => b.text).join('')).slice(0, 120), tools: toolsOf(entries.slice(c, cuts[k + 1])) }
  })
  const subDir = `${dir}/${id}/subagents`
  const nested = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')).map(f => jsonl(`${subDir}/${f}`)).map(es => ({ turns: es.filter(e => e.type === 'assistant').length, tools: toolsOf(es) })) : []
  return [a, { session: id, transcript: `${dir}/${id}.jsonl`, sessionIds: [...new Set(entries.map(e => e.sessionId).filter(Boolean))], prompts, nested }]
}))
const workerTools = Object.values(workers).flatMap(w => (w.prompts ?? []).flatMap(p => p.tools))
// The workers' requests; the mod's own context reads (GETs, with the key as a bearer too, as Unsloth Studio needs it)
// are not theirs.
const wrec = jsonl(`${D}/logs/${tag}.wrec.jsonl`).filter(r => r.method === 'POST')
// Each local agent's own transcript in main's session: the notices the mod added for its worker's tool calls.
const agentFiles = sess && fs.existsSync(projects) ? fs.readdirSync(projects).flatMap(p => locals.map(a => `${projects}/${p}/${sess}/subagents/agent-${a}.jsonl`)).filter(fs.existsSync) : []
const notices = agentFiles.flatMap(f => jsonl(f)).filter(e => e.type === 'system').map(e => String(e.content ?? JSON.stringify(e.message ?? '')))

const checks = {
  'no local-subagent request at the recorder': leaked.length === 0,
  ...(args.includes('--canary-ok') ? {} : { 'no canary or IBAN at the recorder': recs.every(r => r.canary.length === 0) }),
  'no raw statement row at the recorder': rawRows.length === 0,
  [`local subagents answered >= ${opt('--locals')[0] ?? 1}`]: locals.length >= +(opt('--locals')[0] ?? 1),
  'expected values in a local report': missing.length === 0,
  'expected values in main\'s answer': missingMain.length === 0,
  'expected errors answered': opt('--error').every(re => errors.some(e => new RegExp(re).test(e.text))),
  [`resumed local subagents >= ${opt('--resumes')[0] ?? 0}`]: resumed.length >= +(opt('--resumes')[0] ?? 0),
  // A later step of a turn (a refused handback, the engine's nudges) repeats the answer; only a turn's first step runs the worker.
  'worker runs only on a turn\'s first step': locals.every(a => tasks.filter(t => t.agent === a).length <= firstSteps.filter(id => id === a).length),
  'each task read via $.session.messages is a prompt main sent': tasks.every(t => sent.some(p => t.text.includes(p))),
  [`other subagents at the recorder >= ${opt('--others')[0] ?? 0}`]: others.length >= +(opt('--others')[0] ?? 0),
  'workers ran on the expected models': opt('--task-model').every(m => tasks.some(t => t.model === m)),
  'workers ran as the expected agents': opt('--task-name').every(n => tasks.some(t => t.name === n)),
  'workers ran in the expected permission mode': opt('--task-mode').every(m => tasks.length > 0 && tasks.every(t => t.mode === m)),
  'no task holds the excluded text': opt('--task-lacks').every(re => !tasks.some(t => new RegExp(re).test(t.text))),
  'expected tools in a worker transcript': opt('--worker-tool').every(n => workerTools.includes(n)),
  ...(args.includes('--nested') ? { 'a worker ran a subagent of its own': Object.values(workers).some(w => w.nested?.some(n => n.turns > 0)) } : {}),
  ...(args.includes('--wrec') ? { 'worker requests carry only the agent key': wrec.length > 0 && wrec.every(r => r.keyOk && !r.auth && !r.trap) } : {}),
  'expected notices in a local agent transcript': opt('--notice').every(re => notices.some(n => new RegExp(re).test(n))),
  'worker requests for the expected models': opt('--wrec-model').every(m => wrec.some(r => r.model === m)),
  ...(args.includes('--max-main') ? { [`main's own model requests <= ${opt('--max-main')[0]}`]: mainRequests <= +opt('--max-main')[0] } : {}),
}
const pass = Object.values(checks).every(Boolean)
console.log(JSON.stringify({
  tag, pass, checks,
  recorder: { requests: recs.length, mainRequests, byAgent: Object.fromEntries(Object.entries(Object.groupBy(recs, r => r.agent ?? 'main')).map(([k, v]) => [k, v.length])), leaked: leaked.map(r => ({ n: r.n, agent: r.agent, cls: r.cls, atype: r.atype, model: r.model })), progressSummaries: summaries.map(r => r.n), canary: recs.flatMap(r => r.canary), rawRows: rawRows.length, holderName: bodies.filter(b => b.includes('Vossberg')).length },
  ...(wrec.length > 0 ? { workerRecorder: { requests: wrec.length, models: Object.fromEntries(Object.entries(Object.groupBy(wrec, r => `${r.sess} ${r.model}`)).map(([k, v]) => [k, v.length])), keyOk: wrec.filter(r => r.keyOk).length, auth: wrec.filter(r => r.auth).length, trap: wrec.filter(r => r.trap).length } } : {}),
  notices: notices.slice(0, 20),
  locals, others, tasks: tasks.map(t => ({ ...t, text: t.text.slice(0, 200) })), workerMs: reports.map(r => r.ms), errors, missing, missingMain,
  reports: reports.map(r => r.text.slice(0, 300)),
  workers,
  tools,
  main: result ? { subtype: result.subtype, ms: result.duration_ms, text: String(result.result).slice(0, 500) } : null,
}, null, 1))
process.exitCode = pass ? 0 : 1
