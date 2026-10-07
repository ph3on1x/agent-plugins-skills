import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'refine-prompt',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// Stands in for the engine: a prompt box holding `draft`, the skill installed under `skill`.
const fakeEngine = (on: On, draft: string, skill: string | undefined, runFails = false) => {
  const seen = { fills: [] as string[], runs: [] as { command: string; args: string }[], toasts: [] as string[] }
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('command.list', () => ({
    value: skill === undefined ? [] : [{ name: skill, description: '', source: 'plugin' as const }],
  }))
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('command.run', ($, e) => {
    if (runFails) {
      throw new Error('boom')
    }
    seen.runs.push({ command: e.command, args: e.args })
    return {}
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('runs the skill on the draft and clears the box', async ($, on) => {
  const seen = fakeEngine(on, '  write a haiku about tests \n', 'refine-prompt:refine-prompt')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'refine' })
    await ui.unmount()
  }
  expect(seen.runs).toEqual([
    { command: 'refine-prompt:refine-prompt', args: 'write a haiku about tests' },
    { command: 'refine-prompt:refine-prompt', args: 'write a haiku about tests' },
  ])
  expect(seen.fills).toEqual(['', ''])
})

test('finds the skill installed without a plugin namespace', async ($, on) => {
  const seen = fakeEngine(on, 'fix the bug', 'refine-prompt')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'refine' })
  expect(seen.runs).toEqual([{ command: 'refine-prompt', args: 'fix the bug' }])
})

test('a blank draft runs nothing and says why', async ($, on) => {
  const seen = fakeEngine(on, '   ', 'refine-prompt:refine-prompt')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'refine' })
  expect(seen.runs).toEqual([])
  expect(seen.fills).toEqual([])
  expect(seen.toasts.length).toBe(1)
})

test('a missing skill runs nothing and keeps the draft', async ($, on) => {
  const seen = fakeEngine(on, 'fix the bug', undefined)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'refine' })
  expect(seen.fills).toEqual([])
  expect(seen.toasts[0]).toContain('not found')
})

test('a failed run puts the draft back', async ($, on) => {
  const seen = fakeEngine(on, 'fix the bug', 'refine-prompt:refine-prompt', true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'refine' })
  expect(seen.fills).toEqual(['', 'fix the bug'])
  expect(seen.toasts[0]).toContain('failed')
})

test('yields the band to a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'refine' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'survey' })).toBeDefined()
})

test('names the chord that focuses the band', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab, enter' })).toBeDefined()
    await ui.unmount()
  }
})
