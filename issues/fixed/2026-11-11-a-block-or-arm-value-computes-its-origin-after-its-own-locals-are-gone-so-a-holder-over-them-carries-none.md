# A block or arm value computes its origin after its own locals are gone, so a holder over them carries none

**Severity:** S1. `h := { y := Rc.new(…); H(r : &y, n : i32(1)) };` passes `yo check`: the holder that is the block's
value points at `y`, which is dropped at the block's end, and `h` is read after it (ASan: heap-use-after-free). The
same loss hides a loan of an OUTER place when the tail is a block-local holder binding (`h := { t := HL(r : &x); t }`
does not freeze `x`), and it applies to `match`/`cond` arm blocks and to a call result in the tail. Pre-existing:
v0.2.76 accepts every form.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A12). Confirmed on develop `64f33c710`. Re-check after P2
(`&x` as an expression, block tails included; lane `vbd/p2-ref-expr`) lands — but P2 as specified does not fix this
(see Expected).

## Reproducers

`issues/repros/2026-11-11-a-block-or-arm-value-computes-its-origin-after-its-own-locals-are-gone-so-a-holder-over-them-carries-none.yo`
(negative, expects E0911):

```yo
X :: struct(s : String);
H :: struct(r : &Rc(X), n : i32);
main :: (fn() -> unit)({
  h := {
    y := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    H(r : &y, n : i32(1))
  };
  println(`OUT: ${h.r.*.*.s.len().to_string()}`);
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-outer-root.yo` (negative, E0911 at `x = …`): `h := { t := HL(r : &x); t };` then `x` is written while `h`'s
  element reference is live: heap-use-after-free.
- `…-arm.yo` (negative, E0911): the holder over the arm block's local is a `match` arm's value: heap-use-after-free.
- `…-pos.yo` (positive control): the block has a local of its own, but the holder it yields points at an outer local.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| holder / `Option(&Rc(X)).Some(&y)` / spelled `H(y)(…)` / typed-declaration / tuple `(&y, i32(1))` tail over the block's own `y` (holders a01–a05, n04) | accepted, UAF | E0911 |
| the same as a `cond` arm block (a06) or a `match` arm block (a07); assigned with `h = { … }` (a09) | accepted, UAF / stack-use-after-scope | E0911 |
| `H(u)(r : &u)` or a call `mk(&u)` / `pick(H(t)(…), H(u)(…))` in the tail over the block's `u` (calls u07, u08, u02, u02b, u03) | accepted; u02 stack-use-after-scope | E0911 |
| a block-local holder binding as the tail over an outer `x`: `{ t := HL(r : &x); t }`, `{ … u := t; u }`, an arm block (patterns-flow k07, k12, k09, k02, k04) | accepted, UAF | E0911 at the write |
| the holder built directly in the tail over an outer `x` (k05), `{ t }` over an outer `t` (k06), `h = { … }` with `h` already holding `x` (k11) | E0911 | E0911 |
| the same holder returned from a function (holders a08) | E0912 | E0912 |
| `e = pick(…)` inside a block (calls u10) | E0923 | — |

## Root cause

R-ARM's block clause in `_origin_of_into` (`src/evaluator/utils.yo`) computes a block's origin as its tail's,
`_origin_of_into(&tail, env, …)`, and `bind` calls it with the env of the `:=` statement — after the block's frame
was popped. The tail's names no longer resolve: `&y` goes through `_origin_push_lend` → `local_borrow_place_of`,
which finds no `y` and pushes nothing (the arm-binding fallback there finds no registered entry either); an atom
`t` goes through `_holder_roots_into`, whose join entries were truncated with the block. The `cond`/`match` clause
recurses into the arm values the same way. `YO_DEBUG_N2B=1` on the main repro prints `bind h: roots=[]`, and on
`…-outer-root.yo` `bind t: roots=[x(imm)]` followed by `bind h: roots=[]`. With an empty set, neither the §7 scope
check nor any access conflict can fire. A constructor tail over an OUTER place works (k05) because that place still
resolves. A function result is judged by `return_check` inside the body, which is why a08 is E0912.

## Expected

The tail's origin is computed where the tail is evaluated, in the block's own scope, and carried out as the
block's `ExprInfo.origin`: a root that is the block's own local is then E0911 at the binding ("`y`'s scope ends
with its block, while `h` is live to its last use", the message holders j05 gets), and a holder binding's entries become the
block's (k07 freezes `x`). `BORROW_CHECKER_COMPLETENESS.md` §3, R-ARM: "`match`, `cond`, a block tail … the union
over the arms"; Propagation: "an origin is never smaller than its sources' union".

P2 (`BORROW_CHECKER_COMPLETENESS.md` §7 row P2) makes `&place` an expression of type `&(T, place)` "wherever a value
may stand", block tails included, with R-LEND giving its origin. That covers a BARE `&y` tail (rejected today and by
v0.2.76: "`&y` lends a borrow: it is written as a call argument to a `&T` parameter, …") and gives it the origin a
constructor field gets today; it does not change where R-ARM evaluates the tail. A holder constructor in the tail
is already expressible, and P2 makes more such tails expressible, so P2 widens the exposure unless R-ARM's
evaluation point is fixed first (§7: "P1 and P2 are UNSAFE before A … a `&x` arm tail would be exactly H5/H1-class
programs").

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`block-tail-holder-over-block-local` (neg, E0911), `block-tail-holder-binding-outer-root` (neg, E0911) and
`arm-block-holder-over-arm-local` (neg, E0911) in `tests/origins/corpus.tsv`, with `…-pos.yo` as
`block-tail-holder-over-outer-local` (pos).

## Partial fix (2026-11-13, P2 R-TAIL)

P2 (VERDICTS-41 Q1 item 3, VERDICTS-58 decision 12) reads a `:=` initializer's block/arm-tail origin in each tail's
OWN environment (`_chain_leaf_origins`, `src/evaluator/exprs/initialization_assignment.yo`), so a block or arm tail
whose value carries an origin over a local declared inside it is now E0911 ("Cannot end this block while its result
borrows `y`"): the main reproducer, `…-arm.yo`, and a `cond` arm. The G-B rows are
`tests/origins/unsound/block-tail-holder-over-block-local.yo`, `tests/origins/unsound/cond-arm-tail-holder-over-arm-local.yo`
and `tests/origins/unsound/match-arm-tail-holder-over-arm-local.yo`, each with its `-pos` twin; the
`reference_read_rule` test pins the message.

Left open by P2, and closed by the fix below: an outer root reached through a block-local holder binding
(`…-outer-root.yo`, k07/k12/k09: `x` is not frozen), the assignment form `h = { … }` (a09), a call result in the
tail over a block-local (u02/u03/u07/u08), and A22's temporary scrutinee.

## Fix (2026-11-13, branch `fix/c3-value-origins`)

This completes the partial fix above. R-ARM's evaluation point moved to where the value is produced, for every sink. A non-function-body `begin` whose
value carries an origin computes the tail's origin before its frame and its loan entries go
(`src/evaluator/exprs/begin.yo`) and stores it as the block's `ExprInfo.origin`; a `match` computes each arm value's
origin at the arm's end and stores the union as its own (`src/evaluator/exprs/match.yo`). `origin_scope_close`
(`src/evaluator/utils.yo`) replaces a root declared inside the closing block or arm by an `ORIGIN_SCOPED_ROOT` entry
(a reference binding declared inside stands for its own entries), and every sink that keeps the value rejects it
(`bind`, the `=` join, `return_check`): "Cannot bind `h` to `…`: the value holds a reference to `y`, a binding of the
block or `match` arm that produced it, and `y`'s scope ends with that block or arm, while `h` lives on". A block-local
holder binding's entries are read while they exist, so `{ t := HL(r : &x); t }` now freezes `x`. Covered beyond
P2's `:=` form: the outer root through a block-local holder (k07), `h = { … }` (a09), a call result in the tail over
a block local (u02/u07), and A22's arm value. G-B rows: `tests/origins/unsound/a12-block-tail-holder-binding-outer-root.yo`,
`a12-assign-block-tail-holder-over-block-local.yo`, `a12-block-tail-call-over-block-local.yo` (E0911), each with a
`-pos` twin. Backstop (VERDICTS-58 decision 16): an origin computed where a runtime name it reads does not resolve
pushes an `ORIGIN_LOST_ROOT` entry, E0923 at the sink, and `YO_AUDIT_ORIGIN_TOTALITY` reports it as `lost`.
