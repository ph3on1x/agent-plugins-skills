// The values anymodel keeps in $.state for the session (see KEYS in hooks/anymodel.js).
export type Keys = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    anymodel: { keys: Keys }
  }
}
