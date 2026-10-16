# strict-schema-check

**Catch the tool-schema problems that cause 400s — before you ship.**

Strict mode (Anthropic `"strict": true`, OpenAI structured outputs) compiles your JSON Schema into a
grammar. A schema that validates perfectly in your editor still fails there, because the grammar
compiler accepts only a subset of JSON Schema.

This is a zero-dependency CLI that checks the rules that actually bite, and tells you the exact JSON
path of every problem.

```
$ strict-schema-check tools.json

schema checked — 5 blocking problems
  (checked the "input_schema" block of the tool definition)

  ERROR $ — missing "additionalProperties": false — an open object has no closed grammar to compile
  ERROR $ — not listed in "required": filters — optional fields must be a union with null
  ERROR $.properties.order_id — 'maxLength' is rejected or ignored in strict mode
  ERROR $.properties.filters — missing "additionalProperties": false — an open object has no closed grammar to compile
  ERROR $.properties.filters — not listed in "required": status — optional fields must be a union with null

  optional params: 0/24   union-typed: 0/16   tools: 1/20

FAIL — fix the errors above before sending this schema to the API.
```

## Install

No dependencies. Node 14+.

```bash
git clone https://github.com/RichChrisDotCom/strict-schema-check.git
cd strict-schema-check
node strict-schema-check.js your-tools.json
```

Or install it locally so `strict-schema-check` is on your PATH:

```bash
npm install -g .
```

## Use

```bash
strict-schema-check tools.json          # a file
cat tools.json | strict-schema-check -  # stdin
strict-schema-check tools.json --json   # machine-readable
strict-schema-check tools.json --quiet  # exit code only
```

**Input can be** a single tool definition (`{name, input_schema}` — or `parameters` for OpenAI-shaped
definitions), a bare JSON Schema, or **an array of tools**. Pass the array and it checks the
per-request caps too, which only make sense across the whole toolset.

**Exit codes:** `0` clean · `1` blocking problems · `2` bad usage or invalid JSON.

### In CI

```yaml
# .github/workflows/schemas.yml
name: schemas
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: git clone --depth 1 https://github.com/RichChrisDotCom/strict-schema-check.git /tmp/ssc
      - run: node /tmp/ssc/strict-schema-check.js tools.json
```

## What it checks

| Rule | Why it fails |
|---|---|
| `additionalProperties: false` on **every** object, nested included | JSON Schema defaults it to `true`; an open object has no closed grammar to compile. This is the single most common cause of a 400. |
| Every key in `properties` also appears in `required` | Strict mode has no notion of an optional field. Express optionality as a union with null. |
| No `minimum` / `maximum` / `multipleOf` | Numeric bounds are rejected or ignored. |
| No `minLength` / `maxLength` / `pattern` | String bounds are rejected or ignored — and dropped silently from the wire. |
| No external `$ref`, `definitions`, `$defs`, recursive schemas | Not supported. |
| No `oneOf` / `allOf` | Commonly rejected. `anyOf` works but cannot sit at the root. |
| `format` from a supported set only | `date-time`, `date`, `time`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`. Anything else is dropped silently. |
| Per-request caps | 20 strict tools · 24 cumulative optional parameters · 16 union-typed parameters, across all strict schemas in one request. |

Strict mode constrains the **shape**. It does not check your business rules — validate those at your
own boundary.

## Prefer a browser?

The same checks run at **[richchris.com/tools/strict-schema-validator](https://richchris.com/tools/strict-schema-validator)** —
paste a schema, get the same report, nothing uploaded. It also produces a shareable permalink of the
schema you're checking.

## Tests

```bash
node test.js
```

## Background

The rules and the failure modes are written up here:
**[Tool-calling JSON schemas, explained](https://richchris.com/blog/agent-tool-calling-json-schemas)**

If you're building agents and want the rest of it — multi-tool dispatch, memory, and a deployment
path — that's the [Deploy Your First AI Agent](https://richchris.com/guides) guide. The free
walkthrough of the agent loop itself is at [richchris.com/free](https://richchris.com/free).

## License

MIT — use it, fork it, ship it.
