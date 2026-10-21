# An `Arc` cycle through `Mutex` passes the `Acyclic` bound

**Severity:** S2 — a value struct that reaches itself through
`Arc(Mutex(Self))` is derived `Acyclic`, so `arc` and `Mutex` accept it and a
program can close an `Arc` cycle; atomic cells are never cycle-collected
(`docs/en-US/ARC.md`), so the cycle leaks for the life of the process. The
bound exists to reject exactly this shape. Bounded: it needs a
self-recursive payload type and a write under the lock.

**Status:** open. **Found:** 2026-10-21 with the v0.2.67 seed, while
answering the maintainer's question whether an `UnsafeArc` without the
`Acyclic` bound is needed (it already is not enforced for this shape).

## Reproducer

`issues/repros/2026-10-21-an-arc-cycle-through-mutex-passes-the-acyclic-bound.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio.yo");
{ Mutex } :: import("std/sync/mutex");
Gc :: import("std/gc");
Node :: struct(id : i32, peer : Option(Arc(Mutex(Self))));
form_cycle :: (fn() -> unit)({
  a := arc(Mutex(Node).new(Node(id : i32(1), peer : .None)));
  b := a;
  a.with_lock(v => {
    v.peer = .Some(b);
  });
});
main :: (fn() -> unit)({
  before := Gc.tracked_count();
  form_cycle();
  mid := Gc.tracked_count();
  Gc.collect();
  after := Gc.tracked_count();
  unsafe(printf("before=%lu mid=%lu after=%lu\n", before, mid, after));
});
export(main);
```

`yo check` accepts it. Compiled with `--sanitize address --allocator system`
and run with `ASAN_OPTIONS=detect_leaks=1`, LeakSanitizer reports 112 bytes
leaked in 3 allocations (the `Arc` cell, the mutex, the payload's box); the
program prints `before=0 mid=0 after=0` (`Gc.tracked_count` never sees an
`Arc`, by design).

A control with the recursion spelled through a non-atomic cell
(`Option(Rc(RefCell(Self)))`) is the separate
`issues/2026-10-21-an-rc-refcell-cycle-is-never-tracked-by-the-collector.md`.

## Root cause (hypothesis)

The trait checker derives `Acyclic` for a value struct from its fields
(`src/evaluator/trait_checking.yo`, the `(tn == "Acyclic")` branch:
`value_acyclic_obligations`). `Node`'s field reaches `Arc(Mutex(Node))`;
`Arc(V)` is an atomic object, whose `Acyclic` is answered from the
definition-time registry (`can_type_form_rc_cycle`) rather than from its
payload, and `Mutex(T)`'s `impl(..., where(T <: (Send, Acyclic)), Mutex(T),
Acyclic())` needs `Node <: Acyclic` again, which is the obligation being
derived. The recursion guard answers the in-progress pair coinductively
(`g_trait_check_recursion_guard` / `g_ondemand_marker_guard`), which is
right for `Send` (a type is `Send` unless some field is not) and wrong for
`Acyclic` (a type that reaches itself through a cell IS cyclic). The same
walk does the right thing for `ref(struct)` roots, where
`can_type_form_rc_cycle` re-roots at every cell and finds the back edge; the
value-struct path through an atomic cell has no such re-rooting.

## Expected

`arc(Mutex(Node).new(...))` (and `Mutex(Node).new` before it) is rejected:
`Node` is not `Acyclic`, because it reaches itself through `Arc(Mutex(Self))`.
The fix is in the derivation: when the `Acyclic` obligation for a value
struct re-enters itself through an atomic cell, the answer is "not
Acyclic", exactly as `can_type_form_rc_cycle` answers for a reference root.
A recursive value type with no cell on the back edge (`Option(Box(Self))`,
`ArrayList(Self)`) must stay `Acyclic`.

## Test

The reproducer, as a `comptime_expect_error` case in `tests/send_sync.test.yo`
(the `Acyclic` bound's home), beside a positive control for `Option(Box(Self))`.
