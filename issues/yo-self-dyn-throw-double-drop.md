# yo-self: pre-existing double-drop of the dyn-consumed error temp on escape paths (stage-2 startup crash)

**Status:** root-caused 2026-07-15; fix pending. **This is the actual stage-2
runtime blocker** — it PREDATES the 2026-07-15 session work (verified: a clean
`7d6b0385a` baseline s1→stage2.c→s2 build crashes identically TODAY, rc=139,
on `s2 check tests/codegen-bootstrap/empty_main.yo`).

## The bug (Guard Malloc + lldb, deterministic)

Crash: `__yo_decr_rc(ptr)` reads a FREED page (double-drop; Guard Malloc traps
at the second decrement). Site (`stage2l.c` ~493546, fn `yo_id_292354` = the
`unquote` evaluator, but the PATTERN is every `exn.throw(dyn(format_error_message(...)))`
in the compiler — i.e. every throw site):

```c
__yo_t2   t317 = String.from("unquote: argument must have a compile-time value");
__yo_t206* t318 = format_error_message(tok, t317, false, None);
__yo_t774  t319 = { .data = t318, .vtable = ... };          // dyn fat pointer
__yo_effect_escaped = 0;
__yo_t26*  t320 = exn.throw(t319);
if (__yo_effect_escaped) {
  // Drop local variables before early return
  ... drop t317 ...            // ok
  __yo_decr_rc((void*)(t318));        // ← WRONG: t318 was consumed into t319
  __yo_decr_rc((void*)(t319).data);   // ← .data == t318 → DOUBLE DROP → UAF
  ...
}
```

No compensating dup is emitted (Guard Malloc proves rc hits 0 at the first
decrement). The throw path fires constantly during def-time trial evaluation →
heap corruption early in any nontrivial run. Whether it crashes (segv /
malloc-freelist trap / GC tracked-list cycle spin) depends on allocator layout
luck — which is why it presented as a heisenbug that ANY emission change
appeared to "cause".

## TS oracle (same site, `stage1-ref.c` ~385453)

TS's escape list after the throw drops the **dyn once** (`___drop(dyn_temp)`)
and **never the raw `format_error_message` result** — the inner temp's pending
drop is suppressed/never scheduled once the value is consumed by the dyn
construction. TS `generateDyn` (src/codegen/exprs/dyn.ts:115) documents the
invariant: _either_ the inner value is dup'd (then both the dyn drop and the
scope drop are correct) _or_ it is moved (then only the dyn's drop exists).
yo-self emits no dup but keeps BOTH drops.

Where the two sides diverge (to pin down during the fix): the inner temp's
deferred drop is scheduled by `attach_temp_variable_to_expr` on the call
result; TS suppresses it on escape paths via its env-path consumed filter
(`variableWasConsumedBeforeCleanupPoint`) and/or never re-schedules it after
the dyn consumes the value. yo-self's escape checkpoint uses
`skip_env_check=true` → the `!use_env` branch of `_keep_pending_drop`
(return.yo), whose consumed check via `_get_deferred_drop_target_variable`
apparently does not see a `consumed_at_token` for this temp — either yo-self's
dyn evaluation never marks the inner temp consumed, or the marking/lookup
misses (end-of-scope env / name-resolution).

## Fallout of this discovery (bisect-matrix invalidation)

The 2026-07-15 session bisected s2 crashes across ~8 variants and blamed, in
turn: the `;`-form uninit-decl recording, the type*key Pointer branch, the
specialization-signature split (both type_key and state-free variants), the
emitter DECL_RE refactor, and the drop gates. **All those verdicts are
invalidated**: every variant crashed because the baseline crashes. Components
reverted on that evidence (helper.yo `\_id*`signature split, type_key Pointer
branch, emitter`;`-form recording) should be re-evaluated on their own merits
AFTER this double-drop is fixed — with `s2 check`health as a then-meaningful
gate. (The`;`-form uninit-decl recording remains independently dangerous per
the garbage-drop analysis in emitter.yo and the historical "uninit-`;`-decl →
s2 startup crash" note — keep `=`-only unless zero-init lands.)

Kept regardless (validated by deterministic gates, not runtime luck):

- The HashMap same-key-overwrite leak fix (hmap repro `tracked=101→2`, == TS).
- The scope-stack drop gates (stage-2 self-emit clang errors 84→0).
- The gc.yo signature-consistent traverse (kills the 3 `.key.tag on size_t`
  errors deterministically regardless of registration order; see
  issues/yo-self-specialization-signature-type-identity.md).

## Repro / validate

- Fast crash repro: build any stage2.c (baseline or current), `clang -O2`,
  `s2 check tests/codegen-bootstrap/empty_main.yo` → rc 139/133/124 within
  seconds (layout-dependent flavor).
- Guard Malloc pins the exact site:
  `lldb -o "env DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib" -o "env YO_MAIN_STACK_MB=16384" -o run -k "bt 12" /tmp/s2l -- check tests/codegen-bootstrap/empty_main.yo`
  (build s2l from an `--allocator libc` emission at `-O0 -g`).
- Fix gate: the escape drop list after `exn.throw(dyn(X))` must contain
  EITHER a dup of X + both drops, OR only the dyn drop (TS emits the latter);
  then s2 `check` runs clean, and the corpus needs a new
  `tests/codegen-bootstrap/` case exercising throw-dyn + escape + Gc counts.

## Fix (landed 2026-07-15)

`evaluator/values/dyn.yo` now calls `set_expr_as_needs_to_call_dup` on the
final inner value expr in BOTH evaluation paths (non-executing `ne_final_expr`

- executing `final_value_expr_ex`), mirroring TS dyn.ts:321. Verified:
  `/tmp/dd.yo` yo-self-compiled prints `done tracked=0` rc=0 (== TS); the
  stage-2 emission's throw sites now drop only the dyn's `.data` (raw payload
  temp drop gone — TS parity); corpus test added as
  `tests/codegen-bootstrap/dyn_throw_double_drop.yo`.

## Round 2 — a SECOND pre-existing corruption class remains (s2 still rc=139)

With the dyn fix in, Guard Malloc now traps on `__yo_incr_rc` (a DUP) of a
FREED page inside an `ArrayList(...).get(index)` specialization called from
`evaluate_function_parameter` (yo_id_246541, stage2l.c:131855) ←
`_evaluate_function_parameters` loop (yo_id_248305) ←
`synthesize_function_type_from_tokens` (yo_id_249345). I.e. a param-expr list
(or its element) is freed while still reachable — ANOTHER over-drop/missing-dup
divergence, hit during every function-type synthesis. Hunt method that worked
for round 1 (use it again): Guard Malloc bt → map the C site → compare the
same function against the TS oracle emission (/tmp/stage1-ref.c, locate via
distinctive string constants) → build a seconds-fast standalone repro
(TS-compiled vs yo-self-compiled behavior diff) → find the missing
consumption/dup in the yo-self evaluator → fix → re-run
dd.yo + hmap + clang-0 + s2-health gates.

### Round-2 site detail (for the next session)

The freed object is an **AstExpr node**: `evaluate_function_parameter`
(evaluator/types/function.yo; C site stage2l.c:131855) does
`_fn_call_args(expr_mut).get(1)` — reading the param expr's TYPE sub-expression
(`label : Type` → args[1]) — and `ArrayList.get`'s element dup
(`__yo_incr_rc`) traps: the CHILD NODE is already freed while its parent
`expr_mut` still references it. So something over-dropped an AST subtree that
is revisited later — prime suspect: `synthesize_function_type_from_tokens`
makes MULTIPLE passes over the same `param_exprs` (pass 1 forall, pass 2
implicit/using, where-clause pass), and an earlier pass's evaluation drops
node(s) a later pass re-reads. Compare with TS `synthesizeFunctionTypeFromTokens`
(no drops — GC) and find which yo-self eval path drops an arg node it only
borrows. Crash fires during PRELUDE eval → forall/using-heavy signatures;
build the repro from a forall+using fn signature shape.

### Round-2 REPRO CAPTURED (2026-07-15 evening, seconds-fast)

`/tmp/r3.yo` (30 lines): an OWNING local reassigned from a match-arm payload —
the exact aliasing shape of `evaluate_function_parameter`
(evaluator/types/function.yo:740 `expr_mut = match(lhs_expr, .Some(e) => e, …)`):

```rust
probe :: (fn(parent : Node) -> i32)({
  (cur : Node) = parent;
  opt := cur.kids;
  match(opt, .Some(child) => { cur = child; }, .None => ());
  cur.tag
});
```

TS-compiled: `done acc=60 k=2 tracked=2` rc=0. yo-self-compiled: **rc=134**
(abort — double-free): the assignment `cur = child;` emits no dup for the
borrowed match-arm payload, so `cur`'s scope-end drop steals the parent
`kids` field's reference → the child is freed while the tree still holds it —
the s2 `args.get(1)` freed-AstExpr UAF. Next step: diff the emitted C for
`probe` (TS vs yo-self), then fix yo-self's assignment codegen/evaluator to
match TS (deferred-dup on reassignment from a borrowed payload — see TS
generateAssignment / setExprAsNeedsToCallDup usage for `=`). Then the standard
gates + s2 health ×3 + the fixpoint chain.
