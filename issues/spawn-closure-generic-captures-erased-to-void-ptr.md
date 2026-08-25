# Generic type parameters inside a spawn closure are emitted as `void*`

**Status:** OPEN — blocks `Thread.spawn` carrying a result (`join() -> T`),
plans/STD_API_AUDIT.md D7.

## Symptom

A value whose type comes from an enclosing generic function's type parameter is
emitted as `void*` in the spawn closure's capture struct, while the rest of the
specialized function uses the concrete type. The emitted C is rejected:

```
struct __yo_t23_struct { //  : <struct:capture_yo_id_7371>
  __yo_t24* ch;
  void* v;          // <-- should be int32_t
};

error: incompatible pointer to integer conversion passing 'void *' to
       parameter of type 'int32_t' (aka 'int')
```

Calling a captured generic closure has the same shape — the result temp is
declared `void*`:

```
void* _file____User_temp_9326 = closure_yo_id_7419(&(((__yo_t21*)closure_context)->cb), io);
```

## Reproducer

`issues/repros/spawn-closure-generic-capture-void-ptr.yo`

```
yo compile issues/repros/spawn-closure-generic-capture-void-ptr.yo --release -o /tmp/r.out
```

## Measured boundary

| shape                                                                              | result |
| ---------------------------------------------------------------------------------- | ------ |
| generic fn, closure passed to an ordinary fn that CALLS it                          | OK |
| generic fn, closure passed to a non-generic `Impl(Fn() -> unit)` param that calls it | OK |
| generic fn, closure passed to `Thread.spawn` / `__yo_thread_spawn`                  | BROKEN |
| generic **impl method** (`impl(generic(T), Holder(T), run : ...)`) + spawn          | BROKEN (mangled name keeps the unresolved SomeT id, e.g. `_1869_`) |
| `generic(E : Type.Struct)` used as the spawn closure's own parameter type           | BROKEN (`void*`) |

An explicit local annotation (`(r : T) = cb();`) fixes the non-spawn case but
not the spawn case.

Root cause is the same family as
`issues/impl-method-self-receiver-hollows-forwarded-spawn-closures.md`: the
closure handed to the spawn primitive is never re-specialized for the enclosing
generic instantiation, because nothing *calls* it on the Yo side, so the
capture struct registered at first evaluation (with `T` unresolved) is what
codegen reads.

## Why this blocks `join() -> T`

Carrying a task's return value out of the thread requires `spawn` to be generic
over `T` and to place a `T`-typed expression (`ch.send(cb(io))`, a `*(T)` slot
write, …) inside the spawned closure. Every route measured needs exactly that,
so `Thread.spawn`/`ThreadPool` cannot deliver `join() -> T` until this is fixed.
