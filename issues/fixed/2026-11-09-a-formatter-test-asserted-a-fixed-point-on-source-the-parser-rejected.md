# A formatter test asserted a fixed point on source the parser rejected

**Severity:** S3 — a test proved nothing for months and turned develop's battery red once the parser started accepting its input.

**Status:** fixed (fix-forward after #1844).

## Symptom

Develop battery 42585842851 (on 11fb159f9) failed
`Compiler internal tests (tests/internal, self-hosted differential shard 4)`:

```
✗ fmt comma frames: multiline call inside a multiline array is unchanged
  Test failed with exit code 134
  canonical exploded form is stable (at std/assert.yo:39:17)
```

The last battery that ran the shard to completion, on e70c8a21a, passed it.

## Root cause

The test's source wrote a one-element array as `[\n add(…)\n ]`, with no trailing comma.
Until decision 49 S1a (#1844), `[x]` was a parse error ("[T] slice type syntax has been
removed"). The formatter passes source the parser rejects through unchanged, so the assertion
`out == src` held trivially, and it held for the non-canonical `((a + b))` on the first line too.

#1844 made `[T]` parse to the builtin `Slice(T)`. The source now parses, the formatter formats
it, and the redundant group in `(fn(a : i32, b : i32) -> i32)((a + b))` elides to `(a + b)`, so
the output differs from the input.

## Fix

The test now uses the canonical first line and a real one-element array value with its trailing
comma (`[\n add(…),\n ]`), which is what "a multiline call inside a multiline array" means. The
exploded form is a fixed point under the current formatter. Test:
`tests/internal/formatter.test.yo`, "fmt comma frames: multiline call inside a multiline array is
unchanged".
