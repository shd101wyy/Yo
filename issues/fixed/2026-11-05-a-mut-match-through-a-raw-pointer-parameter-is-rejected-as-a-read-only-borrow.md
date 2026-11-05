# `match(&mut p.*.f, …)` through a raw-pointer parameter is rejected as a write through a read-only `&` borrow

**Severity:** S2 — a valid program is rejected with a wrong diagnosis: `p` is a raw pointer (`p : *(T)`), not a `&` borrow, and the place behind it is writable; the workaround is to lend the place to a local first.

Found by the README example-project rehearsal for v0.2.75 (markdown_it_yo's `Token.attr_push`, `self : *(Self)`, `match(&mut self.*.attrs, .Some(attrs) => attrs.push(…), …)`). Reproduced with the v0.2.74 seed and with develop d76eac577.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
T :: struct(xs : Option(ArrayList(i32)));
push_one :: (fn(p : *T, v : i32) -> unit)(
  match(&mut p.*.xs, .Some(xs) => xs.push(v), .None => ())
);
main :: (fn() -> unit)({
  mut(t) := T(xs : .Some(ArrayList(i32).new()));
  push_one(addr_of(t), i32(7));
  println(`${match(&t.xs, .Some(xs) => xs.len(), .None => usize(0))}`);
});
export(main);
```

```text
error[E0908]: Cannot match `&mut ((p.(*)).xs)`: `p` is a `&` borrow, which is read-only.
  --> rawmatch.yo:6:17
help: match it with `&((p.(*)).xs)`, or take `p` as `p : &mut T`
```

Expected: it compiles and prints `1`. Writing the same place through a local borrow is accepted and prints `1`:

```yo ignore
push_one :: (fn(p : *(T), v : i32) -> unit)({
  q := &mut p.*.xs;
  match(q, .Some(xs) => xs.push(v), .None => ())
});
```

## Root cause

`_decide_match_mode` (src/evaluator/exprs/match.yo) handles a `&mut` scrutinee (marker 2) by walking the place to its root variable with `_scrutinee_root_variable`, then rejecting the match when `_variable_is_imm_borrow(root)` holds. The walk follows every `.` access, including `.*`, so for `p.*.xs` it stops at `p`. `p` is an unmarked parameter, which the predicate treats as a read-only borrow. A raw-pointer dereference starts a new place, though: what lies behind `p.*` is not part of `p`'s storage, so `p`'s mutability says nothing about it. The local-borrow path (`q := &mut p.*.xs`) already gets this right.

## Second symptom: argument exclusivity (E0910) treats two fields behind one pointer as one place

The call-argument exclusivity check has the same blind spot. Lending two disjoint fields of a struct reached through a raw pointer is rejected, and the error names the pointer itself as the lent place. The same call through a `&mut` reference is accepted:

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ replace } :: import("std/mem");
S :: struct(a : ArrayList(ArrayList(i32)), b : ArrayList(i32));
via_ref :: (fn(s : &mut S) -> unit)(
  s.a.push(replace(&mut s.b, ArrayList(i32).new()))
);
via_ptr :: (fn(p : *S) -> unit)(
  p.*.a.push(replace(&mut p.*.b, ArrayList(i32).new()))
);
export(via_ref, via_ptr);
```

```text
error[E0910]: This argument lends `&mut` `p`, which an earlier argument of the same call lends to it (`((p.(*)).a)`): …
   --> disj.yo:10:22
```

`via_ref` is accepted. markdown_it_yo's `state_push` (`state.*.prev_delimiters.push(replace(&mut state.*.delimiters, …))`) hit this; the workaround is to split the call into two statements. Fixing the root walk once, for both the match-mode check and the argument-exclusivity check, covers both symptoms; the test should include `via_ptr`.

## Recommendation

Stop the root walk at a `.*` whose operand is a raw pointer (a `*(T)`), and do not apply the read-only check past it. Unsafe code that dereferences the pointer already owns the aliasing obligation. Add the reproducer above as a test expecting `1`, and add the `&`-parameter case (`p : &T`, `match(&mut p.*.xs, …)`), which must stay E0908.

## Fix

A place reached through a raw-pointer dereference is not part of the pointer binding's storage. The helper `deref_operand_is_raw_pointer` (`src/evaluator/utils.yo`) reads this from the evaluated operand's type: `operand.*` dereferences a `*T`. Both checks use it:

- **`&mut` match** (`src/evaluator/exprs/match.yo`): `_scrutinee_crosses_raw_pointer` walks the scrutinee's `.` chain. When a step is a raw-pointer `.*`, `_decide_match_mode` returns `MATCH_MODE_MUT` without the read-only-root check, and the arm bindings get no `inout` borrow root, because they borrow nothing of `p`. A `&` reference stays read-only: `p : &T` with `match(&mut p.*.xs, …)` is still E0908, since `p.*` reads the referent, not a pointer.
- **Argument exclusivity** (`_lent_place_of`, `src/evaluator/calls/function.yo`): a raw-pointer `.*` step stays in the path as `*` instead of clearing it. `p.*.a` and `p.*.b` are therefore disjoint, as `s.a` and `s.b` are. The same field lent twice (`f(&mut p.*.b, &mut p.*.b)`) still overlaps (E0910), and so do the pointer and anything behind it. `_ArgPlace` (`_arg_places`) already kept `*` as a path step.

Tests: `tests/unsafe.test.yo`. "a &mut match and disjoint &mut arguments through a raw pointer" covers this doc's two reproducers and prints the pushed length. Two `comptime_expect_error` canaries cover the `&` reference (E0908) and the same field lent twice (E0910). On the v0.2.74 seed the first reproducer fails with E0908 and the second with E0910; with this branch both compile, and the first prints `1`.
