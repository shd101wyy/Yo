# `rc(b)` of a ref-object parameter asserts it unborrowed

**Severity:** S2 — a valid program panics: a function that only moves its
`ref` parameter into `rc(b)` (or `arc(b)`) gets the borrowed `for`'s entry
assert, which fires when the object is reached through a second handle inside
`for(&mut bag, …)`.

**Found:** 2026-10-28, while fixing
`issues/fixed/2026-10-28-a-match-arm-returning-its-pattern-binding-classifies-as-unknown-storage.md`
(the coordinator asked whether `rc`/`arc` share that gap). They do not: `rc`
and `arc` keep their own bodies (they do not forward to `Rc(T).new` /
`Arc(T).new` until a seed carries static-argument inference A3), and this
false positive has a different cause. Not a regression: the develop binaries
before and after #1646 (`0f8882138`, W4, `49aca7a72`) all panic.

## Reproducer

`issues/repros/2026-10-28-rc-of-a-ref-object-parameter-asserts-it-unborrowed.yo`:
`keep_rc :: (fn(b : VBag) -> Rc(VBag))(rc(b))`, called as `keep_rc(other)`
inside `for(&mut bag, …)` where `other := bag`. Expected: prints `4`, rc 0.
Actual: `panic: container operation while an interior reference (a 'ref'
into an element/field) borrows from it`, rc 134.

## Root cause

`YO_DEBUG_BORROW_MASK=1` on the repro prints, for `rc`'s specialization:

```text
[borrow-all] extern-arg-rooted: saved_ctx
[borrow-all] extern-arg-rooted: saved_vtable
```

`rc`'s `.Some(a)` arm saves the thread's allocation scope
(`saved_ctx := __yo_scope_ctx()`, `saved_vtable := __yo_scope_vtable()`),
sets it to `a`, builds the cell and restores it with
`__yo_scope_set(saved_ctx, saved_vtable)`. `_ms_extern_may_mutate` answers
yes for every `__yo_*` extern that is not a pure builtin, so
`__yo_scope_set`'s arguments count as mutated storage (`roots_of_args`). Its
arguments are the results of the other two externs, which classify as unknown
storage, so `rc`'s mask is `all`. `keep_rc` passes its parameter to a callee
whose mask is `all`, and the walk attributes a deep mutation to it: `b` gets
the entry assert. `arc` has the same arm.

## Fix direction

`__yo_scope_set` writes the thread's allocation-scope slots and nothing its
arguments point at; `__yo_scope_ctx`/`__yo_scope_vtable` only read them. Teach
the mutation summary that the scope triple touches no argument storage (a
named case beside `_msp_allocator_slot`), with this repro as the test. The
arm itself goes away when V5 moves `rc`/`arc` onto `__yo_cell`
(plans/backlog/ALLOCATOR_PLACEMENT.md §6 A1); until then every `rc(x)`/`arc(x)`
of a `ref` parameter carries the false assert.
