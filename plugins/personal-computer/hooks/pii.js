// Pure helpers for personal-computer: which scanner spans are personal data, the IBAN and card checks, the notice
// Claude reads in place of a withheld output, and the placeholders of mask mode.

// The lowest score at which a scanner span counts, per type (the labels OpenAI Privacy Filter and PII-Tracer share).
// A name needs a high score: both models flag ordinary capitalized words at lower ones. A secret needs a higher one:
// OPF calls CSV fields secrets at 0.8, real keys at 0.99. Dates, URLs and PII-Tracer's other_pii are absent: alone
// they identify nobody, and nearly every output has them.
export const THRESHOLDS = {
  private_person: 0.7,
  private_email: 0.5,
  private_phone: 0.5,
  private_address: 0.5,
  account_number: 0.5,
  secret: 0.9,
}

// Where spans overlap, the most precise source keeps its bounds: a checksum is exact, OPF's spans are tight, and
// PII-Tracer's run on over separators ("name, street, phone" as one name).
const PRIORITY = ['checksum', 'opf', 'pii-tracer']
// A token can carry the separator before it (",Mirela"): edges like these are not part of a value.
const EDGE = /^[\s,;:.<>()[\]{}"'|]+|[\s,;:<>()[\]{}"'|]+$/g
// What OPF on CSV rows calls a phone number: an amount, or too few digits for any phone.
const notPhone = (v) => /^[-+]?\d+[.,]\d{1,2}$/.test(v) || v.replace(/\D/g, '').length < 7
// What OPF on statement rows calls an address: a merchant, often with the row's amount after it. A postal address has
// a house number or a postcode.
const AMOUNT_TAIL = /[,;\t|]\s*[-+]?\d+[.,]\d{2}$/
// A reference, contract or invoice number is shorter than any account number.
const ACCOUNT_DIGITS = 6

const plausible = (s) => s.value !== ''
  && !(s.type === 'private_phone' && notPhone(s.value))
  && !(s.type === 'private_person' && /^\S*[\d_]\S*$/.test(s.value))
  && !(s.type === 'private_address' && !/\d/.test(s.value))
  && !(s.type === 'account_number' && s.value.replace(/\D/g, '').length < ACCOUNT_DIGITS)
  && !testValue(s.value)

const WORDS = {
  private_person: ['name', 'names'],
  private_email: ['email address', 'email addresses'],
  private_phone: ['phone number', 'phone numbers'],
  private_address: ['address', 'addresses'],
  account_number: ['account number', 'account numbers'],
  secret: ['secret', 'secrets'],
  iban: ['IBAN', 'IBANs'],
  card: ['card number', 'card numbers'],
}

const PREFIX = {
  private_person: 'PERSON', private_email: 'EMAIL', private_phone: 'PHONE', private_address: 'ADDRESS',
  account_number: 'ACCOUNT', secret: 'SECRET', iban: 'IBAN', card: 'CARD',
}

// A candidate IBAN: country, check digits, then groups of up to 4, spaced or not. A trailing word ("EUR") can look
// like a last group, so a candidate that fails mod-97 is retried without its last group.
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g
const CARD = /(?<![\dA-Za-z])(?:\d[ -]?){12,18}\d(?![\d])/g
// Published test card numbers: in fixtures and docs they are nobody's.
const TEST_CARDS = new Set(['4111111111111111', '4242424242424242', '5555555555554444', '378282246310005', '6011111111111117', '4000056655665556'])
// The example IBAN of bank and library docs: code quotes it as a test value, no one banks with it.
const TEST_IBANS = new Set(['DE89370400440532013000'])
const testValue = (v) => {
  const compact = v.replace(/[\s-]/g, '')
  return TEST_CARDS.has(compact) || [...TEST_IBANS].some(i => compact.includes(i))
}

const ibanValid = (raw) => {
  const s = raw.replace(/ /g, '')
  if (s.length < 15 || s.length > 34) return false
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55))
  let r = 0
  for (const d of digits) r = (r * 10 + Number(d)) % 97
  return r === 1
}

const luhnValid = (digits) => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

const ibanAt = (text, m) => {
  let candidate = m[0]
  while (candidate.length >= 15) {
    if (ibanValid(candidate)) return { type: 'iban', start: m.index, end: m.index + candidate.length, score: 1, model: 'checksum' }
    const cut = candidate.lastIndexOf(' ')
    if (cut < 0) return undefined
    candidate = candidate.slice(0, cut)
  }
  return undefined
}

// IBANs and card numbers whose check digits hold: the models score some of these low (PII-Tracer gave a real card
// 0.45), and a checksum never fires on an order number. Digits inside an IBAN are not a card.
export function checksumSpans(text) {
  const ibans = [...text.matchAll(IBAN)].map(m => ibanAt(text, m)).filter(s => s !== undefined && !testValue(text.slice(s.start, s.end)))
  const inIban = (a, b) => ibans.some(s => a < s.end && b > s.start)
  const cards = [...text.matchAll(CARD)]
    .map(m => ({ type: 'card', start: m.index, end: m.index + m[0].length, score: 1, model: 'checksum', digits: m[0].replace(/[ -]/g, '') }))
    .filter(s => s.digits.length >= 13 && s.digits.length <= 19 && !TEST_CARDS.has(s.digits) && !/^(\d)\1+$/.test(s.digits))
    .filter(s => luhnValid(s.digits) && !inIban(s.start, s.end))
    .map(({ digits, ...s }) => s)
  return [...ibans, ...cards].sort((a, b) => a.start - b.start)
}

// A span with its edge punctuation cut off, and its value.
const trimmed = (text, s) => {
  const raw = text.slice(s.start, s.end)
  const lead = raw.length - raw.replace(/^[\s,;:.<>()[\]{}"'|]+/, '').length
  const value = raw.replace(EDGE, '')
  return { ...s, start: s.start + lead, end: s.start + lead + value.length, value }
}

// OPF splits an address into pieces ("123", "Main St", "Springfield IL 62701"): pieces of one model apart by no more
// than a space or a comma are one address.
const joined = (text, spans) => {
  const out = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const i = out.findLastIndex(o => o.type === 'private_address' && o.model === s.model)
    const last = out[i]
    if (s.type === 'private_address' && last !== undefined && s.start >= last.end && /^[\s,]{0,2}$/.test(text.slice(last.end, s.start))) {
      out[i] = { ...last, end: s.end, score: Math.max(last.score, s.score), value: text.slice(last.start, s.end) }
    } else out.push(s)
  }
  return out
}

// One span per place: a lower-priority span that overlaps a kept one is dropped.
const combine = (spans) => {
  const rank = (s) => (PRIORITY.indexOf(s.model) + PRIORITY.length + 1) % (PRIORITY.length + 1)
  const kept = []
  for (const s of [...spans].sort((a, b) => rank(a) - rank(b) || a.start - b.start)) {
    if (!kept.some(k => s.start < k.end && s.end > k.start)) kept.push(s)
  }
  return kept.sort((a, b) => a.start - b.start)
}

// The personal data in `text`: the scanner's spans of both models at their thresholds, plus checksum hits, one per
// place, in order. `allow` holds the user's own name and email (from git config): their own commits are no one
// else's data.
export function findings(text, spans, allow) {
  const allowed = new Set(allow.map(a => a.toLowerCase()))
  const counted = joined(text, spans
    .filter(s => THRESHOLDS[s.type] !== undefined && s.score >= THRESHOLDS[s.type])
    .map(s => trimmed(text, s))
    .map(s => s.type === 'private_address' && AMOUNT_TAIL.test(s.value) ? trimmed(text, { ...s, end: s.start + s.value.replace(AMOUNT_TAIL, '').length }) : s))
    .filter(plausible)
  return combine([...counted, ...checksumSpans(text).map(s => trimmed(text, s))])
    .map(({ score, model, ...s }) => s)
    .filter(s => !allowed.has(s.value.toLowerCase()))
}

// "2 names, 1 IBAN": distinct values per kind, kinds in the order they first appear.
export function summary(found) {
  const kinds = new Map()
  for (const f of found) kinds.set(f.type, (kinds.get(f.type) ?? new Set()).add(f.value))
  return [...kinds].map(([type, values]) => `${values.size} ${WORDS[type][values.size === 1 ? 0 : 1]}`).join(', ')
}

// What Claude reads in place of an output with personal data: what kind was found, never a value, and who can work
// with it. Claude restates what it needs, which only it knows.
export function withheldNotice(source, found, agent) {
  return `${source} contains personal data (${summary(found)}), so it was withheld from you. ` +
    `Ask anymodel:${agent} to do the part of the task that needs this data: tell it what you need and where the data is ` +
    '(it can read files and run commands itself). Its answer reaches you without the personal data.'
}

// `text` with each finding replaced by its placeholder. `table` maps placeholders to values for the session, so a
// value keeps its placeholder across outputs; the result carries the extended table and leaves `table` as it was.
export function mask(text, found, table) {
  const next = { ...table }
  const known = new Map(Object.entries(next).map(([k, v]) => [v, k]))
  const count = (prefix) => Object.keys(next).filter(k => k.startsWith(`${prefix}_`)).length
  const placeholder = (f) => {
    if (!known.has(f.value)) {
      const key = `${PREFIX[f.type]}_${count(PREFIX[f.type]) + 1}`
      next[key] = f.value
      known.set(f.value, key)
    }
    return `[${known.get(f.value)}]`
  }
  let out = ''
  let from = 0
  for (const f of [...found].sort((a, b) => a.start - b.start)) {
    out += text.slice(from, f.start) + placeholder(f)
    from = f.end
  }
  return { text: out + text.slice(from), table: next }
}

// `value` with each value of `table` in any of its strings replaced by its placeholder, longest first, so a tool's
// own result object keeps its shape (an object where its schema wants one) and reads as usual.
export function hide(value, table) {
  const pairs = Object.entries(table).sort((a, b) => b[1].length - a[1].length)
  const walk = (v) => typeof v === 'string' ? pairs.reduce((t, [key, val]) => t.replaceAll(val, `[${key}]`), v)
    : Array.isArray(v) ? v.map(walk)
    : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    : v
  return walk(value)
}

// `text` with every known placeholder back to its value, as a file Claude writes is saved.
export const restore = (text, table) => text.replace(/\[([A-Z]+_\d+)\]/g, (m, key) => table[key] ?? m)
