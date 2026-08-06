# `own` param discarded via `___ := victim` / `consume(victim)` leaks the object

> **FIXED — 2026-08-06** (the `___ := victim` / move-to-local half; the
> `consume(victim)` half is NOT a bug, see below).
>
> **Root cause (differs from both hypotheses below):** the body-context
> capture map recorded the function's **own parameters as captures**.
> Every body-context creator pushes the parameters frame before creating
> the context (`function-type.ts:380`, `closure-type.ts:67`,
> `anonymous-function.ts:340`), so `trackVariableUsage`'s outer-scope
> guard (`frameLevel >= evaluationEnv.frames.length`) could not exclude
> them, and its name-based re-search found the param in `evaluationEnv`.
> The scope-end drop machinery (`begin.ts` > `variableIsCapturedByCurrentFunction`, name-based) then treated any
> _referenced_ own param as closure-captured and skipped its drop — while
> the moved-to local's drop was correctly cancelled against the move's
> dup. Net: no dup, no drop, one leaked reference. The unused-param
> control never entered the capture map, which is why it was leak-free.
> Not name-specific: `v2 := victim` leaked identically to `___ := victim`.
>
> **Fix:** skip recording a variable as captured when it resolves to the
> top frame of a function-body `evaluationEnv` (that frame is the
> function's own parameters frame) — `src/evaluator/context.ts` > `trackVariableUsage` + the yo-self mirror
> (`yo-self/evaluator/context.yo` `track_variable_usage`).
> Verified: repro 2 leaks/64 B → **0 leaks** (both `___ :=` and a named
> local); `rc(h)` 2 → 1 across the sink call. Regression test:
> `tests/ref_field_borrow.test.yo` "discarding an own param via \_\_\_ :=
> releases it exactly once".
>
> **`consume(victim)` is working as designed, not a leak bug:** `consume`
> is a _transfer marker_ — std uses it to assert ownership moved into raw
> memory (`consume((buf.add(i)).* = val)` in `std/collections/deque.yo`,
> `hash_map.yo`); emitting a drop there would double-free every such
> site. Using it as a discard idiom tells the compiler ownership went
> elsewhere, so no drop is emitted — by contract. The discard idiom is
> `___ := victim`. (Whether `consume` on a still-owned named value should
> be a compile error is a separate design question; noted in the doc
> body's Notes.)

**Found:** 2026-06-12, via CI LeakSanitizer on
`tests/ref_field_borrow.test.yo` ("ref and own arguments of distinct
objects are allowed").

## Repro (minimal)

(2026-08 note: the syntax below is from June — today write
`Holder :: ref(struct(s : String, n : i32));` and `inout(x) : String`.)

```rust
open(import("std/fmt"));
open(import("std/string"));
Holder :: object(s : String, n : i32);
main :: (fn() -> unit)({
  use_and_sink :: (fn(ref(x) : String, own(victim) : Holder) -> usize)({
    ___ := victim;        // ALSO leaks with: consume(victim);
    x.len()
  });
  a := Holder(s : String.from("abcde"), n : i32(1));
  b := Holder(s : String.from("other"), n : i32(2));
  n := use_and_sink(a.s, b);
  consume(n);
});
export(main);
```

`leaks --atExit`: 3 leaks / 112 bytes (the Holder `b` + its String).
With the body reduced to just `x.len()` (own param UNUSED → drops at
callee scope end): **0 leaks**. So the scope-end drop of an own param
works, but both explicit-discard idioms detach the value from the drop
machinery:

- `___ := victim;` — the new local apparently never receives a
  scope-end drop (`_`-family naming?), while `victim`'s own-drop is
  cancelled by the move.
- `consume(victim);` — marks consumed (no scope-end drop) but no drop
  is emitted at the consume site either.

## Expected

Either idiom should release the owned object exactly once.

## Notes

- The affected test now uses the unused-param shape (leak-free).
- Check whether `consume(x)` on owned LOCALS has the same gap or it is
  own-PARAM-specific.
