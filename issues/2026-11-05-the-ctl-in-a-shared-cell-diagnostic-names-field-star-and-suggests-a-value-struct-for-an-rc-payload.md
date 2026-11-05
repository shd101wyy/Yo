# The ctl-in-a-shared-cell diagnostic names field `"*"` and suggests a value struct for an `Rc` payload

**Severity:** S3 — a misleading diagnostic: for `Rc(Slot)` where `Slot` is a value struct holding a `ctl` handler, the error says `Field "*" of a reference type cannot hold Slot` and advises "keep it in a value struct", which `Slot` already is.

Found while migrating `tests/cli-cases/ctl-handler-in-a-ref-struct-field-is-rejected` off
`ref(struct)` (V5 part B, branch `vbd/v5-part-b-tests`), on develop 68b45b81d. The rule is right:
an `Rc` payload outlives the frame a `ctl` handler unwinds into, exactly as a `ref` object did.
Only the wording is still written for `ref` objects.

## Symptom

```yo ignore
Raise :: (ctl(msg : &String) -> i32);
Slot :: struct(r : Raise);
SharedSlot :: Rc(Slot);
```

```
error: Field "*" of a reference type cannot hold Slot: it is (or contains) a `ctl` handler, which unwinds into the frame that installed it. A reference object outlives that frame, so a later call through the object would unwind into a frame that no longer exists. Pass the handler as an argument instead, or keep it in a value struct.
--> main.yo:5:15
```

The golden of `tests/cli-cases/ctl-handler-in-a-ref-struct-field-is-rejected` pins this text.

## Cause

`src/types/utils.yo:2101` formats every hit as `Field "${label}" of a reference type`, and an
`Rc`/`Arc` cell's payload slot is labelled `*`. The help line was written for `ref(struct)`, whose
remedy was to make the record a value.

## Fix direction

Word the payload case separately: `` `Rc(Slot)` cannot hold `Slot`: its payload contains a `ctl` handler (field `r`) … ``.
The remedy is to pass the handler as an argument, or keep the record unshared (a plain value or a
`Box`). Name the field that holds the handler rather than `*`. Once `ref` is gone (v0.2.77), the
`ref`-object wording can go too.

## Test

The fix re-records `tests/cli-cases/ctl-handler-in-a-ref-struct-field-is-rejected` with the new
text (the case keeps its `Rc(Slot)` fixture) and moves this doc to `issues/fixed/`.
