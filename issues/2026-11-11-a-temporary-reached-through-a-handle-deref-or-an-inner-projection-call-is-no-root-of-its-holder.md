# A temporary reached through a handle's `.*` or an inner projection call is no root of the holder it feeds

**Severity:** S1. In `{ v = mkv(&long().*.s); }` (`long() -> Rc(X)`, `mkv :: (fn(r : &String) -> V(r))`) and
`{ v = mkv(mkx().get()); }` (`get(self : &Self) -> &String`), the holder `v` outlives the statement while the `Rc`
or the struct its reference points into is a temporary of that statement; both pass `yo check` and `v.r` is read
after the temporary is gone (ASan: heap-use-after-free; stack-use-after-scope). The plain field form
`v = mkv(&mkx().s)` is rejected. SEED_VERDICT

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A23). Confirmed on develop `64f33c710`. The `.*` half
shares its cause with
`issues/2026-11-11-a-projection-may-return-a-reference-into-a-local-or-by-value-box-rc-or-arc-handle.md` (A30).

## Reproducers

`issues/repros/2026-11-11-a-temporary-reached-through-a-handle-deref-or-an-inner-projection-call-is-no-root-of-its-holder.yo`
(negative, expects E0911):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
V :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(String, p)));
mkv :: (fn(r : &String) -> V(r))(V(r)(r : r));
long :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
main :: (fn() -> unit)({
  k := String.from("k");
  mut(v) := mkv(&k);
  {
    v = mkv(&long().*.s);
  };
  println(`OUT: ${v.r.*}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: SEED_MAIN
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-projection-call.yo` (negative, E0911): `v = mkv(mkx().get())` in an inner block, `mkx() -> X` by value;
  stack-use-after-scope. SEED_PROJ
- `…-pos.yo` (positive control): the `Rc` and the struct are bound to locals that outlive the holders
  (`v := mkv(&h.*.s)`, `w := mkv(x.get())`). Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `v = mkv(&long().*.s)` in an inner block (also in a `while` body) | accepted, UAF | E0911 |
| `v = mkv(&Box.new(longs()).*)` in an inner block | accepted, UAF (ledger) | E0911 |
| `v = mkv2(long().as_ref())` (the `Rc`'s projection `as_ref`) | accepted, UAF (ledger) | E0911 |
| `v = mkv(mkx().get())`, `v = mkv(id(&longs()))` in an inner block | accepted, stack-use-after-scope | E0911 |
| `v := mkv(&long().*.s)` / `v := mkv(mkx().get())`, read later in the same block | accepted; runs print `72 72` / a stale `0` (ledger) | E0911 |
| `v = mkv(&mkx().s)` (a field of the temporary, no `.*`, no inner call) | E0911 "Cannot store a reference into `(mkx().s)` in `v` here: it is a temporary" | — |
| `r := c.borrow_mut().get()` (projection result bound directly) | E0911 (R-TEMP) | — |

## Root cause

`is_temporary_operand` (`src/evaluator/utils.yo`), R-TEMP's test for "this lent operand is a temporary", is
structural, and it returns `false` in exactly the two shapes above:

- at a `.` whose member is `*` it stops ("not a deref (`p.*` is a place behind a reference)") without asking what
  is dereferenced, so `long().*.s` is not a temporary although `long()` is an owned `Rc` the statement made;
- for a projection call it returns `false` ("not a projection's or a subscript's place (those lie in their own
  roots)"), so `mkx().get()` and `long().as_ref()` are not temporaries.

The second exit relies on the caller to recurse: `origin_of`'s R-CALL loop and `_bind_projection_result` both test
each root argument with `is_temporary_operand` and then recurse into it, and the inner call's own root (`mkx()`) is
a temporary. ROOT_CAUSE_PROJ

## Expected

E0911 at both `=` (and at the `:=` forms), naming the temporary, as for the plain field form. BCC's R-LEND row: "a
temporary operand is a hidden statement local (R-TEMP)"; O3's return rule (made precise 2026-11-11, A30): a `.*` on
an owning handle is a field step, and "the same reading applies wherever a place's root is computed: a lend
(`mkv(&long().*.s)` borrows the temporary `long()` returns) and a temporary's extent." An inner projection call's
result is rooted at its own arguments (R-CALL), so a temporary among them is a root of the outer holder too.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows next
to `holder-from-temporary` and `lend-of-temporary-in-call-result` in `tests/origins/corpus.tsv` for the deref and
the inner-projection forms.
