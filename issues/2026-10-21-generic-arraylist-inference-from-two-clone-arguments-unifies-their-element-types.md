# Inferring `T` from two `.clone()` arguments of different `ArrayList(T)` types unifies their element types

**Severity:** S2 — a valid program is rejected with a type error naming two unrelated element types. Only a `.clone()` written in argument position fails: binding each clone to a local and passing the local (`a := labels.clone(); count(a)`) is a workaround, and so is dropping the `.clone()`.

**Status:** OPEN — found 2026-10-21 on `perf/share-typevalue-lists` (a test
helper passing `shared_list(labels.clone())` and `shared_list(types.clone())`
to one constructor). Reproduces with the v0.2.67 seed and with a stage-1
compiler built from develop 7def2203b.

## Reproducer

`issues/repros/2026-10-21-generic-arraylist-inference-from-two-clone-arguments.yo`:

```yo
count :: (fn(generic(T : Type), items : ArrayList(T)) -> usize)(items.len());
both :: (fn(labels : ArrayList(String), nums : ArrayList(i32)) -> usize)(
  count(labels.clone()) + count(nums.clone())
);
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "String"
  --> ...:12:37
   |
12 |   count(labels.clone()) + count(nums.clone())
```

Variants measured on v0.2.67:

| form | result |
| --- | --- |
| `count(labels.clone()) + count(nums.clone())` | E0601 |
| `xs := ...; ys := ...; count(xs.clone()) + count(ys.clone())` | E0601 |
| `a := labels.clone(); b := nums.clone(); count(a) + count(b)` | checks |
| `count(labels) + count(nums)` (no `.clone()`) | checks |
| parameter `x : T` instead of `items : ArrayList(T)`, with `.clone()` | checks |

The second call's argument is a METHOD call whose receiver type is generic
(`ArrayList(T).clone`), checked against the expected parameter type
`ArrayList(T)`. The first call's binding of the callee's `T` (`String`)
reaches the second call's inference, which then unifies it with `i32`.

## Where to look

The callee's forall `T` is one `SomeT` node shared by every call of `count`;
argument checking against an expected `ArrayList(T)` that has not been
freshened per call would carry the first call's solution into the second.
`issues/questions/2026-10-20-typevalue-constraint-lists-are-stamped-in-place.md`
describes the related in-place writes to a `SomeT`'s lists. Not root-caused.

## Test

No test yet: a test that fails until the fix would turn the suite red. The
fix adds the reproducer as a `tests/` case.
