# A closure-typed slot never releases its captures

**Status:** open (fix in flight on `fix/zst-closure-fn-result`)
**Found:** 2026-09-12, measured on the published **v0.2.31** compiler and std —
this is not a regression, it has always been there.
**Class:** the empty-string drop fallback
(memory `empty-string-drop-fallback-class`).

## Symptom

A `Dispose` counter that must read 1 reads 0. Nothing crashes and nothing is
reported: the object simply never dies.

```rust
_dc := AtomicUsize.new(usize(0));
_Tracked :: atomic(ref(struct(tag : i32)));
impl(_Tracked, Dispose(dispose : (fn(self : Self) -> unit)({
  _p := _dc.fetch_add(usize(1), MemoryOrder.AcqRel);
  ()
})));
run_it :: (fn(f : Impl(Fn() -> unit)) -> unit)(f());

{
  tracked := _Tracked(tag : i32(7));
  (inner : Impl(Fn() -> unit)) = (() => { _x := tracked.tag; () });
  run_it(inner);
};
// _dc == 0   ← should be 1
```

Measured on v0.2.31 (`issues/repros/closure-slot-never-releases-captures.yo`):

| shape | disposes | expected |
| --- | --- | --- |
| `tracked` used directly, no closure | 1 | 1 |
| `tracked` captured by a closure LOCAL | **0** | 1 |
| that closure captured by a second closure | **0** | 1 |

## Root cause

`generate_drop_code_for_value` / `generate_dup_code_for_value`
(`src/codegen/exprs/drop_dup.yo`) gate every RC decision on
`type_contains_rc_type`, which is `false` for a bare `SomeT`. A closure-typed
slot's static type IS a bare `SomeT` — the `Impl(Fn(...))` wrapper — even
though at runtime the slot carries the argument closure's CAPTURE STRUCT, which
is what `get_type_string` renders and what the C code casts through.

So every RC value reached through a closure-typed slot was invisible to both
walks:

* a closure LOCAL hit the top-level gate — `generate_drop_code_for_value`
  returned `""`, the silent fallback, and the scope-end drop released nothing;
* a closure captured BY another closure hit the same gate one level in — the
  containing capture struct's field walk skipped the `cb` field, so the spawn
  wrapper's release (`_emit_capture_drop_lines`,
  `src/codegen/exprs/parallelism.yo`) reached `.sink` and nothing else.

The second shape is how this surfaced: D18's `Thread(T).spawn` wraps the user's
callback in a result-relaying closure, `(io) => { sink.send(cb(io)); () }`, so
`cb` becomes a captured closure and `tests/thread.test.yo`'s three
dispose-counter tests went from 1 to 0. The counter was right and the wrapper
was wrong.

## Fix

One resolution point, used by both walks:

```rust
_resolve_closure_impl_type :: (fn(ty : TypeValue) -> TypeValue)(
  cond(
    (is_some_type(ty) && type_implements_fn(ty)) => resolve_some_type_to_concrete(ty),
    true => ty
  )
);
_contains_rc :: (fn(ty : TypeValue) -> bool)(
  type_contains_rc_type(_resolve_closure_impl_type(ty))
);
```

`_contains_rc` replaces every `type_contains_rc_type` call in the module (12
sites), and both generators resolve at entry. Drop and dup therefore change
together by construction, which is the invariant this class of bug breaks: a
field that is dup'd must be dropped.

Narrow by construction — only an `Impl(Fn)` SomeT resolves. An `Impl(Future)`
keeps its existing arm (an RC decrement on the state-machine handle, not a
field walk) and every other SomeT is untouched.

## Why this direction is the safe one

The change only ADDS releases, so the failure mode it could introduce is a
double free, not a use-after-free — and a double free is loud. The oracle is a
dispose counter asserting **exactly one**, so both directions are caught:
`0` is the leak this fixes, `2` would be the over-release it must not cause.

## Tests

`tests/closure.test.yo`:

* a closure local's captures are disposed exactly once at scope end;
* a closure captured by another closure is disposed exactly once;
* the no-closure baseline still disposes exactly once.

`tests/thread.test.yo`'s three existing spawn dispose-counter tests cover the
`Thread(T)` wrapper shape.
