# An owned upcast registers no `__yo_up_` target and the emitter names the slot by the handle's alias

**Severity:** S1 (every owned `upcast(b, Dyn(Tgt))` over a `Box`/`Rc`/`Arc` handle emits C referencing a
vtable member that is never declared, failing the whole translation unit — the two owned-upcast rows of
`tests/dyn_pointer_kinds.test.yo` and every batch containing them, all 30 rows of that batch reported failed)

## Symptom

```yo
(b : Box(Dyn(Speak, Twice))) = dyn(Box.new(Cat(n : i32(2))));
(s : Box(Dyn(Speak))) = upcast(b, Dyn(Speak));
s.speak();
```

The Yo side type-checks; the C compiler fails:

```text
error: no member named '__yo_up___yo_t_7291236631974479915' in 'struct __yo_t_3549794239191277090_vtable_s'
```

`__yo_t_7291236631974479915` is `Box(Dyn(Speak))`'s typedef name; the source vtable (`Dyn(Speak, Twice)`'s)
was emitted without any `__yo_up_` member at all.

## Root cause (two halves, one class)

1. **Registration never fires.** The collector's upcast arm
   (`src/codegen/functions/collection.yo`) unwrapped the SOURCE handle to its `Dyn` but guarded the
   TARGET with `is_dyn_type(&uei.ty())` — the whole `upcast(...)` expression's type. Under the flip an
   owned upcast's result type is the HANDLE (`Box(Dyn(Speak))`, `Rc(Dyn(Speak))`), not a `Dyn`, so the
   guard rejected the pair and `register_dyn_upcast` never ran: no vtable member, no
   `register_dyn_upcast_targets` (concrete, target) impl.
2. **The emitter names the slot by the handle.** `generate_upcast`
   (`src/codegen/exprs/downcast.yo`) spelled the slot `__yo_up_${tgt_c}` with `tgt_c` = the C name of
   the EXPRESSION type. For an owned upcast that is the handle's typedef ALIAS of the target `Dyn`'s
   fat struct — a different member name than the one the vtable layout emits from the registered
   (unwrapped) target `Dyn` (`src/codegen/types/generation.yo`, `src/codegen/functions/dyn.yo`). Even
   with the registration fixed alone, the reference and the member disagree.

## Fix

- The collector unwraps the target exactly as the source (`unique_box_payload_type`, then
  `cell_handle_view`), so the target registers as the `Dyn` every vtable layout and
  (concrete, target) impl lookup is keyed by.
- The emitter computes the slot name from the unwrapped target `Dyn`'s fat struct
  (`__yo_up_${tgt_slot_c}`) while keeping the handle's alias as the cast type (they are the same
  struct).

## Test

The owned-upcast rows of `tests/dyn_pointer_kinds.test.yo` ("an owned upcast after a reference one to
the same target" through "an owned upcast beside a plain `dyn(&v)` of the target") fail before the fix
(the batch's C does not compile) and pass after. Standalone reproducer: `tmp/p/p11a.yo` in this
worktree (reference upcast + one owned upcast; `yo-il` fails it, the fixed binary compiles and prints
`p11a ok`).
