# A `&mut` lend of a reference binding to a spelled-origin parameter does not widen the binding's flow set

**Severity:** S1. `set :: (fn(generic(p : Origin), dst : &mut &(Rc(X), p), v : &(Rc(X), p)) -> unit)({ dst.* = v; })`
called as `set(&mut r, &inner)` re-points the reference binding `r` at `inner`. `lend_through` solves `p` over
`inner` but never writes it back to `r`, so a read of `r` after `inner`'s block ends passes `yo check` (ASan:
heap-use-after-free). The `swap` shape (`sw(&mut r, &mut q)`) is the same. New this cycle: v0.2.76 cannot express the
parameter type (`dst : &mut &(Rc(X), p)` is rejected, "a reference to a reference … arrives with references as
binding types"); P3 (#1841, merged 2026-11-09, after v0.2.76) deleted that wall.

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
set :: (fn(generic(p : Origin), dst : &mut &(Rc(X), p), v : &(Rc(X), p)) -> unit)({ dst.* = v; });
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
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: rejected, the parameter type is not expressible
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

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `set(&mut r, &inner)`, `inner` block-local, `r` read after the block | accepted, heap-use-after-free | E0911 |
| `sw(&mut r, &mut q)`, `q := &inner` block-local | accepted, heap-use-after-free | E0911 |
| `set(&mut r, &inner)`, then `inner = mk()` while `r` is live | accepted, reads the new value | E0911 at the write |
| `set :: (fn(dst : &mut &Rc(X), v : &Rc(X)) …)` (origins elided) | E0923 in the callee | E0923 |
| `rp := &mut r; rp.* = ri` (local borrow, no call) | E0911 | E0911 |
| `swap-inferred-locals`, `swap-declared-union` (corpus, both referents outlive the reads) | accepted | accept |

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

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`swap-inferred-locals-dies` (E0911) beside `swap-inferred-locals`, and `ref-mut-ref-set-spelled-dies` (E0911).
