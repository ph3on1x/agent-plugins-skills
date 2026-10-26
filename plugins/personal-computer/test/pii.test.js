// usage: node --test plugins/personal-computer/test/*.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checksumSpans, findings, hide, mask, reserved, restore, summary, withheldNotice } from '../hooks/pii.js'

const statement = 'Account holder: Johanna Vexley, IBAN DE29 3704 0044 9172 6048 15, email jv@example.org. Total 2996.38'
const at = (text, value) => [text.indexOf(value), text.indexOf(value) + value.length]
// Spans as the scanner answers them: both models' spans, unfiltered.
const span = (type, value, score, text = statement) => ({ type, start: at(text, value)[0], end: at(text, value)[1], score })

test('findings keep spans at or above their type threshold and drop the rest', () => {
  const spans = [
    span('private_person', 'Johanna Vexley', 0.92),
    span('private_email', 'jv@example.org', 0.41),
    span('private_date', 'Total', 0.99),
  ]
  assert.deepEqual(findings(statement, spans, []).map(f => [f.type, f.value]), [
    ['private_person', 'Johanna Vexley'],
    ['iban', 'DE29 3704 0044 9172 6048 15'],
  ])
})

test('dates, URLs and other_pii never count, whatever their score', () => {
  const text = 'Paid on 2026-10-01 via https://bank.example/x, ref 7'
  const spans = [span('private_date', '2026-10-01', 1, text), span('private_url', 'https://bank.example/x', 1, text), span('other_pii', 'ref 7', 1, text)]
  assert.deepEqual(findings(text, spans, []), [])
})

test('where spans overlap, OPF keeps its tight bounds over PII-Tracer\'s, and a checksum over both', () => {
  const text = 'Account holder: Johanna Vexley, Hauptstr. 12, 10115 Berlin\nIBAN DE29 3704 0044 9172 6048 15\n2026-10-01;REWE;-54.20'
  const spans = [
    { ...span('private_person', 'Johanna Vexley', 0.98, text), model: 'opf' },
    { ...span('private_address', 'Hauptstr. 12, 10115 Berlin', 0.8, text), model: 'opf' },
    { ...span('account_number', 'IBAN DE29 3704 0044 9172 6048 15', 0.98, text), model: 'opf' },
    { ...span('private_person', 'Johanna Vexley, Hauptstr. 12, 10115 Berlin', 0.85, text), model: 'pii-tracer' },
    { ...span('account_number', 'IBAN DE29 3704 0044 9172 6048 15\n2026-10-01;REWE;-54.20', 0.75, text), model: 'pii-tracer' },
  ]
  assert.deepEqual(findings(text, spans, []).map(f => [f.type, f.value]), [
    ['private_person', 'Johanna Vexley'],
    ['private_address', 'Hauptstr. 12, 10115 Berlin'],
    ['iban', 'DE29 3704 0044 9172 6048 15'],
  ])
})

test('a PII-Tracer span that overlaps no OPF span still counts', () => {
  assert.deepEqual(findings(statement, [{ ...span('private_email', 'jv@example.org', 0.9), model: 'pii-tracer' }], []).map(f => f.value), [
    'DE29 3704 0044 9172 6048 15', 'jv@example.org',
  ])
})

test('punctuation at a span\'s edges is not part of the value', () => {
  const text = 'a3f9 Dennis Nasarov <dennis@example.org> fix,Mirela T. Vossberg,DE'
  const spans = [
    { type: 'private_email', start: text.indexOf('<'), end: text.indexOf('>') + 1, score: 0.99, model: 'opf' },
    { type: 'private_person', start: text.indexOf(',Mirela'), end: text.indexOf('Vossberg,') + 9, score: 0.99, model: 'opf' },
  ]
  assert.deepEqual(findings(text, spans, ['dennis@example.org']).map(f => f.value), ['Mirela T. Vossberg'])
})

test('a phone span needs seven digits and is never an amount', () => {
  const text = 'Gehalt 3184.27, ext 4412, call +49 30 1234567'
  const spans = ['3184.27', '4412', '+49 30 1234567'].map(v => ({ ...span('private_phone', v, 0.97, text), model: 'opf' }))
  assert.deepEqual(findings(text, spans, []).map(f => f.value), ['+49 30 1234567'])
})

test('an address needs a digit: a merchant on a statement row is none, and an amount it ran on to is cut off', () => {
  const text = '2026-09-04,REWE Markt 4411,-84.37\n2026-09-06,Stadtwerke Strom,-96.50\n2026-09-09,Drogerie Nord,-23.18'
  const spans = [
    { ...span('private_address', 'REWE Markt 4411', 0.81, text), model: 'opf' },
    { ...span('private_address', 'Stadtwerke Strom', 0.75, text), model: 'opf' },
    { ...span('private_address', ',Drogerie Nord,-23.18', 0.74, text), model: 'opf' },
  ]
  assert.deepEqual(findings(text, spans, []).map(f => f.value), ['REWE Markt 4411'])
})

test('pieces of one address from one model are one address, so a street without its number still counts', () => {
  const text = 'name,street,city\nTom Hale,123 Main St,Springfield IL 62701'
  const spans = [
    { ...span('private_address', '123', 1, text), model: 'opf' },
    { ...span('private_address', 'Main St', 0.98, text), model: 'opf' },
    { ...span('private_address', 'Springfield IL 62701', 0.88, text), model: 'opf' },
    { ...span('private_address', '123 Main St,Springfield IL 62701', 0.86, text), model: 'pii-tracer' },
  ]
  assert.deepEqual(findings(text, spans, []).map(f => [f.type, f.value]), [['private_address', '123 Main St,Springfield IL 62701']])
})

test('one token with a digit or an underscore is no name: a code identifier or a file size is none', () => {
  const text = 'ibans_in_csv 1 iban_in_note True\n644  note.md  181B\nJohanna Vexley, Hauptstr. 12'
  const spans = [
    { ...span('private_person', 'ibans_in_csv', 0.98, text), model: 'opf' },
    { ...span('private_person', '181B', 0.84, text), model: 'pii-tracer' },
    { ...span('private_person', 'Johanna Vexley, Hauptstr. 12', 0.85, text), model: 'pii-tracer' },
  ]
  assert.deepEqual(findings(text, spans, []).map(f => f.value), ['Johanna Vexley, Hauptstr. 12'])
})

test('an account number needs six digits: a reference or invoice number is none', () => {
  const text = 'Customer 48213977, contract no. 2209, invoice 17'
  const spans = ['48213977', '2209', '17'].map(v => ({ ...span('account_number', v, 0.9, text), model: 'pii-tracer' }))
  assert.deepEqual(findings(text, spans, []).map(f => f.value), ['48213977'])
})

test('an account number has no letters: an id such as an agent id is none', () => {
  const text = '{"resumedAgentId":"a4215d20415698c29"} account 4821 3977 0012'
  const spans = ['a4215d20415698c29', '4821 3977 0012'].map(v => ({ ...span('account_number', v, 0.9, text), model: 'pii-tracer' }))
  assert.deepEqual(findings(text, spans, []).map(f => f.value), ['4821 3977 0012'])
})

test('the textbook example IBAN does not count, even when a model flags it: code and docs quote it', () => {
  const text = 'const CANARY = /DE89 3704 0044 0532 0130 00/'
  const spans = [{ ...span('account_number', 'DE89 3704 0044 0532 0130 00', 0.9, text), model: 'opf' }]
  assert.deepEqual(findings(text, spans, []), [])
})

test('published test card numbers do not count, even when a model flags them', () => {
  const text = "const TEST_CARDS = new Set(['4242424242424242'])"
  assert.deepEqual(findings(text, [{ ...span('account_number', '4242424242424242', 0.99, text), model: 'opf' }], []), [])
})

test('a secret needs a high score: OPF calls CSV fields secrets at 0.8', () => {
  const text = '2026-10-03;Netflix;-15.99 key sk-live-9f8a7b6c5d4e3f2a1b0c'
  const spans = [
    { ...span('secret', 'Netflix;-15.99', 0.8, text), model: 'opf' },
    { ...span('secret', 'sk-live-9f8a7b6c5d4e3f2a1b0c', 0.99, text), model: 'opf' },
  ]
  assert.deepEqual(findings(text, spans, []).map(f => f.value), ['sk-live-9f8a7b6c5d4e3f2a1b0c'])
})

test('an IBAN followed by a currency or word is still found', () => {
  const text = 'Transfer to DE29 3704 0044 9172 6048 15 EUR 120'
  assert.deepEqual(checksumSpans(text).map(s => text.slice(s.start, s.end)), ['DE29 3704 0044 9172 6048 15'])
})

test('the user\'s own name and email are allowed, case-insensitively', () => {
  const text = 'Author: Dennis Nasarov <dennis@example.org>; payee Johanna Vexley'
  const spans = [span('private_person', 'Dennis Nasarov', 0.9, text), span('private_email', 'dennis@example.org', 0.9, text), span('private_person', 'Johanna Vexley', 0.9, text)]
  assert.deepEqual(findings(text, spans, ['dennis nasarov', 'DENNIS@example.org']).map(f => f.value), ['Johanna Vexley'])
})

test('checksumSpans finds a valid IBAN and card number the models missed, and not invalid or test ones', () => {
  const text = 'IBAN DE29 3704 0044 9172 6048 15, bad DE00 3704 0044 0532 0130 00, card 4539 1488 0343 6467, test 4242 4242 4242 4242, order 1234567890123'
  assert.ok(checksumSpans(text).every(s => s.model === 'checksum'))
  assert.deepEqual(checksumSpans(text).map(s => [s.type, text.slice(s.start, s.end)]), [
    ['iban', 'DE29 3704 0044 9172 6048 15'],
    ['card', '4539 1488 0343 6467'],
  ])
})

test('findings include checksum hits even with no model span', () => {
  const found = findings(statement, [], [])
  assert.deepEqual(found.map(f => [f.type, f.value]), [['iban', 'DE29 3704 0044 9172 6048 15']])
})

test('summary counts what was found in words', () => {
  const found = findings(statement, [span('private_person', 'Johanna Vexley', 0.9), span('private_email', 'jv@example.org', 0.9)], [])
  assert.equal(summary(found), '1 name, 1 IBAN, 1 email address')
  assert.equal(summary([...found, { ...found[0], value: 'Max Mustermann' }]), '2 names, 1 IBAN, 1 email address')
})

test('withheldNotice names the source, the counts and the agent to delegate to, never a value', () => {
  const found = findings(statement, [span('private_person', 'Johanna Vexley', 0.9)], [])
  const notice = withheldNotice('The output of Read', found, 'qwen')
  assert.match(notice, /Read/)
  assert.match(notice, /1 name, 1 IBAN/)
  assert.match(notice, /anymodel:qwen/)
  assert.doesNotMatch(notice, /Johanna|DE29/)
})

test('mask gives each value one placeholder per type, reused across calls, and restore puts the values back', () => {
  const found = findings(statement, [span('private_person', 'Johanna Vexley', 0.9)], [])
  const first = mask(statement, found, {})
  assert.equal(first.text, 'Account holder: [PERSON_1], IBAN [IBAN_1], email jv@example.org. Total 2996.38')
  const again = 'Johanna Vexley paid Max Mustermann'
  const second = mask(again, findings(again, [span('private_person', 'Johanna Vexley', 0.9, again), span('private_person', 'Max Mustermann', 0.9, again)], []), first.table)
  assert.equal(second.text, '[PERSON_1] paid [PERSON_2]')
  assert.equal(restore('Dear [PERSON_2], about [IBAN_1] and [PERSON_1].', second.table), 'Dear Max Mustermann, about DE29 3704 0044 9172 6048 15 and Johanna Vexley.')
})

test('mask leaves the table it was given unchanged', () => {
  const table = {}
  mask(statement, findings(statement, [], []), table)
  assert.deepEqual(table, {})
})

test('restore leaves unknown placeholders and plain text alone', () => {
  assert.equal(restore('[PERSON_9] and [not a placeholder]', { 'PERSON_1': 'X' }), '[PERSON_9] and [not a placeholder]')
})

test('hide replaces every value of the table in every string of a value, the longest first, and keeps its shape', () => {
  const table = { PERSON_1: 'Johanna Vexley', PERSON_2: 'Johanna', IBAN_1: 'DE29 3704 0044 9172 6048 15' }
  const result = { type: 'text', file: { filePath: '/x/statement.csv', content: 'Johanna Vexley, DE29 3704 0044 9172 6048 15; Johanna', numLines: 1 }, lines: ['Johanna'] }
  assert.deepEqual(hide(result, table), {
    type: 'text', file: { filePath: '/x/statement.csv', content: '[PERSON_1], [IBAN_1]; [PERSON_2]', numLines: 1 }, lines: ['[PERSON_2]'],
  })
  assert.equal(hide('nothing here', table), 'nothing here')
})

test('placeholders already in a conversation are reserved: new values are numbered after them, and they stay as they are', () => {
  const table = reserved('Dear [PERSON_1] and [PERSON_3], your [IBAN_2]; [TODO_1] is none of ours')
  assert.deepEqual(table, { PERSON_1: null, PERSON_3: null, IBAN_2: null })
  const text = 'Johanna Vexley, DE29 3704 0044 9172 6048 15'
  const m = mask(text, [{ type: 'private_person', value: 'Johanna Vexley', start: 0, end: 14 }, { type: 'iban', value: 'DE29 3704 0044 9172 6048 15', start: 16, end: 43 }], table)
  assert.equal(m.text, '[PERSON_4], [IBAN_3]')
  assert.equal(hide({ note: 'null and Johanna Vexley' }, m.table).note, 'null and [PERSON_4]')
  assert.equal(restore('Dear [PERSON_1] and [PERSON_4]', m.table), 'Dear [PERSON_1] and Johanna Vexley')
})
