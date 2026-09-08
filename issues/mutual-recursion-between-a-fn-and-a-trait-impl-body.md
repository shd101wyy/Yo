# Mutual recursion between a free fn and a trait-impl body silently produces an abort() stub

**Status: OPEN.** Found 2026-09-09 while writing `Eq` for the recursive
`JsonValue` tree.

## Reproducer

`issues/repros/mutual-recursion-through-a-trait-impl-operator.yo`:

```rust
{ ArrayList } :: import("std/collections/array_list");
E :: enum(Leaf(v : i32), Node(kids : ArrayList(Self)));
_kids_eq :: (fn(a : ArrayList(E), b : ArrayList(E)) -> bool)({
  if(a.len() != b.len(), { return(false); });
  i := usize(0);
  while(i < a.len(), i = (i + usize(1)), {
    if(a(i) != b(i), { return(false); });   // <-- needs E's Eq impl
  });
  true
});
impl(
  E,
  Eq(E)(
    (==) : (fn(lhs : Self, rhs : Self) -> bool)(
      match(
        lhs,
        .Leaf(x) => match(rhs, .Leaf(y) => (x == y), _ => false),
        .Node(a) => match(rhs, .Node(b) => _kids_eq(a, b), _ => false)  // <-- needs _kids_eq
      )
    ),
    (!=) : (fn(lhs : Self, rhs : Self) -> bool)(!(lhs == rhs))
  )
);
```

`_kids_eq` needs `E`'s `Eq` to compare two elements; `Eq`'s `(==)` needs
`_kids_eq` to compare two child lists. Both directions are ordinary recursion,
and the cycle terminates on the data.

## Symptom

`yo check` is **green**. Then:

- `--optimize 2`: the binary links and dies on the first comparison —
  `yo: FATAL: reached yo_id_5076, whose body failed to transpile — its
  definition-time evaluation failed and was swallowed.`
- `-O0`: it does not link — `error: call to 'yo_id_5076' declared with 'error'
  attribute` (the GNU `error` attribute on the stub, which is only diagnosed
  pre-optimization).

So the existing FTT-stub safety net does catch it, but only at C-compile or run
time; nothing reports it while type-checking.

## What is and is not the trigger

| shape | result |
| --- | --- |
| helper defined BEFORE the impl | stub |
| helper defined AFTER the impl | stub — **ordering is not the trigger** |
| ONE self-recursive free fn, impl delegates to it | **works** |

The third row is why the std fix is a restructuring rather than a workaround:
`JsonValue`'s `Eq` now delegates to a single self-recursive `_json_eq`, exactly
as its `Clone` already delegates to a self-recursive `_json_clone`.

## Mechanism

Two plain `fn` definitions may reference each other because their SIGNATURES
bind before their BODIES evaluate — the cyclic-definition error message says so
explicitly ("Function definitions may reference each other"), and that is the
two-phase forcing `plans/reference/LAZY_TOPLEVEL_BINDINGS.md` P0–P5 built.

Impl FIELDS get no such phase. They are evaluated inside the impl field loop
(`evaluate_impl_expression`), so forcing the `Eq` impl in order to resolve
`a(i) != b(i)` evaluates `(==)`'s body immediately, which re-enters the
`_kids_eq` binding that is already being forced. The resulting error lands in
one of the evaluator's deliberate swallowing handlers (the def-time trial runs
INSIDE the impl field loop), so the body is simply left untranspiled and
codegen emits the `error`-attributed stub.

## Fix sketch

Give impl-field function definitions the same signature-first treatment plain
`fn` definitions get: bind each field's function TYPE (from its written
signature — every operator field in the reproducer has one) into the impl's
registration before evaluating any field body. Then resolving `!=` during
`_kids_eq` finds a signature, not a re-entered definition.

That touches impl registration, which is the machinery behind every trait in
the tree, so it wants its own PR with the byte-identity gate
(`plans/reference/...` / the fixpoint) and a `comptime_expect_error` canary per
genuinely-cyclic shape — a constant field that really does name itself must
still be a cycle error, not silently accepted.

Related: `issues/fixed/self-hosted-compile-swallows-undefined-call.md` (the
same "swallowed, then a runnable no-op" class), and the entry-point FTT gate in
`src/codegen/functions/generation.yo` that made this visible at all.
