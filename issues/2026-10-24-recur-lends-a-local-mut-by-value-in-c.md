# `recur(&mut local, …)` passes the local by value in the emitted C

**Severity:** S2 — a valid program that lends a by-value local `&mut` to a `recur(...)` self-call fails at the C compiler ("passing 'struct …' to parameter of incompatible type 'struct … *'"); calling the function by its name is the workaround.

**Status:** open. Found 2026-10-24 while moving `std/encoding/toml.yo`'s writes onto a `&mut` descent (VBD P3, `plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.4). Pre-existing: the v0.2.68 seed and the develop tree binary (`f271ed005`) emit the same C.

## Reproducer

`issues/repros/2026-10-24-recur-lends-a-local-mut-by-value-in-c.yo`:

```yo
bump :: (fn(x : &mut Inner, depth : usize) -> unit)(
  cond(
    (depth == usize(0)) => {
      x.n = (x.n + i32(1));
    },
    true => {
      mut(child) := Inner(n : x.n);
      recur(&mut child, depth - usize(1));
      x.n = child.n;
    }
  )
);
```

`yo compile issues/repros/2026-10-24-recur-lends-a-local-mut-by-value-in-c.yo`:

```text
error: passing '__yo_t_…' (aka 'struct __yo_t_…_struct') to parameter of incompatible type '__yo_t_… *' (aka 'struct __yo_t_…_struct *'); take the address with &
    yo_id_…(__yo_v_child, (__yo_sub_chk_u64((__yo_v_depth), (1ULL), "…", 11, 31)));
```

With `bump(&mut child, …)` in place of `recur(&mut child, …)` the program compiles and prints `2`.

## Root cause

`generate_recur` (`src/codegen/exprs/recur.yo`) emits each argument with `_call_generate_expr` and then only STRIPS a `(*name)` dereference when the argument variable is itself a `&mut` binding (a parameter forwarded on). It never consults the callee's parameter modes, so an argument that is a by-value place lent to a `&mut T` parameter gets no address-of. The ordinary call emitter takes the address for a ref parameter; `recur` needs the same treatment (the function being emitted is the callee, so its parameter modes are at hand).

## Fix plan

Have `generate_recur` emit a `&mut`/`&` argument through the same ref-argument path the ordinary call emitter uses, then turn the reproducer into a test in `tests/` (it fails at the C compiler before the fix). `std/encoding/toml.yo`'s `_store_at` calls itself by name until then; switch it back to `recur` with the fix.
