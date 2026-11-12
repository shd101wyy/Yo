# A composite result that holds a reference into a by-value parameter is accepted

**Severity:** S1. A function whose result is an `Option(&T)` (any composite with an elided origin) may return a
reference into a BY-VALUE parameter or a by-value `self`: `pick :: (fn(a : &String, xs : ArrayList(String)) ->
Option(&String))(.Some(xs.index(usize(0))))` passes `yo check`, the list is dropped when `pick` returns, and the
caller reads freed memory (ASan: heap-use-after-free at `--optimize 1`; the `.Some(&s)` form over a by-value `String`
is a stack-use-after-return at `--optimize 0`). Pre-existing: v0.2.76 accepts the same programs.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A10). Confirmed on develop `64f33c710`. The `-> &T` form is
rejected (decision 24's single-root rule); only composite results are affected.

## Reproducers

`issues/repros/2026-11-11-a-composite-result-that-holds-a-reference-into-a-by-value-parameter-is-accepted.yo`
(negative, expects E0912):

```yo
long :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
pick :: (fn(a : &String, xs : ArrayList(String)) -> Option(&String))(.Some(xs.index(usize(0))));
main :: (fn() -> unit)({
  t := long();
  mut(ys) := ArrayList(String).new();
  ys.push(long());
  o := pick(&t, ys);
  match(o, .Some(r) => println(`OUT: ${r.clone()}`), .None => ());
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-by-value-self.yo` (negative, E0912; v0.2.76 accepts): `impl(Bag, head : (fn(self : Self, a : &String) ->
  Option(&String))(.Some(self.items.index(usize(0)))))`, called as `Bag(items : ys).head(&t)`: heap-use-after-free.
- `…-pos.yo` (positive control): the result is `.Some(a)`, the reference parameter the elided origin names.

The ledger's first form, `mk :: (fn(a : &String, s : String) -> Option(&String))(.Some(&s))`, prints `OUT: ` with
an empty string at `--optimize 1`; ASan proves it only at `--optimize 0` with
`ASAN_OPTIONS=detect_stack_use_after_return=1` (stack-use-after-return).

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `.Some(xs.index(usize(0)))` / by-value `self` (the repros) | accepted, heap-use-after-free | E0912 |
| `.Some(&s)`, `s : String` by value; `.Some(&w.s)` for `w : W` by value (ledger r03, r13) | accepted; -O0 stack-use-after-return | E0912 |
| no reference parameter at all, `fn(s : String) -> Option(&String)` (ledger r07) | accepted | E0912 |
| inside `cond` arms, through an early `return(.Some(&s))`, through `wrap(&s)` (ledger r11, r12, m05) | accepted | E0912 |
| a closure literal, a `ctl` handler, a `&self` method with a by-value parameter (ledger r15, r16, r17) | accepted | E0912 |
| `-> &String` returning `&s` (ledger r03b) | E0912 | E0912 |
| a spelled origin, `-> Option(&(String, a))` / `-> H(a)` (ledger r08, r03c) | E0923 | E0912 (either rejects) |
| a spelled origin naming the by-value parameter itself, `-> V(x)` with `V(x)(r : &x.s)`; also over a by-value handle, `-> V(b)` with `V(b)(r : &b.*.s)`, `b : Box(X)` (moved here from A30, develop `d638ddd0a`) | accepted | E0912 |
| the value first bound to a typed local `(o : Option(&String)) = .Some(&s); o` (ledger r09) | E0912 | E0912 |

## Root cause

`return_check` (`src/evaluator/utils.yo`) walks the frozen roots of the returned value. A root that is a plain local
is rejected (E0912). A root that is a PARAMETER (`rv.is_parameter()`) is only compared with the origins the result
SPELLS (`fn_result_composite_origin_names`, E0923 for a parameter outside them); when the result's origin is elided
that list is `.None` and the parameter root passes unchecked. Nothing asks whether the parameter is a reference
parameter: a by-value parameter's slot is treated as a lent place of the caller. The spelled-origin path at the
signature, `_result_origin_names_into` (`src/evaluator/types/function.yo`), does make that distinction ("a by-value
parameter's place is the callee's own frame, which the call ends: E0912"); `return_check` lacks it. The `-> &T` result
is caught elsewhere, by the projection root check in `src/evaluator/builtins/ptr_fns.yo`, and the typed-local form by
the second-class local-borrow return rule (`local_borrow_reject_result_borrow`), which is why those rows are rejected.

## Expected

E0912 at the `return` / body tail, naming the by-value parameter. `REFERENCES_AND_ORIGINS.md` O3's return rule: "an
origin in a result type may name only origin parameters or reference-typed parameters' places (a by-value parameter
contributes its type's origin parameters, never its own place). A local's place — or a by-value parameter's slot,
which is one — in a result is a compile error at the `return`". A signature with an elided result origin and no
reference parameter (ledger r07) has no place the result could point into.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; a corpus row
`ret-byvalue-param-composite` (E0912) beside `ret-byvalue-param` in `tests/origins/corpus.tsv`, plus a by-value
`self` row.
