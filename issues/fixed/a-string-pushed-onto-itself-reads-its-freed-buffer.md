# A `String` pushed onto itself reads its freed buffer

**Severity:** S1: silently wrong result in safe code. `s.push_string(s)` appends garbage bytes instead of a second copy of `s`, and nothing reports it. The bytes come from the buffer `s` just released while growing.

**Status: FIXED** in String S3a (`plans/STRING_VALUE_SEMANTICS.md` §0). `push_string` grows `self` before it reads `other`'s pointer. Test: `tests/string/string.test.yo`, "s.push_string(s) appends a copy of itself". Before the fix, with `push_string` as it is on develop, the test fails with exit code 6. It passes after the fix.

Found 2026-10-05, while reworking String S3 into S3a. The copy-on-write version of S3 had hidden the bug: its uniqueness step cloned the shared buffer before the write.

## Symptom

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := String.from("ab");
  s.push_string(s);
  println(`[${s}] len=${s.len().to_string()}`); // [ab  ] len=4, not [abab]
  t := String.from("0123456789abcdef0123456789abcdef");
  t.push_string(t);
  println(`[${t}] len=${t.len().to_string()}`); // the second half is not the first
});
export(main);
```

Compiled with yo 0.2.52 against develop's std (`--std-path ./std` at `63314d43c`), the appended half is not a copy of the first. The length is right, so only the bytes give it away. On macOS, `--sanitize address --allocator system` reports nothing, because ASan does not arm there (`.github/instructions/testing.instructions.md`, "Writing a test that observes a LEAK").

## Cause

`push_string(inout(self), other)` took `other`'s data pointer (`ob.ptr()`) and then called `al.extend_from_ptr(p, olen)` on `self`'s list. When `other` is `self`, `ob` and `al` are the same `ArrayList`. The extend grows the list, which reallocates and frees the old buffer, and then it copies `olen` bytes from `p`, which still points at that freed block.

## Fix

`std/string/string.yo` `push_string`: when `self` already has a buffer, it reserves `len + olen` first (`ensure_total_capacity`), and only then reads `other`'s pointer. If the two strings share one list, the pointer is now the grown buffer. The extend no longer reallocates, so the source `[0, olen)` and the destination `[len, len + olen)` do not overlap.

## Related

The same shape is a hazard wherever a mutator takes a pointer into an argument that can share `self`'s buffer. `push_str(s : str)` cannot receive a view of its receiver today, because `String` has no `as_str`. Unique ownership (VALUES_BY_DEFAULT V2b) rules the aliasing out structurally.
