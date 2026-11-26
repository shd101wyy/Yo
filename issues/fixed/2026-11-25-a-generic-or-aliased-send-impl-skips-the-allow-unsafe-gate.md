# A generic or aliased `Send`/`Sync` impl skips the `AllowUnsafe` gate

**Severity:** S1 — a file with no `pragma(Pragma.AllowUnsafe)` declares `Holder(T)` `Send` for every `T` and moves an `Rc` into a thread: a data race on the non-atomic count (ThreadSanitizer), a wrong count and a double free at `-O2`.

Filed 2026-11-25 by the `bound-s1` lane from VERDICTS-84 §7 item 2 (the consult ran `check` only; this doc builds and runs it).
Reproduced with a stage 1 of develop `fc89e3195`.

## Reproducer

No pragma anywhere. Both threads clone and drop the same `Rc(i32)`:

```yo
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), Holder(T), Send());
bump :: (fn(r : &Rc(i32), n : i32) -> unit)({
  (mut(i) : i32) = i32(0);
  while(i < n, i = (i + i32(1)), {
    c := Rc.clone(r.*);
    _x := c.*;
  });
});
main :: (fn(io : Io) -> unit)({
  r := Rc.new(i32(1));
  mine := Holder(Rc(i32))(v : Rc.clone(r));
  t := Thread(unit).spawn({ mine }(io : Io) => {
    bump(&mine.v, i32(200000));
  });
  bump(&r, i32(200000));
  t.join();
  w := r.downgrade();
  println(`strong_count after (expect 1): ${w.strong_count()}`);
});
export(main);
```

`yo check` exits 0. Built with `--sanitize thread --allocator system`:

```text
WARNING: ThreadSanitizer: data race (pid=263020)
  Write of size 4 at 0x720400000000 by thread T1:
    #0 __yo_incr_rc a-race-tsan.c:? (a-race-tsan+0x10c7ba)
  ...
  Previous write of size 4 at 0x720400000000 by thread T2:
    #0 __yo_decr_rc a-race-tsan.c:? (a-race-tsan+0x109ee2)
  ...
strong_count after (expect 1): 15
```

(rc 66, four race reports). Built with `--optimize 2`, five runs printed counts 368, 585, 848, 717 and once
`free(): double free detected in tcache 2`. `impl(generic(T : Type), Holder(T), Sync())` plus `Send()` with the payload in an `Arc`
races the same way (five reports; `-O2` runs abort with a double free or `tcache_thread_shutdown(): unaligned tcache chunk detected`).

The concrete form is open too when the trait is reached through another name:

```yo ignore
S :: Send;
impl(H2, S()); // H2 :: struct(v : Rc(i32)); no pragma; check rc=0, TSan reports ten races
```

The controls are rejected: `impl(H2, Send())` without the pragma ("Manual 'impl(..., Send())' requires pragma(Pragma.AllowUnsafe)"),
and the generic program without the impl (E0602 at the spawn).

## Root cause

`evaluate_module_value` (`src/evaluator/values/impl.yo`) has two paths for a trait constructor in an impl. Case 3 (a concrete receiver)
runs the `Send`/`Sync` gate inline; Case 2 (`impl(generic(...), ...)`) runs only `_throw_if_deref_impl_outside_prelude` and
`_throw_if_acyclic_impl`, so a generic header never meets the gate. Case 3's gate also compares the trait's written name
(`pos_trait_name == "Send"`) instead of the trait it resolves to, so an alias (`S :: Send`) or any other spelling passes. Case 2
skips the `Sized` and `Escapable` rejections the same way (accepted and inert: both are read from the type's structure, so the impl
changes nothing; checked with `Rc.new(Holder(&i32)(...))`, still E0909).

## Fix

One helper, `_throw_if_unimplementable_marker_impl`, called by both cases on the resolved trait: `Sized` and `Escapable` are rejected
outright, `Send` and `Sync` need the pragma in the file the impl is written in. Tests: `tests/thread-safety.test.yo` (the generic,
the generic `Sync` and the aliased forms) and `tests/cli-cases/` for the full text.
