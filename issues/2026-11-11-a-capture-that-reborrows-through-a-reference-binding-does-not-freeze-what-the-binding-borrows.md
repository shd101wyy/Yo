# A capture that reborrows through a reference binding does not freeze what the binding borrows

**Severity:** S1. A capture entry `{ y : &s.* }`, where `s` is a reference binding (a `:=` lend or a borrowed-`match`
binding), passes `yo check` while the place `s` borrows is written during the closure's life: in
`match(&b, Box(s) => { f = ({ y : &s.* }() => …); b = Box.new(…); f() })` the call reads the freed Box (ASan:
heap-use-after-free). The direct capture `{ y : &x }` is rejected. Pre-existing: v0.2.76 accepts it too, and it is
still accepted on develop after #1891 (capture PR1).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A20). Confirmed on develop `64f33c710`. Lane: capture PR2
(scheduled v0.2.78, branch `capture-lane`). Related:
`issues/fixed/2026-11-11-a-capture-of-a-reference-parameter-carries-no-origin-so-the-closure-escapes-its-argument.md` (the
same missing origin for a `{ p }` capture of a reference PARAMETER, A9) and
`issues/2026-11-06-a-user-closure-cannot-capture-a-reference-binding.md` (the spelling this entry form came from).

## Reproducers

`issues/repros/2026-11-11-a-capture-that-reborrows-through-a-reference-binding-does-not-freeze-what-the-binding-borrows.yo`
(negative, expects E0910 at `b = …`, the code the direct capture `{ y : &x }` gets today):

```yo
main :: (fn() -> unit)({
  mut(b) := Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  match(
    &b,
    Box(s) => {
      (f : Impl(Fn() -> usize)) = ({ y : &s.* }() => y.len());
      b = Box.new(String.from("q"));
      println(`OUT: ${f().to_string()}`);
    }
  );
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-binding.yo` (negative, E0910): the minimal form over a `:=` reference binding,
  `y := &x; g = ({ z : &y.* }() => z.*); x = i32(3); g()` — the closure reads the new value 3.
- `…-pos.yo` (positive control): the closure is called and dies inside the arm; `b` is written after the arm.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `{ y : &s.* }` over a borrowed `match` binding of a Box, the Box replaced while the closure lives | accepted, heap-use-after-free | E0910 |
| `{ z : &y.* }` over `y := &x`, `x` written (`…-binding.yo`, ledger cl08: `OUT: 3`) | accepted | E0910 |
| `{ y : &r.* }` over `r := &x` with `x` an `ArrayList`, `x` reassigned (ledger cl01: `OUT: 0`) | accepted | E0910 |
| `{ y : &s.* }` over a borrowed `match` binding of an `Option(String)`, `o = .None` (ledger cl06) | accepted | E0910 |
| `{ y : &x }` directly, `x` written (ledger cl02) | E0910 "the closure `f` borrows `x`" | E0910 |

## Root cause

`_evaluate_capture_list` (`src/evaluator/values/anonymous_function.yo`), borrow branch: for `{ y : &s.* }` the place
root is `s`; when `s` is a reference binding the leading `*` step is dropped (`cap_root_is_reference`, `_dropped_star`)
and the entry is pushed with `root_id`/`root_name` = `s`, an empty path and `origin_roots` EMPTY
(`uses_origin_roots : false`). The capture borrow therefore names the binding `s` — whose own slot nobody writes —
and not the places `s` borrows. The by-value entry `{ y }` over a reference binding (VERDICTS-44 R-CAP-1, the
`ref_copy_var` branch just below) does compute `origin_roots : origin_of(&ev_ref, …)` with `uses_origin_roots :
true`; the reborrow branch has no such step. A `:=` reference binding `r := &s.*` would keep `s`'s parents live
(`local_borrow_register`'s transitive freeze); a capture borrow is registered elsewhere and does not.

## Expected

E0910 at the write of the root while the closure is live, the verdict `{ y : &x }` gets. R-DEREF
(`BORROW_CHECKER_COMPLETENESS.md` §3): "`&r.*` is a reborrow: `origin_of(r)` ∪ `{(r, &)}` when `r` is reached
through a `&` path and holds `&mut`, else `origin_of(r)`"; R-CLOSURE-LIT: "a `&`/`&mut` capture is R-LEND of the
captured place", so the capture's origin is `origin_of(s)` = `{(b, &)}` and `b` is frozen for the closure's live
range, as `{ y : &b }` freezes it.

## Test

With the fix: both negative programs and the positive control move to `tests/origins/unsound/`; rows in
`tests/closure_capture_list.test.yo` (the reborrow entry over a `:=` binding and over a borrowed-match binding) and a
corpus row `closure-reborrow-capture-root-written` (neg, E0910) beside `closure-ref-capture-returned-over-local`.

## Fix

`_evaluate_capture_list` (`src/evaluator/values/anonymous_function.yo`), borrow branch: an entry whose place is
reached through a reference binding (`{ y : &s.* }`, `cap_root_is_reference`) records its capture borrows as
`origin_borrows` — the binding itself, plus every place the binding refers to
(`reference_binding_referents`, `src/evaluator/utils.yo`: a lend binding's or holder's entries, a reference payload
binding's held set, or a borrowed `match` binding's scrutinee origin), each in the entry's mode bounded by the
referent's. The closure's freeze (`note_second_class_binding`) then covers `x` for `{ z : &y.* }` over `y := &x`, and
`b` for `{ y : &s.* }` over `match(&b, Box(s) => …)`, so the write of the root is E0910 as for `{ y : &x }`.

Tests: `tests/origins/unsound/c2-capture-reborrow-match-binding.yo`, `c2-capture-reborrow-ref-binding.yo` (E0910),
`c2-capture-reborrow-match-binding-pos.yo` (accept, ASan clean); `tests/closure_capture_list.test.yo` "a capture that
reborrows through a reference binding freezes what it borrows".
