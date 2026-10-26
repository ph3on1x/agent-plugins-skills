// personal-computer's session state: what the footer and the /personal-computer pane draw. It outlives a reload, and
// a setting changed in the pane ($.config.set) reloads the plugin.

// One line of /personal-computer check: what was looked at, how it stands, and what was found, never a value.
export type Check = { label: string; status: 'ok' | 'failed' | 'missing' | 'skipped'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'personal-computer': {
      // Set up: the gate checks what reaches Claude, and the footer says so.
      isOn: Shaped<boolean>
      checks: Shaped<Check[]>
      // The anymodel agents the pane offers as the private agent.
      agents: Shaped<string[]>
      // What setup is doing now, or '' when it is not running.
      progress: Shaped<string>
    }
  }
}
