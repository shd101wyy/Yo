# R-PROBE runs its reference lookups on every instance call once any reference impl exists

**Severity:** S2. A compiler-performance regression: `check src/main.yo` makes 2.3x more allocation calls and runs about 16% longer on CI. Every build compiled by a seed that carries it pays the cost.

Found 2026-11-10 by the develop battery's `Evaluator memory ratchet` job on develop `a4c34e1a1` (run 42763312857).

## Symptom

| Develop | Allocation calls, `check src/main.yo` | Max RSS | CI wall |
| --- | --- | --- | --- |
| `fe58873dd` (green) | 7,064,194,617 | 1779 MB | 10:22 |
| `a4c34e1a1` (red) | 16,195,326,699 | 1795 MB | 12:02 |

The baseline is 6,992,690,036 (±5%). Memory is unchanged, so the extra allocations are transient.

## Cause (from reading the code; the fix PR's A/B confirms it)

`src/evaluator/calls/function.yo` runs R-PROBE's reference-slot lookups (`&R`, `&mut R`) for every non-static method call whenever `reference_impls_seen()` (`src/evaluator/context.yo`) is true. That function is a global switch: it turns on as soon as any `impl(&C, …)` exists in the program. Until #1876 there was none in std or src, so the cheap path ran. #1876 added `impl(&C, IntoIterator)` / `impl(&mut C, IntoIterator)` to std. Since then, every instance call in every program does three extra things:
- repeats the base lookup;
- looks up a freshly built `&base` and `&mut base`;
- rebuilds the structural type key twice, because fresh handles miss the generic-impl cache's identity front.

The other cost in the range, #1876's lowering of `src/`'s borrowed `for` sites, is real and is not part of this issue.

## Fix (Fable consultation #50)

Gate the two reference lookups on whether the probe can find anything:
- `probe_explicit`;
- or a reference impl is noted for the receiver's pointee head (registration also notes the type-derived head, for alias and primitive receivers);
- or the method name is provided by a bare-binder blanket impl (std's `impl(generic(T), where(T <: …), T, …)` blankets unify with `&C`).

Keep one code path, and delete `reference_impls_seen` and the else arm.

The invariant: a reference lookup can return a candidate the base lookup lacks only under one of those conditions. A `YO_DEBUG_RPROBE_AUDIT=1` knob runs both paths and aborts on a differing hit list. No golden moves, because the "Receiver slot types probed" note still prints on a miss. Tests go in `tests/impl_ref.test.yo`, and the ratchet is the regression test. Any residual above 5% is re-baselined in the same PR.

**Timing:** a v0.2.77 cut gate, because a seed's cost cannot be fixed forward. If the fix is not on develop by 2026-11-14, the ratchet is re-baselined, v0.2.77 is cut on schedule, and the fix is the first merge of v0.2.78.

## Partly fixed: `vbd/rprobe-gate` (VERDICTS-50/51), open at S2

The global switch and the else arm are gone; the `&base` / `&mut base` lookups are gated on
`probe_explicit || reference_impl_head_noted(head) || reference_blanket_method_noted(method)`, both registration sites also note the type-derived head,
`register_generic_impl` notes a bare-binder blanket's methods, and `YO_DEBUG_RPROBE_AUDIT=1` is the soundness check (clean over `check ./std`, `check ./src`,
`impl_ref`, `reference_read_rule`, `for_read_walk`, `for_macro_borrow`). Measured by CI's method (stage-2 C on the libc stand-in, REPEAT=2):

| Tree | Allocation calls, `check src/main.yo` |
| --- | --- |
| `fe58873dd` (green baseline) | 7,064,194,617 |
| A: develop `30e1411cd` | 16,198,306,101 |
| B: `vbd/rprobe-gate` | 12,381,196,693 (-23.6%) |

**Scope that remains:** the residual +5.32e9 is the same defect on a receiver whose head has a reference impl (std's collections: `ArrayList`, `HashMap`,
`BTreeMap`, `Deque`, `HashSet`, `OrderedMap`, `PriorityQueue`, whose `IntoIterator` impls provide only `into_iter`). The head index is too coarse: every
`xs.len()`, `xs.push(v)`, `m.insert(k, v)` still runs the full probe. The (head, method) index (VERDICTS-51 section 3) closes it. Tests: `tests/impl_ref.test.yo` (x).

## Fixed: (head, method) index (VERDICTS-51 B2)

Index (i) is keyed by `(head, method)`: a reference impl notes every method name it registers (members and trait defaults), under the syntactic and the type-derived head, at the concrete and the generic registration sites. A pending reference impl of the head is forced before the gate reads the index. A call such as `xs.len()` on a std collection no longer probes the reference slots, because the collections' reference impls register only `into_iter`.

| Tree | Allocation calls, `check src/main.yo` |
| --- | --- |
| `fe58873dd` (green baseline) | 7,064,194,617 |
| A: develop `30e1411cd` | 16,198,306,101 |
| B: #1882 | 12,381,196,693 |
| B2 | **7,361,723,027** (two runs agreeing to the call) |

`YO_DEBUG_RPROBE_STATS=1` over `check ./src`: 174,513 instance calls; 938 run the reference lookups (198 explicit `(&x)`, 214 a reference impl's method, 526 a bare-binder blanket's method). The ratchet baseline is set to B2's count; the remaining +4.2% over `fe58873dd` is #1876's own cost. `YO_DEBUG_RPROBE_AUDIT=1` is clean over `check ./std`, `check ./src` and the R-PROBE tests. Tests: `tests/impl_ref.test.yo` (x), (xi).
