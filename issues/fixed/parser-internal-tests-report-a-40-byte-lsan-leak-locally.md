# Five parser internal tests fail under local LeakSanitizer with a 40-byte leak CI never sees

**Severity:** S3 — a local-only LSan signal on `tests/internal/parser.test.yo` makes the whole suite red on this box and can mask a REAL new leak; CI stays green, so nothing tracks it.

**Status: FIXED 2026-10-04** (branch `s3/batch-2-fixes`) — hypothesis (a) was
right: a genuine leak, allocator- and platform-independent. See "## Fixed" at
the bottom. Found 2026-10-01 while gating the
same-operator-chain parser fix
(`issues/fixed/same-operator-chain-of-four-or-more-is-not-left-associative.md`).
**Measured on:** this WSL2 box (nix clang 21.1.7, LSan via `--sanitize address`),
`--std-path ./std`.

## The failure matrix

`yo test tests/internal/parser.test.yo --parallel 1` fails the same 5 tests
for every combination measured:

| parser source | binary | result |
| --- | --- | --- |
| develop's `src/parser.yo` (swapped in clean) | tree-built, the chain fix | 2/2 matched tests fail ("Parse ?= with multi-line parenthesized -> RHS", "Parse colon : with multi-line parenthesized -> RHS in struct field") |
| the chain fix (either implementation) | tree-built | all 5 fail (the two above plus "Reject whitespace-separated call f a, b", "Reject removed slice type [T]", "Reject removed slice type [T;]") |
| the chain fix | installed v0.2.48 | same 5 fail |

Each failure is the runner's `Memory leak detected` verdict, not an
assertion: the child reports `Direct leak of 40 byte(s) in 1 object(s)`
with the allocation attributed (after inlining) to the parser's top-level
statement loop. CI's `tests/internal` job is green on develop, so CI's
LeakSanitizer does not reproduce it.

## What this is NOT

- Not caused by the chain fix: develop's parser source fails identically on
  this box.
- Not the `HashMap` the fix's first implementation carried: the leak
  persists after that implementation was replaced by a zero-new-state
  token-scan.
- Not a functional break: with `YO_TEST_LEAK_VERDICT=0` the suite's
  assertions pass.

## Root cause (unresolved)

Either (a) a genuine 40-byte leak in the parser/evaluator path those five
tests exercise that CI's ASan build cannot see (different interceptor
coverage, allocation folding), or (b) an LSan artifact of this box's nix
clang runtime. Distinguishing needs the LSan stack symbolized on both
platforms (`-g` on the emitted C, or a CI job with `ASAN_OPTIONS=...
symbolize=1` dumping the same child).

## Fix direction

Symbolize the 40-byte allocation in a CI-visible configuration; if real,
fix the missing drop; if an artifact, pin the runner's local LSan verdict
off for these tests (as `YO_TEST_LEAK_VERDICT=0` does) with a comment
pointing here so a real leak does not hide behind it.

## Fixed

**2026-10-04, branch `s3/batch-2-fixes`.** Hypothesis (a): the leak was real
and platform-independent. On the effect-UNWIND path — a handler calls
`unwind(...)`, every intermediate frame's `if (__yo_effect_escaped)` check
returns a **dummy that owns nothing** — a local whose ownership had already
left the frame through its consumer was released by nobody: the scope-end
scheduler skips consumed locals (gate e5), the explicit `return`/`unwind`
nodes are covered by the M3 early-return drops, but the escape check's own
consumed-variable channel (`ExprInfo.consumed_variable_drop_expressions` →
codegen's `generate_consumed_var_drops_for_escape`) was **never populated**
— the TypeScript evaluator's `directlyConsumedReturnVar` block that filled it
was not ported (the setter had zero callers in the Yo tree). In the parser
this hit two shapes: `exprs` in `do_parse` (consumed by the tail inout field
write `self.program = exprs` — on a mid-loop throw the partial list leaked;
the 40-byte `ArrayList(AstExpr)` node is that list) and every frame that
returns a moved-out local. Measured with the fixed allocator's `--debug-heap`
atexit oracle (Windows, MSVC CRT + TLSF — allocator-independent): a rejected
`[T]` parse leaked ≈9 blocks/≈550 B per call, a successful multi-line `?=`
parse ≈1 block per call, both linear in N while the plain-success control
stayed flat.

The fix (src/evaluator/exprs/begin.yo, src/codegen/exprs/return.yo): the M3
driver now also records each eligible consumed local's `___drop` in the begin
ExprInfo's `consumed_variable_drop_expressions` (plus a parameters-frame pass
for consumed `own` params of a function body), and the codegen channel emits
them under three guards — position (only at escape points BEFORE the
consumption, `_variable_moved_before_cleanup_point`), C-emission order (the
`declared_scopes` block-scope stack, mirroring `_keep_pending_drop`), and a
one-release-per-name exclusion against the scope channel's live list plus the
escape expr's own drops (`collect_names_released_by_escape_sequence`; without
it an interpolation statement's string temps reached BOTH channels and the
same `__yo_decr_rc` was emitted twice — a double free). Regression test:
`tests/error.test.yo` "a local moved out through the return value is released
when a throw unwinds through its frame" (a `Dispose` counter over 20
unwinds — failed before, passes after). Verified: `tests/internal/parser.test.yo`
54/54, `tests/error.test.yo` 15/15, `tests/rc.test.yo` 68/68,
`tests/dyn.test.yo` 32/32, `tests/algebraic_effects.test.yo` 78/78,
`tests/fs/dir.test.yo` 18/18, `tests/async_await.test.yo` 262/262; all six
`--debug-heap` N-scaling probes flat; a 500-round over-drop canary (resume /
container-move / branch-return-plus-escape arms) with 0 bytes live at exit;
and the dup/drop emit-diff gate: 0 release lines removed, 144 added, remaining
diff confined to match-label renumbering.
