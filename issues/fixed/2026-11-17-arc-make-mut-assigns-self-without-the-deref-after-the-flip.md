# `Arc.make_mut` assigns `self` without `.*` after the deref flip, so every `Arc` test batch fails to compile

**Severity:** S1. After #1976, any program that calls `Arc.make_mut` with a `Clone` payload fails to compile with E0926 raised inside the standard library. On develop 413e23a57 this broke `tests/arc.test.yo`, so the wasm shard and the ThreadSanitizer thread corpus both failed (battery 43889182304).

## Observed

```text
error[E0926]: `self` is a reference (`&mut Arc(_ArcPair)`): writing the value it refers to is spelled `self.* = …`
note: raised here, inside the standard library
      --> std/prelude.yo:10831:9
10831 |         self = Arc.new(unsafe(self._cell.*).clone());
```

## Root cause

The deref flip (#1976) deleted `is_deref_rule_exempt`, so std is now judged by the reference-reading rule like user code. The flip lane's sweep and gates evaluate std through `yo check ./std`, which checks a generic body only when something instantiates it. `Arc.make_mut`'s shared-cell arm (`true => { self = … }`) is reached only when a caller instantiates `make_mut` at a `Clone` payload. `check ./std` never does that, and neither did the lane's Tier-1 test files. The sibling arm on line 10826 already said `self.* = Arc.new(payload)`.

## Fix

`self = Arc.new(…)` becomes `self.* = Arc.new(…)`, the spelling the sibling arm already uses.

## Test

`tests/arc.test.yo` is the regression test. Its `Arc.make_mut` row writes through a shared handle: before the fix it fails to compile on a develop-tree binary; after it, 36/36 pass.
