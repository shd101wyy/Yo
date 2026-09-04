# `toml_parse` returns `.Ok` with a corrupted document for twelve inputs instead of parsing or rejecting them

**Status:** OPEN — silent data corruption from a shipped parser. Found
2026-09-04 in the std-API-audit re-measurement of the encoding/TOML row.

`std/encoding/toml.yo` documents itself as a subset parser (*"Parses a subset of
TOML … Supports: strings, integers, booleans, table sections, comments"*,
`toml.yo:3-4`). A subset is fine when the unsupported part **errors** — and much
of it does (`pi = 3.14`, `a = [1, 2, 3]`, `n = 0xDEADBEEF`, `d = 1979-05-27`
all return `.Err`, which a caller can detect and act on). This issue is about
the other class: twelve inputs — ten with a definite meaning in TOML v1.0.0,
two that TOML rejects outright — which `toml_parse` accepts as `.Ok` while
quietly producing a **different document**.
A caller cannot detect any of them.

## Reproducer

```rust
{ toml_parse, TomlValue } :: import("std/encoding/toml");
open(import("std/string"));
open(import("std/fmt"));

keys_of :: (fn(v : TomlValue) -> String)({
  (out : String) = String.new();
  match(
    v,
    .Table(keys, values) => {
      i := usize(0);
      while(i < keys.len(), i = (i + usize(1)), {
        k := keys(i);
        out = (((out + `<`) + k) + `> `);
      });
    },
    _ => ()
  );
  out
});

probe :: (fn(label : String, src : String) -> unit)({
  r := toml_parse(src);
  match(
    r,
    .Ok(v) => {
      ks := keys_of(v);
      println(`${label}: Ok, ${ks}`);
    },
    .Err(e) => {
      println(`${label}: Err(${e})`);
    }
  );
});

main :: (fn() -> unit)({
  probe(`[[fruit]]         `, `[[fruit]]`);
  probe(`[server.http]     `, `[server.http]`);
  probe(`"my key" = 1      `, `"my key" = 1`);
  probe(`a.b = 1           `, `a.b = 1`);
  probe(`a = 1 / a = 2     `, `a = 1
a = 2`);
  probe(`[t] x=1 / [t] y=2 `, `[t]
x = 1
[t]
y = 2`);
  probe(`garbage line      `, `this is not toml at all`);
  probe(`[not a header     `, `[not a header`);
  r1 := toml_parse(`s = """`);
  match(r1, .Ok(v) => { s1 := v.get(`s`).unwrap().as_string().unwrap(); println(`s = """       : Str<${s1}>`); }, .Err(e) => ());
  r2 := toml_parse(`s = "a" # "c"`);
  match(r2, .Ok(v) => { s2 := v.get(`s`).unwrap().as_string().unwrap(); println(`s = "a" # "c" : Str<${s2}>`); }, .Err(e) => ());
  r3 := toml_parse(`s = "a\\nb"`);
  match(r3, .Ok(v) => { s3 := v.get(`s`).unwrap().as_string().unwrap(); println(`s = "a\\nb"    : Str<${s3}>`); }, .Err(e) => ());
  r4 := toml_parse(`n = 99999999999999999999`);
  match(r4, .Ok(v) => { n4 := v.get(`n`).unwrap().as_int().unwrap(); n4s := n4.to_string(); println(`n = 9999...9  : Int<${n4s}>`); }, .Err(e) => ());
  r5 := toml_parse(`a = 1
a = 2`);
  match(r5, .Ok(v) => { n5 := v.get(`a`).unwrap().as_int().unwrap(); n5s := n5.to_string(); l5 := v.table_len().to_string(); println(`dup get(a)    : Int<${n5s}> table_len=${l5}`); }, .Err(e) => ());
});
export(main);
```

Observed (`yo` v0.2.24, `--std-path ./std --optimize 2`):

```
[[fruit]]         : Ok, <[fruit]> 
[server.http]     : Ok, <server.http> 
"my key" = 1      : Ok, <"my key"> 
a.b = 1           : Ok, <a.b> 
a = 1 / a = 2     : Ok, <a> <a> 
[t] x=1 / [t] y=2 : Ok, <t> <t> 
garbage line      : Ok, 
[not a header     : Ok, 
s = """       : Str<">
s = "a" # "c" : Str<a" # "c>
s = "a\nb"    : Str<a\nb>
n = 9999...9  : Int<7766279631452241919>
dup get(a)    : Int<1> table_len=2
```

What TOML v1.0.0 requires, line by line:

| input | produced | required |
| --- | --- | --- |
| `[[fruit]]` | a table under the key `[fruit]` (brackets in the key!) | an array of tables named `fruit` |
| `[server.http]` | one flat root key `server.http` | nested table `server` → `http` |
| `"my key" = 1` | key `"my key"` — quotes kept | key `my key` |
| `a.b = 1` | flat key `a.b` | nested table `a` → key `b` |
| `a = 1` twice | two entries keyed `a`; `get` returns the first | an error (duplicate key) |
| `[t]` twice | two tables keyed `t`; the second is unreachable via `get` | an error (table redefinition) |
| `this is not toml at all` | `.Ok`, zero keys | a parse error |
| `[not a header` | `.Ok`, zero keys | a parse error |
| `s = """` | the one-character string `"` | the start of a multi-line string |
| `s = "a" # "c"` | the string `a" # "c` | the string `a` plus a comment |
| `s = "a\nb"` | backslash-n kept literally | a newline |
| `n = 99999999999999999999` | `Int<7766279631452241919>` | an error (out of i64 range) |

## Root cause

`toml_parse` (`std/encoding/toml.yo:147-200`) is a line-based loop —
`lines := input.split("\n")` (`:152`) — that classifies each trimmed line with
one `cond` (`:160-194`). Every entry above traces to one of six decisions in
that `cond` and in the value parser it calls:

- **`:164`** — a table header is any line matching
  `line.starts_with("[") && line.ends_with("]")`, and the name is
  `line.substring(usize(1), line.len() - usize(1))` (`:165`). `[[fruit]]`
  satisfies the test, and stripping one bracket from each end leaves the literal
  name `[fruit]`. The name is never split on `.`, so `[server.http]` becomes one
  flat key. Nothing checks whether that name already exists, so `[t]` twice
  makes two sibling tables.
- **`:178`** — the key is `line.substring(usize(0), pos).trim()` and nothing
  else: never unquoted, never split on `.`. Hence `"my key"` keeps its quotes
  and `a.b` stays flat.
- **`:183-184`** — the accepted pair is appended with raw
  `cur_keys.push(key); cur_vals.push(val);`. This bypasses the module's OWN
  duplicate handling: `TomlValue.insert` (`:55-81`) scans for an existing key
  and overwrites it. The two paths disagree, and `get` (`:32-49`) returns the
  FIRST match, so a duplicate later key is silently dead.
- **`:191`** — `.None => ()`: a line with no `=` that is not blank, not a
  comment and not header-shaped is **discarded**. That is the whole
  garbage-line and `[not a header` behaviour.
- **`:112-125`** — a value is a string iff it starts AND ends with `"`
  (`trimmed.starts_with(...) && trimmed.ends_with(...)`), and the content is
  `substring(1, len-1)` with no scanning in between. `"""` passes the test
  (`len >= 2`) and yields `"`; `"a" # "c"` passes and swallows the comment; no
  escape sequence is ever decoded.
- **`:138`** — integers go through `String.parse_i64`, which wraps on overflow
  (`issues/parse-i64-and-parse-u64-wrap-on-overflow.md`). Fixing that one turns
  the last row into an `.Err`.

Being line-based is also why this cannot be patched case by case: multi-line
basic strings, arrays spanning lines and inline tables all require a scanner
that crosses line boundaries, and a typed error with byte positions (D4) needs
offsets into the original input, which `split("\n")` fragments have thrown away.

## Fix

Replace the line loop with a byte scanner over `input.as_bytes()`, in the shape
`std/encoding/csv.yo` and `json.yo`'s `_Parser` already use. Concretely, and
with no shortcuts:

1. **Keys** — a real key parser: bare (`A-Za-z0-9_-`), basic-quoted (with escape
   decoding), literal-quoted (`'…'`), and dotted; a dotted key BUILDS nested
   tables rather than producing a key containing `.`.
2. **Headers** — `[a.b.c]` walks/creates the nested path; `[[a]]` is an
   array-of-tables append, which needs an `Array(items : ArrayList(Self))`
   variant on `TomlValue` (`toml.yo:15-24` has only `Str`/`Int`/`Bool`/`Table`).
3. **Values** — scan the value rather than testing its ends: basic strings with
   escapes and a `"""` multi-line form, literal strings, and a comment that may
   only start OUTSIDE a string.
4. **Errors** — hard-error on: a duplicate key, a redefined table, an
   unterminated header, an unterminated string, and any line that is not blank,
   comment, header or `key = value`. Per D1 these become a real
   `TomlError` enum with byte positions (see `CsvError`, `csv.yo:27-40`),
   replacing both `Result(_, String)` signatures (`toml.yo:103`, `:147`).
5. **Integers** — strip `_`, dispatch `0x`/`0o`/`0b` to `parse_i64_radix`, and
   report overflow instead of wrapping.

Steps 1-4 are the corruption fix; the float/array/datetime value forms are the
separate feature gap and share the same scanner.

Whatever the sequencing, **`.Ok` with a different document than the input
denotes is the bug** — every construct above must either parse correctly or
return `.Err`.

## Regression test

`tests/toml/toml.test.yo` is the only encoding test outside `tests/encoding/`
(its siblings `base64`, `csv`, `hex`, `html`, `json`, `percent`, `utf16`, `utf8`
all live there); move it to `tests/encoding/toml.test.yo` as part of this work.

Its current 10 tests are all happy paths of the supported subset and assert
nothing about rejection. Add one assertion per row of the table above — either
the correct parse or `.is_err()`, never `.Ok` with the mangled shape. The
duplicate-key, table-redefinition and garbage-line cases must be verified RED
before the fix (they pass today as `.Ok`).

## Breaking change

Yes on two counts, and both are wanted: documents that used to "parse" now
return `.Err`, and the error type changes from `String` to `TomlError`. Nothing
in the tree consumes the module — the only non-comment reference anywhere is
`tests/toml/toml.test.yo:2` — so the blast radius is external users only. Call
it out in the release notes.
