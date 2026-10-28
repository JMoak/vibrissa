# Matchers

How a case's `expect` (and `expectInputRequired`, `expectError.message`) is compared with
what the server returned. This page is meant to be enough on its own to write cases.

## How matching works

1. The runner **normalizes** the live result first (see [Normalization](#normalization)),
   so protocol noise such as `resultType` and `_meta["io.modelcontextprotocol/…"]` is gone
   before any comparison.
2. Any `{"$ref": …}` in the expectation is **expanded** from fragment files.
3. The expectation is compared with the result:
   - **Plain JSON means exact deep equality.** Object key order doesn't matter. Extra keys
     on the actual object fail. Arrays must have the same length and order.
   - **Matcher objects** are objects whose key is one of the `$` names on this page,
     e.g. `{"$type": "string"}`. They are interpreted, not compared literally.
   - **Any other `$` key is an error**, caught when the case loads:
     `"$partail" is not a matcher; did you mean "$partial"? Use {"$literal": ...} for data with a literal $-key`.
     The one exception is a string-valued `$schema` (a JSON Schema dialect URI), which is
     plain data. Wrap data that really has `$` keys (`$id`, `$defs`, Mongo operators) in
     [`$literal`](#literal); `vib record` does it for you.
4. Every failure is reported with a **path** into the result, `content[0].text` style.
   Unusual keys are quoted: `_meta["com.example/trace"]`. The whole result is `(root)`.
   Failures are listed together, up to 25 per expectation.

```json
{
  "tool": "echo",
  "args": { "text": "hello" },
  "expect": {
    "content": [{ "type": "text", "text": "Echo: hello" }],
    "structuredContent": { "echoed": "hello", "at": { "$type": "string" } }
  }
}
```

A failing case prints lines such as:

```
content[0].text: expected "Echo: hello", got "Echo: hullo"
(root): unexpected key "isError" (use "$partial": true to allow extra fields)
```

## Quick reference

| Matcher | Meaning | Example |
|---|---|---|
| [`$partial`](#partial) | allow extra keys and trailing array items in this subtree | `{"$partial": true, "isError": false}` |
| [`$regex`](#regex) | string matches a regular expression | `{"$regex": "^Echo: ", "flags": "i"}` |
| [`$wildcard`](#wildcard) | string matches a glob (`*`, `?`) | `{"$wildcard": "req_*"}` |
| [`$unordered`](#unordered) | array in any order | `{"$unordered": true, "value": ["a", "b"]}` |
| [`$any`](#any) | key is present, any value (null too) | `{"$any": true}` |
| [`$type`](#type) | JSON type check | `{"$type": ["string", "null"]}` |
| [`$schema`](#schema) | validate against inline JSON Schema 2020-12 | `{"$schema": {"type": "object", "required": ["id"]}}` |
| [`$oneOf`](#oneof) | any one of several expectations matches | `{"$oneOf": ["active", "pending"]}` |
| [`$contains`](#contains) | array has an element matching x | `{"$contains": {"type": "image"}}` |
| [`$length`](#length) | array/string length | `{"$length": {"min": 1, "max": 10}}` |
| [`$number`](#number) | numeric range | `{"$number": {"gte": 0, "lt": 100}}` |
| [`$ignore`](#ignore) | anything, even missing | `{"$ignore": true}` |
| [`$ref`](#ref) | reuse an expectation fragment from a file | `{"$ref": "./shared/user.json"}` |
| [`$literal`](#literal) | compare as plain data, no matchers inside | `{"$literal": {"$ref": "#/$defs/a"}}` |

## Which matcher should I use?

| Situation | Use | Example |
|---|---|---|
| Timestamp you can't predict | `$schema` with a `format`, or `$regex` | `"createdAt": {"$schema": {"type": "string", "format": "date-time"}}` |
| Generated ids / uuids | `$regex` or `$wildcard` | `"id": {"$wildcard": "req_*"}` |
| Value varies, but the key must exist | `$any` | `"requestId": {"$any": true}` |
| Field may or may not be there | `$ignore` | `"debug": {"$ignore": true}` |
| Field optional, but typed when present | `$schema` on the parent | `{"$schema": {"properties": {"note": {"type": "string"}}}}` |
| Only some fields matter | `$partial` | `{"$partial": true, "isError": false}` |
| Streaming / LLM / long text | `$regex`, `$wildcard`, `$length` | `"text": {"$wildcard": "*Summary:*"}` |
| Text contains a substring | `$wildcard` with stars | `"text": {"$wildcard": "*created*"}` |
| List in any order, all items known | `$unordered` | `{"$unordered": true, "value": [1, 2, 3]}` |
| List has *at least* these items, any order | `$unordered` + `$partial` | `{"$unordered": true, "$partial": true, "value": [{"id": 2}]}` |
| List has *some* item like this | `$contains` | `"content": {"$contains": {"type": "image"}}` |
| Exactly N items like this | `$contains` + `count` | `{"$contains": {"type": "text"}, "count": 1}` |
| Non-empty list / bounded size | `$length` | `{"$length": {"min": 1}}` |
| Counts, scores, durations | `$number` (+ `$type: "integer"`) | `{"$type": "integer", "$number": {"gte": 0}}` |
| A few acceptable values | `$oneOf` | `"status": {"$oneOf": ["queued", "running"]}` |
| Validate `structuredContent` shape | `$schema` | `"structuredContent": {"$schema": {…}}` |
| Same shape in many cases | `$ref` | `"user": {"$ref": "./shared/user.json"}` |
| Data that itself has `$ref`/`$type`/… keys | `$literal` | `"inputSchema": {"$literal": {…}}` |

Tip: if a tool declares an `outputSchema`, the runner validates `structuredContent` against
it on every call (unless the case sets `"validateOutput": false`), using the same validator
as `$schema`. Use `$schema` for extra constraints, not to repeat that schema.

## The rules

### Matcher objects stand alone (precedence)

An object that contains a matcher key **is only that matcher**. Plain keys next to a
matcher are an error, reported as an `invalid matcher` mismatch (the case fails), never
silently ignored:

```json
{ "text": { "$regex": "^a", "note": "why" } }
```
```
text: invalid matcher: "note" cannot sit next to $regex; a matcher object holds only the matcher and its options. Move plain fields to the enclosing object, or wrap data that really has these keys in {"$literal": ...}
```

Each matcher has a fixed set of options that may sit next to it, and nothing else may:

| Matcher | Allowed options |
|---|---|
| `$regex` | `flags` |
| `$unordered` | `value` (required), `$partial` |
| `$contains` | `count`, `$partial` |
| `$oneOf` | `$partial` |
| all others | none |

### Combining matchers in one object = AND

Several matchers in one object must **all** pass. They run in a fixed order
(`$any`, `$type`, `$number`, `$length`, `$regex`, `$wildcard`, `$schema`, `$contains`,
`$unordered`, `$oneOf`) and only the first failure is reported:

```json
{ "count": { "$type": "integer", "$number": { "gte": 1 } } }
{ "content": { "$type": "array", "$length": { "min": 2 }, "$contains": { "type": "image" } } }
```

`$ignore`, `$ref` and `$literal` cannot be combined with anything.

### Matchers nest anywhere

Matchers can appear at any depth, inside each other, and inside arrays:
`$partial` + `$contains`, `$oneOf` of `$regex`es, `$unordered` items using `$type`,
`$contains` of an object with a `$regex` field, and so on.

```json
{
  "$partial": true,
  "content": {
    "$contains": {
      "type": "text",
      "text": { "$oneOf": [{ "$regex": "^Error" }, { "$wildcard": "*failed*" }] }
    }
  }
}
```

### Missing keys

A key in the expectation that's missing from the actual object fails with
`missing expected key (expected …)`, whatever the matcher, with two exceptions:
`$ignore`, and a `$oneOf` that has an `$ignore` alternative. `$any` needs the key to be
present.

### Partial mode

Partial mode (from `$partial: true`) applies to the whole subtree below it: objects may
have extra keys, and arrays may have extra **trailing** elements (order still matters).
Matchers with nested expectations (`$oneOf`, `$unordered`, `$contains`, `$literal`) inherit
it. It never loosens `$schema`, `$length`, `$number` or `$type`.

## v1 matchers

### `$partial`

Allow extra fields: the object and everything under it only need the fields you list.

```json
{ "expect": { "$partial": true, "structuredContent": { "user": "jordan" } } }
```

Failure (fields you list are still checked):
```
structuredContent.user: expected "jordan", got "sam"
```

Notes:
- `"$partial": false` switches back to exact matching for a subtree:
  `{"$partial": true, "meta": {"$partial": false, "v": 1}}`.
- `{"$partial": true}` with no other keys matches any object.
- On `$unordered`, `$contains` and `$oneOf`, `$partial` sets the mode for their elements or
  alternatives. Anywhere else next to a matcher it's an `invalid matcher`.
- In partial mode `[x]` matches `[x, y]` but not `[y, x]`. For "contains" use `$contains`
  or `$unordered` + `$partial`.
- A `$partial` that isn't `true`/`false` is an `invalid matcher`.

### `$regex`

The string matches a JavaScript regular expression, unanchored. Optional `flags` (`"i"`,
`"m"`, `"s"`, `"u"` …).

```json
{ "text": { "$regex": "^Echo: .+", "flags": "s" } }
```

Failures:
```
text: expected string matching /^Echo: /, got "hello"
text: expected a string matching /^Echo: /, got number
text: invalid $regex pattern /([/: Invalid regular expression: /([/: Unterminated character class
```

Notes: escape backslashes for JSON (`"\\d+"`). Anchor with `^…$` when you mean the whole
string.

### `$wildcard`

A glob over the **whole** string: `*` = any run of characters (newlines included), `?` =
exactly one. Everything else is literal (no regex escaping needed).

```json
{ "id": { "$wildcard": "req_*" }, "text": { "$wildcard": "*created*" } }
```

Failure:
```
id: expected string matching wildcard "req_*", got "job_1"
```

### `$unordered`

The array matches `value` in any order, as a multiset (duplicates count). Each actual
element can satisfy only one expected element. Exact length unless partial.

```json
{ "tags": { "$unordered": true, "value": ["a", "b"] } }
{ "items": { "$unordered": true, "$partial": true, "value": [{ "id": 2 }] } }
```

Failure (names the expected element nothing matched, and the closest leftover element):
```
tags: no arrangement of the actual array satisfies the expected elements (unordered): expected value[0] "a" matches no actual element; closest is tags[1]: expected "a", got "c"
```

Notes:
- With partial mode (inherited, or `"$partial": true` on the matcher) the actual array may
  have extra elements, and elements are compared in partial mode.
- `value` items can be any expectation (`$type`, `$regex`, objects with matchers …).
  Assignment is solved optimally, so overlapping item patterns are fine.
- `$unordered` must be `true` and `value` must be an array, otherwise `invalid matcher`.

## v2 matchers

### `$any`

Present, with any value. `null` counts as present; a missing key fails.

```json
{ "requestId": { "$any": true } }
```

Failure:
```
requestId: missing expected key (expected {"$any":true})
```

Use `$ignore` instead if the key may be absent.

### `$type`

JSON type check. One of `"string"`, `"number"`, `"integer"`, `"boolean"`, `"object"`,
`"array"`, `"null"`, or an array of them (any may match). `"number"` includes integers;
`"integer"` means a whole number; `"object"` excludes arrays and null.

```json
{ "id": { "$type": "string" }, "parentId": { "$type": ["string", "null"] } }
```

Failures:
```
id: expected type string, got number 42
parentId: expected type string | null, got array (2 items)
```

Notes: combine with `$number`, `$length`, `$regex` in the same object for AND. An unknown
type name is an `invalid matcher` (data that really has a `$type` key, e.g. .NET
`"$type": "Acme.Widget, Acme"`, needs `$literal`).

### `$schema`

Validate the subtree against an inline JSON Schema (2020-12 by default; draft-07 and
2019-09 are honored when the schema's own `$schema` names them). Unknown keywords and
formats are ignored; standard formats (`date-time`, `email`, `uri`, `uuid` …) are checked.
`$ref`s inside the schema resolve within it (`"#/$defs/…"`).

```json
{
  "structuredContent": {
    "$schema": {
      "type": "object",
      "required": ["id", "name"],
      "properties": {
        "id": { "type": "integer" },
        "tags": { "type": "array", "items": { "$ref": "#/$defs/tag" } }
      },
      "$defs": { "tag": { "type": "string", "minLength": 1 } }
    }
  }
}
```

Failure (the first 3 schema errors with full paths, then a count):
```
structuredContent: value does not match $schema: structuredContent must have required property "name"; structuredContent.id must be integer, got string
```

Notes:
- `$schema` is a matcher only when its value is an object or boolean. A string `$schema`
  (a dialect URI such as `"https://json-schema.org/draft/2020-12/schema"`) is plain data,
  so recorded JSON Schema documents still compare normally.
- Partial mode doesn't apply inside; the schema alone decides (`additionalProperties`
  etc.).
- A schema that can't compile (bad keyword value, unresolvable `$ref`) fails with
  `invalid matcher: $schema could not be compiled: …`.
- `$ref`s inside a `$schema` are JSON Schema refs, not Vibrissa fragment refs. To reuse a
  schema across cases, put the whole `{"$schema": …}` matcher in a fragment file and
  `{"$ref": …}` that.

### `$oneOf`

Passes if **any** alternative matches (first match wins; it's "any of", not JSON
Schema's "exactly one"). Alternatives are full expectations.

```json
{ "status": { "$oneOf": ["queued", "running", { "$regex": "^done" }] } }
```

Failure (why each alternative failed, the first 5 shown):
```
status: none of 2 $oneOf alternatives matched: #1 expected "active", got "gone"; #2 expected "pending", got "gone"
```

Notes: inherits partial mode; `"$partial": true|false` next to `$oneOf` sets it for all
alternatives. Including `{"$ignore": true}` as an alternative makes the key optional (for
"optional but typed when present", the parent `$schema` approach is clearer). Must be a
non-empty array.

### `$contains`

The actual value is an array and **at least one** element matches `x`. Elements are
compared in partial mode by default (extra fields on the element are fine).

```json
{ "content": { "$contains": { "type": "text", "text": { "$regex": "^Saved" } } } }
{ "content": { "$contains": { "type": "text" }, "count": 1 } }
{ "rows": { "$contains": { "status": "error" }, "count": { "max": 0 } } }
```

Options:
- `count`: exact number of matching elements (`1`), or a range `{"min": n, "max": n}`.
  `"count": 0` asserts that no element matches.
- `"$partial": false`: elements must match `x` exactly.

Failures:
```
content: expected array to contain an element matching {"type":"image"}, but none of 1 element matched; closest is content[0].type: expected "image", got "text"
content: expected 1 element(s) matching {"type":"text"}, found 2 (at [0], [1])
content: expected array to contain an element matching 1, but the array is empty
```

Notes: only arrays. For "string contains" use `{"$wildcard": "*text*"}` (the message
says so). Combine with `$length` for "contains x and has at least n items".

### `$length`

Length of an array or string: an exact length, or `{"min": n, "max": n}` (either bound
can be left out). Strings count Unicode code points (an emoji is 1).

```json
{ "items": { "$length": { "min": 1, "max": 10 } }, "code": { "$length": 6 } }
```

Failures:
```
items: expected array length >= 1 and <= 10, got 0
code: expected an array or string with length 6, got number 123456
```

Bounds must be non-negative integers with `min <= max`.

### `$number`

Numeric range with any of `gt`, `gte`, `lt`, `lte`, `eq`; all must hold.

```json
{ "durationMs": { "$number": { "gte": 0, "lt": 1000 } } }
{ "count": { "$type": "integer", "$number": { "gte": 1 } } }
```

Failures:
```
durationMs: expected number >= 0 and < 1000, got 1500
durationMs: expected a number >= 0, got string "5"
```

Notes: no float tolerance. For "about 3.14" use `{"gte": 3.13, "lte": 3.15}`. Add
`"$type": "integer"` to require whole numbers.

### `$ignore`

Always matches, even when the key is missing. Unlike `$partial`, it states exactly which
field you don't care about, and the rest of the object stays exact.

```json
{ "content": [{ "type": "text", "text": "ok" }], "debugInfo": { "$ignore": true } }
```

Never fails (except an `invalid matcher` if it isn't `true` or has company). In arrays it
still takes up a slot: `[1, {"$ignore": true}]` needs two elements.

### `$ref`

Reuse an expectation fragment stored in a JSON file. The runner expands refs before
matching; the matcher itself never reads files.

```json
{ "structuredContent": { "user": { "$ref": "./shared/user-shape.json" } } }
{ "content": [{ "$ref": "./shared/fragments.json#/textBlock" }] }
```

`./shared/user-shape.json` is an ordinary expectation and can use any matcher, including
more `$ref`s:

```json
{ "$partial": true, "id": { "$type": "integer" }, "address": { "$ref": "./address.json" } }
```

Rules:
- Paths are relative to **the file that contains the `$ref`**: the case file, or the
  fragment for nested refs. Absolute paths work; remote URLs are rejected by the case
  loader (vendor the fragment into the repo).
- Fragment files may live under the case globs. A JSON file with no operation that a case
  references, or that sits in a `shared/` or `fragments/` directory, is skipped as a
  fragment, not run as a case.
- `file.json#/json/pointer` selects part of a fragment file. Inside a fragment file,
  `"#/pointer"` refers to that same file. In a case file, a `#` ref with no file is an
  error.
- A `$ref` object holds nothing but `$ref` (no `$partial` next to it; put that in the
  fragment).
- `$ref`s inside `$schema` bodies and `$literal` values are left alone.
- Cycles (`a.json` → `b.json` → `a.json`) fail with the chain:
  `$ref cycle at user.next.next: shared/a.json -> shared/b.json -> shared/a.json. Break the cycle by inlining one of the fragments.`
- A missing file fails as:
  `Cannot resolve $ref "./shared/x.json" at user: failed to load "shared/x.json": ENOENT … Ref paths are relative to the file that contains them.`

### `$literal`

Compare the wrapped value as **plain data**: any matcher-looking keys inside (`$ref`,
`$type`, `$regex`, `$partial` …) are just keys. Use it for data that really has such keys,
e.g. a recorded JSON Schema with `$ref`, or Mongo-style query objects.

```json
{ "inputSchema": { "$literal": { "type": "object", "properties": { "a": { "$ref": "#/$defs/a" } } } } }
```

Failure (an ordinary deep-equality failure):
```
inputSchema.$ref: expected "#/$defs/a", got "#/$defs/b"
```

Notes: inherits partial mode from above. Must stand alone. `escapeDirectives()` does this
wrapping automatically for goldens written by `vib record` and `vib run --update`.

## Invalid matchers

A malformed matcher never passes silently. It becomes a mismatch starting with
`invalid matcher:` that says what is wrong:

```
(root): invalid matcher: "$partial" cannot be used with $type (only on plain objects, $unordered, $contains and $oneOf)
(root): invalid matcher: $ignore must be used on its own, not combined with $type
n: invalid matcher: "$number" does not support "min" (use gt, gte, lt, lte, eq)
```

Matchers in a `$oneOf` alternative that's never reached aren't evaluated, but
`lintExpectation()` checks the whole tree statically (unknown `$` keys, regex patterns,
`$schema` compilation) when cases load, in `vib run` and `vib explain`. A malformed or
unknown matcher anywhere fails the case with `errorKind: "load"` before any call is made.

## Normalization

Before matching (and before `record` writes a golden), results are normalized according
to config `normalize` (per case: `"normalize": false` to opt out, or an object):

| Option | Default | Effect |
|---|---|---|
| `stripMeta` | `["io.modelcontextprotocol/*"]` | Remove matching keys from every `_meta` object anywhere in the result. A `_meta` emptied this way is removed. `*` matches any run of characters (including `/`); everything else is literal. |
| `dropKeys` | `["resultType"]` | Remove these top-level result keys. |
| `ttlMs` | `"ignore"` | `"ignore"` removes top-level `ttlMs` and `cacheScope` (list-result cache hints); `"keep"` keeps them. |

So goldens recorded against 2025-era servers keep matching 2026-era servers, which add
`resultType` and `_meta["io.modelcontextprotocol/serverInfo"]`. Don't put those fields in
expectations unless you turned normalization off.

## Library API

```ts
// src/match.ts, src/normalize.ts, src/schema.ts

matchValue(expected, actual, { partial?: boolean }): Mismatch[]   // [] = match
matches(expected, actual, options?): boolean
resolveRefs(expected, loader: (relPath: string) => JsonValue): JsonValue  // throws RefResolutionError
lintExpectation(expected): Mismatch[]
escapeDirectives(recorded): JsonValue
normalizeResult(result, cfg?: NormalizeConfig): JsonValue
validate(schema, value, { resolve? }): { ok, errors: { path, message }[], schemaError? }
```

`Mismatch` is `{ path, message, expected?, actual? }` (see `src/events.ts`).
