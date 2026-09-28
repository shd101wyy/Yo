# A state-machine binding from a `match` arm's payload is released only on escape

> Found 2026-09-28 while fixing
> `issues/fixed/an-awaited-match-scrutinee-is-never-released.md`. Open.

## Reproduction

```rust
(g_d : i32) = i32(0);
P :: ref(struct(n : usize));
impl(P, Dispose(dispose : (fn(self : Self) -> unit)({ g_d = (g_d + i32(1)); })));
optp :: (fn(n : usize) -> Option(P))(Option(P).Some(P(n : n)));
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    io.await(yield(io), io);
    kept := match(
      optp(usize(5)),
      .Some(p) => p,
      .None => P(n : usize(0))
    );
    return(kept.n);
  });
  r := io.await(task, io);
  println(`r=${r} disposed=${g_d}`);   // r=5 disposed=0; expected 1
});
export(main);
```

The same body without the `io.await` (not a state machine) prints
`disposed=1`. An awaited scrutinee behaves the same.

## What the C shows

`kept` is a cross-boundary local (`sm->var_kept_<id>`). The arm `incr`s the
payload into it. The completion state releases the scrutinee temp but not
`kept`: the only `__yo_decr_rc(sm->var_kept_…)` is in the state machine's
dispose, under `if (sm->state == -2)` (escape). One reference leaks per
run.

## Expected

The completion state releases `kept` exactly once, like the synchronous
scope-end drop.
