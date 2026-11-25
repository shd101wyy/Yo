# A colon-spelled `where` bound on an impl or a derive is silently dropped

**Severity:** S1 — `impl(generic(T : Type), where(T : Send), Holder(T), Send())` registers an unbounded impl, so `Holder(Rc(i32))` is `Send` and an `Rc` crosses a thread: a data race (ThreadSanitizer) and a double free at `-O2`.

Filed 2026-11-25 by the `bound-s1` lane from VERDICTS-84 §7 item 1 (probes `c1`, `c3`, `d1`, `e1`, `a1` in `fable/v84-probes/`).
Reproduced with a stage 1 of develop `fc89e3195`.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), where(T : Send), Holder(T), Send()); // `:` instead of `<:`
bump :: (fn(r : &Rc(i32), n : i32) -> unit)({
  (mut(i) : i32) = i32(0);
  while(i < n, i = (i + i32(1)), {
    c := Rc.clone(r.*);
    _x := c.*;
  });
});
main :: (fn(io : Io) -> unit)({
  r := Rc.new(i32(1));
  mine := Holder(Rc(i32))(v : Rc.clone(r));
  t := Thread(unit).spawn({ mine }(io : Io) => {
    bump(&mine.v, i32(200000));
  });
  bump(&r, i32(200000));
  t.join();
  w := r.downgrade();
  println(`strong_count after (expect 1): ${w.strong_count()}`);
});
export(main);
```

`yo check` exits 0. Under `--sanitize thread`: four `WARNING: ThreadSanitizer: data race` reports between `__yo_incr_rc` and
`__yo_decr_rc`, `strong_count after (expect 1): 19`, rc 66. At `--optimize 2`, three of five runs abort with
`free(): double free detected in tcache 2`. With `<:` the spawn is E0602, as it should be.

In a file with no pragma this needs the generic-impl gate hole
(`issues/2026-11-25-a-generic-or-aliased-send-impl-skips-the-allow-unsafe-gate.md`); with the pragma it does not: the author wrote the
bound that makes the claim true, and the compiler dropped it without a word.

The same drop, with other traits:

- `impl(generic(T : Type), where(T : T1), W(T), Marker())`: `W(i32)` satisfies `where(X <: Marker)` though `i32` has no `T1` impl.
- `derive(generic(T : Type), where(T : Clone), Pair(T), Clone)`: the derive's where is forwarded into the generated impl and dropped
  there; `Pair(NoClone).clone()` fails with E0610 inside auto-generated code.
- A function's `where(T : Eq(T))` is skipped at definition and reported (uncoded) only when the function is called; a trait's
  `where(Self : Sup)` and a type constructor's are uncoded errors.

## Root cause

Each `where` reader filters on `<:` and skips anything else. `_collect_impl_where_constraints` (`src/evaluator/values/impl.yo`)
reads only `L <: R` entries, so a `:` entry contributes nothing to the `GenericImplEntry`'s constraint list; `derive` hands its clause
to that reader. `prepare_where_clause_variables` (`src/evaluator/types/function.yo`) skips a non-`<:` entry the same way, and only the
later `parse_where_clause_constraints` call throws. No reader checks the clause's form.

## Fix

VERDICTS-84 PR 1: one form check, `check_where_clause_form`, run where each clause is first read (a function or type constructor's
signature, a trait, both impl header positions, a derive) before any reader filters. A `:` entry is E0624 with the `yo fix` rewrite
`:` → `<:`; any other entry that is not `L <: R` is the existing "Expected constraint in the form" error, now at definition.
