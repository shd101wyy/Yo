# Static-argument inference, then `Box.new`/`Rc.new`/`Arc.new` replace `box`/`rc`/`arc`

**Status: BACKLOG, decided 2026-10-23 by the maintainer** ("let's do what the advisor suggested and let's remove
box/rc/arc eventually"). Nothing is built. Background and the case for and against:
`issues/retired/2026-10-23-should-box-rc-arc-be-constructed-with-new.md`. Placement: the rule (Generation A) at
v0.2.72; the migration and the sweep (B1, B2, B4) at v0.2.73, with the builtins still present; their deletion (B3)
at v0.2.74; the migration retired at v0.2.75 (`plans/handover/VBD_RELEASE_SCHEDULE.md`; §6 below). Facts measured
on develop `54e94f11e` with the v0.2.68 seed.

## 1. What holds today

- **Decision 32** (`plans/VALUES_BY_DEFAULT.md`, "decision 32, Generation A"; #1241) infers an unapplied type
  constructor's arguments from the first argument only. Hook: `_infer_unapplied_ctor_receiver`
  (`src/evaluator/calls/function.yo:1191`, called at `:11150`). It runs before any method lookup, so it decides even
  for a method that has no `self`.
- **Probes** (`yo check`, v0.2.68):

  | Source | Result |
  | --- | --- |
  | `Pair.mk(i32(2))`, `mk : (fn(a : A) -> Self)` on a generic `Pair(A)` | E0613 "… which has type `i32`, not an instance of `Pair`" |
  | `Rc.new(i32(1))` | E0613 (raised before the lookup; `Rc` has no `new`) |
  | `Rc(i32).new(i32(1))`, `Box(i32).new(i32(1))` | E0610 `No method "new" on Rc(i32)` / `on Box(i32)` |
  | `Pair.mk(q)` with `q : Pair(i32)` | E0601 "Cannot unify incompatible types: "i32" and "Pair(i32)"": decision 32 bound `A := i32` from the receiver |
  | `Rc.new(r)` with `r : Rc(i32)` | E0610 `No method "new" on Rc(i32)`: decision 32 bound `Rc(i32)` |
  | `(xs : ArrayList(i32)) = ArrayList.new()` | E0613 "… and this call has none" |
  | `Rc(ArrayList(i32)).new()` | E0610: a static call does not forward through `Deref`, so adding `Rc.new` changes no existing meaning |
  | generic `f(i32(1), u8(2))`, `f : fn(generic(T), a : T, b : T)` | E0601 "Incompatible types for generic parameter "T": it is i32 from argument 1 but u8 from argument 2" |

- **`box`/`rc`/`arc`** are generic prelude functions (`std/prelude.yo:9966`, `:9763`, `:10108`) with an optional
  `alloc : Option(Allocator)`. `Rc`/`Arc` are `ref`/`atomic(ref)` structs built as `Rc(V)(value)`; `Box(V)` is a
  `newtype(_cell : *V)`.
- **Call sites** (regex `(?<![A-Za-z0-9_.])(box|rc|arc)\(`, comments and strings included):

  | Area | Lines | Calls | Files |
  | --- | --- | --- | --- |
  | `src/` | 1,045 | 1,065 | 115 |
  | `std/` | 27 | 27 | 6 |
  | `tests/` (15 cli fixtures among them) | 966 | 1,043 | 132 |
  | `docs/en-US/`, `docs/zh-CN/` | 83 + 82 | 94 + 93 | 10 + 9 |
  | `.github/` (2 skill cheatsheets, 3 instruction files, 1 workflow comment) | 22 | 25 | 6 |

  By name across src/std/tests: `rc` 1,938, `arc` 108, `box` 89. Eleven pass `alloc :`. None is a function value.
  `markdown_yo` has none. Of src's 1,045 lines, 29 are `//` comments and 6 sit in string literals, among them the
  `yo explain E0919` examples (`src/diagnostics_registry.yo:713`/`:714`, `count := rc(i32(0))`), which
  `tests/internal/diagnostics_registry_examples.test.yo` compiles. These counts are a 2026-10-23 snapshot: V4's
  `AstExpr` (v0.2.72) adds about 1,300 `rc(` constructions to src before Generation B runs
  (`plans/VALUES_BY_DEFAULT.md`, "Constructors").
- **Where the compiler names them:**
  - `src/evaluator/values/dyn.yo:1148` and `:1235` synthesize a call to an atom named `rc` (or `arc` for a Send
    `Dyn`) around a payload that is not an object.
  - `dyn.yo:991` recognizes `dyn(rc(<closure>))` by the call head, through
    `shared_cell_type_name_of_constructor` (`src/types/guards.yo:407`).
  - `src/types/guards.yo:367`: `SharedCellNames(type_name : "Rc", constructor : "rc")`.
  - `src/evaluator/effects/mutation_summary.yo:3507` is **not** a name match. `"rc"` is the handle-kind label of
    the `YO_AUDIT_RC_WRITE` census, compared at `:3584`, and it can stay.
  - Text that names them without matching: the user-facing message at `dyn.yo:267` ("…or \`arc(v)\`") and the C
    comment at `src/codegen/exprs/dyn.yo:103` ("use rc() for value types").
- **A user `rc` is an error today:** `tests/rc_binding_gives_way.test.yo` pins that a module-level or local
  definition of `rc` collides with the prelude, while a parameter or pattern binding wins.

## 2. The rule

`G.m(a1, …, an)`, where `G` evaluates to a comptime function returning a `Type` (an unapplied constructor), is
`G(A1, …, Ak).m(a1, …, an)`. The `Ai` come from the method's declaration:

1. **Find `m`.** The candidates are every impl, inherent or trait, whose receiver is an instance of `G` by
   constructor identity (decision 32's `_instance_constructor_fid`) and which declares `m`. Each candidate has the
   impl's binders (`GenericImplEntry.forall_some_types`; none for an impl on a concrete `G(i32)`) and the receiver
   pattern that `Self` stands for. On an index miss, the pending impls of `G`'s head name are forced
   (`force_pending_impls_for_type_name`, as `_try_find_receiver_method` does at `function.yo:1057`) and the index
   is read again, so an `impl` placed below the call is found (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md` §4.4).
   If no candidate exists, decision 32's behavior stands unchanged: E0610 names the instance when the first
   argument is one, otherwise E0613.
2. **The precedence is the method's own form.**
   - **A method whose first parameter's declared type is `Self`**, under any label or mode (`self : &Self`,
     `self : &mut Self`, `self : Self`, `sink(self) : Self`, `comptime(self) : Self`, `lhs : &Self`), keeps
     decision 32 unchanged. Yo does not reserve the label `self`: trait and operator methods spell it `lhs`
     (`std/prelude.yo:505`, `:1099`). The first argument is the receiver, and nothing else is consulted.
   - **Any other method** is a static method, and every argument is consulted (step 3).
   - Decision 32's fast path stays first: when the first argument is an instance `G(A…)`, the method is looked up on
     `G(A…)`. The binding is kept only if the method found there takes `Self` first. A static method found there
     makes the binding void, and step 3 runs. Nothing found there also voids the binding, and step 3 runs; E0610
     naming the instance is raised only when step 3 has no candidate either. So `Rc.new(some_rc)` with
     `some_rc : Rc(X)` is `Rc(Rc(X)).new(some_rc)`, as Rust's `Rc::new(rc)` is `Rc<Rc<X>>`, and `Pair.mk(q)` above
     becomes `Pair(Pair(i32))`. The receiver's ExprInfo is overwritten only after the choice is made, never
     before. Today's hook writes it before `_try_find_receiver_method` runs (`function.yo:1191`, the lookup at
     `:11151`), so the hook consults the candidate index itself (§4).
3. **Bind from the arguments.** Match arguments to parameters by position and label, as argument matching does.
   An argument is consulted when its parameter's declared type mentions one of the candidate's binders, directly or
   through `Self`:
   - The argument is evaluated once, with no expected type, as decision 32 evaluates its receiver. Its id is marked
     pre-evaluated for the call (decision 32's mechanism, widened from one id to a list).
   - Its type is unified into the parameter's declared type by `synthesize_types`, the matcher that
     `try_match_generic_impl` (`src/evaluator/values/impl.yo:1399`) already runs for receiver patterns, in a
     unification frame holding the candidate's binders. Nesting comes from that matcher: a parameter
     `xs : ArrayList(T)` given `ArrayList(String)` binds `T := String`, `p : *T` and `o : Option(T)` likewise, and
     `Rc.new(ArrayList(HashMap(String, TypeValue)).new())` binds `T := ArrayList(HashMap(String, TypeValue))`.
   - A comptime integer or float literal binds its default type (`i32`, `f64`), as a generic function's binder
     does: `Rc.new(42)` is `Rc(i32)`, like `rc(42)`.
   - **Not consulted:** a closure literal, an enum shorthand `.X`, an argument left to its default (`alloc`), and a
     parameter whose type mentions only the method's own `generic(...)` binders. These arguments are evaluated
     afterwards, under the instantiated parameter type, as the written `G(A…).m(…)` evaluates them. A method's own
     binders are inferred afterwards, as today.
   - A comptime VALUE parameter of the constructor (`comptime(N) : usize`) is bound only through a type that
     mentions it, such as a parameter `a : Array(T, N)`. A comptime argument's value never binds it.
   - After the arguments, the candidate's where-pass runs as `try_match_generic_impl` runs it
     (`src/evaluator/values/impl.yo`, after `:1541`). It may bind a binder that only a bound mentions
     (`impl(generic(I, A), where(I <: Iterator(Item := A)), MyWrap(I), …)`). A candidate whose where-clause fails
     drops out, because coherence allows inherent impls over different bounds.
4. **Outcome.**
   - **Every binder bound:** the receiver becomes `.TypeVal(G(A…))` and the call proceeds as `G(A…).m(…)`. That
     covers lookup, `Self`, where-clauses and codegen's static dispatch. When every candidate's where-clause
     failed and exactly one candidate existed, that failure is reported as the bound's own error
     (`Arc.new(non_send)` fails the `Send` bound, not E0613). The AST is not rewritten, so a generic body
     infers again per specialization (decision 32's reason).
   - **A conflict:** E0601 in the generic-function wording, naming the constructor ("Incompatible types for type
     parameter "A" of `Pair`: it is i32 from argument 1 but u8 from argument 2").
   - **A binder no consulted argument mentions:** E0613 naming the binder, with the help
     `` write the type arguments: `Pair(…).m(…)` ``. Examples: `Rc.new(.None)`, `Lazy.new(() => 1)`, and a binder
     that appears only in the result. A call with no arguments at all keeps decision 32's "… and this call has
     none" text, so `Rc.default()` (which `Rc`'s `Default` impl makes a candidate) reads as it does today.
   - **Several candidates succeed** (two impls on `G(i32, B)` and `G(u8, B)` both declaring `m`): E0613 "ambiguous",
     listing the impl sites.
5. **The expected type is never consulted for `G`'s arguments.** This is decision 32's "whenever we could be
   explicit, do explicit". Aliases and partial applications stay constructors of their own (decision 32).

**Non-goals.**

- A zero-argument call, `ArrayList.new()` or `Rc.default()`, stays E0613. Inferring `G`'s arguments from the
  expected type is a separate, larger decision, and this plan does not open it.
- A closure-only binding (`Lazy.new(() => 1)`) stays E0613 for the same reason. Its return type is a kind of
  expected type.
- `Rc.new` used as a value (`xs.map(Rc.new)`) is not a call, and this rule does not cover it: write `Rc(T).new`.
  Today `f := Pair.mk;` fails with "Failed to evaluate, got (Pair.mk)" and no code (v0.2.68). The tree has no
  `rc`/`box`/`arc` used as a value (grep 2026-10-23), so B1 meets none.
- `Rc(V)(value)`, the raw `ref`-struct constructor call (192 lines, regex), is untouched. V5 Generation B decides
  its fate when `ref` leaves the parser.

## 3. Tests

Generation A creates and updates these:

- **`tests/static_argument_inference.test.yo`** (new):
  - `Pair.mk(i32(2))` is `Pair(i32)`, and `_Pair.make(i32(1), true)` is `_Pair(i32, bool)`.
  - Nested binders: `ArrayList(T)`, `Option(T)`, `*T` and `&T` parameters.
  - Literal defaulting: `Rc.new(42) : Rc(i32)`.
  - `Pair.mk(q)` is `Pair(Pair(i32))`; it was E0601.
  - The conflict E0601 text, and the unbound-binder E0613 naming `B` for a binder no argument mentions.
  - `Rc.new(.None)` and a closure-only call are E0613 with the written-arguments help.
  - The two-impl ambiguity, a module-qualified constructor (`mv.Cell.new(x)`), and one generic body specialized
    twice.
  - A where-clause failure is the bound's error; two inherent impls over different bounds select by where-clause;
    a binder only a where-clause mentions is bound.
  - An `impl(Pair(A), mk2 : …)` placed below its call is found (lazy impls).
  - A trait method whose first parameter is `lhs : &Self` keeps decision 32.
  - `ArrayList.new()` and `Rc.default()` stay E0613, even under an annotated binding.
- **`tests/unapplied_constructor_method.test.yo`:** "a static method has no receiver to infer from (E0613)" flips to
  inference for `_Pair.make(i32(1), true)` and keeps `Rc.default()` as E0613 with its "this call has none" text
  (§2 step 4). The receiver cases stay as they are, including `Rc.clone(i32(1))` and `Arc._handle(r)`. The file's
  header comment (lines 5-7) states the old rule and is rewritten.
- **`tests/handle_constructors.test.yo`** (new):
  - `Rc.new`, `Box.new` and `Arc.new`, with `alloc : .Some(a)` placed into an arena and the scope restored, the
    cases `tests/rc.test.yo`/`tests/arc.test.yo` pin for `rc`/`arc`.
  - `Rc.new(some_rc) : Rc(Rc(i32))`.
  - `dyn(Rc.new(<closure>))` contextually types the closure, as `dyn(rc(<closure>))` does.
  - `dyn(i32(1))` still builds through the synthesized cell, now `Rc(i32).new`.
- **Explain text:** `E0613` in `src/diagnostics_registry.yo:899` (both languages) states the rule. The `explain-list`
  cli golden is unaffected, because the one-line summary does not change.
- **Statements of the old rule**, rewritten by A1: decision 32's "Static methods" bullet in
  `plans/VALUES_BY_DEFAULT.md` (amended with a date, not deleted); `docs/en-US/DESIGN.md` (line 1058 and the
  example comment at 1073) and `docs/zh-CN/DESIGN.md` (1021, 1036);
  `.github/instructions/yo-syntax.instructions.md:532`; `.github/skills/yo-syntax/syntax-cheatsheet.md:192`; the doc comment at `function.yo:1176-1180`. The cheatsheet
  edit moves the 7 skill-copy cli goldens (§5 B2 lists them) at A1 already.

Generation B creates and updates these:

- **`tests/internal/diagnostics_registry_examples.test.yo`** runs in B2's Tier 1: it compiles the E0919 examples,
  which B2 rewrites by hand (the `bad` example must still fail with exactly E0919, the `good` one load clean). No
  cli golden pins an explain example; `explain-list` prints summaries only.
- **`tests/handle_builtins_removed.test.yo`** (new, B3): `rc(x)`, `box(x)` and `arc(x)` are E0401 with the help naming
  `Rc.new(x)` and the migration. A user definition named `rc` is now an ordinary name.
- **`tests/rc_binding_gives_way.test.yo`:** rewritten at B3. The collision with a prelude `rc` no longer exists.
- **The cli case `tests/cli-cases/fix-migrate-handle-ctors/`** (B1):
  - plain, nested (`rc(rc(x))`) and `alloc :` sites;
  - a parameter named `rc` that must not be touched;
  - `dyn(rc(x => …))`;
  - `rc(.None)` under an annotated binding, rewritten to `Rc(Option(i32)).new(.None)`;
  - `rc(` inside a comment, left alone.

## 4. Cost budget

Measured against `scripts/bootstrap/memory-ratchet.tsv` at its 2026-10-23 baselines: `check_src_main_max_rss_kb`
1,159,212, `check_src_main_alloc_calls` 1,961,432,937 and `compile_src_main_peak_kb` 3,317,216.

- **Candidate lookup** is an index `(constructor fid, method name) → candidates`. It is rebuilt lazily when the
  trait-impl epoch moves (`bump_trait_impl_epoch`), never by scanning every bucket per call.
- **Generation A (A1).** Decision 32's fast path gains one lookup. The hook (`function.yo:1191`) writes the
  receiver's ExprInfo before `_try_find_receiver_method` runs (`:11151`), so deciding before the overwrite means
  the hook consults the candidate index itself. Only src's unapplied-constructor calls (`Rc.clone(`, `Box.clone(`,
  …) take this path. Budget: alloc calls within ±0.1%, RSS unchanged.
- **Generation A (A2):** `rc`/`box`/`arc` forward to `new` for one generation, which adds one specialization per
  distinct payload type. Budget: +0.5% alloc calls.
- **Generation B** moves every src site counted at the time of B from a generic call to the rule: 1,065 on
  2026-10-23, plus V4's ~1,300 `AstExpr` constructions from v0.2.72. The budget below is recomputed from the
  B1 dry run's count. Before the sweep, a generated file of
  2,000 `rc(…)` sites is measured against the same file spelled `Rc.new(…)` (`/usr/bin/time -v`, the
  `eval_work_ratchet.sh` shim), and the per-site delta is multiplied out. Budget for the sweep PR: alloc calls ≤ +1%
  (≈19.6 M), RSS ≤ +1% (≈11.6 MB), compile peak ≤ +1%, wall time of `check ./src` ≤ +2%. Over budget, the candidate
  index is memoized per call site before the sweep merges, rather than re-baselining.

## 5. Rollout and seed gating

`src/` and `std/` are compiled by the previous release, so std or src may spell `Rc.new(x)` only after a published
seed carries the rule. There is a second gate. **The seed's `dyn` synthesis names `rc`/`arc` and looks them up in
the tree's prelude**, and src has such sites (`analyze_await_points`'s closure). So the tree may delete `rc` only
after the seed no longer synthesizes it. A third gate comes from the migration itself: `handle-ctors` types an
old call through the prelude's `rc`, so every release that ships the mode must still carry the builtins (B3 below).

**Generation A: compiler and std additions; no src or std call uses them.**

- **A1, the rule** (§2): the explain text, E0613 and E0601 wording, the tests, and the rewritten statements of the
  old rule (§3).
- **A2, the constructors.** Std adds `impl(generic(T), Rc(T), new : (fn(sink(value) : T, (alloc : Option(Allocator))
  ?= .None) -> Self)(…))`, and the same for `Box` (no `sink`, as `box` today) and `Arc` (with
  `where(T <: (Send, Sync))`). The bodies move from `rc`/`box`/`arc`, which forward to them with written type
  arguments (`Rc(V).new(value, alloc : alloc)`) until Generation B, so a seed without A1 accepts them. This is a
  Generation A transition, not a kept alias. It is plain Yo, but `rc`'s body is seed-sensitive: the seed's `dyn`
  synthesizes `rc` around src payloads, and #1547's first build failed on the v0.2.68 seed for that reason. Gate
  A2 with a seed-built stage 1 (`yo build --std-path ./std`).
- **A3, the compiler's own spelling.**
  - `dyn.yo:1148`/`:1235` synthesize `Rc(T).new(x)`/`Arc(T).new(x)` with the cell type already computed there as a
    `TypeVal` receiver. No name lookup remains, so a user binding named `rc` can no longer capture the synthesized
    call.
  - `dyn.yo:991` recognizes `Rc.new(<closure>)` and `Rc(T).new(<closure>)` beside `rc(<closure>)`. For the
    unapplied form it sets the receiver's ExprInfo to `.TypeVal(Rc(W))`, the cell type it already computes with
    `_create_box_type_via`, before evaluating the call, because §2 step 5 bars the expected type and step 3 does
    not consult a closure. Recognizing the call alone would leave `Rc.new(<closure>)` at E0613.
  - `SharedCellNames.constructor` gives way to a method-name check.
- **Emitted C.** A2 and A3 change the emitted C (`new` instead of `rc` in names). They merge first in the v0.2.72
  window, before decision 43 step 1 takes its no-C-change emit-diff baseline, and so before V5 Generation A, which
  is serialized after step 1 and then rewrites the `new` bodies onto `__yo_cell` instead of `rc`'s.

**Generation B, on a seed carrying A1–A3.**

- **B1, `yo fix --migrate handle-ctors`.** The recorder follows `dyn-spelling`'s (`src/expr_info.yo:3196`): sites
  with `path, row, col, expect`, the source text matched before any edit. The evaluator records each call whose head
  resolves to the prelude's `box`/`rc`/`arc` (so a parameter or local `rc` is skipped). That resolution needs the
  builtins, which is why B3 waits one release (`dyn-spelling` works the same way: the old form is still understood
  while the mode runs, `src/main.yo:3363-3375`).
  - The callee token is rewritten, `rc` → `Rc.new`, `box` → `Box.new`, `arc` → `Arc.new`. The arguments are kept,
    `alloc :` included, as a named argument.
  - Where §2 step 3 would not consult the argument (a closure literal outside `dyn(…)`, an enum shorthand), the
    migration writes `Rc(V).new(`, with `V` printed from the type the old call bound.
  - Syntactic count of those forms today: 9 `.X`, 13 closures and 14 literals. Literals need no type unless the
    old call took a non-default type from the expected type. The dry run reports the exact count in the PR.
- **B2, the sweep.** The mode runs over `src/`, `std/` and `tests/` (with the 15 cli fixtures). `yo fix` takes only
  `.yo` paths (`src/main.yo:3646`) and the evaluator records calls only, so a scripted text pass, checked by hand,
  covers the rest, as earlier migrations did (`plans/VALUES_BY_DEFAULT.md:5724`):
  - the Markdown: both doc trees, the two skill cheatsheets
    (`.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`, `.github/skills/yo-syntax/syntax-cheatsheet.md`),
    the three instruction files and the `.github/workflows/test.yml:2301` comment;
  - src's 29 `//` comment lines;
  - the string literals: the E0919 explain examples (`src/diagnostics_registry.yo:713`/`:714`), the message at
    `src/evaluator/values/dyn.yo:267` and the C comment at `src/codegen/exprs/dyn.yo:103`.

  The skill edits move 7 cli goldens (`init`, `init-build-test`, `init-cwd`, `init-existing`, `skills-install`,
  `skills-install-zh`, `build-stamp-dotted-dir`), and the fixture edits can move their own goldens' columns. Read
  each GOLDEN-DIFF before `--record`. The PR's Tier 1 adds `tests/internal/diagnostics_registry_examples.test.yo`.
  The six README example projects are re-grepped and migrated with the same mode on the v0.2.73 release.
- **B3, the removal, one release after B1/B2.**
  - Delete the prelude's `box`, `rc` and `arc` and their exports. Remove the `rc(<closure>)` recognition and the
    `constructor` field.
  - E0401 on `rc`/`box`/`arc` gains the help "`rc(x)` is `Rc.new(x)`" and a structured repair that rewrites the
    token. That repair is a per-diagnostic repair, so it survives v0.2.75. Until v0.2.75 the help also says "or run
    `yo fix --migrate handle-ctors` with v0.2.73", the last release whose mode can type the old calls; the token
    repair cannot print a `V`, so a closure or `.None` site it rewrites then meets E0613's written-arguments help.
  - No alias is kept, following the no-backward-compatibility policy.
- **B4, "`new` means an empty collection".** A grep on 2026-10-23 finds no doc or skill sentence that says so. What
  exists is `ArrayList(T).new()`'s `ensures(r.len() == usize(0))`, which stays true. B2 re-greps (`\bnew\b` near
  "empty" in `docs/`, `.github/`) and rewords any hit to "`new` is a type's primary constructor; a collection's
  `new` builds an empty one" (both languages).
- **Retirement:** v0.2.75 removes the `handle-ctors` mode with the others, if its B1/B2 shipped by v0.2.74;
  otherwise it retires one release after it ships (§6). E0401's token repair stays, and its help drops the
  `--migrate handle-ctors` clause.

## 6. Placement

| Piece | Release | Why |
| --- | --- | --- |
| A1–A3 | **v0.2.72** (cadence; off the critical path), A2/A3 first in the window | v0.2.70 is a short seed release. Any piece merges once its Tier 1 passes (§5c decision 20). Shipping A in v0.2.71 would give B one release of slack, but v0.2.71 is the heaviest window and carries B12's `Dyn` changes beside A3's `dyn.yo` edits, so A targets v0.2.72. A2/A3's C change lands before step 1's emit-diff baseline (§5). |
| B1, B2, B4 | **v0.2.73**, as the first PR of its window, on the v0.2.72 seed | B needs a seed with A1–A3, and v0.2.72 is the first. The builtins stay in this release so that the published mode can still resolve and type old calls. The README projects are migrated with v0.2.73. K7's docs sweep (v0.2.74) then reads the final spelling, and V5 Generation B rewrites only the `new` bodies. |
| B3 | **v0.2.74**, on the v0.2.73 seed | One release after the mode ships, so v0.2.73 is a published release whose mode works. B3 is a deletion and a diagnostic, small beside W6b's risk in the same release. |
| `handle-ctors` retired | **v0.2.75** | with every other mode |

- **If any of A1–A3 misses v0.2.72**, B1/B2 move to v0.2.74 on the v0.2.73 seed and B3 rides v0.2.75 with the
  retirement. The mode then ships in v0.2.74 only, and the README projects are migrated with v0.2.74.
- **If A misses v0.2.73 too**, B leaves the campaign for §7 "Out of the campaign" of the schedule. It adds no VBD
  cut, and its migration then retires one release after it ships.
- **Collision with decision 43 steps 2 and 3** (v0.2.73), which edit src, with V4 `EvalValue` in the same window,
  and with V5 Generation A if it slips to v0.2.73: B is mechanical. On a conflict, the migration is re-run on the
  rebased tree and nothing is hand-merged. B touches call heads only, and `--migrate deref` (step 2) touches `.*`,
  so the two rewrites commute.

## 7. Open measurements

- The B1 dry-run count of sites that need written type arguments (§5). If it is large, reopen expected-type
  inference as its own decision rather than widening this rule.
- An LLM authoring probe: does a model write `rc(x)`, `Rc.new(x)` or `Rc::new(x)` unprompted? This informs the
  E0401 help wording only.
