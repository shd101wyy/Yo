# A `mut` name destructured from a call's tuple, and reassigned, is released twice

**Severity:** S1 — use-after-free in generated code: `(mut(x), y) := f()` with an `Rc` element and any reassignment of `x` in the body releases the element twice at scope exit (seed v0.2.79 and develop `f06ff5889`)

**Status:** OPEN (found 2026-11-22 by the VERDICTS-73 F2 lane; root cause of
`issues/fixed/2026-11-22-e0623-raised-inside-a-body-trial-or-specialization-recurses-without-bound.md`)

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

## Test

A fix adds the reproducer above as a runtime test (`ref_count` before and
after, both `swap` values), which fails under ASAN today.
