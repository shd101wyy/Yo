# `#line` directives — mapping emitted C back to `.yo` sources

> **Status: LANDED 2026-09-30** (`--line-directives`, off by default — the
> flip to default-on stays its own PR after a battery cycle, per the rollout
> rule below). The last deferred item of
> [ERROR_DIAGNOSTICS_OVERHAUL.md](ERROR_DIAGNOSTICS_OVERHAUL.md) P4 and the
> whole of ROADMAP Phase 2.4. Kept as the authoritative reference for the
> landed design; sections below are the design as approved, plus a
> **Landing record** at the end for what shipped and what is still deferred.

## Goal

C-compiler diagnostics, profilers and debuggers currently report
`yo.c:2603629` — a line in a 2.6 M-line file nobody reads. With `#line`
directives the C compiler's diagnostics carry the `.yo` file and line the
code came from:

```c
#line 42 "src/app.yo"
_yo_str _file__app_temp_1 = app_greet((*_yo_str)(&name));
#line 897123 "yo-out/<target>/bin/yo.c"
```

The second directive is as important as the first: it RESTORES honest
numbering for compiler-generated code (runtime glue, drop calls, state
machines), so a C error inside generated plumbing still points at real C.

## Why this is its own project, not a diagnostics patch

1. **Line accounting.** A `#line` directive sets the number of the NEXT
   physical line. To restore honest numbering the emitter must know how many
   lines it has actually written into the current buffer — across the header /
   declaration / code buffers, the runtime blocks, and the chunk split
   (`--emit-chunks` concatenates per-chunk buffers, so per-buffer counters
   must survive re-chunking).
2. **Every emitted-C consumer changes.** The emitted C is a tested artifact:
   the sweep69 battery, the chunked self-build, ASAN runs, the portable-C
   bundle and every `--emit-c` golden all see the new directives. Line-number
   pins in tests shift by the number of directives added.
3. **`__LINE__` and tooling.** Any `__LINE__` use in the runtime's C changes
   meaning under an active `#line`. The runtime blocks must either reset
   numbering first or avoid `__LINE__`.
4. **Source positions must survive to emission.** The emitter writes by
   `ExprInfo`/node; each emitted statement needs the defining expression's
   `module_path + row` at hand. Positions exist on tokens; the plumbing is
   threading them into `generate_*` flush points, not discovering them.

## Design sketch

- **Directive pairs, not sprinkles.** Emit `#line <yo-row+1> "<module-path>"`
  when the source position CHANGES from the previous emitted statement, and
  `#line <real-next> "<chunk-path>"` when leaving user code. Adjacent
  statements from the same `.yo` line pay zero directives.
- **One counter per output buffer** on the Emitter (`out_lines`), incremented
  by every `emit_*line` helper — the helpers are already the single choke
  point (src/emitter.yo), so the counter is ~6 increment sites and no
  call-site churn.
- **Chunking.** Each chunk starts with a `#line 1 "<chunk>.c"` reset and its
  own counter; the declarations buffer (shared per-chunk) is emitted under a
  reset so its numbering stays honest.
- **Positions come from `ExprInfo`**, which codegen already reads: the
  statement-level `generate_statement` flush points compare the current
  `(module_path, row)` with the last one emitted and toggle directives.
  Module paths are the canonical `file://` spelling already used by
  diagnostics; a `-fdebug-prefix-map`-style trim (project-relative) keeps
  them short.
- **Rollout behind a flag.** `--line-directives` (default off) lands the
  emitter counter + directive emission; the self-hosted gates run once with
  it on. Flipping the default is its own PR after a battery cycle, because
  flipping changes every emitted-C artifact at once.
- **The payoff step (separate again):** once C diagnostics carry `.yo`
  positions, main.yo's C-compiler-failure path (currently: raw stderr under a
  wrapper) can PARSE the C diagnostics and re-emit them as structured
  `Diagnostic`s — the last unmapped diagnostics in the toolchain (D12).

## Non-goals

- Full debug-info (DWARF variable locations, inlining info) — that is the
  debugger story beyond ROADMAP 2.4's wording, and needs `-g` cooperation.
- Mapping RUNTIME panic locations — already solved at the source level in
  P3 (panic call-sites embed `.yo` file:line in the message).

## Acceptance sketch

1. Emitter counter: unit test — emit a fixed small program, assert the
   directive count and the restored real numbering at the tail.
2. A C compile ERROR planted in user code reports the `.yo` path:line
   (CLI goldens with a deliberately bad `c_include`).
3. `yo build` (chunked) and `hollow_sweep69.sh` green with
   `--line-directives` on.
4. The wrapper-Diagnostic step: `yo compile` on a file whose C fails shows
   the C error with the `.yo` location, in all three error formats.

## Landing record (2026-09-30)

What shipped, and where each piece lives:

- **Flag**: `yo compile --line-directives` (off by default; the emission with
  it off is byte-identical to the pre-flag compiler — verified by an A/B of a
  pristine stage-1 against the flag-carrying stage-1 on the same program).
  The restore directives need the sidecar's name before emission starts, so
  `run_compile` now derives `c_base` (`output` minus a target-format
  extension) above `compile_module` and threads `line_c_name` /
  `chunk_name_base` in.
- **Emitter** (`src/emitter.yo`): `set_yo_line_position(path, row)` /
  `clear_yo_line_position()` are the emission surface; `note_line_position`
  (`src/codegen/utils/index.yo`) is the one-liner the statement flush points
  call. Positions come from the statement's own token
  (`ast_expr_token`), `file://` is stripped for display, `\` and `"` are
  escaped, and `_` / `drop` / `auto-generated://` pseudo-paths never map.
- **Restores**: `clear_yo_line_position` writes `#line 00000000 "<c>"` (the
  8-zero placeholder is the patch passes' marker). The number cannot be known
  at emission time — the declarations buffer keeps growing after bodies are
  emitted — so `Emitter.sections`/`print` patch the digits in place (no copy
  of the ~100 MB code buffer) against the FINAL header/declaration sizes,
  once emission is complete. Numbers are written left-aligned and
  space-filled: a zero-padded pp-number reads as octal and clang warns.
- **Statement flush points**: the begin/function-body/loop-body/case-body /
  cond-arm statement loops (`begin.yo`, `while_loop.yo`, `match.yo`,
  `cond.yo`, `functions/generation.yo`) note each statement; function
  boundaries (`generate_function`, the async resume emitter in `async.yo`)
  clear. Scope-end drops, state-machine dispatch and runtime scaffolding
  keep honest C numbering via those clears; code generated FOR a statement
  (its temps, sub-expressions) maps to the statement's line, bounded drift —
  the same trade every `#line`-emitting compiler makes.
- **Chunking** (`src/codegen/chunk_assembly.yo`): `assemble_chunks` takes the
  driver's `<base>_chunk` name prefix and rewrites each chunk's markers to
  that chunk's own file (the emitter cannot know which chunk a function lands
  in) and chunk-local honest numbers (the file is `#include` + body, so a
  marker at body line L names L+2). The code spill stays OFF with the flag on
  — a marker inside the spill file could not be patched in place.
- **The wrapper** (acceptance 4, `src/main.yo`): with the flag on, the
  single-file C leg captures instead of streaming (`CcPlan.capture_cc`,
  threaded through the exec handoff), and a failure re-renders the captured
  stderr through the active `--error-format` — parsed
  `file:row:col: severity: message` lines become structured Diagnostics
  carrying the `.yo` spans the directives gave the C compiler; anything
  unparseable prints verbatim first. The per-chunk `cc -c` jobs still stream
  raw (their diagnostics already carry `.yo` positions, just unrendered).
- **Tests**: `tests/internal/line_directives.test.yo` (the emitter counter +
  chunk rewrite, with a self-consistency oracle — a restore's number must
  equal the physical line of the line after it) and the
  `line-directives-c-error` cli-case (a `c_include` prototype mismatch whose
  C error re-renders with a `--> main.yo` anchor).

Still deferred, deliberately:

- **`yo build` plumbing**: build artifacts compile through the
  `__yo_build_executable` builtin, whose argv the seed controls — a
  `line_directives` build option is a Generation-A/B step
  ([`backlog/SEED_VERSION_AUTOMATION.md`](../backlog/SEED_VERSION_AUTOMATION.md)).
  The chunked half of acceptance 3 is covered by
  `yo compile --emit-chunks … --line-directives` (the same assembly path).
- **Flipping the default on**: its own PR after a battery cycle — flipping
  changes every emitted-C artifact at once.

