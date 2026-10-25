// A stdio MCP server with one tool, secret_word, for the MCP scenario: its answer is only here.
// usage: node mcp-word.mjs (as an MCP server's command)
import readline from 'node:readline'

const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  // A notification (initialized) wants no answer.
  if (m.id === undefined) return
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'word', version: '1.0.0' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'secret_word', description: 'Returns the secret word of this test.', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: 'MCP-OTTER-41' }] } })
  else send({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } })
})
