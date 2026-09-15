# A generic `io.async` fn whose Future result CONTAINS `T` emits the unsubstituted type beside the substituted one

**Status:** OPEN.
**Found:** 2026-09-14, writing `with_deadline` for `std/async` — the last
actionable row of `plans/backlog/ASYNC_DEADLINE_COMBINATOR.md`. It is the third
defect standing between that plan and a working combinator, after the two fixed
in `issues/fixed/an-async-closure-capturing-a-future-parameter-emits-a-nested-typedef.md`.
**Severity:** blocks the whole shape "a generic async function that returns
something built from `T`", which is what almost any async combinator is.

## Symptom

The combinator, written as the awaitable twin of `std/async`'s `timeout` (same
signature, blocking poll replaced by a real `yield` suspension):

```rust
with_deadline :: (
  fn(generic(T : Type), handle : JoinHandle(T), limit : Duration, io : Io)
    -> Impl(Future(Result(T, TimeoutError), Io))
)(io.async(e => { ... }));
```

ONE call, at `T = i32`:

```
error: assigning to '__yo_t_12358778192450428604' (aka 'struct __yo_t_12358778192450428604_struct')
       from incompatible type '__yo_t_14213201662139104531' (aka 'struct __yo_t_14213201662139104531_struct')
```

and the two C types are the same type, once substituted and once not:

```c
struct __yo_t_12358778192450428604_struct { //  : Result(i32, TimeoutError)
struct __yo_t_14213201662139104531_struct { //  : Result(T, TimeoutError)
```

So the state machine's `result` slot kept the generic `Result(T, TimeoutError)`
while the caller reads `Result(i32, TimeoutError)`. A SECOND instantiation is
not required — one call is enough, which distinguishes this from
`issues/fixed/a-generic-function-returning-impl-future-t-miscompiles-at-a-second-t.md`
(same family, different trigger: that one needed a second `T`).

## A hypothesis that READING THE CODE REFUTED — do not re-run it

The obvious suspicion was the binder-site collector
`_gc_collect_binder_sites` (`src/evaluator/calls/function.yo:1411`), whose
worklist has arms for only `.SomeT`, `.FnTraitT` and `.FutureTraitT` and then
`_ => ()`. The reading was: `.FutureTraitT` pushes its output type
`Result(T, TimeoutError)`, that is an `.EnumT`, `_ => ()` drops it, so the `T`
one composite deep is never collected and never freshened.

**That is wrong, and the walk is fine.** The arm list only decides what is
pushed as FURTHER work; the sites themselves are recorded from
`somes := get_all_some_types(cur)` on every popped item, and
`_collect_some_types_into` (`src/types/utils.yo:1004`) DOES descend into
`.EnumT` variant field types, as well as `.Struct` fields, `.Tuple`,
`.TypeAppT` args, `.Array`, `.Pointer`, `.IsoT` and `.Func`. `Result(T, E)`
carries `T` as the `.Ok` variant's field type, so it is found.

Recorded because it is the FIRST place anyone will look, it is wrong, and the
cost of re-deriving it is an hour.

## MEASURED 2026-09-14 — and the exclusion is DELIBERATE

`YO_DEBUG_RRE=1` on the minimal shape
`fn(generic(T), v : T, io : Io) -> Impl(Future(Option(T), Io))`:

```
[rre] callee=_wrap old=true era=false self=<none>
      hkt=Impl : (Future[Future](Option(i32)) Io : Io)
      resolved_ret=Impl : (Future[Future](Option(T)) Io : Io)
```

The call site's expected type (`hkt`) is CORRECT — `Option(i32)`. The resolved
return keeps `T`. That is the same signature as bug 1 of the sibling doc, which
was fixed for a BARE binder; a binder one composite deep still does not resolve.

`src/evaluator/calls/function.yo:2553` is where it is decided, and the comment
above it names this exact family as an excluded hazard:

> The two recorded adoption hazards stay excluded structurally: **`-> Option(V)`
> carries its V in ENUM VARIANT FIELDS (no tyarg slots → the collector finds
> nothing)**, and the per-call closure-F family (`IterFilter(Self, F)`) keeps
> SomeTs after substitution.

```
rre_decl_tyarg_somes := ...; _collect_type_arg_somes(ret_type, rre_decl_tyarg_somes, ...);
rre_era_suspect := ((rre_decl_tyarg_somes.len() > usize(0)) && (get_all_some_types(resolved_ret).len() == usize(0)));
rre_old_wanted := (hkt_ret_binder || ((get_all_some_types(resolved_ret).len() > usize(0)) && !(type_somes_all_resolve_concrete(resolved_ret))));
```

`_collect_type_arg_somes` is NOT `get_all_some_types` — it looks only at a
nominal instantiation's TYPE-ARGUMENT SLOTS. `Option(V)` / `Result(T, E)` carry
their binder in enum VARIANT FIELD types, not in tyarg slots, so it finds
nothing and `rre_era_suspect` is false. The other arm does not fire either when
every SomeT resolves through its cell — the comment immediately above says "Do
NOT re-evaluate when the substituted result is already codegen-concrete",
because re-evaluating clobbers the per-call closure identity
(`iter_filter_closure`: three arms' returns collapsed onto one C record).

So the return type is never re-evaluated, the substituted copy keeps rendering
as `Result(T, TimeoutError)`, and it keys to a different C type than the
caller's `Result(i32, TimeoutError)` — the SAME "two C structs with identical
bodies that do not typecheck against each other" failure the comment describes
for `local_map_to`, arriving through the door that family is excluded from.

**This is therefore not an oversight to patch but a deliberate exclusion to
revisit**, which is why it must not be done casually: the exclusion exists
because the inclusive version broke two other families, both named above and
both with tests (`tests/where_clause_fn_inference`, `iter_filter_closure`).

### Fix direction, for whoever takes it

Make the era-suspect gate see a binder carried in ENUM VARIANT FIELDS, not only
in type-argument slots — i.e. widen `_collect_type_arg_somes` for this decision
only, or add a third arm keyed on "declared return is a nominal enum
instantiation mentioning a forall binder". Then prove, in this order:

1. the seven `issues/repros/generic-future-return-*.yo` shapes, INCLUDING the
   canary `-two-t-method-call.yo` that already passes;
2. `tests/where_clause_fn_inference` and the `iter_filter_closure` arms — the
   two families the exclusion protects;
3. the full fast suite.

Anything less will look green and regress one of them silently; the sibling doc
records exactly that happening.

## TRAP IN THE INSTRUMENT — `[rre]` prints the PRE-adoption value

`YO_DEBUG_RRE=1`'s line is emitted at `src/evaluator/calls/function.yo:2579`,
inside the `rre_wanted` block and immediately after `_trial_eval_ret_type_expr`.
The ADOPTION that may overwrite `resolved_ret` is ~50 lines later (the
`.Some(hkt_ty) => if(...) { resolved_ret = hkt_ty; }` arm). So

```
[rre] ... hkt=Impl : (Future[Future](Option(i32)) Io : Io)
          resolved_ret=Impl : (Future[Future](Option(T)) Io : Io)
```

does NOT show that adoption was refused — it shows `resolved_ret` before the
adoption ran. Reading it as "the evaluator computed the right answer and threw
it away" is wrong, and it was my second dead end.

Worked by hand, the adoption condition looks SATISFIED for this shape:

```yo
((get_all_some_types(hkt_ty).len() == 0)
 || (rre_old_wanted && (type_somes_all_resolve_concrete(hkt_ty)
      || (is_some_type(hkt_ty) && !_rre_mentions_binder(hkt_ty, rre_binder_ids)))))
&& !is_unit_type(hkt_ty)
```

- arm 1 fails — `Impl(...)` IS a SomeT, so the result is not SomeT-free;
- `rre_old_wanted` is true (the trace says `old=true`);
- `type_somes_all_resolve_concrete` is false — an async `Impl` return is one
  SomeT with an EMPTY resolution cell, exactly as the comment there says;
- but `is_some_type(hkt_ty)` is true and the re-evaluated type no longer
  mentions `T`, so the THIRD arm should fire and adopt `Option(i32)`.

**So the next measurement is not "was it adopted" but "what happens after".**
Add a debug print AFTER the adoption arm (or inspect `resolved_ret` at the
call's registration) and compare with what the async block records as its own
result type — the state machine's result is a DIFFERENT channel from the
function's return type, and `timeout` (the same signature WITHOUT `io.async`)
is fine, which keeps pointing there.

## Two hypotheses eliminated so far

1. the binder-site collector misses `T` inside an enum — REFUTED by reading
   `_collect_some_types_into`, which walks `.EnumT` variant fields;
2. the re-evaluated type is computed correctly and adoption refuses it —
   NOT SUPPORTED: the trace that suggested it prints before adoption, and the
   condition appears to hold.

Neither is the cause. Recording both so the next attempt starts at the third
question rather than re-running these.

## Where to actually look

Unmeasured as of this writing. The sibling doc supplies the instrument:
**`YO_DEBUG_RRE=1`** prints the resolved return type per call —

```
[rre] callee=wrap old=true hkt=Impl : (Future[Future](i32) Io : Io)  resolved_ret=Impl : (Future[Future](R) Io : Io)
```

Run it on the `with_deadline` call and compare `hkt` against `resolved_ret`. If
the evaluator's resolved return type is already correct, the loss is downstream
— in what the ASYNC BLOCK records as its own result type, which is a different
channel from the function's return type and the likelier suspect given that
`timeout`, the same signature without `io.async`, is fine.

## What narrows it

- `timeout` itself — generic over `T`, returning the same `Result(T, TimeoutError)`
  — is shipped, tested and fine. It is a PLAIN fn. The difference is the
  `io.async` body, so the state-machine result typing is the suspect, not
  generic `Result` instantiation.
- A generic async fn returning a BARE `T` is the already-fixed case above, so
  bare `T` is handled somewhere that a composite is not. The natural read is
  that the substitution is applied to the result type only when it IS the type
  variable, rather than being applied THROUGH the type.

A second probe — a generic async fn returning `Impl(Future(Option(T), Io))` —
fails EARLIER, in the evaluator, with `Cannot unify incompatible types: "i32"
and "Option(T)"`. That may be the same root cause seen before codegen or a
separate inference gap; it has NOT been narrowed and should not be assumed
identical.

## Why it has never been hit

Every combinator in `std/async` (`join_all`, `race`, `any`, `timeout`) is a
blocking-poll PLAIN fn, by deliberate design — they drive the event loop rather
than suspending. So the tree has no generic async function returning a
composite of `T`, and nothing has ever asked for one.

## What it blocks

`plans/backlog/ASYNC_DEADLINE_COMBINATOR.md` Option B. Combined with the two
defects already fixed, the picture for that plan is:

| defect | status |
| --- | --- |
| on-demand typedef emitted inside an open struct body | FIXED 2026-09-14 |
| `get_future_field_name` returned a bare name for an `.Outer` capture | FIXED 2026-09-14 |
| this one — generic async result type not substituted through a composite | OPEN |

The first two were only reachable through Option B's original
future-taking signature; this one is reached by the `JoinHandle`-taking
signature too, which is the one consistent with the rest of `std/async`. So
`with_deadline` cannot ship in either shape until this is fixed.

## The working draft

This type-checks (`yo check std/async/index.yo` — `evaluator OK`) and fails only
at the C compile described above. It is recorded here, rather than as a
`issues/repros/*.yo`, because it is a fragment meant to be pasted into
`std/async/index.yo` and would not compile standalone. The next attempt should
start from it rather than from the plan's prose.

Note the signature takes a `JoinHandle(T)`, not a future: every other
combinator in `std/async` takes a spawned handle, so that is the consistent
shape — not a way around the future-parameter defects, which are fixed.

```rust
/// `timeout`, as a FUTURE — awaitable from inside a task.
///
/// `timeout` drives the event loop itself, so calling it from within an
/// `io.async` body nests the loop and freezes every other task on it
/// (`issues/fixed/sync-await-in-plain-fn-nests-the-event-loop.md`). This is the
/// same contract with the blocking poll replaced by a real suspension, so it
/// composes with other futures:
///
/// ```rust
/// h := io.spawn(fetch(io), io);
/// r := io.await(with_deadline(h, Duration.from_secs(i64(5)), io), io);
/// match(r, .Ok(v) => use(v), .Err(_) => give_up());
/// ```
///
/// Takes a spawned handle rather than a future, like every other combinator in
/// this module — spawn at the call site.
///
/// Two costs are inherent to today's primitives and are NOT fixed here
/// (`plans/backlog/ASYNC_DEADLINE_COMBINATOR.md`): the aborted task's in-flight
/// buffers are not reclaimed, because the I/O backend has no cancel; and the
/// wait is a `yield` poll rather than a woken one. Putting the race in ONE
/// place is what makes those fixable in one place later.
with_deadline :: (
  fn(generic(T : Type), handle : JoinHandle(T), limit : Duration, io : Io) -> Impl(Future(Result(T, TimeoutError), Io))
)(
  io.async(e => {
    // Same reasoning as `timeout`: the deadline is a spawned TASK, never a bare
    // io-timer local, so the armed timer is owned on every path
    // (issues/pending-io-future-local-drop-uaf.md).
    ms := Box(u64)(u64(limit.as_millis()));
    dh := e.io.spawn(
      io.async((io2 : Io) => {
        io2.await(IO_timer.sleep(ms.*), io2);
        return(());
      }),
      e.io
    );
    (waiting : bool) = true;
    // Which arm ended the wait — the only place the two failure modes are
    // distinguishable, since `await` reports `.None` for either abort.
    (elapsed : bool) = false;
    while(runtime(waiting), {
      cond(
        handle.is_finished() => {
          waiting = false;
        },
        dh.is_finished() => {
          handle.abort();
          elapsed = true;
          waiting = false;
        },
        true => e.io.await(yield(e.io), e.io)
      );
    });
    // Consume the deadline handle exactly once; the abort cancels a still-armed
    // timer so this returns immediately when the task won.
    dh.abort();
    dh.await(e.io);
    match(
      handle.await(e.io),
      .Some(v) => .Ok(v),
      .None => cond(
        elapsed => .Err(TimeoutError.Elapsed),
        true => .Err(TimeoutError.Aborted)
      )
    )
  })
);
```
