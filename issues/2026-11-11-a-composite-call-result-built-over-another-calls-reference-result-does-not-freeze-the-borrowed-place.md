# A composite call result built over another call's reference result does not freeze the borrowed place

**Severity:** S1. `o := wrap(first(&xs))` (`wrap : &String -> Option(&String)`, `first : &ArrayList(String) ->
&String`) binds an `Option(&String)` that points into `xs`, but `o` holds no loan of `xs`: `xs = …` is accepted while
`o` is live and the read through `o` is a heap-use-after-free. The same holds for a holder built by a generic
constructor, `h := mk(first(&xs))`. Pre-existing: v0.2.76 accepts both programs.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A5). Confirmed on develop `64f33c710`. The wider ledger
finding (a composite result over a lend of a FIELD or ELEMENT place, `o := wrap(&w.s); drop(w)`, probes c56, c57,
c40, c45, c62, c61, c46, o06, o05) is fixed by lane o6 (call-result origin naming, `~/Workspace/Yo-wt/o6-m`): checked
on 2026-11-11, its binary rejects all nine with E0911. Lane o6 does NOT cover the nested form this document
describes (probe c39): both repros below are accepted by it. Related:
`issues/2026-11-11-a-temporary-reached-through-a-handle-deref-or-an-inner-projection-call-is-no-root-of-its-holder.md`
(A23, an inner projection call over a TEMPORARY).

## Reproducers

`issues/repros/2026-11-11-a-composite-call-result-built-over-another-calls-reference-result-does-not-freeze-the-borrowed-place.yo`
(negative, expects E0911):

```yo
first :: (fn(xs : &ArrayList(String)) -> &String)(&xs(usize(0)));
wrap :: (fn(r : &String) -> Option(&String))(.Some(r));
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(long());
  o := wrap(first(&xs));
  xs = ArrayList(String).new();
  match(o, .Some(r) => println(`OUT: ${r.clone()}`), .None => ());
});
```

```text
$ yo check repro.yo        # develop 64f33c710, lane o6 (o6-m), v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-holder.yo` (negative, E0911; develop, o6-m and v0.2.76 accept): `mk :: (fn(generic(p : Origin), r : &(String,
  p)) -> H(p))(H(p)(r : r))`, `h := mk(first(&xs)); xs = …; h.r.clone()`: heap-use-after-free.
- `…-pos.yo` (positive control): the `Option`'s last use is before `xs` is reassigned.

## The family (develop `64f33c710` / lane o6)

| Shape | develop | o6-m | Correct |
| --- | --- | --- | --- |
| `o := wrap(first(&xs))`; `h := mk(first(&xs))` (the repros) | accepted, UAF | accepted | E0911 |
| `h := mk(idr(&xs(usize(0))))` (`idr : &String -> &String`) | accepted | accepted | E0911 |
| `o := wrap(&w.s); drop(w)`; `h := mk(&xs(usize(0)))`; `Option(&mut T)` / holder of `&mut w.s` (ledger c56, c40, o06, o05 …) | accepted, UAF | E0911 | E0911 |
| `r := first(&xs); h := mk(r); xs = …` (the inner result named first) | E0911 | E0911 | E0911 |
| `e := idr(first(&xs)); xs = …` (a `&T` outer result) | E0911, but the text says `first(&xs)` "is a temporary that ends with this statement" | same | E0911, naming `xs` |
| a whole-variable lend `o := wrap(&s)`; an `&T` result `e := first(&xs)` (ledger c55, c42, c43, c44) | E0911 | E0911 | E0911 |

## Root cause

Measured with `YO_DEBUG_N2B=1` on the o6-m binary: the binding statement records `bind o: roots=[]
rhs=wrap(first(&(xs)))`. `origin_of` (`_origin_of_into`, `src/evaluator/utils.yo`) returns no root for the outer
call, so `bind` registers no entry and nothing freezes `xs`.

Hypothesis for why (not traced step by step): R-CALL in `_origin_of_into` does recurse into each root argument that
`projection_call_root_args` returns (`first(&xs)` for `wrap`'s `r : &String`). But a reference-typed call result
carries a recorded reference type (`expr_info_converted_runtime_type` is `.Reference`), so the recursion takes the
"R-LEND (recorded form, T9)" branch, which treats the node as a lend OF ITSELF and pushes
`local_borrow_place_of(first(&xs))`. A call is not a place, so nothing is pushed, and the R-CALL branch that would
have reached `&xs` is never taken. The same misreading of a reference call result as a place would explain the
`idr(first(&xs))` row's diagnostic, which calls `first(&xs)` a temporary.

## Expected

E0911 at `xs = …`, naming `o` (`h`) as the live borrow of `xs`. `plans/backlog/BORROW_CHECKER_COMPLETENESS.md`
§3 R-CALL: "the callee's declared result origin (spelled, or O2's elided union of the reference-holding parameters)
with each parameter name substituted by `origin_of(arg)`". `origin_of(first(&xs))` is `{(xs, &)}`, so
`wrap(first(&xs))`'s is too; the `_origin_of_into` comment says the same ("each root argument's own origin computed
RECURSIVELY"). A reference-typed CALL result is R-CALL's, never R-LEND's.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`composite-result-over-nested-call` (E0911) and `holder-ctor-over-nested-call` (E0911) beside the o6 lane's
call-result rows.
