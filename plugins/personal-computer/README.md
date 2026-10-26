# personal-computer

Keeps personal data out of Claude while Claude still does the work. Every tool output is checked on your machine
before Claude reads it. Output with names, addresses, phone numbers, IBANs, card numbers or secrets is withheld, and
Claude asks a private model you choose to work with it instead: a local one, or one on your own server.

Claude still plans, codes and orchestrates. A total, a count or a summary without personal data reaches it as usual;
the bank statement, the contract or the customer list it came from does not.

## Quick start

You need [anymodel](../anymodel) with an agent on a private model, [uv](https://docs.astral.sh/uv/), and a Mac with
Apple silicon (the checks run on MLX).

```text
/plugin marketplace add ph3on1x/agent-plugins-skills
/plugin install anymodel@ph3on1x
/plugin install personal-computer@ph3on1x
```

Installed, personal-computer is off: Claude Code works as before, and nothing is checked until you turn it on.

1. Add the private agent in `/plugin configure anymodel`, for example `qwen` on `http://127.0.0.1:8888`.
2. Run `/personal-computer`. Its pane shows how it stands and its settings: pick **Private agent** `qwen` there.
3. Press **Set up** (`s`). It downloads the detection models (3.7 GB for both) from Hugging Face, starts the scanner
   and checks it: it must find the name and IBAN in a test text. Once that passes, it is on, and the footer shows
   **personal computer** beside Claude Code's own modes.

The pane lists each part: the Mac, uv, the models, the scanner, and your private agent, with a warning when it is not
on this machine. Its settings write to `/plugin configure personal-computer`. Where no pane can be shown (`claude -p`),
`/personal-computer check` prints the same and `/personal-computer setup` sets it up. `/anymodel check <agent>` tests
that the agent answers. To turn personal-computer off again, disable the plugin in `/plugin`.

Then ask as you would: "what did I spend on groceries in October? The statement is in ~/Downloads". Claude finds the
file, the statement is withheld from it, and Claude hands the question to `anymodel:qwen`, which reads it on your
machine and answers.

## Modes

**When personal data is found** (`/plugin configure personal-computer`):

| Mode | Claude gets |
|---|---|
| `private` (default) | A notice of what was found, by type and count, never a value. Claude asks your private agent, which reads the output from a local copy. |
| `mask` | The output with each value replaced by a placeholder: `[PERSON_1]`, `[IBAN_1]`. Files Claude writes get the real values back. |
| `ask` | Your choice each time: process privately, mask, share as-is or leave out. With no one to ask (`claude -p`), it stays private. |

Files the engine reads into a request itself, a file you name after an `@` and a file Claude read that changed on disk
since, are checked the same way. An `@`-mentioned image is not read, as it cannot be checked (in `ask` mode you can
share it).

**Your prompts** (`prompts`) are checked before they reach Claude, pasted text included. With `ask` (default), a prompt
with personal data asks you: mask it, send it as is, or cancel. `mask` masks without asking, and with no one to ask
(`claude -p`) the prompt is masked too. `off` leaves prompts unchecked. Slash commands are not checked.

## How it works

Two models check each output, both on your machine: [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter)
and [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer). IBANs and card numbers are also found by their
checksums. A short output takes well under 100 ms. **Detection models** (`detectors`) picks `both` (default), `opf`
or `pii-tracer`: one model alone needs less disk and memory, and finds less.

| Checked | Not counted |
|---|---|
| Names, email addresses, phone numbers, postal addresses, account and card numbers, secrets | Dates, URLs, amounts, reference numbers, published test card numbers and IBANs, your own name and email (git and your Mac account) |

One scanner process serves all your sessions. It listens on 127.0.0.1 only and exits after 30 minutes without a
request. Withheld outputs and masked answers are kept in `~/.local/state/personal-computer/withheld`, readable by you
only.

**Answers are checked too:** your private agent's, and every background task's notification (subagents run in the
background by default). If one holds personal data, Claude gets it masked and you get a notice with the path of the
full text.

**Once on, anything that cannot be checked is withheld,** and a warning line under the prompt says so until a check
works again (`⚠ personal-computer: can't check for personal data, so outputs are withheld`). A prompt that cannot be
checked asks whether to send it unchecked (with `prompts` set to `ask`); otherwise it is not sent. Images are
withheld as well: the text models cannot read them.

## Limits

- Detection is statistical: a model can miss a value, or flag a word that is none (a shop on a statement row can
  count as an address). The defaults favour finding. Test fixtures with realistic data get withheld too.
- An image you paste into a prompt cannot be checked: in `ask` mode you choose to send it or not, in `mask` mode it
  goes as is.
- Text other settings hooks and plugins add for Claude (their context) is not checked.
- The footer label and the pane are drawn in the terminal and the desktop app. VS Code shows the pane but no label,
  and mobile shows neither; the warning line shows everywhere. Use `/personal-computer check` where there is no pane.
- Changing a setting reloads the plugin, so the pane locks its settings while setup runs.
- The private agent's tools are not sandboxed: it works with your files under your permission rules, as any
  subagent does.
- Claude Code's local transcripts (`~/.claude/projects`) can hold personal data: the private agent's own transcript,
  and background notifications as they were queued. They stay on your machine.
