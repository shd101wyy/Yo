# A generic instantiated over a `Dyn` cannot cross a module boundary

**Status:** open
**Found:** 2026-09-15 writing `error_chain`; **re-diagnosed 2026-09-16 — the first
characterization in this file was WRONG and is corrected below.**

## The defect

A function whose signature mentions `ArrayList(Dyn(Trait))` — in EITHER the
return or the parameter position — fails to transpile when called from another
module. The caller's `main` body is reported as untranspiled:

```
yo: error: internal compiler error: Failed to transpile part of main's body —
the emitted C for "__yo_user_main" contains an untranspiled expression
```

## What it is NOT — measured, each with a passing control

The original entry here claimed "`ArrayList(Dyn(Trait)).get()` fails to
specialize `_ptr.add(index)`". That was the symptom of a narrower situation and
the wrong generalization. Controls, all compiled with `--optimize 2`:

| case | result |
| --- | --- |
| `ArrayList(Dyn(Shape))` built, pushed and `get()` **in the user module** | **compiles** |
| `ArrayList(AnyError)` built, pushed and `get()` **in the user module** | **compiles** |
| `ArrayList(i32)` returned **from std/error.yo** | **compiles** |
| `ArrayList(Dyn(ToString))` returned from std/error.yo | **FTT** |
| `ArrayList(Dyn(ToString))` as a std fn PARAMETER | **FTT** |
| `ArrayList(AnyError)` returned from std/error.yo (`error_chain`) | **FTT** |

So it is not "a trait object cannot be indexed", not specific to `Error` or
`SelfTrait`, and not a general cross-module generic problem. It is exactly:
**the generic's type argument is a `Dyn`, and the instantiation crosses a module
boundary.**

The `_ptr.add(index)` "No matching call" at `array_list.yo:311` appears only
when the caller additionally calls `.get()` on such a value — i.e. it is a
SECOND symptom of the same broken instantiation, not the root cause. Both
reproduce from the same one-line change.

## Reproducer

Add to `std/error.yo`:

```yo
{ ArrayList } :: import("./collections/array_list.yo");
_probe :: (fn() -> ArrayList(Dyn(ToString)))(ArrayList(Dyn(ToString)).new());
export(_probe);
```

and call `_probe()` from any user file. FTT. Replace `Dyn(ToString)` with `i32`
and it compiles — that one substitution is the whole difference.

## Why it matters

It blocks `error_chain` (the "every link" half of the `ErrorChain`/`root_cause`
row in plans/STD_API_STABILIZATION.md — `root_cause` itself needs no container
and LANDED). More broadly, **a std API cannot return or accept a collection of
trait objects at all**, which is a real expressiveness limit rather than a
formatting inconvenience.

Sibling: `issues/option-of-a-trait-object-never-emits-its-inherent-methods.md`.
A second reader framed the shared class well — "specialize a generic container
method whose element type is a `Dyn`" — and that still looks right; this entry
adds that the MODULE BOUNDARY is the trigger, which narrows where to look
(instantiation identity / specialization registration across module loads,
rather than the container's own method bodies).

## The mechanism (added 2026-09-16)

Not a codegen limitation — a **swallowed definition-time evaluation**.

Put the call in a HELPER rather than in `main` and the compile SUCCEEDS, because
the FTT guard is fatal only for `__yo_user_main`. The binary then links and, when
run, says exactly what happened:

```
yo: FATAL: reached yo_id_17528351815223688312000000, whose body failed to
transpile - its definition-time evaluation failed and was swallowed.
Re-run `yo check` with YO_DEBUG_SWALLOW=1 to see the original error.
```

The stub IS the calling function (`size_t yo_id_…()`, no parameters — the
helper). So: evaluating the call at definition time fails, the failure is
swallowed, the caller's body degrades to an abort stub, and in `main` that stub
trips the fatal FTT guard. The `_ptr.add` "No matching call" seen with `.get()`
is the same broken instantiation surfacing one layer down.

`YO_DEBUG_SWALLOW=1` on this repro prints 50 swallows, all of them `[trial]`
noise from `std/prelude.yo`'s generic def-time trials — none names this call
site. So the swallow that matters is NOT attributed to the failing function,
which is itself worth fixing: the diagnostic points at a tool that then does not
show the error.

## The narrowing, as a 2x2

| | built locally | crosses a module boundary |
| --- | --- | --- |
| `ArrayList(i32)` | OK | **OK** |
| bare `Dyn(ToString)` param | OK | **OK** |
| `ArrayList(Dyn(ToString))` | **OK** | **FAILS** |

A bare `Dyn` crosses fine and a non-`Dyn` generic crosses fine. It is the
COMBINATION — a generic whose type argument is a `Dyn` — instantiated on one
side of a module boundary and used on the other.

## Note on oracles

`yo check` passes over every failing case above — it is evaluator-only, and this
is a codegen failure. `yo compile` is the minimum oracle here, and the compiler
refuses to emit the `.c` when it detects the FTT, so the usual
"grep the emitted C for `Failed to transpile`" technique does not apply: score
on the exit code of `yo compile`.
