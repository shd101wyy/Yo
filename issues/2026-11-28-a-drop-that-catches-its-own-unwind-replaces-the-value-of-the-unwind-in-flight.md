# A `Drop` that catches its own unwind replaces the value of the unwind in flight

**Severity:** S1 — while an unwind is travelling, a destructor that calls a function which installs and catches its own handler overwrites the in-flight unwind's value and target: the installer returns the destructor's value instead of its own (`-1` for `100`), and with different types it reads a freed `String` as its result (ASan heap-use-after-free in safe code).

- Filed: 2026-11-28, finding F5 of VERDICTS-95 (Fable 5.2, §7), with its probes `q01` and `q01b`.
- Status: open, not fixed: retired with the mechanism at E-5 of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (VERDICTS-96 §5). `ctl` and `unwind` are deleted, and this doc moves to `issues/retired/` with E-5.
- Related: `issues/fixed/2026-10-22-an-unwind-is-lost-when-a-temporary-dropped-after-the-call-runs-a-destructor-that-calls-a-function.md` and `issues/fixed/an-unwind-through-a-frame-whose-destructor-calls-a-function-is-lost.md` fixed the flag half of this; the value and target were never saved.

## Reproducer

`issues/repros/2026-11-28-a-drop-that-catches-its-own-unwind-replaces-the-value-of-the-unwind-in-flight.yo`: `outer` installs `a`, which unwinds `i32(100)`. `mid` holds a `Guard` and calls `a`. `Guard.drop` calls `quiet()`, which installs its own handler, catches its own unwind of `-1` and returns normally. No unwind leaves the destructor.

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : &String) -> i32);

// A helper that fails and is caught locally. Nothing escapes it.
quiet :: (fn() -> i32)({
  (h : Raise) = (
    msg -> {
      unwind(i32(-1));
    }
  );
  r := leaf(h);
  (r + i32(1))
});
leaf :: (fn(h : Raise) -> i32)(h(`inner`));

Guard :: struct(id : i32);
impl(
  Guard,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      // cleanup code that uses a locally handled failure
      v := quiet();
      println(`drop guard ${self.id}: quiet()=${v}`);
    })
  )
);

mid :: (fn(a : Raise) -> i32)({
  g := Guard(id : i32(1));
  r := a(`outer`);
  println(`mid: after a() r=${r} (must not print)`);
  _ := &g;
  (r + i32(10))
});

outer :: (fn() -> i32)({
  (a : Raise) = (
    msg -> {
      unwind(i32(100));
    }
  );
  r := mid(a);
  println(`outer: after mid r=${r} (must not print)`);
  (r + i32(1000))
});

main :: (fn() -> unit)({
  println(`outer() = ${outer()} (expected 100)`);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. Compiled with `--optimize 2 --sanitize address --allocator system`, rc 0:

```text
drop guard 1: quiet()=-1
outer() = -1 (expected 100)
```

The second file, `issues/repros/2026-11-28-a-drop-that-catches-its-own-unwind-replaces-the-value-of-the-unwind-in-flight-types.yo`, has `outer : -> Option(Box(i32))` unwinding `.None` and `quiet : -> String` unwinding a heap `String`. `yo check`: `evaluator OK`. Run as above, rc 1 (program output lost with the abort):

```text
=================================================================
==3363887==ERROR: AddressSanitizer: heap-use-after-free on address 0x761d655e0020 at pc 0x5603b60079ff bp 0x75bd62dfec50 sp 0x75bd62dfec48
READ of size 4 at 0x761d655e0020 thread T1

0x761d655e0020 is located 0 bytes inside of 63-byte region [0x761d655e0020,0x761d655e005f)
freed by thread T1 here:
```

`outer` read `quiet`'s freed `String` from the value buffer as its `Option(Box(i32))` result.

## Root cause

As VERDICTS-95 §7 states it: there is one thread-local value buffer (`__yo_unwind_value`) and one target (`__yo_unwind_target`) for all unwinds, and a frame that runs drops while an unwind is in flight re-arms only the flag afterwards. In the emitted C of `mid`'s escape path the destructor runs between the raise and the frame's return, and the code after it is `__yo_effect_escaped = 1;` (`_reraise_escape_after_drops`, `src/codegen/exprs/return.yo`), or, after a call's temporaries, `__yo_effect_escaped = (__yo_effect_escaped | __yo_escaped_keep_N);` (line 1642 on `c1f2221be`). `quiet`'s handler wrote its own value and target into the same globals, and nothing restores `outer`'s.

The docs' caveat ("Do not unwind from a `Drop` impl", `docs/en-US/ALGEBRAIC_EFFECTS.md`, "Semantics") does not cover this: the destructor never unwinds out.

## Fix

Not built (VERDICTS-96 §5): no statement in `src/` or `std/` has this shape, and E-5 deletes the mechanism. The repair the doc was filed with, K-2 of [`plans/archive/CAPABILITIES_AND_HANDLERS.md`](../plans/archive/CAPABILITIES_AND_HANDLERS.md), was:

K-2: a frame saves the in-flight unwind's value and target before it runs drops on an escape path and restores both after, at every place that re-arms the flag today. The protocol H-3 builds on frames (an unwind is a status return with its target, not a global) removes the shared buffer.

## Test

None: the bug is not fixed. Its reproducer stops compiling at E-5, when `ctl` and `unwind` leave the language.
