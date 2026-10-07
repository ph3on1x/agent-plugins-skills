import type { EngineInterface, Register } from 'claude-code'

const SKILL = 'refine-prompt'

// Installed as a plugin the skill is `/refine-prompt:refine-prompt`; via `npx skills add` it is `/refine-prompt`.
const findSkillCommand = async ($: EngineInterface) =>
  (await $.command.list()).find(c => c.name === SKILL || c.name.endsWith(`:${SKILL}`))?.name

const refineDraft = async ($: EngineInterface) => {
  const draft = (await $.prompt.read()).text.trim()
  if (draft === '') {
    $.ui.toast('Type a prompt first, then press refine prompt.')
    return
  }

  const command = await findSkillCommand($)
  if (command === undefined) {
    $.ui.toast(`/${SKILL} not found among this session's slash commands.`)
    return
  }

  await $.prompt.fill({ text: '' })
  try {
    await $.command.run({ command, args: draft })
  } catch (error) {
    // Never lose what the person typed.
    await $.prompt.fill({ text: draft })
    $.ui.toast(`/${command} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const register: Register = on => {
  // The band above the prompt is the one site near it that takes the keyboard: on the terminal ctrl+x tab
  // focuses it, the button holds the focus ring from the start, so Enter presses it. Other surfaces bind
  // their own keys, so only the terminal names the chord.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={2}>
        <Button key="refine" label="refine prompt" dimColor autoFocus onPress={() => refineDraft($)} />
        {e.surface === 'terminal' && <Text dimColor>ctrl+x tab, enter</Text>}
      </Box>
    )
  })
}
