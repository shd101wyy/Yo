# `inout` local bindings — feasibility audit

Status: **AUDIT — decision pending (maintainer).** Written 2026-09-07 against
`develop` at `c787fdc45` (`yo 0.2.27`) and PR #461 (`std-d14-iter-pointers`).
Every "today" claim below was checked against `src/` and `std/` on that day,
not against the historical plans (`plans/archive/BORROW_EXCLUSIVITY.md` is a
v4 record and its "KEPT" table predates v4.1; do not read it as the current
rule).

## 0. The question

Can Yo support a **local reference binding**

```rust
x := i32(1);
inout(y) := x;   // y aliases x's storage
y = i32(2);
assert(x == i32(2));
```

with the same memory-safety guarantee safe code has today — and would that
let the `for` macro iterate the pointer-yielding `iter()` (D14, PR #461:
`ArrayList`, `OrderedMap`, `HashMap`, `HashSet`, `Deque`, `PriorityQueue`,
`BTreeMap`, `LinkedList` all hand out `*(T)` into their own storage) without
the user's file needing `pragma(Pragma.AllowUnsafe)`?

The form existed once (`ref(name) := lvalue`, v4) and was deleted in v4.1
because it had zero users and was the only reason the borrow-invalidation
gates and the owner pin existed. The blocker then was not "impossible" but
"machinery servicing a feature nobody used". The iterator motivation changes
that calculus, so the audit asks what the machinery *is*, place by place.

## 1. What exists today (verified)

### 1.1 The `inout` parameter model

- `inout` is not a keyword; `inout(name) : T` is a prefix call stripped in
  `evaluate_function_parameters` (`src/evaluator/types/function.yo:1181-1213`)
  into `FuncParam.is_ref` → `FuncMeta.param_is_ref`. The env binding is
  `Variable.is_ref` (`src/env.yo:195-199`), stamped only by
  `add_parameter_to_env` and the closure-param binders;
  `add_variable_to_env` hardcodes `is_ref : false` (`src/env.yo:1143`).
- Codegen: declaration `T*` (`src/codegen/functions/declarations.yo:188-196`),
  reads `(*x)` (`src/codegen/exprs/atom.yo:408-435`, `_var_read_code`),
  writes `(*x) = v` (falls out of the same path, `assignment.yo:100`),
  arguments `(&(place))` with `(&(*x))` folding for pass-through
  (`_apply_ref_amp`, `src/codegen/exprs/other_fn_call.yo:536-620`).
- Escape channels, all closed: no `inout` *type* (so no field, no generic
  payload, `y := inout_x` copies the pointee — completely ungated and
  correct); closure capture ban
  (`src/evaluator/values/anonymous_function.yo:599-620`); return-slot ban,
  four throw sites in `function.yo` (`:3689`, `:3763`, `:3800`, `:3869`);
  `inout` cannot combine with `own` or `generic`.
- Argument **place rule** `require_valid_ref_argument_places`
  (`src/types/flowability.yo:857-981`): a whole variable (any scope), or a
  field chain rooted at a local/param with no intermediate object hop, or an
  index / deref place (`xs(i)`, `b.*.f`) **only when no other argument of the
  same call can reach the container** (object/closure/raw-pointer-typed
  args, aliases via `is_owning_the_same_rc_value_as`, module-level
  containers are all rejected).
- Call-site `inout`/`own` exclusivity (`flowability.yo:619-750`). There is
  **no** gate on the same variable passed twice as `inout` (`swap(x, x)`);
  that is aliasing, not a memory-safety hole — both pointers name one live
  slot.
- No owner pin exists for `inout` args rooted in RC objects: Stage-0's
  caller-owned `+1` is explicitly gated OFF for `inout` params
  (`src/evaluator/calls/helper.yo:886-890`, `function.yo:4899-4901`).
  Soundness of `bump(h.n)` rests on the caller's *local handle* `h`, which
  the callee cannot reassign or consume (the place rule forbids module-level
  roots and object hops; the exclusivity gate forbids `own(h)` in the same
  call).

### 1.2 The local form is rejected with a teaching error

`src/evaluator/exprs/initialization_assignment.yo:159-173`, for both `:=`
and `::`:

> `'inout(name) := ...' local bindings were removed — 'ref' exists only in
> parameter position. Read and write fields directly ('h.s = v'), or bind the
> handle ('b := a.b') to keep an object alive.`

Pinned by `tests/ref_local_binding.test.yo`. Three seams from the deleted
feature are still in the tree and shaped for a return:
`FlowOptions.allow_same_frame_local` (`flowability.yo:139`, doc still names
the binding site), `Variable.is_ref`'s doc (`env.yo:196`, still says "or a
`inout(name) := ...` local"), and the codegen deref branch, which is live
even though `atom.yo:12-13,296-297` claims it is omitted.

### 1.3 FINDING F1 — the runtime borrow backstop is dead code (live UAF)

`docs/en-US/FLOWABILITY.md` says the one shape the static place rule cannot
see (container escaped into a global, then `bump(xs(i))`) is closed by the
`borrow_count` flag. In the self-hosted compiler the header field, its
zero-init and the auto-emitted `__yo_borrow_assert_unborrowed` before
`__yo_realloc`/`__yo_free` all exist, but `_emit_borrow_acquires` /
`_emit_borrow_releases` (`other_fn_call.yo:330-391`) are **never called** —
the TS compiler called them at three sites; the port kept the helpers and
dropped the calls. The count is never non-zero, so no assert can fire. The
documented reproducer asserts-fails at `-O2` and SEGVs under GuardMalloc.
Filed and FIXED the same day: `issues/fixed/interior-ref-arg-borrow-acquire-never-emitted.md` (+ repro, CLI case, release-side tests).

This matters twice: it is an open soundness hole in the *current* model, and
it is the exact mechanism any interior-borrow design below would extend.
**Wiring it is a prerequisite, not part of the feature.**

### 1.4 FINDING F2 — closure captures are by value

```rust
sum := i32(0);
run(() => { sum = (sum + i32(5)); });   // sum is still 0 afterwards
```

(verified 2026-09-07). Therefore a callback-style borrowed loop
(`coll.each_mut((inout(x)) => body)`) cannot be the `for` lowering: the body
could not update outer locals, and `break`/`continue`/`return`/effect
`unwind` would have to cross a closure boundary. The value-form `for` only
works because it is a *macro* expanding to a `while` in the caller's frame.
Any borrowed form must stay a macro expanding in-frame, which means it needs
an in-frame **binding** for the element — i.e. exactly the local `inout`
form.

### 1.5 FINDING F3 — macro expansions carry the *defining* file's privilege

A macro defined in a `pragma(Pragma.AllowUnsafe)` file may dereference a raw
pointer, and the expansion is accepted in a user file that has no pragma
(verified: `deref_in_macro(p).value` compiles and runs from a safe file; the
inline `(p.*).value` in the same file is rejected with "Pointer dereference
requires 'unsafe(...)'"). The gate keys on the token's `module_path`
(`src/evaluator/memory_safety.yo:97-107`, `auto-generated://` and the
pragma'd file both pass). So the prelude `for` **can** consume `iter()`'s
`*(T)` internally today without exposing `*(T)` to the user. That is the
enabler — and a reminder that std macros are trusted code and must be
audited like any `unsafe(...)` site.

### 1.6 Other facts the design leans on

- The `for` macro (`std/prelude.yo:8465-8534`) expands the value form to
  `it := coll.into_iter(); while(runtime(true), match(it.next(), .Some(x) => body, .None => break))`
  and rejects `inout(x) =>` with a `comptime_assert`. `IntoIterator.into_iter`
  takes `self` by value (a dup for RC collections, a copy for `Array`).
- `ArrayList.iter()` yields VALUES today (dup per element); PR #461 flips it
  to `*(T)`. After #461 every collection's `iter()` is a pointer iterator
  whose `next` takes `inout(self)` and returns `Option(*(T))` computed from
  the collection handle the iterator holds (`_list`, `_map`, `_current`).
- `LinkedListIterPtr.next` returns `&node.value` and then *advances past the
  node* (`std/collections/linked_list.yo:455-466`) — the pointer is kept
  alive only by the list's chain, not by the iterator.
- A may-mutate analysis already exists: `src/evaluator/effects/mutation_summary.yo`
  ("may a call to this function transitively mutate RC container storage
  reachable from its parameters, captures, or globals?"; MAY-analysis,
  anything unresolvable = mutates). It is used to elide Stage-0 dups.
- `xs(i).a = v` (index-then-field store through the transient Index pointer)
  works in safe code today; the transient pointer never outlives the
  statement.
- Scope-end cleanup rides `deferred_drop_expressions` + the codegen flush
  points with `emitted_deferred_drop_ids` idempotence (AGENTS.md pitfalls);
  early `return`, `break`, and effect `unwind` all pass through it. In async
  bodies every local lives in the heap state-machine struct
  (`sm->var_<id>`), so `&local` is stable across `await`.

## 2. Threat model, place by place

`inout(y) := PLACE` is a pointer to a slot. It can dangle only if the
*memory holding the slot* is freed or moved while `y` is live. Escape
channels are the same as for parameters and stay closed for free (no type,
no capture, no return, no store; copies copy the pointee). So the whole
question is the lifetime of the slot's memory, which depends on what kind of
place it is.

| # | place | slot memory | can it die while `y` lives? | needed |
|---|---|---|---|---|
| P1 | whole local / parameter `x` | frame slot (C local, or `sm->var_x` in async) | No: `y` is declared inside `x`'s scope, so `x`'s slot outlives `y`. Reassigning `x` is fine (Pascal slot semantics; `y` sees the new value). | one gate: **no `own`-consume of `x` while `y` is live** (see 2.1) |
| P2 | whole module-level variable | global | No (params already allow it) | nothing |
| P3 | field chain rooted at a local **value** struct, no object hop | inside the frame slot | No | nothing |
| P4 | field of an RC object (`h.n`, `a.b.n` through an object hop) | inside a heap object O | Yes: same-frame `h = other` / `h` consumed / callee reaching O via an alias or global and dropping the last count | **owner pin**: dup O at the binding, drop at `y`'s scope end (2 RC ops per binding, not per access), riding the deferred-cleanup lists so `break`/`return`/`unwind` release it. With the pin, even a same-frame reassign of `h` is memory-safe (`y` keeps naming the *old* object's field). Optional static "reassign-while-borrowed" diagnostic for UX. |
| P5 | element of reallocatable / shrinkable storage owned by O: `xs(i)`, `p.*` where `p` came from `iter()` into a buffer, a bucket array, or a node | heap block owned by O, or a node object N owned by O's chain | Yes, three ways: (a) realloc (`push`, `reserve`); (b) free of the block (O dies — pin fixes this one); (c) **logical invalidation**: `pop`/`clear`/`truncate`/`remove`/`insert`/`sort`/`retain` drop or move the element under `y`; a linked-list unlink frees N. For RC-typed elements (c) leaves a *released handle* in the slot — reading `y` afterwards is a UAF, not just a stale value. | pin O **and** dynamic exclusivity: `borrow_count++` on O at the binding, `--` at scope end (unwind-safe), and `assert_unborrowed(self)` at entry of every O method that may invalidate storage. Static same-scope diagnostic where the mutation is lexically visible. See 2.2. |
| P6 | rvalue / temporary (`inout(y) := f()`, `inout(y) := make_list()(i)`) | statement temp | Yes, immediately | **reject** (the place rule already requires a root atom; keep it) |

P1–P3 are "sound by construction" in exactly v4's sense and cost nothing.
P4 costs a dup/drop per binding and is sound with the pin alone. P5 is the
whole difficulty and is the one iteration needs.

### 2.1 P1 with RC-typed locals: the consume gate

`inout(y) := s` (`s : String`) then `sink(own(s))`: the slot's count moves
into the callee; `y` still points at the slot. A later read through `y`
sees a handle whose count it does not own; a later `y = other` does
`drop(old)` on a count that was already moved — an over-release. A pin does
**not** fix the second case (the drop targets the slot's count, not the
pin's). So P1 needs one static rule: a variable with a live `inout` binding
cannot be passed to an `own` parameter (or otherwise consumed). The
evaluator already tracks `consumed_at_token`; the gate is a `borrowed_by`
mark on `Variable` set at the binding and cleared at the binding's scope
end, checked in `set_expr_as_consumed`. That is the smallest piece of the
v4 "borrow-invalidation gates" and the only one P1 needs. (Reassignment
`s = other` does not need it: the assignment drops the old count and stores
a new owned one, and `y` simply names the new value.)

The same shape exists today for **parameters** (`inout(y) : String` in a
callee that does `sink(own(y))`) and should be checked while building the
gate; it is out of this audit's scope.

### 2.2 P5: what "dynamic exclusivity" has to cover

The runtime primitives exist (F1): `__yo_borrow_acquire/release` and
`__yo_borrow_assert_unborrowed`. Today the assert is auto-emitted only
before `__yo_realloc`/`__yo_free` in RC-object methods — case (a) and part
of (b). Case (c) is not covered by anything, and it is the case a loop body
hits first (`for(xs, inout(x) => { xs.pop(); ... x ... })`).

Two ways to cover (c):

1. **std discipline** — every invalidating method calls
   `__yo_borrow_assert_unborrowed(self)` (it is already a prelude builtin,
   `std/prelude.yo:98`). Precise, cheap (a same-cache-line load and a
   predicted branch), but a *missed* method is a silent UAF, and the std
   audit (`plans/STD_API_STABILIZATION.md`) is exactly the kind of sweep
   that would have to enumerate them for eight collections.
2. **compiler auto-emit from the may-mutate summary** — at entry of every
   method of a type that hands out interior borrows (any type with an
   `Iterator` impl whose `Item` is a raw pointer, or an `Index` impl), if
   `mutation_summary` says the method may mutate storage reachable from
   `self`, emit the assert. Over-approximates (a `sort` of value elements
   would panic under a live borrow even though nothing is freed), but it is
   mechanical and cannot miss a method. Reads stay free.

Either way, the guarantee for P5 is **Swift's**, not v4's: safe code cannot
touch freed memory, but a program can *panic deterministically* on a borrow
conflict instead of being rejected at compile time. Where the conflict is
lexically visible (the binding and the mutating call in the same body, no
call in between that could hide it), a static diagnostic should fire first;
the may-mutate summary makes that check a lookup per call in the borrowed
region.

Two more P5 corners:

- **Node-based collections.** `&node.value` is interior to node object N,
  not to the list's block. Pinning the *list* does not stop `list.remove`
  from freeing N; the assert on `remove` does. So for P5 the assert set is
  what protects, and the pin only guarantees the collection itself survives
  the loop. (Alternatively the iterator could yield the *node handle* and
  the binding pin N — sound with no assert at all — but that is a different
  iterator protocol and only helps node-based containers.)
- **Threads and async.** `borrow_count` is a plain `u16`; that is fine
  because Yo's parallelism API already forbids sharing a mutable container
  across threads without `Mutex`/`Iso`. A borrow spanning an `await` is
  legal under this model: another task on the same event-loop thread that
  mutates the container hits the assert (deterministic panic), and the
  release must run when the task is *aborted* (`FutureState.Aborted`), i.e.
  the state-machine cleanup path must flush the borrow release like a drop.

## 3. What it would take

Requirements, so the decision is about scope rather than mystery:

- **R0 (prerequisite, independent of the decision)** — fix F1: call
  `_emit_borrow_acquires`/`_releases` at the three call paths, with a
  regression test that the documented reproducer panics.
- **R1 parser/evaluator** — accept `inout(name) := place` in
  `initialization_assignment.yo` (replace the teaching error); run the
  existing `require_valid_ref_argument_places` logic on the RHS (same
  accepted places as an `inout` argument, minus the "other argument can
  reach the container" clause, which has no meaning here); bind a
  `Variable` with `is_ref : true`, `is_reassignable : true`,
  `is_owning_the_rc_value : false` (so scope-end drops skip the pointee);
  keep `inout(name) :: …` rejected.
- **R2 codegen** — `T* y = &(place);` via the same `_apply_ref_amp` cascade
  (fold `(&(*x))`, spill never — a spill would be a copy and must be a
  compile error, not a fallback); reads/writes already work through
  `_var_read_code`. Async: the binding is stored in `sm->var_y` as a pointer
  to another `sm->var_*` or to heap storage — verify the state-machine
  spill stores the pointer, not a dereferenced copy.
- **R3 P1 consume gate** — `Variable.borrowed_by` (or a scope-local list),
  set at binding, cleared at scope end, checked at every consume site
  (`set_expr_as_consumed` and the `own`-argument binders). Error text should
  teach: "copy the value out, or end the `inout` binding's scope first".
- **R4 P4 owner pin** — when the place's root is an RC object (or the chain
  hops through one), emit `___dup(owner)` at the binding and register the
  matching drop on the binding scope's deferred list. Same lists, same
  idempotence key, as scope-end drops.
- **R5 P5 exclusivity** — at the binding, `acquire(owner)` alongside the
  pin; release from the same deferred list before the drop. Add the assert
  coverage for logical invalidation per 2.2 (option 2 recommended: it
  cannot miss a method; the false-positive cost is a panic on a pattern the
  language would rather reject anyway).
- **R6 static diagnostic (UX)** — in the lexical region between a P5
  binding and its scope end, a call whose may-mutate summary reaches the
  borrowed container is a compile error. Not required for safety once R5
  holds; required for the feature to feel like Yo rather than like a
  runtime-checked language.
- **R7 tests** — `tests/ref_local_binding.test.yo` flips from "banned" to
  the P1–P6 matrix: P1 read/write-through and the consume gate
  (`comptime_expect_error`), P4 reassign-while-borrowed still reads the old
  object (pin), P5 push-under-borrow panics (runtime — the `yo test` runner
  has no expected-panic assertion, so this goes in `tests/cli-cases/` with a
  recorded non-zero rc + panic text) and is rejected
  statically when visible (R6), P6 rvalue rejected, async body binding
  across an `await`, `break`/`return`/`unwind` out of a borrowed region
  releases (assert the next `push` does *not* panic), and an ASan/GuardMalloc
  run of the P4/P5 cases.

Rough size: R1–R4 are a few hundred lines across `initialization_assignment.yo`,
`flowability.yo`, `env.yo`, `utils.yo` (consume) and `init_assignment.yo`
(codegen); R5's compiler half is small once R0 is done; the assert coverage
(R5 option 2) is one emission site keyed on `mutation_summary`; R6 reuses
the same summary. The seed gates the *source form* — std cannot use
`inout(y) :=` until a release that accepts it becomes the seed
(`yo-seed-gates-source-forms`), so the prelude `for` borrowed form lands one
release after the binding form.

## 4. What it buys for `for`

With R0–R5 in place, the prelude can add the borrowed form (privileged
expansion, F3), sketched:

```rust
// for(coll, inout(x) => body)
{
  __c := coll;                       // hidden local: pins the collection (P4/P5 owner)
  __it := __c.iter();                // pointer iterator (D14)
  // acquire(__c) — emitted by the compiler for the P5 binding below, or once
  // for the whole loop if the macro binds `inout(__elems) := __c` (see note)
  while(runtime(true), {
    match(__it.next(),
      .Some(__p) => { inout(x) := unsafe(__p.*); body },   // P5 binding, per element
      .None => break
    );
  });
}
```

Properties: `body` is in-frame (F2 satisfied: outer locals, `break`,
`continue`, `return`, effects all work as in the value form); the user file
never sees `*(T)`; RC elements are borrowed, not dup'd (the perf motive);
struct elements mutate in place through `x`; a `push`/`pop` on `coll`
inside the body panics at the mutating method (R5) or is rejected when
lexically visible (R6); `break`/`return`/`unwind` release through the
deferred list. Note: acquiring once per loop rather than per element needs a
"borrow the collection for this scope" binding shape (`inout(__elems) :=
__c` is P1 — a whole variable — and would not acquire); simplest is to let
the per-element P5 binding acquire and release each iteration (two
increments per element, same cache line as the RC count).

What it does **not** buy: iteration over a `HashMap` yields `*(MapEntry)`;
`inout(x)` then names the *entry*, and writing `x.key` corrupts the table.
The borrowed form needs `iter()` to yield something whose *mutable* surface
is safe (value pointers for maps, or a `MapEntry` whose key is read-only) —
a std API decision, not a compiler one.

### 4.1 Alternatives that do not need P5

- **Position iterator + index sugar** (random-access only): `iter()` yields
  `usize`; the macro rewrites `x` in `body` to `coll(i)` reads/writes —
  no pointer, bounds-checked, realloc-safe, no runtime flag. Fails the goal
  for `HashMap`/`LinkedList`/`Deque` and has no way to hand `x` to an
  `inout` parameter without materialising a pointer anyway.
- **Value form everywhere** (status quo): one dup/drop per RC element, a
  copy per struct element. Correct, zero machinery. The benchmark in the v4
  record (≤10% worst case, faster for struct copies) still stands — the
  reason to move is API uniformity and in-place mutation, not speed.
- **Callback `each_mut`**: dead (F2).

## 5. Verdict

**Feasible, and the safety argument is bounded — but it is not v4's
argument.** Split by place:

- P1–P4 (`inout(y) := x`, `:= h.n`) can be re-added with the *same*
  "sound by construction" guarantee safe code has today: one consume gate
  (R3) and one owner pin (R4). Nothing about them requires a runtime check.
  The example in §0 is P1 and needs only R1–R2.
- P5 (`inout(y) := xs(i)`, and therefore the borrowed `for`) cannot be
  made sound by construction without a borrow checker; the honest options
  are v4's (make it inexpressible — status quo) or Swift's (pin + dynamic
  exclusivity, R5, with a static diagnostic in front for the visible cases,
  R6). The runtime cost is nanoseconds per binding; the *semantic* cost is
  that a safe program can panic on `push`-during-`for`. That is a language
  stance the maintainer has to take explicitly; the previous stance
  (`BORROW_EXCLUSIVITY.md` v1 rejection: "runtime checks") said no, and
  then the F1 backstop quietly said yes for the residual — F1 is the proof
  that the project already accepted a runtime flag as the closing move.

Recommended sequencing if the answer is yes:

1. **R0 now** — the backstop is documented, half-built, and its absence is a
   live UAF regardless of this feature. Ship with the regression test.
2. R1–R4 + R7's P1/P4/P6 cases in one PR: the §0 example works; `xs(i)` is
   still rejected as a binding RHS ("bind an element by index needs the
   borrowed `for`; copy with `.get(i)`").
3. R5 (+ the assert-coverage choice) + R6 + R7's P5 cases.
4. After the seed carries 2–3: the prelude borrowed `for`, and the std
   decision on what map iterators expose mutably.

If the answer is no for P5, steps 1–2 still stand on their own: the §0
binding is safe, cheap, and removes the "second-class references exist only
at call boundaries" asymmetry — while iteration stays on the value form.

## 6. Maintainer questions (2026-09-07) and the compile-time-first layering

**"Does this mean Swift's approach? I don't want a borrow checker."** Yes to
the model (static where the conflict is visible, a deterministic runtime
check where it is not), no to a borrow checker: nothing here tracks
references across functions, and nothing needs annotations.

**"How does Hylo handle it?"** Fully statically: `inout x = &a[i]` is a
second-class projection whose live range ends at its *last use*; while it is
live, `a` is inaccessible (Law of Exclusivity), so `a.append` in the loop is
a compile error; `for inout x in &a { … }` projects the collection for the
loop. This is complete for Hylo only because Hylo has mutable *value*
semantics and no reference types — every place has one owner and every
access path is a syntactic lvalue the compiler can see. Yo's `ref(struct)`
collections are shared handles, so the in-function analysis is incomplete
by construction; Hylo's rules map onto Yo's value structs/enums exactly and
onto Yo's `ref` types the way they map onto Swift classes.

**"With a cross-function checker, would Yo need lifetimes?"** No. Lifetimes
describe references that are stored or returned; `inout` is second class,
so its lifetime is always the enclosing call/scope. What a checker needs
instead is **aliasing information about handles**: the unsafe case is a
callee mutating the borrowed container through an alias the caller cannot
see. Rust has that information from ownership (`Vec` is unique, `&mut` is
exclusive) — and for Yo's shape, a shared mutable collection
(`Rc<RefCell<Vec<T>>>`), Rust *also* checks at runtime: `borrow_mut` is the
borrow flag. The runtime check is a consequence of shared mutable handles
being the default representation, not of a weak checker.

Fully static options that keep going, honestly costed:

1. **Value-semantics collections** (Hylo's road): `ArrayList` a unique
   value, sharing through an explicit wrapper. No annotations, complete
   static story, a rewrite of std and of every program's mental model.
2. **Declared `mut` parameters + deep immutability** (v3 in
   `plans/archive/BORROW_EXCLUSIVITY.md`'s appendix): sound, zero overhead,
   one annotation; rejected because the rules compounded (derived handles,
   returns-fresh, variance). Still the only known fully static design that
   keeps shared handles.
3. **Callee mutation summaries as the gate.** `mutation_summary.yo` already
   answers "may this call transitively mutate RC container storage reachable
   from its params, captures or globals" (MAY-analysis; unresolvable =
   mutates). Using it as the admission rule for an interior borrow makes the
   global-escape shape a *compile* error. Costs: non-local diagnostics, and
   `dyn` / closure-parameter / extern callees must be rejected, not trusted.

**Recommended layering (compile-time first):**

- In-function exclusivity is static and complete (Hylo's rule; live range
  = last use, not scope end, so `push` after the last read of `x` is fine).
- Cross-function: the mutation summary decides. A borrowed call is rejected
  statically when the summary proves, or cannot rule out, a conflicting
  container mutation.
- The runtime flag guards only the summary's genuinely opaque cases (`dyn`,
  closure parameters, extern), and a strict pragma turns those into compile
  errors too for code that wants zero dynamic checks.

Under that layering the shipped runtime check is a backstop the compiler can
name at each site, not the safety story — which is the compile-time-first
stance without lifetimes, without `mut`, and without changing the
representation of collections.
