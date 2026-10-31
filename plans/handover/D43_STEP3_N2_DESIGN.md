# Decision 43 step 3 (N2): first-class storage — design, inventory and PR split

**Status: ACTIVE design note (2026-10-30), branch work in the v0.2.74 window.** The design is
`plans/backlog/REFERENCES_AND_ORIGINS.md` (O1–O10, §8 N2) and `plans/VALUES_BY_DEFAULT.md`
decision 43 step 3; this note is the PR sequence, the measured inventory and the questions the
spec leaves open. It is stacked on step 2 (N1), whose own note is the branch-local
`DESIGN.md` of the step-2 work (Fable consultation 2026-10-29, "option A on Q1–Q12"; its
verdicts are restated below where N2 depends on them). Inventory taken on the step-2 tip
`3a7c3e3cf` (`vbd/d43-step2-n1c3-p1684`, N1a + N1b + N1c-1 + N1c-3 over develop `a8e93166a`);
line numbers are that tree's.

## 0. Where step 2 leaves N2

| Piece | State on the tip | What N2 takes from it |
| --- | --- | --- |
| N1a | built | the `Origin` kind (`TypeValueNode.OriginKind`), `generic(p : Origin)`, `&(T, o)` parameter slots, `OriginSet(names, is_elided)` values, E0922 |
| N1b | built | the `Reference` result slot, `-> &(T, o)` spelled result origins (E0912 for a by-value place) |
| N1c-1, N1c-3 | built | freeze roots narrowed to the result origin; the return rule against spelled origins (E0912/E0923); impl ⊆ trait; `Fn(...) -> &T` result slots |
| N1c-2, N1c-4 | not started | E0910 call-argument overlap; A2 forwarding by substitution |
| N1d | not started | `Escapable` and its derivation, the constructor-side `Rc`/`Arc` payload check (one predicate, Q6), O9 |
| N1e | not started | references as binding types, `.*`, auto-deref, `--migrate deref` (std/src exempt until N3) |
| N1f | not started | `impl(&T, …)`, `FnMut` |

`Reference(T, mutable, origin)` exists only in SLOTS on the tip (`src/types/definitions.yo:610`:
"Only a SLOT holds one"): a parameter slot, a projection's result slot, a `Fn` slot. Everywhere
else a `&T` operand that is a type is "a borrow mode, not a type" (`src/expr.yo:851`,
raised from `src/evaluator/exprs/_expr.yo:1179,1216` and `src/evaluator/calls/helper.yo:956`),
and the three N2 spellings carry phase messages naming N2: `&(T, o)` outside a signature
(`_expr.yo:653`), `comptime(p) : Origin` on a type constructor (`evaluator/types/function.yo:2165`),
and `Dyn(Trait, p)` (`evaluator/types/dyn.yo:212`).

## 1. Settled choices (implementation consequences of the spec; no consultation needed)

| # | Choice | Why it follows from the spec |
| --- | --- | --- |
| T1 | `&T`, `&mut T`, `&(T, o)` and `&mut(T, o)` whose operand is a type evaluate to `Reference(T, m, origin)` in every type position: a field of a struct/enum/tuple, a type argument, a type alias, a composite in a signature. A `Reference` whose pointee is a `Reference` stays N1e's (reference-to-reference slots). | O4's table; decision 43 step 3 ("references sit in fields") |
| T2 | A type constructor's origin parameter `comptime(p) : Origin` binds `p` ABSTRACTLY (`OriginSet([p])`) while the constructor body runs, and the instance records the call's origin at that parameter's position in `type_arguments` (today a `Unit` placeholder for a non-type argument, `evaluator/calls/comptime_fn.yo:1293-1314`). No new `Struct`/`EnumT` field. | O1: origins are erased from every identity but the checker's, the constructor memo included, so one constructor body serves every origin |
| T3 | Origins inside a TYPE argument (`Option(&(i32, x))`, `ArrayList(&(i32, (x, y)))`) are carried by the argument itself. The constructor memo compares arguments with origins erased; the instance stamps the unerased arguments. | O1 (as T2) |
| T4 | Identity: `type_key` renders every `OriginSet` as one constant; `are_types_compatible` treats two `OriginSet`s as equal (erasure; the checker reads them, not compatibility); the intern key renders them (two nodes, one key, as step 1's slots). | O1; step 1's test pattern (`tests/internal/type_key.test.yo`) |
| T5 | Origin names outside a signature resolve, in order, to: an origin parameter in scope (`generic(p : Origin)` / `comptime(p) : Origin`); a binding's place (a local, a parameter, a module-level binding — O1's "a local's place is an origin inside bodies", §7 "Module-level origins"); a union `(a, b)` of those. A type is E0922 with the `&Tuple` hint (Q3 of step 2); a name that is none of these is E0922. In a TYPE DEFINITION a field path (`self.f`, `self`) or a field label of the type being defined is WF_SELF. | O1 (well-formedness, declared before use) |
| T6 | One structural predicate, `type_carries_origin(ty)`: a `Reference` anywhere outside a `Func`/`FnTrait` slot (a function type's slot origins are bound per call, O2), an `OriginSet` in a struct's or enum's `type_arguments`, and a field, payload, element or pointee carrying one. It is E0909's restated test ("this position requires an `Escapable` type; `X` carries origin `p`", O10) and, until N2b, the value wall. N1d's `Escapable` derivation reads the same predicate (plus the capture-borrow registry, Q3). | O4 "E0909 is restated: one structural check off the type"; O10 |
| T7 | Codes: WF_SELF is E0924 (the step-2 design reserved it for N1e's binding form; whichever of N1e and N2a lands first registers it, with one message covering both forms). UNION is E0925 (N2c). E0909 keeps its number; its text is restated. Codes are never reused. | `src/diagnostics.yo` policy; step-2 design §3.5 |
| T8 | Flow sets: a SPELLED origin (`_View(x)`, `ArrayList(&(i32, (x, y)))`) is a bound carried in the type; the LIVE freeze of a body-local is its flow set, per binding (grown by pushes, element writes and `&mut` lends, joined over control flow). A value whose type spells ground places freezes them from its initialization (the flow set equals the bound). | O6 "Which set freezes"; §7 "A local's flow set after a `&mut` lend" |
| T9 | A struct constructor's parameter for a `&`/`&mut` field is the field's `Reference` slot, so `S(at : &x)` is an ordinary lend (decision 33) and the constructor call is a call whose RESULT carries the origin: the caller freezes what the result's origin names, exactly as N1c narrows a projection's roots, generalized from a `Reference` result to any origin-carrying result. | O3 step 1 (application = substitution), O4 row 2 |
| T10 | Elided field origins (O2's table: "a fresh anonymous origin parameter per field") are implicit origin parameters of the type, appended after the declared ones in `type_arguments`, named by the field label (`'next`), never spelled. Q1's verdict adds to O2: a BY-VALUE parameter whose type carries origins gets a fresh one per occurrence in parameter position and the union in a result. | O2; step-2 consultation Q1 follow-up for N2 |

## 2. Inventory (measured on `3a7c3e3cf`)

### 2.1 The corpus: 37 N2 rows, by piece and by outside prerequisite

`tests/origins/corpus.tsv` holds 71 rows: 28 N1, 37 N2, 6 N3. Today's first error for the 37
N2 rows: "is an origin-qualified reference" 20, "a type constructor's origin parameter" 7,
"is a borrow mode, not a type" 7, "a payload bounded by an origin" 2, E0914 1.

| Piece | Rows (expected verdict) | Needs besides its N2 predecessors |
| --- | --- | --- |
| N2a | `wf-self-field` (WF_SELF), `extern-box-origin` (E0909), `global-refcell-origin` (E0909) | — |
| N2b | `wf-outward-field` (ACCEPT) | — |
| N2b | `copy-shared-holder` (ACCEPT), `ret-byvalue-carried` (ACCEPT), `match-arm-binding-origin` (E0911), `store-same-origin` (ACCEPT), `store-widen-mut-pointee` (E0923), `get2-mut-pair` (ACCEPT), `cursor-two-items` (ACCEPT), `copy-mut-holder` (E0901) | N1e (`.*`, reference-typed bindings, auto-deref through a reference field) |
| N2b | `rc-of-ref-holder` (E0909) | N1d (the `Rc` payload predicate) |
| N2c | `words`, `push-inside-union`, `push-spelled-shared`, `elided-container-lent-mut`, `loop-join-push-after`, `drop-order-may-dangle` (ACCEPT); `words-then-write`, `elided-container-lent-mut-then-write`, `loop-join-push`, `drop-order-user-drop`, `place-write-join`, `list-mut-two-pushes` (E0911); `push-outside-union`, `push-elided-unrelated` (UNION); `wf-self-binding` (WF_SELF) | N1e (a std generic body specialized at `T := &U` reads `T` as a value) |
| N2c | `rc-push-handle-borrow` (ACCEPT) | N1e, N1d (O9) |
| N2d | `closure-caps-within-slot` (ACCEPT); `store-widen-refcell`, `closure-caps-exceed-slot` (E0923); `spawn-box-origin`, `thread-send-origin` (E0909) | N1e (`store-widen-refcell`'s `with_mut` body), N1d (`Escapable` at spawn/`Send`) |
| N2e | `closure-push-capture` (ACCEPT), `closure-push-capture-then-write` (E0911), `closure-param-into-capture` (UNION) | N2c, N2d |

Corpus correction owed by N2b: `copy-shared-holder` copies `v` with `w := v` and uses both, but
a struct is `Copy` only when it declares it (VALUES_BY_DEFAULT; measured: the seed rejects the
same program over `struct(a : i32, n : usize)` with E0901). §5 route 3's "all-`&` values are
`Copy`" means such a holder MAY derive `Copy`; the fixture gains
`derive(generic(p : Origin), _View(p), Copy, Clone)` (Q4).

### 2.2 Compiler sites

| What | Sites (files) | Piece |
| --- | --- | --- |
| "borrow mode, not a type" raises (`borrow_mode_not_a_type_message`) | 7 (3): `_expr.yo:1179,1216`, `calls/helper.yo:956` | N2a (type operand ⇒ `Reference`) |
| origin phase messages naming N2 | 3: `_expr.yo:653`, `types/function.yo:2165`, `types/dyn.yo:212` | N2a (first two), N2d (`Dyn`) |
| `TypeValueNode.Reference` matches outside `definitions.yo` | 17 (11); `codegen/utils/index.yo:1878` panics if one reaches C | N2a (identity arms), N2b (C lowering) |
| comptime-constructor memo and stamp | `calls/comptime_fn.yo:74-333` (arg equality), `:1293-1314` (`type_arguments`), `:1415-1441` (stamp) | N2a |
| `type_key` `OriginSet` arm (falls back to `type_to_string`, which prints the names) | `types/type_key.yo:282` | N2a |
| E0909 machinery: `reject_second_class_escape` 20 (9), `reject_second_class_return` 10 (5), `note_second_class_binding` 8 (4), `reject_second_class_result_outliving` 4 (2), `type_is_second_class` 14 (5), `E_BORROW_ESCAPES` 17 (5) | 73 | restated over `type_carries_origin`: N2a adds the predicate and the type-level positions; N2b–N2d move each value-level site |
| capture-borrow registry: `g_capture_borrows` 13, `capture_struct_borrows`/`collect_type_borrows` 28 (6) | 41 | stays as the closure/future origin source behind `type_carries_origin` until N3's `Future(T, p)` (Q3) |
| projection-result freeze: `_bind_projection_result` (`exprs/initialization_assignment.yo:558-700`), `projection_call_root_args` (`evaluator/utils.yo:7686`) | 2 functions | N2b generalizes from a `Reference` result to an origin-carrying result (T9) |
| `type_is_control_bound` (the `ctl` patches) | 25 (12) | N2f deletes them site by site (Q1 of step 2) |
| docs/instructions naming "a borrow mode, not a type" | `docs/{en-US,zh-CN}/{DESIGN,GRAMMAR}.md`, `.github/instructions/yo-syntax.instructions.md`, `.github/skills/yo-syntax/syntax-cheatsheet.md` | N2a (docs + instructions); the skills cheatsheet with N2b, when values exist (a skills edit moves seven cli-case goldens) |
| tests pinning the old messages | `tests/borrow_spelling.test.yo` (13 "borrow mode" lines across the tree, most there), `tests/internal/parser.test.yo` | N2a |

### 2.3 Decision 44: borrowed trait objects (`&Dyn(Trait)`)

Decision 44 (`plans/VALUES_BY_DEFAULT.md`, "`Dyn(Trait)` stays the owned, boxed trait object")
gives decision 43 one more reference type: `&Dyn(Trait)` / `&mut Dyn(Trait)`, Rust's `&dyn
Trait`, a fat reference (data pointer, vtable) over the payload, with no allocation. It is N2's,
not step 2's: every piece but the parameter slot is a reference VALUE (N2b) or a write through
`.*` (N1e), and the corpus has no row for it yet. The pieces, each with its test:

| Rule | Test (accept / reject) | Needs |
| --- | --- | --- |
| `dyn(&v)` / `dyn(&mut v)` over a borrow of a concrete value is `&Dyn(Trait)` / `&mut Dyn(Trait)`, no cell | ACCEPT: call a trait method through it; the emitted C allocates nothing | N2b |
| `&x` / `&mut x` with `x : Dyn(Trait)` lends the PAYLOAD (Rust's `&dyn`, never `&Box<dyn>`) | ACCEPT: `use(&x)` for `use : fn(r : &Dyn(T))` calls through the payload; a `&mut x` lend mutates the payload `x` keeps | N2b (the `&mut Dyn(T)` slot's lowering: Q6) |
| `r.* = dyn(other)` through `r : &mut Dyn(T)` is an error (write the owning slot) | REJECT naming the owning binding | N1e (`.*`) |
| `&dyn(v)` is a call-argument temporary only | ACCEPT `use(&dyn(v))`; REJECT `r := &dyn(v)` and `{ r : &dyn(v) }` (a borrow of a temporary, as `t : &make_name()`) | N2b |
| trait-set narrowing is `upcast(r, Dyn(A))` | ACCEPT `upcast(r, Dyn(A))` over `r : &Dyn(A, B)`; the result keeps `r`'s origin | N2b, N2d |
| a borrowed trait object is origin-carrying | REJECT storing `dyn(&v)` past `v` (E0912 / O3); REJECT it at a no-origin position (E0909) | N2b, N2d |

These land as **N2g** (§3), after N2b and N1e, beside N2d. AnyError's follow-up (§3.2) needs
the payload lend and `&Dyn` results (`Error.source -> Option(&Dyn(SelfTrait))`), so N2g is on
the v0.2.75 critical path, not v0.2.74's.

## 3. The PR split

All of N2 is Generation A (the compiler; no std or `src/` file spells a reference type until N3).
Every PR keeps every existing program's C byte-identical unless it says otherwise.

| PR | Lands | Rows green (target `PHASES=N2`) | Depends on |
| --- | --- | --- | --- |
| **N2a** storage vocabulary | T1–T7: `&T`/`&(T, o)` as a type in every type position; `comptime(p) : Origin` constructor parameters with origin arguments (T2, T3, T5); identity erasure (T4) with the `type_key` test; WF_SELF for type definitions (E0924); `type_carries_origin` and the type-level no-origin positions (an `extern` signature, a module-level binding's type: E0909 restated); **the value wall**: a call whose result type carries an origin is a phase error naming N2b, so no build holds a stored reference the checker cannot see; evaluator only, emit-diff EMPTY | `wf-self-field`, `extern-box-origin`, `global-refcell-origin` | N1a |
| **N2b** inline composites | values of origin-carrying structs, enums, tuples and arrays: constructor lends (T9), result-origin substitution and the binding freeze generalized from projections, the return rule over composite results, `Copy`/move of holders (route 3), elided field origins and Q1's by-value elision (T10), impl-level `generic(p : Origin)`, C lowering of reference fields (`const T*` / `T*`, no drop, no dup), field reads; the wall moves to containers and cells | `wf-outward-field`; with N1e the eight rows of §2.1; with N1d `rc-of-ref-holder` | N2a; N1e for the `.*` rows |
| **N2c** containers | a std generic body at `T := &U` (buffer of pointers, no element drop, `may_dangle`), O6 declared unions (E0925) and the `yo fix` widening repair, flow sets grown by `push`, element writes and `&mut` lends (§7 of the plan), the loop fixpoint, user-`Drop` liveness | the 17 N2c rows | N2b, N1e |
| **N2d** cells and `Dyn` | `Box`/`RefCell` payload origins (the `RefCell` payload invariant, O3-3), `Dyn(Trait, p)` and `Dyn(Trait)` = `Dyn(Trait, ∅)` (a `DynT` origin), a `Dyn(Fn(...), p)` closure whose captures lie within `p`, spawn/`Send` as no-origin positions | the 5 N2d rows | N2b, N1d; N1e for `store-widen-refcell` |
| **N2e** closures × containers | a literal's `&mut` capture of a flow-inferred container (§7), per-call parameter origins against a captured union | the 3 N2e rows | N2c, N2d |
| **N2g** `&Dyn(Trait)` (decision 44) | the §2.3 rules: `dyn(&v)`/`dyn(&mut v)`, the payload lend of an owned `Dyn`, the `&dyn(v)` temporary rule, `upcast(r, Dyn(A))` over a reference, the whole-value write error; the `&mut Dyn(T)` slot lowering (Q6) | the §2.3 tests (new corpus rows) | N2b, N1e; beside N2d |
| **N2f** `ctl` handlers origin-carrying | step 2's Q1 verdict: the handler's origin is its defining frame's hidden origin plus its captures'; the 25 `type_is_control_bound` sites deleted one by one, each with a row (the three retired patches, `io.spawn` capturing an outer bundle E0909, a bundle passed down and returned ACCEPT); diagnostics say "the frame of `f`" | the new rows | N2b; LAST, fallback v0.2.75 (the `Copy` derive at v0.2.76) |

### 3.1 What N3 needs from N2 (the seed boundary)

N3's list (VBD_RELEASE_SCHEDULE v0.2.75) is `iter`, `slice`, `entry`, the borrowed `for` by
`impl(&C, IntoIterator)`, the `FnMut` slots, `Future(T, p)` and `--migrate deref` over std/src.
Each needs N2b (a cursor, a view and an entry are inline composites holding a reference) plus
N1e/N1f — none needs N2c's containers of references, N2d or N2e. So the v0.2.74 seed must carry
N2a + N2b; N2c–N2f can slip to v0.2.75 without delaying N3 (they would then ride as
Generation A beside it).

### 3.2 The std follow-up: `AnyError` and `Error.source` (VERDICTS-1 §C)

The end state is decided: `AnyError :: Dyn(Error)` (no `Clone`), `Error.source : fn(self :
&Self) -> Option(&Dyn(SelfTrait))`, `root_cause(err : &AnyError) -> &AnyError`, a lending
`error_chain`, `Context.cause : AnyError` without `derive(Clone)`, a borrowing `downcast`/`is`
on a link, the `compile-io-async-body-swallowed-error` golden back to `dyn(ToString + Error)`.

**It cannot land in v0.2.74.** `std/error.yo` is imported by the compiler (`src/init.yo`,
`src/cache.yo`, `src/fetch.yo`, `src/skills_command.yo`, `src/context_command.yo`, …; 67
`AnyError` mentions in `src/`), so stage 1 compiles it with the SEED, and the v0.2.73 seed
rejects `Option(&i32)` in a trait method's result ("`&i32` is a borrow mode, not a type",
probed 2026-10-30). It is therefore Generation B: it needs a seed carrying N2b and N1e (the
chain walks bind `&Dyn` links), i.e. the v0.2.74 seed, and lands in the v0.2.75 window as an
N3 piece (one std PR: `std/error.yo`, its tests, the golden, `docs/*/DYN_DESIGN.md`). The
schedule's v0.2.74 row ("with it, or in a small std PR right after") must move it (Q2).

## 4. N2a in detail

**Lands.** (1) The `&`/`&mut` arms in `evaluator/exprs/_expr.yo` return `TypeVal(Reference(T,
m, o))` when the operand is a type (one argument: the elided origin; two: T5's resolution),
except a `Reference` pointee (N1e's phase message). (2) `comptime(p) : Origin` on a type
constructor: `types/function.yo:2165` admits it; `calls/helper.yo`'s argument step evaluates the
argument of an `Origin`-kinded comptime parameter as an origin (T5) instead of a value;
`calls/comptime_fn.yo` binds the parameter abstractly for the memo and the body and stamps the
call's origin into the instance's `type_arguments` (T2), and erases origins inside type
arguments for the memo (T3). (3) `type_key`'s `OriginSet` arm and the compatibility arm (T4).
(4) WF_SELF (E0924, registry entry + explain text en/zh-CN + examples). (5)
`type_carries_origin` (`src/types/utils.yo`), E0909 at an `extern` signature and a module-level
binding whose type carries an origin. (6) The value wall in `evaluate_function_call`, both
branches (the std and the user path), naming N2b.

**As landed (deltas from the plan above).** The origin argument is read by name in both
argument paths: `check_if_function_parameter_matches_argument` and the `FuncVal` arm of
`evaluate_function_call` (`fv_takes_origin`), which is the one a type constructor applied in an
expression (`_View(x)`) takes. A function's `generic(p : Origin)` binders are bound in the
definition-time body env (`_build_def_time_body_env`), so a body may name `p` in a type
(`Option(&(i32, p))`). The wall has a fourth site, the struct constructor
(`try_to_call_type_with_arguments`), which stops before an argument such as `&mut x` meets a
by-value field's rule. A comptime `Origin` parameter on a function that does not return
`comptime(Type)` is rejected: only a type constructor takes one. A parameter or result whose
pointee is itself a reference (`v : &mut RefAlias` with `RefAlias :: &i32`) is N1e's phase
message; `v : &mut &i32` in a parameter stays the mode rule's error (the parser reads it as two
mode sigils).

**Not in N2a.** Values (N2b), `Dyn(Trait, p)` (N2d), `Rc`/`Arc` payloads (N1d's predicate),
reference-to-reference (N1e), local annotations naming the binding itself (`wf-self-binding`,
with N1e's annotated bindings), impl-level origin binders (N2b).

**Tests.** `tests/borrow_spelling.test.yo`: the cases that pinned "a borrow mode, not a type"
for a field or a type argument now pin the type (`type_of`-free: a struct definition with a
`&T` field and a type alias check; a value of one hits the N2b wall); a `comptime(p) : Origin`
constructor applied to a local, a parameter and a union; E0922 for an undeclared origin and
for a type in a field's origin; E0924 for a field naming its own type's field; E0909 for an
`extern` signature and a module-level binding. `tests/internal/type_key.test.yo`: `_View(x)`
and `_View(y)` (and `Option(&(i32, x))` / `Option(&(i32, y))`) have one `type_key`, are
compatible, share a constructor-memo entry (one struct id) and intern to two nodes.
`tests/internal/parser.test.yo` if it pins the message.

**Corpus.** `today` re-recorded for every row whose first error moves (expected: most N2 rows
move from the three phase messages to the N2b wall, E0922 or E0909); `target` with
`PHASES=N2` for the three N2a rows; `RULE_CODES[WF_SELF]=E0924`.

**Gates.** Build (`--std-path ./std`), then with the tree binary `check ./src`, `check ./std`,
`borrow_spelling`, `ref_return_ban`, `parameter_modes`, `ref_params`; internal `type_key`,
`types_compound`, `synthesizer`, `compile`, `diagnostics_registry`,
`diagnostics_registry_examples`, `parser` (one file per call); emit-diff of the language
corpus and `src/main.yo` against the step-2 tip (EMPTY); cli-diff (`explain-list` gains E0924;
any moved diagnostic); fmt with the tree binary; `check-issue-refs.sh`.

## 5. Open questions (for consultation)

### Q1. N2 before N1e: the value wall, or wait?

Most N2 rows read a stored reference (`v.r.*`, a `match` payload `r.*`, `a.* = …`, a reference
field's method `self.xs.len()`), which is N1e's reading (reference-typed bindings, `.*`,
auto-deref). N1e is not started.

- **A. Stack N2 now with a wall** (recommended): N2a lands the vocabulary with no values (the
  wall); N2b lands values whose reads need nothing from N1e (construction, copies, the freeze,
  returns, non-reference field reads; a READ of a reference field is a phase error naming N1e);
  the rows needing `.*` turn green when N1e lands. Pro: N2 proceeds in parallel; every PR is
  sound because no stored reference exists that the checker cannot see. Con: N2b's reference-field
  read is a phase error for one or two PRs.
- **B. Wait for N1e**, then do N2 in order. Pro: no phase errors. Con: serializes the
  heaviest window; N2 starts days later.
- **C. Pre-N1e reading for reference fields** (a read of `v.r` implicitly dereferences, as a
  borrow binding does on the tip). Con: a construct is introduced with the reading N1e deletes
  in the same release (Q7 of step 2: "no release accepts both spellings").

### Q2. The `AnyError` follow-up moves to v0.2.75 (schedule amendment)

§3.2: Generation B by construction. **Recommendation:** amend the v0.2.74 row (drop "With it
(or in a small std PR right after) …") and add the item to v0.2.75's N3 list; keep B13's
interim `Clone` bound and its docs one more release. No alternative keeps it in v0.2.74 except
an std that the compiler does not import, which `std/error.yo` is not.

### Q3. E0909 restated: what carries a closure's or a future's origins?

`type_carries_origin` must see a borrowing closure and a borrowing future, whose borrows live
today in the capture-borrow registry (`g_capture_borrows`, keyed by capture-struct or wrapper
id, 41 sites) rather than in their types.

- **A. Convert in N2**: a capture struct's borrow entry becomes a `Reference` field with its
  ground origin; the registry is deleted for closures; futures keep it until N3. Pro: one
  representation for closures at once. Con: rewrites decision 35/38's capture machinery inside
  N2, beside A2's registry that N3 replaces anyway; large.
- **B. Keep the registry as an origin source behind the one predicate** (recommended):
  `type_carries_origin` = the `Reference` walk ∪ the registry walk (`collect_type_borrows`); the
  registry is deleted at N3 with `Future(T, p)`, when both closures and futures move. Pro: N2
  stays about storage; one predicate either way, so E0909 is "one structural check off the
  type" from the caller's view. Con: two internal sources for one release.

### Q4. `copy-shared-holder`: declared `Copy`, or implicit `Copy` for an all-`&` holder?

- **A. Declared** (recommended): fix the fixture with `derive(generic(p : Origin), _View(p),
  Copy, Clone)`; §5 route 3 reads "may be `Copy`". Matches every other struct (explicit `Copy`
  is VBD's rule).
- **B. Implicit**: an all-`&` holder is structurally `Copy`. Con: a second, origin-specific
  `Copy` rule; contradicts decision 17's explicit-copy direction.

### Q5. Schedule: what of N2 must the v0.2.74 seed carry?

§3.1: N3 needs N2a + N2b (+ N1e, N1f), not N2c–N2f. **Recommendation:** commit v0.2.74 to
N2a + N2b; N2c, N2d, N2e and N2f land in v0.2.74 if ready and otherwise in v0.2.75 as
Generation A beside N3 (none of them is seed-gated). This keeps "step 3 in v0.2.74" true for
everything N3 consumes.

### Q6. Decision 44's payload lend and the existing `&Dyn(T)` / `&mut Dyn(T)` slots

A `&T` parameter is passed as a copy (decision 33's lowering), so a `&Dyn(T)` slot already
receives the fat pair, which is the payload lend. A `&mut Dyn(T)` slot passes a pointer to the
caller's owning slot, which is exactly what makes `r.* = dyn(other)` expressible. Decision 44
makes `&mut x` lend the payload too, so the `&mut Dyn(T)` lowering changes (to be measured on
the tree first: the count of `&mut Dyn` slots in `src/` and `std/`).

- **A. Lower `&mut Dyn(T)` as the fat pair in N2g, Generation A** (recommended): the whole-value
  write becomes the rejection of §2.3 instead of a lowering choice; the emit-diff names exactly
  the `&mut Dyn` sites; no source changes, since the spelling is unchanged.
- **B. Keep the pointer-to-slot lowering for `&mut Dyn(T)` slots** and give only `dyn(&mut v)`
  values the fat-pair form. Pro: no C change. Con: two representations of one type, and the
  rejected write stays reachable through the slot.
