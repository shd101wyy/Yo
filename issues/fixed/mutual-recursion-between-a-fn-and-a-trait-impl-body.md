# Mutual recursion between a free fn and a trait-impl body silently produces an abort() stub

**Severity:** S2 — fn ↔ trait-impl mutual recursion is wrongly rejected (E0610 on a valid recursive-tree `Eq`)

**Status: FIXED** on `tss/enum-final-name` (2026-10-01). The mechanism below was confirmed: impl forcing now names a self-referential type's nameless final by its binding (`type_binding_name`, `src/types/creators.yo`), so an element of `ArrayList(Self)` forces the later `Eq` impl. `issues/repros/mutual-recursion-through-a-trait-impl-operator.yo` checks clean. Regressions: `tests/lazy_toplevel_bindings.test.yo` (the recursive enum and recursive struct list-element tests).

Re-measured 2026-10-01 on develop after #1062, which was expected to fix it
and does not. The mutual recursion is NOT the trigger. An earlier note here said a non-recursive
helper checks fine; that was measured on a different shape and is wrong. Measured with v0.2.47
`yo check`, one file per row, the helper `_h` placed above `impl(E, Eq(E)(…))`:

| `E` | `_h`'s parameters | operands | result |
| --- | --- | --- | --- |
| `enum(Leaf(v : i32), Node(n : i32))` | `a : E, b : E` | `a != b` | OK |
| `enum(Leaf(v : i32), Node(kids : ArrayList(Self)))` | `a : E, b : E` | `a != b` | OK |
| `enum(Leaf(v : i32), Node(n : i32))` | `a, b : ArrayList(E)` | `a(usize(0)) != b(usize(0))` | OK |
| `enum(Leaf(v : i32), Node(kids : ArrayList(Self)))` | `a : ArrayList(E)` | two fresh `E.Leaf(…)` | OK |
| `enum(Leaf(v : i32), Node(kids : ArrayList(Self)))` | `a, b : ArrayList(E)` | `a(usize(0)) != b(usize(0))` | **E0610** |
| same | same | `(x : E) = a(usize(0))`, `x != y` | **E0610** |

`YO_DEBUG_LAZY=1` prints `[force] impl(E, …)` in every passing row and nothing in the failing
ones. So the operator-miss path (`calls/function.yo`, the lazy-impl branch before the E0610
throw) runs `force_pending_impls_for_type_name` with a head name that does not match the impl's
`E`. The element type of an `ArrayList` over a self-referential enum reaches the operator as a
type whose `type_head_name_for_impl_forcing` is not `E`. Which spelling it has (an enum shell,
the internal `enum_decl_…` name, a pointer) is the next measurement, and it needs a debug print
in a built compiler. The mutual recursion only matters because that is where such a helper
occurs.

Likely mechanism (REASONED from the source, not yet measured). A self-referential enum
evaluates its variants against a shell `EnumT` with a distinct id. `ArrayList(Self)` is
instantiated with that shell, and the finished type is recorded under the shell's id with an
EMPTY name (`register_enum_final(shell_id, EnumT(enum_id, "", …))`, `evaluator/types/enum.yo`).
An element read from the list is the shell. The operator path calls `resolve_enum_shell`, which
returns that nameless final, so `type_head_name_for_impl_forcing` returns `""` and
`force_pending_impls_for_type_name` exits at "an unnamed receiver cannot select an impl". A
parameter typed `E` carries the bound, named type and forces normally. To confirm, print the
head name at the operator-miss branch in a built compiler.

`issues/repros/mutual-recursion-through-a-trait-impl-operator.yo` still fails with
E0610 at 9:13. Found 2026-09-09 while writing `Eq` for the recursive `JsonValue` tree.

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

## 2026-09-24: the swallowed error now reaches `check`

Since `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 1.6 (an operator whose trait lookup misses is an
error, never `unit`), `yo check` on the reproducer is no longer green:

```
error[E0610]: No matching call found for operator "!=" with receiver type "<enum:enum_decl_repros__mutual_recursion_through_a_trait_impl_operator_r1c5>"
  --> issues/repros/mutual-recursion-through-a-trait-impl-operator.yo:9:13
```

That is the error the definition-time trial of `_kids_eq` used to swallow: the trial runs while
`E`'s `Eq` impl is still being registered, so `!=` on `E` finds no impl. The program is valid, so
the error is still wrong — the root cause (the order in which the impl member and the helper are
forced) is unchanged — but it now fails at check time instead of as an FTT stub at run time. The
receiver type prints an internal id instead of `E` (Phase 4.4, diagnostics).
Soundness census class: RUN_FTT → CHECK_RED.
