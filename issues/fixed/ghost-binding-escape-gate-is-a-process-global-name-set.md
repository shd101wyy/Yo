# The ghost-binding escape gate was a process-global name set — cross-module false rejections

**Date found:** 2026-09-20 (post-v0.2.38 FV audit, phase V5/V7 review).
**Status: FIXED** (fix/ghost-binding-scope).

## Symptom

A multi-file `yo verify <dir>` run rejected modules that have nothing to do
with any ghost binding. Minimal repro (two files, one directory):

```rust
// a_ghost_def.yo
pragma(Pragma.Verify);
ghost(v := i32(5));
uses_ghost :: (fn() -> i32)(i32(1));

// b_plain_use.yo — an INDEPENDENT module
pragma(Pragma.Verify);
plain_user :: (fn() -> i32)({ v := i32(3); (v + i32(1)) });
```

```
yo verify <dir>
error: ghost value escapes specification context: 'v' is a ghost binding,
readable only from contract clauses, ghost(...) code and ghost_fn bodies
```

`b_plain_use.yo`'s `v` is a plain local — the error message is simply false.
In the repo's own corpus, loading `valid/ghost_fn_contracted_ghost_call.yo`
(`ghost(v := g(n))`) poisoned `valid/inout_two_state.yo` (an `inout(v)`
parameter) and others for the rest of the process: a directory run of
`tests/spec/fixtures/valid` failed 4 files that are clean individually.

## Root cause

`ghost(name := e)` (V5 task 3) registered the NAME in a process-global
`HashSet(String)` (`g_ghost_binding_names`, contracts.yo), and the escape
gate (identifer_and_operator.yo) rejected any non-ghost-context read of any
name in that set — regardless of WHICH binding the lookup resolved to, in
which module, or whether the registering function was even alive. The set
was never scoped (no module key, no lifetime), so:

- any later module in the same `verify`/`check` run whose local or parameter
  shares the name is falsely rejected (cross-module);
- the same applies across functions WITHIN one module (define
  `ghost(prev := x)` in one function, and another function's plain `prev`
  breaks).

Never hit in CI: every test file loads in its own process, and the
`yo verify ./std/collections` files create no module-level ghost bindings.
The gate's PURPOSE — a loud eval-time error when ordinary code reads the
ACTUAL spec-only binding (pre-fix of the undeclared-C-identifier crash) —
is unchanged.

## Fix

The ghost-binding identity lives ON the bound `Variable`:

- `Variable` gains `(is_ghost_binding : bool) ?= false` (the bool-flag
  group; named construction keeps every existing site valid);
- `evaluate_ghost` sets the flag on the Variable `add_variable_to_env`
  returned;
- the escape gate tests `v.is_ghost_binding` on the RESOLVED variable;
- the global set and its two accessors are deleted (no other consumers).

A name collision — cross-module or cross-function — now resolves to the
plain Variable and is allowed; a read of the ACTUAL ghost binding still
errors, in every mode combination the original gate covered.

## Test

`tests/internal/verifier_ghost.test.yo` — "a ghost binding does not poison a
same-named local in ANOTHER module": loads `valid/ghost_binding.yo` (the
poisoner) then `valid/ghost_name_collision.yo` (a plain local named `prev`)
in the same process; the second must load and prove. The pre-existing
negative-twin test (`negative/ghost_escape.yo` still gated) guards the
gate's purpose. Fixture: `tests/spec/fixtures/valid/ghost_name_collision.yo`.
