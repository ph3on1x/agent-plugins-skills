# personal-computer tests

Two suites, both without the models or a network:

- `pc.test.ts`: the mod's hooks in Claude Code's test runner, with a stand-in scanner (`$.http`) and stand-in
  processes. Each mode against tool output, attached and `@`-mentioned files, prompts, anymodel's answers and
  background notifications; what happens when the scanner or the models are missing; setup, the check, the pane, the
  footer label and the warning line; the placeholders across resume, reload and fork; cleanup.
- `pii.test.js`: `hooks/pii.js`, the pure part: which scanner spans count, the IBAN and card checksums, the notice
  Claude reads, and the placeholders of mask mode.

## Run

```bash
(cd plugins/personal-computer && claude plugin test)        # the mod's hooks (test/pc.test.ts)
node --test plugins/personal-computer/test/pii.test.js      # hooks/pii.js
claude plugin validate plugins/personal-computer
```

## Against real sessions

What the suites cannot show, that nothing with personal data reaches Anthropic, was tested by hand on Claude Code
2.1.310 with real sessions pointed at a loopback stand-in for api.anthropic.com that records every request (as
[anymodel's tests](../../anymodel/test/README.md) do), and a statement CSV holding canary values. Read, `cat`, an
`@`-mention, a background agent and a background command, typed prompts, `--resume` and `--fork-session`: no
recorded request held a canary value. The films and the README's demo come from real Claude sessions with the
private agent `qwen` on Unsloth Studio.
