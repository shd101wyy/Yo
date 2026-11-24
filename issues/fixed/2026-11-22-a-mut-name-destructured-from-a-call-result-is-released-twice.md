# A `mut` name destructured from a call's tuple, and reassigned, is released twice

**Severity:** S1 — use-after-free in generated code: `(mut(x), y) := f()` with an `Rc` element and any reassignment of `x` in the body releases the element twice at scope exit (seed v0.2.79 and develop `f06ff5889`)

**Status:** FIXED on `v0280/s1-destructure-mut` (found 2026-11-22 by the VERDICTS-73 F2 lane; the
root cause of that lane's unbounded E0623 recursion)

## Reproducer

```yo
{ println } :: import("std/fmt");
Node :: struct(n : i32);
pair :: (fn(e : &Rc(Node)) -> Tuple(Rc(Node), usize))((Rc.clone(e.*), usize(0)));
use :: (fn(e : &Rc(Node), swap : bool) -> i32)({
  (mut(written), synth) := pair(e);
  if(swap, {
    written = Rc.new(Node(n : i32(9)));
  });
  written.*.n
});
main :: (fn() -> unit)({
  x := Rc.new(Node(n : i32(7)));
  keep := Rc.clone(x);
  println(`before ${ref_count(x)}`);
  a := use(&x, false);
  println(`after ${ref_count(x)} ${a}`);
});
export(main);
```

```text
$ yo compile dd.yo --allocator system --sanitize address -o dd && ./dd
==2450394==ERROR: AddressSanitizer: heap-use-after-free on address 0x7397935e0010 ...
READ of size 4 at 0x7397935e0010 thread T1
```

Without ASAN (`--allocator system`): `tcache_thread_shutdown(): unaligned tcache chunk detected`, rc=134.
The `swap = false` call alone is enough: the reassignment only has to exist in the body.

Controls (same program shape, seed v0.2.79): no reassignment of `written`
(`mut` kept) — counts stay balanced; `(written, synth) := pair(e)` without
`mut` — balanced; `t := pair(e); (mut(written) : Rc(Node)) = Rc.clone(t.0)` —
balanced.

## Root cause (emitted C)

```c
__yo_t_N __yo_v_written = _tmp._0; // Destructuring 0
size_t __yo_v_synth = _tmp._1; // Destructuring 1
...
__yo_decr_rc((void*)(__yo_v_written));
__yo_decr_rc((void*)((_tmp)._0));
return __yo_scope_ret;
```

A destructured name does not own its element (`evaluate_destructuring` in
`src/evaluator/exprs/destructuring-assignment.yo` adds it with
`is_owning_the_rc_value` false; the tuple temporary keeps the element and
releases `._0` at scope exit). A `mut(name)` binding is made reassignable
there, and a reassigned binding is treated as owning: the reassignment
releases the old value (the element the temporary still owns) and the scope
exit releases the binding as well as the temporary's `._0`. One of the two
owners has to give way: either the destructuring moves the element out of the
temporary when the name is `mut` (no `._0` release), or the binding stays
non-owning until its first reassignment.

## Where it bit

`member_behind_deref_error` (F2 of VERDICTS-73,
`src/evaluator/exprs/property-access.yo`) bound `(mut(written), synth) :=
strip_synthesized_stars(obj)` and reassigned `written` on the `for`-head path.
Every E0623 then released the receiver's AST node once too often; the node was
freed while still in the tree, and any later walk of it (a `yo compile` whose
body holds a `comptime_expect_error` E0623 row, `yo fix`, a test batch's
check) crashed or looped on reused memory. F2 binds each name once instead;
it was the only `(mut(x), …) := call()` in `src/` and `std/`.

## Why the element was not moved out of the temporary

A destructuring BORROWS (`plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md` item 8): each name is a
bitwise copy of its element, and the destructured value, a call's temporary or a named local, keeps
owning every element and releases it at scope end. Yo has no partial moves (decision 19), so there is
no state in which the temporary owns `._1` but not `._0`. A `mut(name)` binding made that borrowed copy
writable: its reassignment released the old value (the element the temporary still owns) and flipped
the binding to owning (`is_owning_the_rc_value` follows the stored type in `assignment.yo`), so the
scope end released the binding as well as the temporary's element. A `self : &mut Self` call on such a
binding (`xs.push(…)`) was already E0908, and a field write E0908 too; the whole-binding write was the
one door left open.

The same hole, by the same path (`handle_member_destructuring`, `destructuring-assignment.yo`):

| Shape | Seed v0.2.79 |
| --- | --- |
| `(mut(w), s) := f()`, `w` reassigned | ASan heap-use-after-free |
| `{ a : mut(w), b } := f()`, `w` reassigned | ASan heap-use-after-free |
| `t := f(); (mut(w), s) := t`, `w` reassigned | ASan heap-use-after-free |
| `(mut(xs), n) := f()`, `xs.push(…)` | E0908 (already rejected) |
| `match(f(), (mut(w), s) => …)`, `w` reassigned | balanced: a consuming match moves the parts |
| `((mut(a), b), c) := f()` | "Nested destructuring is not supported" |

## Fix

A `mut(name)` destructuring binding is a by-value copy of a borrowed element, which is exactly a `&`
match's `mut(name)` binding (VERDICTS-28 Q2). The destructurer now applies that rule: when the
element's type holds an RC cell or an owned buffer (`type_contains_rc_cell_or_move_only`, true of
`Rc`, `Box`, `String`, the collections and every move-only type, false of plain data), the binding is
E0901 at its declaration, whether or not it is ever written:

```text
error[E0901]: use of moved value: cannot copy `written` out of the destructured value: a `mut(name)` binding of a destructuring copies its element by value, and its type `Rc(Node)` holds data the destructured value still holds.
help: bind `written` without `mut` (it borrows its element) and copy it explicitly into a `mut` local (`.clone()`), or match the value instead: a `match` of a value you own moves its parts into the arm's bindings, `mut` ones included
```

A plain-data `mut` element (`(first, mut(second)) := (i32(1), i32(2))`) is unchanged, and so is a
reference element (`is_ref`) and a compile-time destructuring. The two sound spellings are
`(w0, s) := f(); mut(w) := w0.clone();` and `match(f(), (mut(w), s) => …)`.

Letting a destructuring of an owned temporary consume it, as a by-value `match` does (Rust's
`let (mut a, b) = f();`), would accept the reproducer instead; that is a language change, filed as a
question for the maintainer, not part of this fix.

## Tests

- `tests/mut-bindings.test.yo`: "a mut(...) destructuring binding of an element with drops is E0901"
  (the reproducer reassigned and not, a struct destructuring, a named source, and `String`, `Box`
  and `ArrayList` elements; fails before the fix: no error is raised) and "a destructured element with
  drops changes through an owned copy or a consuming match" (balanced `ref_count` on both paths).
- `tests/origins/unsound/destructure-mut-call-element.yo` (`// expect: E0901`; before the fix it
  checks clean and its ASan run is heap-use-after-free) and its positive control
  `destructure-mut-call-element-pos.yo` (the `.clone()` spelling, ASan-clean).
