# `IpAddr.parse_v4` accepts empty octets and leading zeros, and WRAPS on overflow into a wrong address

**Status: OPEN.** **Class**: wrong-value — a caller can bind or connect to an
address the input text never named, with no error anywhere.

**Found**: 2026-09-04, measuring the `net` row of the std API audit (the row
asks for `parse_v6` / `SocketAddr.parse`; the one parser that already exists
turned out to be the defect).

## Symptom

`IpAddr.parse_v4` (`std/net/addr.yo:37-88`) is the only address parser in the
tree. It accepts four inputs it must reject, and for two of them it returns a
plausible, silently WRONG address.

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
open(import("std/string"));
open(import("std/fmt"));
{ IpAddr } :: import("std/net/addr");
{ Error, AnyError, Exception } :: import("std/error");

try_parse :: (fn(s : String) -> unit)({
  unsafe(printf("  %-20s -> ", s.to_cstr().ptr().unwrap()));
  exn := Exception(
    throw : (
      err -> {
        unsafe(printf("REJECTED\n"));
        unwind(());
      }
    )
  );
  addr := IpAddr.parse_v4(s, exn);
  out := addr.to_string();
  unsafe(printf("%s\n", out.to_cstr().ptr().unwrap()));
});

main :: (fn() -> unit)({
  try_parse(`1.2.3.4`);
  try_parse(`1.2.3.`);
  try_parse(`1..2.3`);
  try_parse(`01.02.03.04`);
  try_parse(`4294967297.0.0.1`);
  try_parse(`256.1.1.1`);
  try_parse(`1.2.3.4.5`);
  try_parse(``);
  try_parse(`...`);
  try_parse(`1.2.3.4294967296`);
});
export(main);
```

Observed (`yo 0.2.24`, `yo compile parse_v4.yo --std-path ./std --optimize 2`):

```
  1.2.3.4              -> 1.2.3.4
  1.2.3.               -> 1.2.3.0
  1..2.3               -> 1.0.2.3
  01.02.03.04          -> 1.2.3.4
  4294967297.0.0.1     -> 1.0.0.1
  256.1.1.1            -> REJECTED
  1.2.3.4.5            -> REJECTED
                       -> REJECTED
  ...                  -> 0.0.0.0
  1.2.3.4294967296     -> 1.2.3.0
```

Expected: every line except `1.2.3.4` is `REJECTED` (this matches Rust's
`Ipv4Addr::from_str`, which also rejects empty components and leading zeros).

The last four rows are the dangerous ones:

- `4294967297.0.0.1` → **`1.0.0.1`**. `4294967297` is `2^32 + 1`; the `u32`
  accumulator wraps to `1`, which is `<= 255`, so the range check passes and a
  completely different host is returned.
- `1.2.3.4294967296` → **`1.2.3.0`**, the same wrap on the final octet.
- `...` → **`0.0.0.0`**, i.e. the wildcard address, from a string containing no
  digits at all. A service that parses a configured "bind address" and gets
  `0.0.0.0` back binds every interface instead of failing.
- `1.2.3.` → `1.2.3.0` and `1..2.3` → `1.0.2.3`, both from a missing component.

## Root cause

`std/net/addr.yo:37-88`. The scanner has three independent holes.

1. **No saw-a-digit flag per component.** `val` starts at `0` and is reset to
   `0` after each separator (`:60-62`). Nothing records whether any digit was
   consumed, so an empty component is indistinguishable from a literal `0`.
   That is `1.2.3.` (empty last), `1..2.3` (empty second) and `...` (four
   empties).

2. **The range check runs only at a separator or at end of input**, not per
   digit — `:54-59` for the `.` arm and `:80-85` after the loop. The
   accumulator itself is

   ```rust
   val = ((val * u32(10)) + u32(ch - _ASCII_ZERO));      // std/net/addr.yo:66
   ```

   with no bound, so a component with ten or more digits wraps modulo 2^32
   *before* `val > u32(255)` is ever evaluated, and the check then sees the
   wrapped residue. `4294967297 mod 2^32 == 1`.

3. **No leading-zero rule.** `01` accumulates to `1` and passes. RFC 6943 §3.1.1
   and Rust both reject this, because in some resolvers a leading-zero component
   is read as octal — `010` meaning 8, not 10 — which makes it an SSRF-filter
   bypass primitive.

## Fix

Rewrite the component scanner in `std/net/addr.yo:37-88` so each component is
validated as it is built. No workaround (a post-hoc length check on the input
text) — the accumulator itself must be safe:

- Track `digits : usize` per component, reset with `val` at every separator.
  Throw `NetError.Other("empty octet in IPv4 address")` when a `.` or the end
  of input is reached with `digits == 0`.
- Reject leading zeros: if `digits > 0` and `val == 0` and another digit
  arrives, throw. This accepts exactly `0` and rejects `00`, `01`, `010`.
- Bound *inside* the digit arm, before the multiply can wrap:
  `if(digits >= 3 || val > u32(25), throw)` is fragile; the clean form is to
  compute into the same `u32` but check first —
  `cond((val > u32(25)) => throw, true => ())` before `val * 10`, then
  `cond((val > u32(255)) => throw, true => ())` after the add. With
  `digits <= 3` enforced, no multiply can ever exceed `u32` range.

Keep the existing `Exception`-throwing signature. std is genuinely inconsistent
about parse error style (`String.parse_i32` → `Option`, `DateTime.parse` →
`Result`, `Url.parse` → throws), but changing `parse_v4`'s signature is a
separate decision that belongs with that cross-std cleanup, not with a
correctness fix.

## Breaking change

Yes, and it must be named in the release notes: text that parses today
(`1.2.3.`, `1..2.3`, `01.02.03.04`, `4294967297.0.0.1`) will start throwing.
Every one of those cases currently produces an address the input did not name,
so the break is the point.

## Regression test

`tests/net/addr.test.yo`. It currently pins only the happy path plus
`999.0.0.1` / `1.2.3` / `1.2.3.abc` (lines 55-100), so none of the four defects
is covered. Add a reject table asserting the exception fires for:
`1.2.3.`, `.1.2.3`, `1..2.3`, `...`, `01.02.03.04`, `00.0.0.0`, `010.0.0.1`,
`4294967297.0.0.1`, `1.2.3.4294967296`, `99999999999.1.1.1`;
plus an accept table that must keep working: `0.0.0.0`, `1.2.3.4`,
`127.0.0.1`, `255.255.255.255`, `192.168.1.100`. Verify the reject cases fail
before the fix — today they all pass, which is the bug.
