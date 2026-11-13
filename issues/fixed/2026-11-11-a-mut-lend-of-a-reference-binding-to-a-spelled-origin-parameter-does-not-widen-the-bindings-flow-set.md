# A `&mut` lend of a reference binding to a spelled-origin parameter does not widen the binding's flow set

**Severity:** S1. `set :: (fn(generic(p : Origin), dst : &mut &(Rc(X), p), v : &(Rc(X), p)) -> unit)({ dst.* = v; })`
called as `set(&mut r, &inner)` re-points the reference binding `r` at `inner`. `lend_through` solves `p` over
`inner` but never writes it back to `r`, so a read of `r` after `inner`'s block ends passes `yo check` (ASan:
heap-use-after-free). The `swap` shape (`sw(&mut r, &mut q)`) is the same. New this cycle: v0.2.76 cannot express the
parameter type ("`&(Rc(X), p)` cannot be this parameter's type: a reference to a reference (`&mut &(T, p)`) arrives
with references as binding types"); P3 (#1841, merged 2026-11-09, after v0.2.76) deleted that wall.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A28). Confirmed on develop `64f33c710`. Related: the
local-borrow form `rp := &mut r; rp.* = ri` was fixed by
`issues/fixed/2026-11-08-a-store-through-a-mut-lend-of-a-reference-does-not-widen-its-flow-set.md`; this is the
call form of the same store.

## Reproducers

`issues/repros/2026-11-11-a-mut-lend-of-a-reference-binding-to-a-spelled-origin-parameter-does-not-widen-the-bindings-flow-set.yo`
(negative, expects E0911):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
mk :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
set :: (fn(generic(p : Origin), dst : &mut&(Rc(X), p), v : &(Rc(X), p)) -> unit)({
  dst.* = v;
});
main :: (fn() -> unit)({
  outer := mk();
  mut(r) := &outer;
  {
    inner := mk();
    set(&mut r, &inner);
  };
  println(`OUT: ${r.*.*.s.len().to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: error, "a reference to a reference … arrives with references as binding types"
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
$ YO_DEBUG_N2B=1 yo check repro.yo
[n2b] lend-through &mut arg &mut(r): place=r atom=true fixed=0
[n2b] lend-through solve &(inner): roots=[inner(imm)]
                                   # no "write-back r" line follows
```

- `…-swap.yo` (negative, E0911): `sw(generic(p : Origin), a : &mut &(Rc(X), p), b : &mut &(Rc(X), p))` swapping
  `r` with a block-local `q := &inner`, the corpus row `swap-inferred-locals` with a referent that dies.
- `…-pos.yo` (positive control): the re-pointed `r` is read while `inner` is live.

- `…-through-mut-binding.yo` (negative, E0911): `rp := &mut r; set(&mut rp.*, &inner);`. Accepted; heap-use-after-free.
- `…-chain.yo` (negative, E0911): `rp := &mut r; rpp := &mut rp; set(&mut rpp.*.*, &inner);`, the depth-2 re-borrow
  chain the audit re-probe found on develop `4f8f975b3`, after #1916 fixed the rows above. Accepted; heap-use-after-free.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `set(&mut r, &inner)`, `inner` block-local, `r` read after the block | accepted, heap-use-after-free | E0911 |
| `sw(&mut r, &mut q)`, `q := &inner` block-local | accepted, heap-use-after-free | E0911 |
| `set(&mut r, &inner)`, then `inner = mk()` while `r` is live | accepted, reads the new value | E0911 at the write |
| `set :: (fn(dst : &mut &Rc(X), v : &Rc(X)) …)` (origins elided) | E0923 in the callee | E0923 |
| `rp := &mut r; rp.* = ri` (local borrow, no call) | E0911 | E0911 |
| `rp := &mut r; set(&mut rp.*, &inner)` (VERDICTS-58 probe 1: the binding lent through a local `&mut` borrow of it and reborrowed at the call) | accepted, heap-use-after-free | E0911: the write-back reaches `r`, the place `rp` borrows |
| `rp := &mut r; set(rp, &inner)` (the bare binding) | E0601, a wrong rejection: `issues/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.md` | as the row above |
| `swap-inferred-locals`, `swap-declared-union` (corpus, both referents outlive the reads) | accepted | accept |

## The depth-≥2 family (develop `4f8f975b3`, after #1916)

#1916 fixed every row of the table above. The audit re-probe then found the same store through a chain of `&mut`
re-borrows (`mut(rp) := &mut r`, `rpp := &mut rp`, …), and probing its neighbours found three more holes. Each
"accepted" row below is a heap-use-after-free under ASan.

| Shape | Verdict on `4f8f975b3` | Correct |
| --- | --- | --- |
| `set(&mut rpp.*.*, &inner)`, `r` read after `inner`'s block (the audit's `e_rr_chain`) | accepted | E0911 |
| the same at depth 3, `rppp := &mut rpp; set(&mut rppp.*.*.*, &inner)` (`e_rr_chain3`) | accepted | E0911 |
| the method `s.set(&mut rpp.*.*, &inner)`, qualified `S.set(&s, &mut rpp.*.*, &inner)` and fn-value `f := set; f(&mut rpp.*.*, &inner)` forms, and the method form at depth 3 | accepted | E0911 |
| `set2(&mut rpp.*, &inner)` through `dst : &mut &mut &(Rc(X), p)` (the callee stores two levels down) | accepted | E0911 |
| `sw(&mut rpp.*.*, &mut q)`, `q := &inner` block-local | accepted | E0911 |
| `set(&mut rpp.*.*, &inner)`, then `inner = mk()` while `r` is live | accepted | E0911 at the write |
| `set(&mut rp.*, &inner)` (depth 1), then a read of `rp.*.*` after `inner`'s block | accepted: #1916 redirected the join from `rp` to `r` and skipped `rp` | E0911 |
| `ri := &inner; rpp.*.* = ri` (a local store, no call) | accepted | E0911 |
| `set2(&mut rp, &inner)` (the re-borrow lent bare to a `&mut &mut &(Rc(X), p)` parameter) | E0911 | E0911 |
| `rp.* = ri` (depth 1 local store), then a read of `rp.*.*` | E0911 | E0911 |
| `rpp.*.* = &inner` (`e_rr_chain_store`) | rejected: `&inner` is no expression of its own there | a wall, not a hole |
| `rq := &mut rpp.*.*` (`e_rr_chain_rq`) | rejected: a local borrow cannot reach through a pointer dereference | a wall, not a hole |

The cause is #1916's redirect. `lend_through` step 3 found the lent holder through `_deref_atom_of`, which strips ONE
`.*`: `rpp.*.*` is not an atom (`YO_DEBUG_N2B`: `place=((rpp.(*)).(*)) atom=false`), so the write-back was skipped
whole. Where the place was an atom, the redirect followed one link (`rpp` to `rp`, never on to `r`) and joined the
redirect target instead of the lent binding, so `rp` itself was never widened. The local store `rpp.*.* = ri` goes
through the property-assignment path, whose `place_write_join` saw only `rpp` and only a value whose type carries an
origin (`ri`'s read is its pointee); the depth-1 `rp.* = ri` is an atom assignment and was already joined into both
`rp` and `r` (`_join_through_mut_self_lend`).

## Root cause

Verified in the source and with `YO_DEBUG_N2B`. `lend_through` (`src/evaluator/calls/function.yo`) step 1 fixes
nothing (`r`'s origin is flow-inferred, `fixed=0`), so step 3, the flow write-back (§7 "flow inference at a `&mut`
lend"), runs and solves `p` to `{inner}`. Its last guard writes the solved roots back only when
`type_carries_origin(&variable_value_type(&hv))`. For a reference binding `variable_value_type` returns the
POINTEE (`src/env.yo`: "a reference binding's POINTEE"), here `Rc(X)`, which carries no origin, so the write-back is
skipped. The step-1 path already knows this case (`is_reference_self_place`: "`&mut r` on a reference binding … is
typed as the reference itself"); step 3 does not. The corpus's `swap-*` rows are positive only, so nothing pinned the
write-back: they pass with it or without it.

## Expected

E0911: `inner`'s scope ends while `r`, which may now point into it, is live. BORROW_CHECKER_COMPLETENESS.md §3 item 4:
"a flow-inferred set on the caller's side is an inference variable solved by the unification and written back to the
holder after the call", and §7 P3: "Parameters `a : &mut &(T, p)` are accepted …, with `lend_through` unifying `p`
exactly through the `&mut` pointee and a flow-inferred `ra` widening". The holder written back is the reference
binding `r` itself, judged on its slot type (`variable_slot_type`), and the join is `bind_join_roots_for`'s, as for
any holder, so §7's scope check reaches `r`'s last use.

## Test

`tests/origins/unsound/` (G-B, each beside a `-pos` control that compiles and runs clean under ASan):
`ref-mut-ref-store-narrower`, `-narrower-declared`, `-reborrow`, `-method`, `-qualified`, `-fn-value` (#1916, depth
0 and 1); `ref-mut-ref-store-chain2`, `-chain3`, `-chain2-method`, `-chain3-method`, `-chain2-qualified`,
`-chain2-fn-value`, `-chain2-local`, `ref-mut-ref-store-reborrow-read-through`, `ref-mut-ref-ref-param-chain`,
`ref-mut-ref-swap-chain2` (this fix). Corpus rows (with their toy-model tests in `tests/origins/model_corpus.test.yo`):
`ref-mut-ref-store-narrower`, `-narrower-declared`, `-same-scope`, `-reborrow` (#1916), `ref-mut-ref-store-chain2`,
`-chain3`, `-chain2-same-scope`, `ref-mut-ref-store-reborrow-read-through` (this fix).

## Fix

Two PRs.

- #1916 (depth 0 and 1, every call form): step 3's guard also accepts a reference binding whose slot type
  (`variable_slot_type`) carries the origin, and a `&mut` re-borrow `rp := &mut r` lent as `&mut rp.*` redirected the
  join to `r`. #1913 had routed the method, qualified and fn-value forms through `lend_through`, so the same guard
  covered them. The record of that PR is `issues/fixed/2026-11-12-a-mut-ref-ref-lend-does-not-write-back-its-solved-origin.md`.
- This fix (any depth): `reference_reborrow_chain` (`src/evaluator/utils.yo`) walks the `&mut` re-borrow links from a
  binding. A link is a local borrow whose slot's pointee is itself a reference (`rp : &mut &T` lends the whole
  reference binding `r`, so `rp.*` IS `r`); the walk is breadth-first over every place a re-pointed link lent and
  ends at a parameter, a field place or a binding that holds the `&T` itself. Step 3 now takes the bare name under
  any number of `.*` (`deref_chain_atom`) and writes the solved roots into every holder on the chain: each one's type
  names the same origin, and a `&mut` pointee is invariant (decision 43 O3), so a read through any of them after the
  referent dies is the same use-after-free. Every holder GENs; the chain's end is KILLed only when the chain has a
  single end, since the store replaced its value; the holders above it still point where they pointed. The local
  store `rpp.*.* = ri` (`_join_through_reborrow_chain`, `src/evaluator/exprs/assignment.yo`, k ≥ 2 `.*`) is `r = ri`'s `bind_join` on the
  binding k links down (KILL + GEN, the subset check of a spelled `r`, the §7 scope check), plus a GEN on each holder
  above it.

Not in this fix: the bare `set(rp, &inner)` is E0601
(`issues/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.md`),
a separate wrong rejection. The two walls in the depth-≥2 table stay walls.
