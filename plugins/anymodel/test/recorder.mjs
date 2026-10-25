// Stand-in for api.anthropic.com: records every request the main session sends, then forwards it to the local model
// so the main agent behaves for real. Any request carrying a local subagent's agent id is a leak. A second instance
// as a worker's base_url records the worker's requests the same way.
// usage: node recorder.mjs <port> <log.jsonl> [upstream=http://127.0.0.1:8888]   env: UP_MODEL (the model the upstream
//        serves: every request goes to it), UP_KEY_FILE (a file holding the upstream's key, sent as a bearer token),
//        CANARY (regex source)
import fs from 'node:fs'
import http from 'node:http'

const [port, log, upstream = 'http://127.0.0.1:8888'] = process.argv.slice(2)
const UP_MODEL = process.env.UP_MODEL
if (!UP_MODEL) throw new Error('set UP_MODEL to the model the upstream serves')
const UP_KEY = process.env.UP_KEY_FILE ? fs.readFileSync(process.env.UP_KEY_FILE, 'utf8').trim() : undefined
const CANARY = new RegExp(process.env.CANARY || 'CANARY-ANYMODEL-7Q9X|DE89 3704 0044 0532 0130 00', 'g')
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(upstream)) throw new Error('upstream must be loopback')
fs.mkdirSync(`${log}.bodies`, { recursive: true })
let seq = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length : 0

http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString()
  let body = {}
  try { body = JSON.parse(raw || '{}') } catch {}
  const h = req.headers
  const n = ++seq
  const t0 = Date.now()
  const rec = {
    n, t: t0, run: h['x-anymodel-run'], method: req.method, url: req.url, model: body.model,
    agent: h['x-claude-code-agent-id'], cls: h['x-claude-code-request-class'], atype: h['x-claude-code-agent-type'],
    sess: h['x-claude-code-session-id'], nmsg: (body.messages || []).length, bytes: raw.length,
    canary: [...new Set(raw.match(CANARY) || [])],
    // Which credentials came: the worker's placeholder bearer, any bearer, an x-api-key that is (as a worker's provider)
    // the upstream's key, a header a project's settings tried to add. The header values are never stored.
    placeholder: h['x-api-key'] === 'local', auth: 'authorization' in h, apiKey: 'x-api-key' in h,
    keyOk: UP_KEY !== undefined && h['x-api-key'] === UP_KEY, trap: 'x-trap' in h,
  }
  fs.writeFileSync(`${log}.bodies/${n}.json`, raw)
  if (body.model) body.model = UP_MODEL
  try {
    const up = await fetch(upstream + req.url, {
      method: req.method, headers: { 'content-type': 'application/json', ...(UP_KEY ? { authorization: `Bearer ${UP_KEY}` } : {}) },
      body: req.method === 'POST' ? JSON.stringify(body) : undefined,
    })
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' })
    for await (const c of up.body) res.write(c)
    res.end()
    rec.status = up.status
  } catch (err) {
    // 400 so Claude Code does not retry ten times.
    rec.status = 400
    rec.err = String(err.cause?.code || err)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'recorder upstream is down' } }))
  }
  rec.ms = Date.now() - t0
  fs.appendFileSync(log, JSON.stringify(rec) + '\n')
}).listen(Number(port), '127.0.0.1', () => console.log('recorder on', port))
