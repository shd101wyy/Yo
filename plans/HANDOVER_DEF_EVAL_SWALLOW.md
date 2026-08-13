# Handover — the def-eval swallow endgame, and the three PRs behind it

**Written 2026-08-13.** Branch `fix/def-eval-swallow-sizing` = PR #110.
Read this first, then `issues/def-eval-swallow-remaining-roots.md` for the full
measurement record. This doc is the state, the traps, and the next move; that
file is the evidence.

---

## 0. TL;DR — what to do first

1. **Wait for PR #110's CI, then merge it.** Nothing is blocked on more work; it
   is blocked on a ~60 min CI run. Do NOT push to that branch while you wait —
   every push restarts all 16 checks (this already happened twice, see §5).
2. **Then rebase and merge #98, then #112.** Both conflict on exactly one file.
3. **Then resume family A** with the measurement in §4, which is already done —
   its result is in §3, and it reopened a direction the record had closed.

---

## 1. What the campaign is

`_trial_eval_fn_body` (`yo-self/evaluator/calls/function_type.yo:263-280`) wraps
definition-time body evaluation in a capture-free `->` handler that unwinds `()`
on ANY error, and the FuncVal registers anyway. TS's counterpart
(`src/evaluator/calls/function-type.ts:499`) is FATAL.

So every swallowed error marks a place where yo-self's definition-time
environment is thinner than TS's. A body whose statements lose their ExprInfo is
what codegen turns into a `// Failed to transpile` **C comment** — which the C
compiler skips, producing a binary that links, runs, and does nothing.

**Making the handler fatal is the endgame.** An attempt at it (2026-08-12) broke
10 corpus files: the swallow is currently load-bearing. The roots must go first.

Progress so far, all landed with the full battery:

| stage                         | distinct roots | `Variable "X" not found` |
| ----------------------------- | -------------- | ------------------------ |
| baseline (2026-08-13)         | 33             | 17                       |
| + generic TYPE binders bound  | 17             | 1                        |
| + generic VALUE binders bound | 16             | 0                        |

16 roots remain (19 swallows), inventoried and attributed to owning functions in
`issues/def-eval-swallow-remaining-roots.md`. They fall into two families.

---

## 2. Family A — and the one attempt that must NOT be repeated

**Family A** (roots #1, #2, #3): a sibling method called inside another method's
body evaluates to `unit` at definition time, so the arms cannot unify
(`usize` vs `unit`). Minimal reproducer, 15 lines of substance:
`issues/repros/self-static-method-at-def-time.yo`. The real target is
`std/collections/array_list.yo`'s `slice_copy` (`:73:59`), whose body opens with
`out := Self.new();`.

### The failed attempt — read before touching `impl.yo`

`_try_create_forward_shell` has exactly ONE call site in `impl.yo` — Case 3
(non-generic impls, `~:2862`) — while TS runs its equivalent for BOTH paths,
since `evaluateImplFieldList` (`impl.ts:590`) is shared. That asymmetry is real,
so the obvious move is to add the pre-pass to Case 2 (generic impls).

**Do not.** It was implemented, measured, and reverted (commit `c2613e0b5`):

| measurement             | result                                       |
| ----------------------- | -------------------------------------------- |
| the reproducer          | rc=0, 1 swallow → **0**, FTT 0               |
| baseline distinct roots | 16 → **16** (no change)                      |
| `check ./yo-self`       | 247/247                                      |
| fixpoint                | FIXPOINT_HOLDS                               |
| hollow sweep            | **`tests/imm_map.test.yo` RED** — regression |

Confirmed against a control binary built from the same tree with only `impl.yo`
reverted: it runs that file at 21 passed / rc=0.

**Why it regresses.** Case 3 may register shells into the global
`type_trait_methods` because its main pass supersedes each shell in place
(`impl.yo:3199-3238`, matching `source_trait_id == "__forward_shell"`) and records
a shell→real redirect for codegen. **Case 2 has no supersede path at all** — it
accumulates into a `GenericImplEntry` and never calls
`register_type_trait_method` — so the shells become the only entries under that
receiver id, permanently, each carrying an unevaluated body. TS avoids this by
scoping: it pushes shells onto a CLONE of `receiverType.trait.fields`
(`impl.ts:576-585`) and restores the original at `impl.ts:899`.

---

## 3. The finding that reopens family A (measured, this session)

The record previously concluded that "the def-time body trial happens outside the
impl's field loop, and no amount of publishing into `current_impl_trait_field_*`
can reach it." **That conclusion is false.** An ordering probe (§4) shows:

```
[field-begin] case2 recv=struct_yo_id_3171 name=new
[trial]       std/collections/array_list.yo:57:4
[field-end]   case2 recv=struct_yo_id_3171 name=new
[field-begin] case2 recv=struct_yo_id_3171 name=slice_copy
[trial]       std/collections/array_list.yo:73:59
[swallow]     Error: Cannot unify incompatible types: "usize" and "unit"   <- root #1
[field-end]   case2 recv=struct_yo_id_3171 name=slice_copy
```

1. **The trial runs INSIDE the field loop.** So a loop-scoped channel — the
   provisional registry, cleared at loop end — IS live at trial time. The
   permanent registration that regressed `imm_map` is not required.
2. **`new` reaches `[field-end]` before `slice_copy` reaches `[field-begin]`.**
   Its real, fully-evaluated FuncVal already exists when the failing body is
   trialled. **No forward shell is needed for this class at all** — register real
   values, not shells.

**Why the earlier probe measured `n_labels=0`:** it patched the wrong branch. The
`g_mval` push site (`impl.yo:2581`) is inside Case 2's TRAIT-CONSTRUCTOR branch
(guarded by `!(BK_COLON)`), while the failing fields are direct `name : fn` pairs
handled by the branch at `impl.yo:2458`. Nothing was ever pushed for them. The
885 pushes that "fired" belonged to other impls.

### The shape of the fix this implies

Three parts; all three are needed or the change is inert (or unsafe):

1. **Register** each impl method into the PROVISIONAL registry
   (`register_provisional_trait_method`,
   `yo-self/evaluator/values/type_trait_methods.yo:207`) as each field completes,
   keyed by the receiver type id, in Case 2's direct colon-pair branch
   (`impl.yo:2458`, after the existing `add_variable_to_env`) and the Case 3
   equivalent (`impl.yo:3110`).
2. **Consume** it from the STATIC lookup. Verified by reading:
   `Self.new()` is `is_static` (`calls/function.yo:313`), so it resolves through
   `get_type_trait_methods_by_name_from_env` (`env.yo:2736`), whose only sources
   are the trait-qualified case, the permanent registry (`:2780`), and the
   generic-impl fallback (`:2784-2790`). It never consults the provisional
   registry — whose sole consumer today is
   `get_receiver_methods_by_name_from_env` (`env.yo:3207,3222`), the INSTANCE
   path. **Add the consult as a last-resort fallback, ranked BELOW the
   generic-impl fallback** — outranking it is exactly how `imm_map` broke.
3. **Clear** with `clear_provisional_trait_methods(receiver_id)` when the field
   loop finishes, next to the existing context-list restores (`impl.yo:2607`,
   `:3431`).

Known caveat: provisional entries carry `value : None` (type only) by design
(they port TS's window where `assignedValue` is still undefined). For the trial
to typecheck `Self.new()`, the entry may need to carry the real FuncVal. If you
change that, check every existing provisional consumer — the `value : None`
contract is load-bearing for the derive(Clone)/TreeNode case documented at
`type_trait_methods.yo:187-204`, and a valueless entry shadowing a real method
already miscompiled `enum_ne_dispatch` once (see the comment at `env.yo:3199`).

### Family A's second half, still open

Even with shells working, the root count did not move (16 → 16), because
`_try_create_forward_shell` returns `.None` whenever `_trial_eval_fn_type_head`
(`impl.yo:1957`) cannot evaluate the signature — and it cannot for `array_list`'s
(`Range(usize)`, `?*(T)`, `Option(T)`, `ArrayListError`), while the reproducer's
`fn(self : Self) -> usize` succeeds. If you pursue the shell path at all, that is
the blocker. **The §3 finding suggests you should not need to.**

---

## 4. The ordering probe — reproduce it in one build

Apply this patch (saved verbatim at `/tmp/probe_instrumentation.patch` this
session; reproduced here because `/tmp` will not survive):

```rust
// yo-self/evaluator/values/impl.yo, after `open(import("std/string"));`
open(import("std/fmt"));
_(env : impl_dbg_env) :: import("std/env");

// at impl.yo:2458 (Case 2, direct colon-pair branch), around the eval:
if(impl_dbg_env.get(`YO_DEBUG_SWALLOW`).is_some(), {
  eprintln(`[field-begin] case2 recv=${type_id_or_empty(receiver_type_pattern)} name=${mname}`);
});
eval_mval := evaluate_expression_raw(mval_expr, forall_env, ctx, exn);
if(impl_dbg_env.get(`YO_DEBUG_SWALLOW`).is_some(), {
  eprintln(`[field-end]   case2 recv=${type_id_or_empty(receiver_type_pattern)} name=${mname}`);
});

// at impl.yo:3110 (Case 3), same pattern with `receiver_ty` / `method_name`,
// tagged case3.
```

Then:

```bash
./yo-cli fmt yo-self/evaluator/values/impl.yo
<stage1> check ./yo-self                     # expect 247/247
<stage1> compile yo-self/main.yo --release -o /tmp/yo-probe   # ~9 min
YO_DEBUG_SWALLOW=1 YO_MAIN_STACK_MB=4096 /tmp/yo-probe \
  compile issues/repros/self-static-method-at-def-time.yo \
  --emit-c --skip-c-compiler -o /tmp/x &> /tmp/probe.log
grep -E "\[field-begin\]|\[field-end\]|\[trial\]|\[swallow\]" /tmp/probe.log
```

`array_list`'s impl shows up in that same log — the reproducer imports `std/fmt`,
which pulls it in — so you get the real target for free.

---

## 5. The three PRs

| PR   | branch                        | state                                           |
| ---- | ----------------------------- | ----------------------------------------------- |
| #110 | `fix/def-eval-swallow-sizing` | CI re-running; was 15/17 green before my pushes |
| #98  | `p2/ci-migration`             | CONFLICTING — `.github/workflows/release.yml`   |
| #112 | `chore/release-bump-first`    | CONFLICTING — `.github/workflows/release.yml`   |

**Order: #110 → #98 → #112.** #110 gates the others.

**Trap: PR #110's head branch is the working branch.** Every commit pushed there
restarts all 16 checks (~60 min). This session pushed three doc commits and
restarted CI twice. If you have doc-only work while #110 is in flight, either
hold it or put it on a separate branch — do not push it to
`fix/def-eval-swallow-sizing`.

**Trap: `[skip ci]` in prose.** A commit message that merely _describes_ the
mechanism using the literal string will skip CI — GitHub scans the whole message,
not just the subject. This already cost one debugging cycle; write it as
`` `skip-ci` ``.

Both #98 and #112 conflict only on `.github/workflows/release.yml`, because #112
rewrites the release flow (bump ahead of the release, no PR) and #98 touches the
same file for the CI migration. Rebase each on develop after #110 lands.

---

## 6. Method notes — traps this session hit, in cost order

- **Never trust a fast gate alone for anything touching impl evaluation.** The
  Case-2 patch passed `check ./yo-self` 247/247 AND fixpoint AND the reproducer,
  and still regressed the corpus. The hollow sweep is what caught it. Full
  battery, every time: `fixpoint_only.sh`, `hollow_sweep69.sh`,
  `test ./tests/internal`, `check ./std`, `check ./yo-self`.
- **Build controls in the main repo, not a `git worktree`.** A worktree has EMPTY
  submodule dirs, so `vendor/markdown_yo` is missing and `main.yo` dies with the
  unhelpful `file or directory not found`. Use
  `cp <file> /tmp/x.bak && git checkout <file> && <build> && cp /tmp/x.bak <file>`.
- **Never run two heavy `yo-cli` children at once.** `macro_expansion` alone needs
  6.52 GB; two concurrent compiles on 16 GB swap, and the swapping trips the
  runner's own 600 s deadline, manufacturing failures that do not reproduce in
  isolation. One battery arm at a time.
- **Attribute regressions against a control binary, not against sweep history.**
  Ten prior GREEN sweeps are suggestive; a same-tree build with only the suspect
  file reverted is proof, and costs ~9 min.
- **`Cannot destructure from a module that is still being evaluated` means a
  MISSING SYMBOL**, all three times it appeared. Adding `open(import("std/fmt"));`
  for `eprintln` fixed an 86-error circular-import cascade.
- **A single-expression `{}` parses as a struct literal.** `if(c, { match(...) })`
  needs the braces removed or a `;` added.
- **Measure the probe, not the reverted probe.** One cycle was lost measuring
  `n_labels` with the pushes reverted, where `0` is trivially true and proves
  nothing.

---

## 7. Where everything lives

| what                                     | where                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| full measurement record, 16-root table   | `issues/def-eval-swallow-remaining-roots.md`               |
| family A reproducer                      | `issues/repros/self-static-method-at-def-time.yo`          |
| the swallow's surface / earlier analysis | `issues/def-time-body-eval-swallow-surface.md`             |
| the silent-miscompile origin story       | `issues/self-hosted-compile-swallows-undefined-call.md`    |
| P2 roadmap this feeds                    | `plans/P2_RETIRE_SRC.md`, `plans/P2_5_RETIRE_EXECUTION.md` |
| the trial/swallow debug hook             | `yo-self/evaluator/calls/function_type.yo:263-280`         |
| the marker gate that makes it visible    | `yo-self/codegen/functions/generation.yo:575-630`          |
