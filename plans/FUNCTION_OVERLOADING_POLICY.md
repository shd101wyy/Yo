# Function overloading policy: none, like Rust — with one prelude exception

**Status:** IMPLEMENTED 2026-08-21 (this branch). Decision by maintainer:
Yo disallows function overloading, Rust-style. The single sanctioned
exception is std/prelude.yo's runtime/comptime operator pairing.

## The decision

- **No function overloading.** Two callables with the same name and
  different signatures cannot coexist in one scope, and a caller-visible
  name never dispatches over a candidate *set*.
- **The one exception:** std/prelude.yo's operator modules — `(!)`, `(~)`,
  `(-)` — which pair a runtime and a comptime implementation behind one
  operator name (`Call :: (neg, comptime_neg)`). This pairing is what makes
  `-x` fold at comptime and compile at runtime from a single spelling, and
  it stays **prelude-only**: user code (and the rest of std, and the
  compiler tree itself) cannot define overload sets.
- **Not overloading, unaffected:** the trait channel. Parameterized trait
  impls (`Eq(String)` beside `Eq(str)`, `Sub(i32)` beside `Sub(f64)`) and
  trait-provided methods sharing a name with an inherent method dispatch by
  argument type — Rust allows the same thing (generic trait impls), and the
  entire numeric tower is built on it. Also unaffected: a SINGLE-function
  `Call` (a callable module) — one candidate is not a set.

## The audit — where overloading could enter, and what holds today

| Channel | Behavior before this branch | Verdict |
| --- | --- | --- |
| Rebinding a name (`f :: A; f :: B`) — module scope, fn body, impl block | Rejected: `Failed to define variable` / "variable shadowing is not allowed" (`src/evaluator/exprs/binding.yo`) | Already correct |
| **`Call` overload sets** — `impl({ ... Call :: (f, g); export(Call); })` | **OPEN**: worked in arbitrary user code (was even positively tested by `tests/fn.test.yo` "Test function overloading using module Call" and `tests/basic.test.yo` "Test 'comptime_fn' ... and function overloading") while `.github/instructions/yo-design.instructions.md` claimed "Yo does not support function overloading" | **Gated by this branch** |
| Duplicate INHERENT method impls (`impl(P, get : ...)` twice) | **OPEN**: silently accepted — same signature: first wins; different arity: both callable, dispatch by arity — despite yo-design.instructions.md and the core-patterns cheatsheet both documenting rejection ("Method already defined", a string that does not exist in the evaluator) | Filed as `issues/fixed/duplicate-inherent-method-impls-not-rejected.md`; fix SCHEDULED as the follow-up branch after this one lands (`plans/backlog/DUPLICATE_INHERENT_METHOD_REJECTION.md` — the check must distinguish a genuine second definition from the loader's idempotent re-registration of the same impl, see `src/evaluator/values/type_trait_methods.yo`'s "callers responsible" note) |
| Trait-channel same-name methods / parameterized trait impls | Allowed, dispatch by argument type | By design (Rust-equivalent), kept |

## The gate

Definition-site, at the module-export choke point:

- `is_overload_set_capable_file(module_path, std_path)` in
  `src/evaluator/memory_safety.yo` — true only for
  `<std_path>/prelude.yo` (lexically absolutized both sides, same
  machinery as the `AllowMacroDef` std exemption) and for
  compiler-synthesized `auto-generated://` code, which inherits the
  privileged caller's policy exactly like the unsafe and macro gates.
- Enforcement in `src/evaluator/values/anonymous_module.yo`'s export loop:
  when the exported name is `Call` and its value is a `TupleVal` with ≥ 2
  entries, a non-capable file gets
  `Function overloading is not supported: "Call" here is a tuple of N
  candidates...`. The export loop is the single choke point — both
  `impl({...})` modules and file modules flow through
  `evaluate_anonymous_module_begin_exprs`, and the dispatcher
  (`_try_expand_call_overload`, `src/evaluator/calls/function.yo`) only
  ever reads the exported struct field, so an unexported `Call` binding
  never becomes dispatchable.

Definition-site (not dispatch-site) because the defining FILE is what the
policy is about, and because an unused overload set should still be an
error. Value inspection (TupleVal arity), not syntax, so assembling the
tuple indirectly (`cands :: (f, g); Call :: cands;`) is equally caught.

## Seed constraint

None. The gate is evaluator code in `src/` (the seed binary compiles it as
ordinary Yo); no new pragma variant, no std change. The prelude keeps its
three `Call` pairs, which the gate itself sanctions.

## Tests

- `tests/fn.test.yo` "Test function overloading using module Call is
  rejected": the old positive overload test inverted to
  `comptime_expect_error`, plus a positive arm proving single-function
  `Call` (callable module) still works and still arity-checks.
- `tests/basic.test.yo` "Test 'comptime_fn' function call and overload-set
  rejection": the runtime/comptime PAIR in user code is rejected;
  `comptime_fn` conversion itself and comptime calls through an exported
  member (`add.comptime_add(3, 4)`) keep their coverage.
- Prelude exception's continued function is covered by the whole suite
  (every `-x` / `!x` / `~x` fold) and `tests/operator_grouping.test.yo`.

## Relation to `plans/backlog/OVERLOADING_REDESIGN.md`

That earlier redesign (owner decision 2026-06-22) covers METHOD-level
arg-type overloading: it already removed std's `StrPattern` overload
pattern and landed inherent-first resolution (§6,
`issues/fixed/yo-inherent-first-resolution.md`). This policy enforces the
function-level and definition-level bans both documents assume; the
redesign's remaining trait-bound-generics migration is orthogonal and
stays in its own backlog.

## Rejected alternatives

- **A `Pragma.AllowOverload` opt-in** (mirroring `AllowMacroDef`): rejected
  — the maintainer wants overloading *not to exist* as a user feature, not
  to be opt-in; and a pragma would need seed choreography for no benefit.
- **Gating at dispatch** (`_try_expand_call_overload`): rejected — lazy
  (fires only when called), and the call site's file is the wrong policy
  subject; the definition's file is.
- **Whole-std exemption** (like the transitional macro-gate std branch):
  rejected — only prelude.yo uses the pattern (repo-wide grep), so the
  narrow gate documents reality.
