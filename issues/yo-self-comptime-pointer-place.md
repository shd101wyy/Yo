# yo-self: compile-time pointer PLACES (`&(arr(0))`, `p.* = v`)

Status: STAGE 1 FIXED (`tests/comptime.test.yo` arm 23 "Test comptime Array
value" flips GREEN). STAGE 2 open — arm 22 "Test comptime Ptr value" still
hollow.

## Symptom

```rust
arr :: Array(i32, usize(3)).fill(0);
p :: &(arr(0));      // → "// Failed to transpile p :: &(arr(0));"
(p.(*)) = 16;        // → nothing to write through
```

## Stage 1 — two faithful-port fixes (landed)

**A. `ptr_fns.yo` had TS's ladder in the wrong ORDER.** TS
(`src/evaluator/builtins/ptr-fns.ts:130-205`) checks, in order: `comptimeRef` →
`sourceVariable && sourceVariable.value` → `indexTraitPtrType` →
`isUnknownValue(value)`, and documents the first step as load-bearing:

> We check comptimeRef BEFORE indexTraitPtrType because comptime arrays set
> both properties, and comptimeRef allows creating a comptime pointer whereas
> indexTraitPtrType would return a runtime-only pointer.

yo-self checked `index_trait_ptr_type` FIRST. Since the index arms
(`function.yo`'s index dispatch) stamp `index_trait_ptr_type` unconditionally
alongside `comptime_ref`, `&(arr(0))` on a COMPTIME array always produced the
runtime-only pointer.

**B. the compile-time `p.*` deref dropped the pointer's INDEX.**
`property_access.yo`'s `.PtrVal(target_box, _)` arm returned the whole
aggregate and stamped no place. TS indexes it —
`dereferencedValue = target.elements[objectValue.targetIndex]` — and stamps
`ptrTargetValue`/`ptrTargetIndex` (`property-access.ts:327-352`) for
`assignment.ts:1150-1173` to write through. yo-self's
`ComptimeRef.ArrayRef(elements, index)` IS that pair and `assignment.yo`'s
Step 6 is already its consumer, so the arm now binds the index, reads
`elements(index)`, and stamps the ref.

Regression guard for (A): `tests/index.test.yo` (48 passed, markers=0) — its
"Test Index trait address-of" / "…on ArrayList" arms do
`(p : *(i32)) = &(container(1)); p.* = i32(999);` on RUNTIME containers and must
keep taking the index-trait arm. They do: yo-self's index arms never set
`source_variable`, and `comptime_ref` is only set for a comptime `ArrayVal`
receiver.

## Stage 2 — what arm 22 still needs

Arm 22 takes the address of a scalar VARIABLE and mutates through it inside a
CTFE body:

```rust
increment :: (fn(comptime(p) : *(i32)) -> comptime(unit))(begin((p.(*)) = ((p.(*)) + i32(1)), ()));
counter :: i32(0);
```

That needs the shared-cell value model TS has and yo-self does not:

| TS                                                                                                                                   | yo-self today                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `PtrValue.targetValue: [Value]` (src/value.ts:180-196) — a 1-element array                                                           | `PtrVal(target : EvalValue, index : usize)` — a COPY |
| `Variable.value: Value[]` (src/env.ts:73-79) "Uses an array wrapper to enable mutable reference semantics for compile-time pointers" | `value : Option(EvalValue)`                          |
| `ptr-fns.ts:172` passes `sourceVariable.value` (the variable's own cell)                                                             | passes a copy of the value                           |
| `assignment.ts:1150-1173` writes `ptrTargetValue[0] = rhs` for the scalar case                                                       | no scalar place exists                               |

So the port is: `PtrVal(target_value : ArrayList(Self), target_index : usize)`
plus `Variable.value : ArrayList(EvalValue)` (empty = TS `undefined`), then pass
the variable's own cell at the address-of site and add the scalar arm to the
assignment consumer. That is a ~43-construction-site sweep over `env.yo` plus
~8 `PtrVal` match sites (`value.yo` eq/`value_to_string`, `eval.yo` ×2,
`index_trait.yo` ×2, `clone_value.yo`, `comptime_index_fns.yo`, `ptr_fns.yo`) —
mechanical, but big enough to want its own round and its own gate.

Optional faithfulness completion (not needed for arms 22/23): the SECOND deref
site in `property_access.yo` ("Dereference through PtrVal before field
selection") also drops the index, where TS indexes first
(`property-access.ts:1066-1073`).
