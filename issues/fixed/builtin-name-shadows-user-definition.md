# Builtin names silently shadow same-named user definitions (DECIDED: reserve them)

**Kind:** design question, decided 2026-11-27 (option 1) and implemented; see `## Decision`. Moved from `issues/` root in the 2026-09-28 severity triage.

**PRODUCTION CASUALTY (2026-08-30):** a local named `short` in
`src/version_cache.yo`'s `download_version` resolved to the prelude C-interop
integer type inside a template interpolation; the def-eval failure was
swallowed, the WHOLE async body shipped hollow, and **`yo version install`
was silently broken in the released v0.2.19 and v0.2.20** (rc=0 no-op /
bare-SIGABRT rc=134 —
issues/fixed/wrong-arity-call-silently-accepted-version-install-broken.md). This
issue is no longer theoretical: pick option 1 (reserve) or 2 (prefer user
bindings), or at minimum land option 3's shadowing diagnostic, before the
next release.

**Found 2026-08-06** while attempting to fix
`issues/retired/ctfe-elided-unit-call-arg-temp-leak.md` (whose diagnosis this
finding invalidates — see the banner there).

## The hole

A user definition with the same name as a builtin type-checks fine but is
**dead code**: both compilers' dispatch checks builtins BEFORE user bindings.

- Evaluator: `src/evaluator/exprs/_expr.ts:750` routes `consume(x)` to
  `evaluateConsume` (`src/evaluator/builtins/consume.ts`) even when the user
  defined `consume :: (fn(x : MyVal) -> unit)(...)` in scope.
- Codegen: `src/codegen/exprs/generation.ts:1010` does the same.

Demonstrated: a program defining and calling its own `consume` never calls
it — the builtin evaluates the argument (attaching an owned RC temp), marks
it consumed, and discards it, which reads like a leak but is the builtin's
legal semantics. Renaming the function to `eat_it` produces fully correct C
(real call + scope-end and escape-path drops).

## Secondary observation

Statement-position builtin `consume(<fresh owned value>)` is a silent leak
instrument; an evaluator diagnostic (warning on consuming a freshly
constructed value in statement position) may be worth adding regardless of
the shadowing decision.

## Decision needed

1. **Reserve builtin names** — reject user definitions whose name collides
   with a builtin (clear, breaking for existing code that shadows harmlessly).
2. **Prefer user bindings** — resolve identifiers through the env first and
   fall back to builtins (matches user intuition; needs an audit of prelude
   internals that rely on builtin-first dispatch).
3. Keep builtin-first but **warn on shadowing definitions** (cheapest,
   catches the confusion without changing semantics).

Either way the fix must land in BOTH compilers (dispatch sites above + the
yo-self mirrors in `yo-self/evaluator/exprs/_expr.yo` /
`yo-self/codegen/exprs/generation.yo`).

## Third face (2026-08-26): a LOCAL cannot shadow a prelude TYPE NAME as a method receiver

Found writing D5's `tests/io/bufio.test.yo` — a local named `short` (the
C-interop integer type) broke method calls on it:

```yo ignore
short := Option(i32).Some(i32(1));
short.is_none()   // Error: No matching call found with arguments: (short.is_none)()
```

The dot-call receiver resolution treats `short` as the TYPE (static-dispatch
path) before consulting the environment, so the local is unreachable as a
receiver. Any in-scope type name behaves this way (`int`, `long`, `uint`,
`String`, …). The failure is loud but the diagnostic names neither the
shadowing nor the type — it cost a multi-probe bisect to trace, because the
same test passed verbatim with the local renamed `b`.

Repro: `issues/repros/local-named-short-not-usable-as-receiver.yo`.

Same decision as above, sharpened: either locals shadow (env-first receiver
resolution), or declaring a binding whose name collides with an in-scope
type/builtin is REJECTED with a diagnostic that says so. The silent
middle — declaration legal, use broken — is the worst option and is what
ships today.

---

## Recommendation (agent triage, 2026-09-28 — awaiting maintainer verdict)

Land option 3 (a shadowing diagnostic) immediately — it is release-gating per
the casualty banner above and changes no semantics. Then adopt option 2 (resolve
identifiers env-first, builtins as fallback) as the target rule: it matches user
intuition and Rust's precedent (user scope shadows prelude names), and the only
obstacle is the prelude audit the doc names. Treat option 1 (reserve the names)
as the fallback if that audit finds builtin-first dispatch load-bearing in the
prelude. The third face (a local shadowing an in-scope type name as a method
receiver) should follow the same decision — env-first fixes it; until then the
diagnostic must name the collision, which today's error does not.

## Decision (maintainer, 2026-11-27: option 1)

"Give the user an error if binding with builtin names." A binder a person wrote
whose name the compiler resolves before any binding is E0407, with the help
"`` `law` is a builtin; rename the binding (e.g. `law_`) ``" and, when every use
of the binder is in the file and none heads a call or is a brace pun, a
`yo fix` repair that renames the binder and its uses to `law_`. Every binder is
checked: `::`, `:=`, a typed `(x : T) =`, a parameter (a closure's included), a
capture entry, a labeled return, a pattern or destructuring binding, an import
rename. `std/prelude.yo` is exempt; compiler-minted binders are never checked
(`TokenData.written`, VERDICTS-72 rule (b)).

The reserved set is read from the compiler, not listed by hand
(`reserved_binding_message`, `src/evaluator/memory-safety.yo`):

- the call heads: every identifier-spelled head of `_evaluate_expression`'s
  dispatch outside the `__yo_` namespace (`builtin_call_head_names`,
  `src/expr.yo`), the parse-time and statement heads `if`, `for`, `return`,
  `break`, `continue`, and the mutation summary's pure-structure heads `clone`
  and `as`. `tests/internal/reserved-names.test.yo` reads the dispatch and fails
  when an arm is missing from the list;
- the builtin type names identifier resolution answers before any binding
  (`builtin_type_keyword` minus `is_env_first_c_type_name`,
  `src/types/creators.yo`);
- `mut`, and `logic` and `lemma`, reserved ahead of SPEC_AND_PROOF PR 2;
- every `__yo_` name (VERDICTS-72).

Kept out, because a binding of the name is reached: `assert` (the dispatch
evaluates the ordinary call), `exists` (the quantifier only in ghost context),
the words that are keywords only in one position (`fn`, `ctl`, `unsafe_fn`,
`Fn`, `FnMut`, `FnOnce`, `generic`, `given`, `where`, `comptime`, `own`, `sink`,
`using`, `thread_local`, `export`) and the C interop type names (`int`, `char`,
`short`, `uint`, `long`, `ulong`, `ushort`, `longlong`, `ulonglong`,
`longdouble`, `void`).

The third face (a local `short` as a method receiver) was already fixed by
issues/fixed/local-named-after-a-prelude-c-type-is-not-shadowed.md: the C
interop names resolve env-first, so `short` stays bindable and its repro is a
passing row of `tests/reserved-builtin-names.test.yo`. The same face for the
types that still resolve first (`i32 := …; i32.is_some()` was E0610) is now
E0407 at the binder. Struct and enum field labels, methods and named arguments
are not binders: `p.law` resolves through `.` (VERDICTS-92 probes q01, q04).
