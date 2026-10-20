/**
 * Argument parsing for the companion CLI. Slash commands pass "$ARGUMENTS" as one argv element,
 * so that raw string is split shell-style first. Unknown flags stay positional (task text).
 */

export type ParseSpec = {
  readonly values?: readonly string[];
  readonly booleans?: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
};

export type Parsed = {
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly positionals: readonly string[];
};

/**
 * Splits a raw argument string. A quote opens a quoted span only at the start of a token or right
 * after `=` (`--base='main'`); anywhere else it is literal, so focus text such as `don't` survives.
 */
export function splitRawArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  let escaping = false;
  for (const ch of raw) {
    if (escaping) {
      current += ch;
      escaping = false;
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "\\") {
      escaping = true;
      started = true;
    } else if ((ch === "'" || ch === '"') && (!started || current.endsWith("="))) {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`Unmatched ${quote} in arguments: ${raw}`);
  if (escaping) current += "\\";
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Slash commands run `companion <cmd> "$ARGUMENTS"`: a lone element is the raw argument string.
 * Only used for slash-command entry points; `task` takes its prompt on stdin so quotes and
 * apostrophes in task text survive untouched.
 */
export function expandRawArguments(argv: readonly string[]): string[] {
  return argv.length === 1 ? splitRawArgs(argv[0] ?? "") : [...argv];
}

export function parseArgs(tokens: readonly string[], spec: ParseSpec): Parsed {
  const values = new Set(spec.values ?? []);
  const booleans = new Set(spec.booleans ?? []);
  const aliases = spec.aliases ?? {};
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const long = token.startsWith("--");
    const body = token.slice(long ? 2 : 1);
    const eq = long ? body.indexOf("=") : -1;
    const rawKey = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const key = aliases[rawKey] ?? rawKey;

    if (booleans.has(key)) {
      options[key] = inline === undefined ? true : inline !== "false";
    } else if (values.has(key)) {
      const value = inline ?? tokens[i + 1];
      // `--model --background` is a missing model, not a model named "--background".
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
        throw new Error(`Missing value for ${token}`);
      }
      options[key] = value;
      if (inline === undefined) i += 1;
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

export const stringOption = (parsed: Parsed, key: string): string | undefined => {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
};

export const flag = (parsed: Parsed, key: string): boolean => parsed.options[key] === true;
