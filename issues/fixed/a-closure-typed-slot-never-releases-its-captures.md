# A closure-typed slot never releases its captures

**Status:** FIXED 2026-09-28 (see "The complete fix" at the end). The
spawn-wrapper half landed 2026-09-12 on `fix/zst-closure-fn-result`. The rest
was found again by the evaluator memory campaign: 38 leaked `ExprInfoTable`s
pinned 129 MB of `check src/main.yo` (`plans/EVALUATOR_MEMORY_REDUCTION.md`
§0.19).
**Found:** 2026-09-12, measured on the published **v0.2.31** compiler and std —
this is not a regression, it has always been there.
**Class:** the empty-string drop fallback
(memory `empty-string-drop-fallback-class`).

## Symptom

A `Dispose` counter that must read 1 reads 0. Nothing crashes and nothing is
reported: the object simply never dies.

```rust
_dc := AtomicUsize.new(usize(0));
_Tracked :: atomic(ref(struct(tag : i32)));
impl(_Tracked, Dispose(dispose : (fn(self : Self) -> unit)({
  _p := _dc.fetch_add(usize(1), MemoryOrder.AcqRel);
  ()
})));
run_it :: (fn(f : Impl(Fn() -> unit)) -> unit)(f());

{
  tracked := _Tracked(tag : i32(7));
  (inner : Impl(Fn() -> unit)) = (() => { _x := tracked.tag; () });
  run_it(inner);
};
// _dc == 0   ← should be 1
```

Measured on v0.2.31 (`issues/repros/closure-slot-never-releases-captures.yo`):

| shape | disposes | expected | after this fix |
| --- | --- | --- | --- |
| `tracked` used directly, no closure | 1 | 1 | 1 |
| a plain `ref` struct TEMP passed by value | 1 | 1 | 1 |
| `tracked` captured by a closure LOCAL | 0 | 1 | **0 — see "what is left"** |
| a closure LITERAL passed as an argument | 0 | 1 | **0 — see "what is left"** |
| that closure captured by a second closure | 0 | 1 | **0 — see "what is left"** |
| a closure captured by a `Thread(T).spawn` wrapper | 0 | 1 | **1** (this fix) |

## Root cause

`generate_drop_code_for_value` / `generate_dup_code_for_value`
(`src/codegen/exprs/drop_dup.yo`) gate every RC decision on
`type_contains_rc_type`, which is `false` for a bare `SomeT`. A closure-typed
slot's static type IS a bare `SomeT` — the `Impl(Fn(...))` wrapper — even
though at runtime the slot carries the argument closure's CAPTURE STRUCT, which
is what `get_type_string` renders and what the C code casts through.

So every RC value reached through a closure-typed slot was invisible to both
walks:

* a closure LOCAL hit the top-level gate — `generate_drop_code_for_value`
  returned `""`, the silent fallback, and the scope-end drop released nothing;
* a closure captured BY another closure hit the same gate one level in — the
  containing capture struct's field walk skipped the `cb` field, so the spawn
  wrapper's release (`_emit_capture_drop_lines`,
  `src/codegen/exprs/parallelism.yo`) reached `.sink` and nothing else.

The second shape is how this surfaced: D18's `Thread(T).spawn` wraps the user's
callback in a result-relaying closure, `(io) => { sink.send(cb(io)); () }`, so
`cb` becomes a captured closure and `tests/thread.test.yo`'s three
dispose-counter tests went from 1 to 0. The counter was right and the wrapper
was wrong.

## Fix — and the one that was WRONG first

`_emit_capture_drop_lines` (`src/codegen/exprs/parallelism.yo`) walks the spawn
wrapper's capture struct field by field and resolves each field type through
`resolve_some_type_to_concrete` before asking whether it carries RC. A captured
closure's `Impl(Fn)` field then releases what the inner closure captured.

**The first attempt did this in `generate_drop_code_for_value` itself**, which
looks like the more general fix and is not: it releases a closure-typed slot at
EVERY drop site, including the many whose captures are already released by a
synthesized capture-dispose. That is a double release — a
**heap-use-after-free in `__yo_decr_rc`**, which macOS ran green and the Linux
ASan leg caught on this very file's "Test closure with Impl that captures Rc
object" and "Test closure captured Rc survives nested early return".

The spawn wrapper is the one place that owns a heap COPY of a capture struct
and is the only thing that will ever release it, so it is the one place the
resolution belongs. (memory `leak-gates-need-a-dispose-counter`: a leak is
invisible without a counter, and an over-release is invisible without ASan —
this change needed BOTH oracles, and only had the first.)

## What is left — a SECOND defect in the same measurement

The walk fix above is necessary and lands the `Thread(T).spawn` case, but it is
not sufficient for the other three rows, which turn out to be a DIFFERENT bug
sharing the same oracle: **a closure literal's capture-struct temp is never
dropped.**

```c
__capture_closure_…_0 = (…){ .tracked = __yo_incr_rc_atomic(tracked) };  // +1
run_it(__capture_closure_…_0);
__yo_decr_rc_atomic(tracked);                                            // -1 (the LOCAL)
// the temp's +1 is never released
```

Compare the same shape with a plain `ref` struct temp, which is handled
correctly — `take_it(_Tracked(tag : i32(7)))` emits a scope-end
`__yo_decr_rc_atomic` on the temp. The closure literal's capture struct is an
owning temp exactly like it, and does not get one.

This is squarely in the dup/drop area the pitfalls file warns about: the
capture-struct dup must NOT be cancelled against the capturing scope's drop
(`_search_dup_calls` skips closure-definition nodes carrying deferred dups —
`issues/fixed/spawn-closure-captures-never-dropped-leak.md`), because the
capture struct can outlive the capturing scope. The missing piece is the temp's
OWN release on the paths where it does not.

It is pre-existing and reproduces identically on v0.2.29, v0.2.30 and v0.2.31,
so it is not a regression from this work. Its red-first tests are written and
parked (they assert exactly one dispose, so they catch both the leak and an
over-release) — they land with the fix, not before.

**Where the fix goes.** The temp is emitted as a raw C declaration by
`_generate_closure_capture` (`src/codegen/exprs/closures.yo`, the
`__capture_<fid>_<n>` line), entirely outside the evaluator's deferred-drop
bookkeeping — which is why it has no scope-end release *by construction*, while
an ordinary owning temp of the same shape does. Two measurements pin the scope
of the missing case: a plain `ref` struct temp passed by value IS released, and
so is a VALUE struct temp carrying an RC field. Only the capture struct is not.

**Why it is not a one-liner.** The capture struct must NOT be released where it
is MOVED rather than copied. `_generate_spawn_call` is exactly that case — its
own comment says "NO dup is added at the call site to match. The heap copy is a
shallow copy of the call-site struct, so it INHERITS that struct's references"
— and the io.async state machine is another. A release added without
distinguishing those turns this leak into a use-after-free, so the change needs
the dup/drop emit-diff gate plus an OVER-release canary per consumer, not just
the dispose counters.

## Tests

`tests/closure.test.yo`:

* a closure local's captures are disposed exactly once at scope end;
* a closure captured by another closure is disposed exactly once;
* the no-closure baseline still disposes exactly once.

`tests/thread.test.yo`'s three existing spawn dispose-counter tests cover the
`Thread(T)` wrapper shape.

## The complete fix (2026-09-28)

The memory campaign's exact Linux heap census (§0.19) found the unreachable
LEAK group at `check src/main.yo` exit: 1.49 M objects, 129.5 MB. It was 38
whole `ExprInfoTable` maps, with everything their `ExprInfo`s pin. A new
refcount-balance trace (`alloc_site_census_t.py --rc-balance`,
`rc_balance_report.py`) showed two sites taking a table reference that no
freed table ever passed through:
- `evaluate_anonymous_function_implementation`: the closure
  `(e) => expr_info_table_get(info_tbl, …)` passed to `analyze_await_points`;
- `analyze_await_points`: the `dyn((expr, …) => detect_await_expr_(…, get_info))`
  that captures that closure.

This is the defect recorded above, in the compiler's own code. The minimal
repro (`Payload` with a `Dispose` counter, and
`(c : Impl(Fn(x : i32) -> i32)) = ((x : i32) => (x + p.n))` in an inner
block) reads 0 disposes on every published seed from v0.2.29 to v0.2.44.

Three defects, each fixed:

1. **Closure values were invisible to drop and dup.** A closure's static type
   is its `Impl(Fn)` SomeT. `generate_drop_code_for_value` /
   `generate_dup_code_for_value` fell to their `true => ""` arm for it, while
   the evaluator did schedule the closure local's scope-end drop
   (`owning=true`). Both now resolve a bound closure identity to its capture
   struct (`_closure_value_type`, `src/codegen/exprs/drop_dup.yo`), so a
   closure releases and retains field by field like any value struct. Both
   walks change together. The 2026-09-12 attempt changed only the drop, so a
   copy (`closure2 := closure`) had two releasing owners and one reference,
   which is the heap-use-after-free ASan caught then. There is no
   "synthesized capture-dispose": the declaration hooks for one are no-ops.
2. **Each capture was retained twice when the closure was bound.**
   `emit_deferred_dup_or_code` recognised a closure construction, whose dups
   the closure emitter already writes into the capture struct's initializer,
   but still emitted them a second time as statements. It now returns the
   construction's code.
3. **A closure literal passed as an argument had no owner.** The capture
   struct temp was a raw C declaration outside the deferred-drop
   bookkeeping. A sync closure whose capture struct holds RC now gets an
   owning temp typed as that struct (`attach_temp_variable_to_expr`, at the
   end of `evaluate_anonymous_function_implementation`), and the capture
   temp takes that name (`generate_closure_construction`). A borrowed argument
   is released at the scope end; a binding, owning parameter or return
   consumes it. io.async closures keep their state-machine ownership.

That third change made the MOVE described under "Why it is not a one-liner"
unsound. `_generate_spawn_call`'s heap copy inherited the call-site struct's
references, and ASan reported a heap-use-after-free on every
`tests/thread.test.yo` case. The heap copy is now a second owner: it retains
its fields (field-wise when the struct has no dup method), and the spawn
wrapper's `_emit_capture_drop_lines` releases them when the thread ends.

Tests (`tests/closure.test.yo`, all asserting exactly one dispose, so a leak
and an over-release both fail): a closure local, a copied closure, a closure
literal passed as an argument (unused and called), a closure local passed as
an argument, a closure captured by another closure (local and through a
parameter), and a closure captured by a `Dyn` closure field. All six fail on
the develop compiler. After the fix they pass under ASan, and so do six
older tests in the same file that LeakSanitizer had been failing on this
defect ("anonymous closure value with Impl that captures Rc object", both
generic-impl-method capturing-closure tests, "a container of a closure
type…", and the two closure-list tests): 24/24.
`tests/thread.test.yo` stays 19/19 under ASan.
