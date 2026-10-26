// The values anymodel keeps in $.state for the session (see KEYS in hooks/anymodel.js).
export type Keys = Record<string, string>

// What anymodel adds to `$` for other plugins.
export type Anymodel = {
  /**
   * Raised before an agent's answer goes to main (as its Agent result, a handback or /anymodel's answer): a hook on
   * `anymodel.screen` may rewrite the text. Its bottom passes the text on unchanged.
   */
  screen: (args: AnymodelScreenArgs) => Promise<AnymodelScreenResult>
  /** The saved agents as this session read them, in their saved order; never a key. */
  agents: () => Promise<AnymodelAgent[]>
}
export type AnymodelAgent = {
  /** The agent's name, as in @anymodel:<name>. */
  name: string
  /** Its model id; absent while its settings have a problem. */
  model?: string
  /** Its server's base URL; absent while its settings have a problem. */
  url?: string
  /** What is wrong with its settings, as /anymodel shows it; empty when it can run. */
  problems: string[]
}
export type AnymodelScreenArgs = {
  /** The agent's id, as `$.agent.list()` names it. */
  agentId: string
  /** The agent's name, as in @anymodel:<name>. */
  name: string
  /** The answer as the worker gave it. */
  text: string
}
export type AnymodelScreenResult = { text: string }

declare module 'claude-code' {
  interface PluginState {
    anymodel: { keys: Keys }
  }
  interface EngineInterface {
    anymodel: Anymodel
  }
}
