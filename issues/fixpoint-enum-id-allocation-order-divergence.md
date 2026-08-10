# Fixpoint: TS-built and self-built binaries allocate enum-value ids in different order

**Status: OPEN** (found 2026-08-10, the layer UNDER the bare-if clang errors —
this diff was unreachable until `issues/fixed/ts-bare-if-await-early-return-silently-skipped.md`
took stage-2 from 17 clang errors to 0). It is what keeps
`scripts/bootstrap/fixpoint_only.sh` at FIXPOINT_BROKEN and PR #92's
bootstrap-fixpoint job red.

## Symptom

Stage-2 (emitted by the TS-built stage-1) and stage-3 (emitted by the
clang-built stage-2 binary) both compile clean, but differ textually in
~362K lines — ALL of it mangled-name renumbering. First divergence: the
forward-decl list at line ~340; the C type numbers themselves largely agree,
but the SOURCE enum-instantiation ids embedded in mangles differ:

```
stage2 (TS-built emitter):   __yo_t795 = <enum:enum_yo_id_738498>, __yo_t797 = <enum:enum_yo_id_738500>
stage3 (self-built emitter): __yo_t795 = <enum:enum_yo_id_738439>, __yo_t797 = <enum:enum_yo_id_738441>
```

Those two types are `FunctionGenerationContext.sm_while_break_info` /
`sm_while_continue_info` (yo-self/codegen/functions/context.yo) — Option-ish
value-enum instantiations. The self-built binary reaches them ~60 enum-value
id allocations EARLIER than the TS-built binary: the two binaries evaluate
yo-self in a slightly different order (or one instantiates ~60 fewer/more
enum values first). The ids leak into every specialization's mangled name,
renumbering the whole file.

## Established facts (2026-08-10)

- **Deterministic per binary**: the TS-built stage-1 emits byte-identical C
  across two runs on yo-self. So this is NOT hash/ASLR nondeterminism — it
  is a stable behavioral difference between the TS-compiled and
  self-compiled compiler binaries, i.e. a self-hosted miscompile (or a
  TS one) of some evaluator-adjacent function.
- **Small inputs agree**: the async probe, a lexer slice
  (`tokenize` via `yo-self/lexer.yo`), and a parser slice (`parse` via
  `yo-self/parser.yo`) all emit BYTE-IDENTICAL C under both binaries.
  An evaluator slice (`{ Evaluator } :: import("evaluator/index.yo")` +
  parser, 14 MB of C) is ALSO byte-identical. The divergence needs the
  codegen modules and/or main.yo in the closure — next slices to try:
  `codegen/codegen_c.yo`, then `module_manager.yo`, then `main.yo` minus
  subcommands.
- Unknown whether P1 introduced it or it predates the branch — develop's
  fixpoint is green, but on this branch the clang failure masked the diff
  from day one, so there is no bisectable signal before the bare-if fix.

## Hunt plan

1. Finish the slice bisection: evaluator slice → if SAME, add codegen
   modules until it DIFFERS. The smallest differing import closure is the
   repro.
2. Instrument the enum-value id allocator (the counter minting
   `enum_yo_id_N`) to log `id → (enum decl site, type args)` on both
   binaries; diff the traces. The first divergent allocation names the
   evaluator code path that runs differently.
3. Suspects, given the ~60-id offset appears by the time context.yo is
   processed: memo hit/miss divergence (capture-env memo, specialization
   caches), module-load order, or a function whose async emission differs
   behaviorally between TS and yo-self codegen (module_manager's awaits).
