# A Future-implementing SomeT's drop/dup lowered to NOTHING — every sync await leaked its Future

**Status: FIXED 2026-08-14** (`yo-self/codegen/exprs/drop_dup.yo`, on PR #122).

## Symptom

Every program with a SYNCHRONOUS await (io.await outside a state machine —
i.e. every `main :: (fn(io : Io) -> unit)` that awaits) leaked the awaited
Future's state machine: calloc'd, incr_rc'd for the event loop, never
released. 96 bytes per await on the minimal probe; `leaks --atExit` shows 1
leak under the self-hosted emit and 0 under the TS emit of the same program.

Found by P2.5 Group B's OWN leak verdicts (the sanitizer plumbing ported from
TS): the first Linux CI run with functional AddressSanitizer turned **79
hollow-sweep files and 11 tier-1 suites RED simultaneously** — every
io-touching test. Invisible locally: this macOS box cannot arm ASan
(`issues/…` / memory note), and `leaks` was only consulted once the CI
pattern demanded a single-root explanation.

## Root cause

The drop was scheduled and reached the emitters — but rendered as the EMPTY
STRING, so every site silently skipped it (the abort-branch early return
even printed its `// Drop local variables before early return` header with
nothing under it). `generate_drop_code_for_value`'s cond had **no arm for a
Future-implementing SomeType**: the type passes the `type_contains_rc_type`
gate, matches none of the array/tuple/dyn/struct/enum arms, and fell to
`true => ""`. TS lowers the same drop in `generateYoSomeTypeDrop`
(src/codegen/exprs/rc-fns.ts:455) to `if (x != NULL) __yo_decr_rc(x)`.
`generate_dup_code_for_value` had the symmetric hole (identity, no +1) —
fixed together, since with drops firing a future copied into a second owner
needs its incr (generateYoSomeTypeDup parity).

An empty-string drop is a MINI-HOLLOW: the emitters treat "" as "nothing to
do", so the accounting error is silent by construction. Worth remembering as
a class: any `true => ""` fallback in a drop/dup lowering hides every type
it doesn't recognize.

## Verification

`leaks --atExit` 0 (was 1×96B); the emitted C carries TS's exact 3
null-checked decr sites; async_await 164/164, arc/rc/closure/
algebraic_effects/sys/file/sys/bufio/fs/file/sync/mutex/iterator_combinators
green; MallocScribble async clean; fixpoint + Linux ASan CI on PR #122.
