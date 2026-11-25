# A `&mut` lend of a holder's field does not write back what the callee stores: `put(&mut h.o, &y)` with `y` in an inner block passes check and reads freed stack

**Severity:** S1: safe code that `yo check` accepts reads a dead stack slot at runtime (ASan `stack-use-after-scope`). Any holder with an origin-carrying field (`Option(&T)`, a reference field, a nested holder) lent field-wise `&mut` to a callee that may store into it escapes the borrow checker.

Found 2026-11-25 by the VERDICTS-78 Q1 lane while routing `&mut h.r` (a reference field lent as a `&mut &T`) through `lend_through`; reproduced on develop `8da9761d1` (a tree binary of the same week).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("abc"))));
H :: struct(o : Option(&Rc(X)), n : i32);
use :: (fn(o : &Option(&Rc(X))) -> unit)(match(o, .Some(r) => println(r.*.*.s.len()), .None => ()));
put :: (fn(generic(p : Origin), dst : &mut Option(&(Rc(X), p)), v : &(Rc(X), p)) -> unit)({ dst.* = .Some(v); });
main :: (fn() -> unit)({
  z := mk();
  mut(h) := H(o : .Some(&z), n : i32(0));
  {
    y2 := mk();
    put(&mut h.o, &y2);
  };
  use(&h.o);
});
export(main);
```

`yo check` passes ("evaluator OK"). Compiled with `--sanitize address --allocator system` and run:

```text
==3180142==ERROR: AddressSanitizer: stack-use-after-scope on address 0x7191a10ff080 at pc 0x5646272e0260 bp 0x7191e19feb30 sp 0x7191e19feb28
READ of size 8 at 0x7191a10ff080 thread T1
SUMMARY: AddressSanitizer: stack-use-after-scope
```

The same store written as a field write, `h.o = .Some(&y2)`, is E0911 ("Cannot store a reference to `y2` in `h` here"), and the same lend of a whole holder, `put(&mut o, &y2)` with `mut(o) := Option(&Rc(X)).None`, is E0911 too.

## Root cause

`lend_through` (`src/evaluator/calls/function.yo`) step 3, the flow write-back of a `&mut` lend: a callee that may store through a `&mut` argument whose pointee carries an origin stores what the call's other same-origin arguments carry, so the caller's holder joins that set after the call. The step resolved the holder only for a bare binding (`&mut o`, with `&mut s.*` re-borrow chains) and for a `&mut` projection's result; a field place (`&mut h.o`, `&mut h.a.b`, `&mut t.0`) matched neither shape, so nothing joined `h`'s flow set and `y2`'s scope end was never checked against `h`'s later read.

## Fix

The write-back resolves a field path to the binding it is rooted at (`_field_path_root`, every hop a field or tuple element, no `.*`) and joins the solved set into that binding, never KILLing its set (the callee replaced one field; the holder's other fields still hold what they held). A holder that is a parameter with declared origins judges each stored argument as `holder.* = arg`, as for a whole-holder lend.

## Test

`tests/origins/unsound/field-mut-lend-write-back-scope.yo` (E0911) and its positive twin `field-mut-lend-write-back-scope-pos.yo` (G-B, run under ASan).
