# A SELF-BUILT compiler has a use-after-free in the report and build paths — 8 cli-cases abort

**Status: ROOT CAUSE FOUND AND FIXED 2026-08-12** —
`yo-self/codegen/exprs/init_assignment.yo`. A variable binding whose RHS carries
no temp variable never emitted its deferred dup, while the matching drop was
still emitted: a net **−1 per binding**. Inside an async state machine that is
the _normal_ shape (`sm->var_N = (*index(...));`), so every
`element := list(i)` in an async loop silently under-counted its element.

Found 2026-08-11 by the first CI run in which stage-1 is built by the previous
release instead of by TypeScript: exactly the bug class the 2.3 migration exists
to expose, because every CI arm until then tested a **TS-built** stage-1, so a
defect in what the SELF-HOSTED codegen emits was invisible.

## Root cause

TS computes the RHS **once**, through a four-arm chain in which _every_ arm
emits the RHS's deferred dups, and only then chooses where the value lands —
a plain local or, for a state-machine variable, `sm->field`
(`initialization-assignment.ts:487-494`). The destination never changes whether
the +1 is emitted.

yo-self instead short-circuits: `init_assignment.yo:205-250` detects a
state-machine binding, generates the RHS raw, assigns it, and **returns early**,
jumping over the entire dup chain below:

```rust
sm_rhs := _call_generate_expr(rhs, indent.clone(), context);   // no deferred dups
em.emit_string_line(`${indent}sm->${sm_field} = ${sm_rhs};`);
return(Option(String).Some(String.from("")));
```

The drop side was never conditional on the dup side, so the pair came apart.

Why it hid in async code specifically: that early return is reachable _only_
inside a state machine. Outside one, the same binding takes the normal path and
is correct (`__yo_t2* temp = (*index(...)); __yo_incr_rc(temp); it = temp;`) —
a sync control compiled by the same binary proves it. So the defect needs both
an async body and an RC-carrying binding:

```c
/* TS   */ temp_a = (*index(&sm->__capture.items, sm->var_i));
           temp_b = Item___dup(temp_a);          /* the +1 */
           sm->var_it = temp_b;
           ...
           Item___drop(sm->var_it);              /* balanced */

/* self */ sm->var_it = (*index(...));           /* NO +1 */
           ...
           __yo_decr_rc((void*)(sm->var_it));    /* net -1 per iteration */
```

Elements are therefore freed while the list still points at them. The first pass
is usually survivable (elements sit at refcount 2), so the corruption needs a
second read of the same list — which is why it surfaced in the compiler's own
multi-pass walks and not in small tests.

`public-safe-report` was where it showed because its scan loop binds
`decl := decls(di)` inside an async body: the crash is the _list's_ teardown
walking element pointers that its own loop already freed.

```
frame #0: __yo_decr_rc            ← reads a freed RC header
frame #1: <ArrayList element teardown>
frame #2: __yo_decr_rc            ← refcount reached ZERO here
frame #3: <async block>_resume
```

## Fix

Route the state-machine branch's RHS through `emit_deferred_dup_or_code` — the
helper the normal path's arms already use, which emits the dups and returns the
dup result name — so the early return no longer skips the +1:

```rust
sm_rhs := emit_deferred_dup_or_code(rhs, _call_generate_expr(rhs, indent.clone(), context), indent.clone(), context);
```

Emission afterwards is TS-shaped (yo-self inlines `__yo_incr_rc` where TS calls
a synthesized `___dup`, per `yo-self-rc-dup-drop-methods-never-synthesized`):

```c
__yo_t2* temp = (*index(...));
((__yo_t2*)__yo_incr_rc((void*)(temp)));   /* the +1 */
sm->var_it = temp;
...
__yo_decr_rc((void*)(sm->var_it));         /* balanced */
```

**A second, smaller parity gap** was found while reading TS and is fixed in the
same commit: the `.None` arm of the normal path (no temp variable name on the
RHS) also skipped its dups, where TS's matching `else` (lines 464-484) emits
them. That arm is _unreachable for state-machine bindings_ — they return early
above — so it is **not** the cause of this bug and has no regression test of its
own; it is ported for parity with its three sibling arms. The outer `.None` (no
`ExprInfo` at all) is left alone: TS guards on `rhs.$?`, so no deferred dups can
exist there.

## Verification

A differential reproducer now lives in `tests/async_await.test.yo` ("async index
binding keeps the element alive"): it indexes a 3-element `ArrayList` of ref
structs inside an async loop containing an await, **twice**.

| built by                | `total` | element 0's String |
| ----------------------- | ------- | ------------------ |
| TS compiler             | 12      | `alpha`            |
| self-hosted, **before** | 12      | **empty — freed**  |
| self-hosted, **after**  | 12      | `alpha`            |

Both self-hosted binaries were built **by the TS compiler from the same tree**,
differing only by the patch — the comparison the invalid verification below
failed to make.

End-to-end, on the case that actually blocked 2.3 (`public-safe-report` over the
2-file fixture, compiled by a stage-1 carrying the fix):

|                               | before                             | after              |
| ----------------------------- | ---------------------------------- | ------------------ |
| exit code, 3 consecutive runs | 133 / 138 / 139 (nondeterministic) | **0 / 0 / 0**      |
| stdout vs the TS-built binary | empty (crashed)                    | **byte-identical** |
| under Guard Malloc            | `EXC_BAD_ACCESS` in `__yo_decr_rc` | **clean exit**     |

It passes under the TS compiler and FAILED under the pre-fix self-hosted binary
with `element 0 outlived the async loop`, so it is a real ratchet in the hollow
sweep rather than a vacuous assertion. Two passes are required: at one pass the
elements sit at refcount 2 and the imbalance is masked — the earlier judgement
that "no value-asserting regression test can gate this class" was wrong, and it
was wrong because it was formed while the root cause was still misidentified.

## What the earlier "fix" did and did not do

The awaited-RC-result dup fix (PR #103, shipped in v0.2.3,
`state_machine.yo:1774`) is a **real and separate defect fix** — an awaited RC
result was shallow-copied into its slot — and it stays. It was **not** the cause
of these 8 failures, and the verification that claimed it was is invalid: it
compared a TS-built stage-1 against a seed-built one instead of fixed sources
against unfixed ones. A TS-built stage-1 scores 27/27 with or without it, and
v0.2.3 carries it and still scored 15/27.

**The lesson, worth more than the fix:** when validating a codegen change, hold
the BUILDER constant and vary the SOURCES. Varying the builder measures which
generation compiled the compiler, not whether the patch works.

## What is and is not affected — measured

Same fixture, same `YO_STD`, four binaries:

| binary                                 | built by        | rc  | filesScanned | findings |
| -------------------------------------- | --------------- | --- | ------------ | -------- |
| stage-1 built by the v0.2.2 seed       | **self-hosted** | 134 | —            | —        |
| `local_s2` (a stage-2 from 2026-08-11) | **self-hosted** | 0   | **0** ✗      | **16** ✗ |
| stage-1 built by the TS compiler       | TypeScript      | 0   | 1 ✓          | 2 ✓      |
| the shipped v0.2.2 release binary      | TypeScript      | 0   | 1 ✓          | 2 ✓      |

**Every self-built compiler is wrong; every TS-built compiler is right** — which
is the signature of a `yo-self` codegen defect, and is why the builder-vs-sources
confusion above was so easy to fall into. Reproduces identically on macOS-arm64
and linux-x64, so it is not platform-specific.

## Why nothing caught it

- **Every CI arm built stage-1 with TypeScript** (until PR #98). GATE 7 therefore
  compared TS against a TS-BUILT self-hosted binary — one compiled by the
  correct codegen.
- **The fixpoint cannot see it.** stage-2 ≡ stage-3 compares emitted C _text_ for
  stability, not behavior; both stages are equally affected, so the byte-diff is
  clean. AGENTS.md notes that a stage-2-only bug is invisible to every stage-1
  arm; this is the same hole in the other direction — a self-BUILT-only bug is
  invisible to every TS-built arm.
- **Wrong numbers do not crash.** With counters read from freed memory,
  `public-safe-report` exits 0 and prints plausible JSON. Only the mimalloc
  build turns it into an abort. The silent wrong answer is the dangerous half.

The fix and its test now sit on opposite sides of that line: the test lives in
the language suite (run by both compilers), and the self-hosted arm is what
fails without the fix.

## Family

Same class as `issues/fixed/seed-built-stage1-miscompiles-current-source.md`
(the escape-path pending-drop filter freeing a borrowed match binding, fixed in
#100) — a drop emitted for something still live. This is a sibling site that
fix did not cover.

## Symptom (as originally observed)

`YO_SELF_BIN=<seed-built stage-1> scripts/cli-diff-test.sh` scores
**PASS 15/16, DIFF 3, SELF-FAIL 5, BOTH-FAIL 3-4** where a TS-built stage-1 from
the same sources scores **27/27**. Eight cases abort with rc=134; three doc cases
differ in stdout.

```
$ cd <unsafe-pragma-ok fixture> && <seed-built stage-1> build run
yo-self: error: Error: Build DAG stalled — possible undetected cycle.
mimalloc: error: corrupted free list entry of size 96b at 0x020004935280: value 0x2014493A680
```

```
$ <seed-built stage-1> public-safe-report --json      # 2 files
"filesScanned": 16131858542891098079                  # 0xDFDF… — mimalloc's freed-block fill
```

Both are the same defect read at different times: the second is a freed block
observed before reuse, the first the allocator's own structures after it.
