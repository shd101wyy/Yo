# inout-param C codegen emits `T self = (*self);` shadow in multi-statement bodies

## Summary

When an `inout(name) : T` parameter is referenced inside a multi-statement function body, the C codegen emits a buggy local declaration that shadows the parameter:

```c
static inline uint64_t fn_...(uint64_t* self) {
  uint64_t self = (*self);                   // <-- BUG: redefines the param
  uint64_t _tmp = ((self) * (2ULL));         // uses parameter (uint64_t*) not the local
  ...
}
```

clang rejects this with:

```
error: redefinition of 'self' with a different type:
   'uint64_t' (aka 'unsigned long long') vs 'uint64_t *' (aka 'unsigned long long *')
```

## Minimal repro

```yo
my_fn :: (fn(inout(self) : u64) -> u64)({
  doubled := (self * u64(2));
  doubled
});
main :: (fn() -> unit)({
  x := u64(21);
  y := my_fn(x);
});
export(main);
```

Compile with `./yo-cli compile <file>.yo`.

## What works

Single-expression body works fine:

```yo
my_fn :: (fn(inout(self) : u64) -> u64)(self);   // OK
```

`inout` on object/struct types where the body accesses fields (`self.field`) also works — `emitter.yo` migrated cleanly. The bug only manifests when `self` itself appears as a bare value in an expression that triggers temp-variable materialization.

## Why it matters

This blocks the ToString trait migration to `inout(self) : Self` (and presumably any other trait migration where impl bodies use `self` as a bare value rather than `self.field`). The impl looks like:

```yo
to_string : (fn(inout(self) : Self) -> String)({
  buffer := Array(u8, _INT_BUFFER_SIZE).fill(0);
  ...
  snprintf(..., "%llu", self);   // <-- triggers the bug
  ...
})
```

Reverted in commit-after-XXXXX. The Hash and Clone trait migrations worked because their impl bodies were single-expression and trivially inlined.

## Suspected location

`src/codegen/exprs/initialization-assignment.ts` around the temp-variable declaration emit (the agent investigation pointed at lines 401–408 but the trigger may be elsewhere — the emitted line has no `// Save old value` comment, so it's a different code path from the obvious one). The bug occurs when:

1. A binding `name := rhs` is being codegened.
2. `rhs.$.variableName` is set to the inout parameter's name (`"self"`).
3. The codegen emits `${tempVarType} = ${rhsExprCode};` using the variable's _own_ name as the temp name, producing `T self = (*self);`.

The fix is probably to detect that the temp-var name collides with an inout parameter name and either rename the temp or skip materialization.

## Workaround

Don't migrate `(self : *(Self))` to `(inout(self) : Self)` when the body references `self` as a bare value. Field accesses (`self.field`) are fine.
