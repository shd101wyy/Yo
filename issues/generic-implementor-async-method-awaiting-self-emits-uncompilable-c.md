# A GENERIC implementor whose async method awaits `Self.<async method>` emits C that does not compile

**Status: OPEN.** Found 2026-08-26 while reviewing the C16 fix; **pre-existing**,
reproduces identically on develop tip.

## Symptom

```rust
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(
  generic(T : Type),
  Wrap(T),
  AR(
    read  : (fn(self : Self, io : Io) -> Impl(Future(usize, IoExn)))(io.async((e) => usize(5))),
    twice : (fn(self : Self, io : Io) -> Impl(Future(usize, IoExn)))(
      io.async((e) => {
        a := e.io.await(Self.read(self, io), e);
        b := e.io.await(Self.read(self, io), e);
        a + b
      })
    )
  )
);
```

clang rejects the emitted C with 4–5 errors:

```
error: returning '_file____priv_temp_8413_sync_fut_t *' from a function with
       incompatible result type '__yo_t0'
error: initializing '__yo_t23 *' with an expression of incompatible type '__yo_t0'
```

`__yo_t0` is the erased `Impl(...)` placeholder — the specialization never
replaced it with the concrete state-machine type, and one of the two futures came
out as a `_sync_fut_t` while its consumer expects a `_state_t`.

## Scope — this is NOT the trait-default bug

It happens with the body **provided explicitly** in the impl (above) *and* with
the body coming from a trait `?=` default. It is the *generic implementor* that
breaks it: the same trait, the same default, and a NON-generic implementor
compiles and runs correctly (that is what
`issues/fixed/trait-default-awaiting-self-async-method-emits-hollow-fn.md` fixed).

## Why it matters

`plans/STD_API_AUDIT.md` **D5** wants `BufReader(R)` / `BufWriter(W)` wrapping any
`Reader`/`Writer`. That is exactly a generic implementor of an async trait, so
D5 is **not fully unblocked** by the C16 fix: concrete implementors work,
`Wrap(T)`-shaped ones do not.

## Reproducer

`issues/repros/generic-implementor-async-await-self.yo`

```bash
yo compile issues/repros/generic-implementor-async-await-self.yo \
  --std-path ./std --release -o /tmp/g.out    # currently: C compiler failed (exit 1)
```
