# `#line` directives — mapping emitted C back to `.yo` sources

> **Status: DESIGN 2026-09-22 — not started.** The last deferred item of
> [ERROR_DIAGNOSTICS_OVERHAUL.md](../reference/ERROR_DIAGNOSTICS_OVERHAUL.md)
> P4 and the whole of ROADMAP Phase 2.4. Unlike the other three P4 items
> (color, SARIF, the warnings channel — all landed 2026-09-22), this one is a
> codegen project with whole-tree blast radius, so it is scoped here rather
> than improvised inside a diagnostics PR.

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
