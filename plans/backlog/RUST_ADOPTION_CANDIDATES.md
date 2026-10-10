# What else to take from Rust: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-10-10 at the maintainer's
request.** Nothing here is adopted; each candidate ends with a verdict and
a trigger, and the maintainer picks. Companion to
[`RUST_REFERENCE_PATTERNS.md`](RUST_REFERENCE_PATTERNS.md) (the borrow
shapes: what Rust stores in structures and what replaces it) and
[`LANGUAGE_FEATURE_CANDIDATES.md`](LANGUAGE_FEATURE_CANDIDATES.md) (the
2026-10-08 parking lot, with the standing-rejections table that this
document extends in §5). Every "Yo today" claim below was checked by grep
on the 2026-10-10 tree (`std/prelude.yo`, `std/collections/*.yo`,
`src/lexer.yo`, `src/parser.yo`, `src/main.yo`, `src/lsp/`); a claim marked
*(verify)* was not run to ground and the adopting PR must. Two candidates
drafted as new turned out to exist once a program was compiled rather than
grepped (L2, L6); they stay in §2 as records so the next survey does not
redo them.

## 0. The filter

A candidate survives only if it passes all four:

1. **Not already rejected.** The standing rejections (§5 here,
   `LANGUAGE_FEATURE_CANDIDATES.md` §0, and VALUES_BY_DEFAULT decision 43's
   rejected list): named lifetimes, regions or origins, deref coercions,
   guard values for `RefCell`, `Cell`/`Cow`/`Weak`, operator precedence
   and overloading, `Pin`, order-free named arguments, literal inference
   through bindings, `yo run`, deprecation windows and editions (no
   backward compatibility, single user).
2. **Fits the model.** Mutable value semantics for owned values;
   references `&T`/`&mut T` as second-class types with lifetimes elided
   (decisions 42 and 43, `NON_ESCAPABLE_TYPES.md`); sharing spelled
   `Rc`/`Arc` and the dynamic check `RefCell(T)` (decision 41); `Fn`/
   `FnMut`/`FnOnce` (decision 37); comptime as the metaprogramming layer;
   everything lowers to portable C11.
3. **Pays for an LLM author.** Yo's users are mostly models; a feature
   earns its place by removing a class of mistakes or a class of
   boilerplate they produce, not by matching Rust's surface.
4. **Not already here.** §1 lists what Yo already has so nobody proposes
   it again.

## 1. Already taken (do not re-propose)

| Rust | Yo today | Where |
| --- | --- | --- |
| `Option`/`Result` combinators (`map`, `and_then`, `or_else`, `ok_or`, `unwrap_or*`, `map_err`, `expect`, `is_some_and`, `flatten`, `zip`, `take`, `replace`, `filter`, `inspect`, `ok`, `err`, `transpose`) | all present | `std/prelude.yo` |
| `From`/`Into`/`TryFrom`/`TryInto`, `FromStr` + `parse::<T>()` | `From`, `Into`, `TryFrom`, `TryInto`, `FromString` + `String.parse(T)` | `std/prelude.yo:10106`–`10164`, `std/string/string.yo:3338` |
| `checked_*`, `wrapping_*`, `saturating_*`, `overflowing_*`, `leading_zeros`, `count_ones`, `abs_diff`, `rem_euclid`, `pow`, `rotate_*`, `next_power_of_two` | present, generic over `Integer` | `std/prelude.yo` (`wrapping_*` are SAFE_MODE 3a's escape hatch) |
| `#[derive(...)]` | `derive(T, Clone \| Copy \| Debug \| Default \| Eq \| Error \| Hash \| Ord \| ToString)` | `plans/reference/DERIVE_TRAITS.md` |
| `Display` vs `Debug` | `ToString` vs `Debug` (D15) | `std/fmt/to_string.yo` |
| `Error::source()`, `Box<dyn Error>`, `Any` + `TypeId` downcast | `Error.source`, `AnyError`, `Dyn` + `TypeId` | `std/error.yo`, `plans/reference/ERROR_TRAIT_AND_TYPEID.md` |
| `Send`/`Sync`, `Drop` | `Send`/`Sync` (D10), `Dispose` | `plans/reference/PARALLELISM_RULES.md` |
| `Iterator` adapters | `map filter take skip enumerate zip rev take_while skip_while peekable fold any all position sum collect last nth count chain filter_map find inspect min max for_each` | `std/prelude.yo` (index-based after V2b, decision 39) |
| `format!` width/fill/align/precision | `std/fmt/format.yo`, "Rust's model" | `std/fmt/format.yo` |
| `Vec` API | `sort`/`sort_by`/`sort_unstable`, `binary_search`, `dedup`, `retain`, `drain`, `windows`, `chunks`, `extend`, `truncate`, `swap_remove`, `split_off`, `fill`, `resize`, `first`/`last`/`contains` | `std/collections/array_list.yo` |
| `HashMap::entry` | `entry`, `get_or_insert_with`, `update_with`, `retain`, `extend`, `keys`, `values` | `std/collections/hash_map.yo` (post-V2b shape: `issues/questions/hashmap-entry-has-no-sound-post-v2b-shape.md`) |
| `Mutex`/`RwLock`/`Condvar`/`Barrier`/`Once`/`OnceLock`/atomics/channels/`thread_local!` | `std/sync/*` (`once.yo` has `Once` and `OnceCell`), `std/thread.yo`, `thread_local` | `std/sync/` |
| allocator-parameterized containers (`Vec<T, A>`) | explicit allocators, `with_allocator`, arenas, `new_in` | `plans/reference/EXPLICIT_ALLOCATORS.md` |
| associated types, trait coherence, default methods (`?=`), supertraits | all landed | `plans/reference/ASSOCIATED_TYPES.md`, `TRAIT_COHERENCE.md`, `std/error.yo:43` |
| `pub`/private members | the compiler-enforced `_` prefix | `plans/reference/MEMBER_VISIBILITY.md` |
| `cargo add/remove/update/install`, workspaces, lockfile, content-addressed store | `yo add/remove/update/install`, `[workspace] members` | `src/manifest.yo:177`, `plans/reference/DEPENDENCY_MANAGEMENT.md` |
| `rustc --explain`, `cargo fix`, `cargo fmt`, `cargo doc`, `cargo test` filters | `yo explain`, `yo fix`, `yo fmt`, `yo doc`, `yo test --test-name-pattern` | `src/main.yo` |
| rust-analyzer: completion, go-to-definition, hover, references, rename, symbols, folding, signature help, diagnostics | present | `src/lsp/` |
| `cargo miri` / sanitizers | `--sanitize address\|thread\|undefined\|leak` | `src/main.yo` |
| `#[must_use]` | planned as ATS A2 | `plans/ATS_LESSONS_BEYOND_INDEXED_TYPES.md` §A2 |
| `?` | ruled back in as the `try(expr)` prelude macro 2026-09-19; **not landed** (no `try` in `std/prelude.yo`) | `plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §2.3 owns it |
| `let … else` | not needed: `x := match(opt, .Some(v) => v, .None => return(…));` is the idiom; add it to the cheatsheet, not the language | — |

Two things Yo has that Rust does not, so the comparison is not one-way:
contracts discharged by Z3 at compile time, and comptime evaluation with
AST reflection in the language (Rust's `const fn` plus proc macros, in one
layer).

## 2. Language candidates

### L1. Second-class slice parameters — Rust's `&[T]` / `&str` in argument position

```rust
// Rust
fn checksum(bytes: &[u8]) -> u32 { .. }
checksum(&buf[hdr..hdr + len]);          // a view, no copy
```

**Yo today.** No view type: `Slice(T)`, `ListView(T)`, `String.as_str()`
and `ArrayList.as_slice()` were deleted (`plans/archive/SLICE_REWORK.md`,
"if a real view type is ever needed it comes back with iteration and
`Index`"); `arr(a..b)` and `ArrayList.slice` **copy**
(`std/collections/array_list.yo:804`, and line 1657: "Yo has no slice type,
so each chunk is a freshly allocated `ArrayList(T)`"); `RawSlice(T)` is
ptr+len under `pragma(Pragma.AllowUnsafe)`. The safe workaround is the pair
"whole buffer lent, plus a `Copy` range" (RUST_REFERENCE_PATTERNS §2.4),
which every callee must re-derive.

**Why it fits now.** The reason the view was deleted was the lack of
consumers under the old model. Under VBD a borrow is a mode, and a view
that can exist **only in a borrow position** is exactly a borrow: a
`[T]` type that is a second-class reference type like any other (decision
43): `xs : &[T]` / `xs : &mut [T]` in parameters, locals, fields of
second-class structs and `Option(&[T])`, never the payload of a cell, and
returned only under the single-root rule (`NON_ESCAPABLE_TYPES.md` R1,
R3). It is constructed at the call site from an
`ArrayList(T)`, an `Array(T, N)`, a `String` (as `[u8]`) or a sub-range
(`&xs(a..b)`, zero-copy), lowers to the `RawSlice` ptr+len pair, carries
`len()` and `Index` projections, and can be the source of the borrowed
`for`. A callee that needs to own the bytes calls `to_list()`, the visible
copy. This is Rust's `&[T]` with the lifetime erased by second-classness,
and Swift's `ArraySlice` without the storage.

**Cost.** A new second-class kind in the evaluator (the capture-list and
future slots already carry borrows; this is a third holder), the `[T]`
spelling in the parser, flowability (a view of a value-rooted buffer is a
borrow of that root; of an `Rc`-rooted one, a pinned borrow), `Index`
projections and `len`, the verifier's `index-in-bounds` obligations on
views. Not seed-gated in the language (new syntax the seed never sees), but
`std` cannot use `[T]` in signatures until `SEED_VERSION` carries it
(Generation B), so std's sub-range APIs convert in two generations.

**Verdict: adopt, after V3b Generation B** (the modes must be final before
a third second-class holder is added). Trigger to start: the count of
`slice(`/`arr(a..b)` copies in `src/` and `std/` that exist only to pass a
window, plus the parser/lexer/`String` cursor shapes of
RUST_REFERENCE_PATTERNS §2.1–§2.4. One design question to file with the
plan: whether `str` (today the view of **static** bytes) becomes the `[u8]`
view of any `String` in borrow position, which would retire the
literal-only condition on its `Copy` impl (decision 36).

### L2. Digit separators — already here

`n := 1_000;` compiles and prints 1000 (checked 2026-10-10 with a compiled
program; the first grep of `src/lexer.yo` missed it). Nothing to do except
say so in the cheatsheet, which does not mention the separator.

### L3. Labeled `break`/`continue`, and `break` with a value

```rust
// Rust
let found = 'outer: loop { for x in row { if p(x) { break 'outer Some(x) } } break None };
```

**Yo today.** `while(cond, body)` and `break`/`continue`
(`src/expr.yo:326`, `BK_BREAK`); no label and no value *(verify: no label
handling in `src/parser.yo`)*; nested loops exit through a flag variable,
and a "found" value is a mutable local assigned before `break`. The emitted
C already labels every loop (`loop_<fn>_r<row>c<col>_n0:` after each
`while`), so codegen has the target.

**Why.** Flag variables are the error-prone shape (a model forgets to reset
or to test the flag); `break(value)` removes a mutable local and a
`match` on it.

**Cost.** Parser (a label form), evaluator (the loop's result type when
`break(v)` is used: `while` stops being `unit`), codegen (`goto` the
existing label), fmt. The spelling is the open question: Yo has no
`'label` syntax and no attributes. One candidate, all in existing syntax:
`outer :: while(cond, { … break(outer, v); … })` — a `::` binding of a
loop gives it a name (a binding is already what names things), and
`break(name, value)`/`continue(name)` target it; a bare `break(v)` targets
the innermost loop. **Verdict: adopt; spelling needs the maintainer's
call.**

### L4. `unreachable()`, `todo()`, `unimplemented()`

**Yo today.** `__yo_panic("…")` and `assert(false, "…")`; no named
helpers *(verify: none in `std/prelude.yo`)*.

**Why.** Each says something different to a reader and a tool:
`unreachable()` is a claim the verifier can be asked to **prove** (it is a
sited `assert(false)` obligation, exactly the `index-in-bounds` family of
SAFE_MODE 5b), `todo()` is the one a `yo check --deny todo` can refuse
before a release, `unimplemented()` is a documented contract hole. For a
model, the names carry intent the panic string does not.

**Cost.** Three prelude functions returning the bottom type *(verify: what
`__yo_panic` returns and whether a `Never` type exists; if not, they
return `unit` and the call sits in statement position)*, one verifier rule
for `unreachable` (prove the path infeasible, else runtime abort),
`--deny todo`. **Verdict: adopt now** for the three functions; the verifier
rule when SAFE_MODE 5b Phase 3 lands.

### L5. Functional record update — `S { x: 1, ..base }`

**Yo today.** Named constructor arguments are mandatory
(`Point(x : i32(1), y : i32(2))`); no spread form *(verify: no `..` in a
constructor argument list in `src/parser.yo`)*. A struct with eight fields
and one changed is eight lines, and `Default` plus overrides is a
`default()` call followed by field assignments on a `mut` local.

**Why.** Under values by default the semantics are exactly Rust's with no
surprises: the remaining fields **move** out of `base` (or copy, if
`Copy`), `base` is consumed, and a `base.clone()` is written where the
original must survive (decision 19: no partial moves — the spread is a
whole-value destructure of the unnamed rest, which decision 19 already
allows). `S(x : 1, ..S.default())` is the Rust idiom for configs and
builders, and it is the one place the no-partial-move rule otherwise
hurts.

**Cost.** Parser (a `..expr` entry in a constructor's argument list; `..`
is the range operator elsewhere, but a range has two operands and this
has one, in a position where no expression is otherwise allowed), the
evaluator's constructor path (destructure the rest), fmt. **Verdict:
adopt**, small, after V3b Generation B so the move semantics are the
final ones.

### L6. Total ordering for floats without a `PartialOrd` split — already decided

Yo already made the call this document would have recommended:
`impl(f64, Ord(f64)(…))` in `std/prelude.yo` (near line 3790) keeps the
operators IEEE (`NaN < x` false) and overrides `cmp` with a total order
(NaNs equal to each other and greater than everything, `-0 == +0`), citing
`plans/archive/STD_API_AUDIT.md` D3.3's "no-`PartialOrd` decision".
`ArrayList(f64).sort()` and `into_iter().sum()` on floats compile and run
(checked 2026-10-10). Rust's `PartialEq`/`PartialOrd` split stays
rejected (§5).

### L7. `matches(x, pattern)` as a prelude macro

**Yo today.** `match(x, p => true, _ => false)` by hand. Prelude macros
are free to call (`plans/reference/MACRO_POLICY.md`), and `if` is already
one.

**Verdict: adopt now;** a five-line prelude macro with a guard form
`matches(x, (p && (g)))`, and a fmt case. It removes the most common
three-line `match` a model writes.

### L8. Explicit enum discriminants and C-layout enums for FFI

**Yo today.** `docs/en-US/FFI.md` does not mention enums *(verify: whether
an `enum` with no payloads can be given explicit integer values and passed
to C as an `int`)*. Rust: `#[repr(C)] enum E { A = 1, B = 4 }`.

**Verdict: verify first;** if absent, adopt as `enum(A = 1, B = 4)` for
payload-free enums only, with `extern` acceptance and a `sizeof` golden.
Small, and FFI code is where models most often hand-write magic numbers.

### L9. Associated comptime values in traits — Rust's associated `const`

**Yo today.** Associated **types** (`plans/reference/ASSOCIATED_TYPES.md`);
whether a trait may declare a comptime *value* member (`N : comptime(usize)`)
that impls provide *(verify)*. Rust uses them for `BITS`, `MAX`, array
lengths, sizes in generic numeric code.

**Verdict: verify;** if a trait member of comptime type already works,
document it beside associated types; if not, it is a small evaluator
addition that `std/math` and `std/hash` would use at once.

## 3. Standard library candidates

### S1. The missing iterator adapters

Measured absent from `std/prelude.yo` (present: §1's list): `flat_map`,
`min_by_key`/`max_by_key`/`min_by`/`max_by`, `product`, `step_by`, `scan`,
`cycle`, `unzip`, `partition`, `reduce`, `find_map`, `rposition`,
`try_fold`, `fuse`, `dedup` on an iterator, `map_while` (`sum` on floats
works, checked). All are consuming or owned-source adapters, so decision 39
(index-based read walks, no borrowing chains) does not block them.

**Verdict: adopt now,** one std PR, each with a test; `product`/`min_by_key`
/`max_by_key`/`flat_map`/`partition` first (the ones a model reaches for
and then rewrites as a loop).

### S2. Container API parity sweep

Absent from `ArrayList` *(measured)*: `dedup_by_key`, `splice`,
`rotate_left`/`rotate_right`, `is_sorted`, `concat`/`join` on lists of
lists, `repeat`, `iter().rev()` on the index walk. Absent from `HashMap`:
`drain`, `into_keys`/`into_values`, `remove_entry` exists. Missing
containers: `BTreeSet` (`BTreeMap` exists; `HashSet` exists), `BinaryHeap`
is `PriorityQueue`, `VecDeque` is `Deque`. **Verdict: adopt as one
checklist PR per container** (the API doc lists Rust's name beside Yo's),
after V2b so the by-value signatures are the final ones.

### S3. `LazyCell` / `LazyLock` and a non-atomic `OnceCell`

**Yo today.** `Once` and `OnceCell(T)` in `std/sync/once.yo`, both atomic
and `OnceCell` requiring `T <: (Send, Acyclic)`. Rust has the
single-thread `OnceCell`/`LazyCell` beside the atomic `OnceLock`/`LazyLock`.
Under decision 41 the single-thread form is `RefCell(Option(T))` with a
`get_or_init(f)` method, which is a four-line std addition; the lazy form
wraps it with the initializer. **Verdict: adopt with decision 41's std PR**
(`RefCell` is the prerequisite), and rename nothing: `OnceCell` stays the
atomic one as today's docs say *(or verify: whether the Rust naming —
`OnceLock` for the atomic — is worth a rename while `std/sync` is still
unstable)*.

### S4. Result context chaining — `anyhow::Context`

**Yo today.** `AnyError` and `Error.source` (`std/error.yo:240`), so the
chain exists; what is missing is the ergonomic `.context("reading config")`
that wraps a `Result(T, E)`'s error into an `AnyError` with a message and
the original as `source` *(verify: no `context` method on `Result` in the
prelude)*. **Verdict: adopt now;** two methods (`context`, `with_context`)
on `Result` where `E <: Error`, in `std/error.yo`.

### S5. The bench harness, and `yo bench`

**Yo today.** `std/testing/bench.yo` is a `bench(name, n, f)` function
reporting total/avg/min/max, marked unstable with the note that "Rust's
libtest reports a median and a deviation, and `criterion` a confidence
interval"; `tests/bench_black_box.test.yo` and
`issues/questions/no-volatile-so-black-box-needs-inline-asm.md` hold the
`black_box` question. CODEGEN_PERFORMANCE CP0 needs exactly a harness.

**Verdict: adopt as `yo bench`** — `bench("name", () => …)` declarations in
`*.bench.yo` files (the `test(...)` shape), auto-scaled iteration counts,
warm-up, median and median absolute deviation, `--json`, `black_box` in
`std/testing`, and a `--baseline <file>` diff with a tolerance. This is the
`scripts/bench/lang-vs-c/` runner CP0 asks for, in the toolchain instead of
a script, and the CP plan's "events removed beside time saved" lands as
its counters. Owned by CP0 once that campaign opens.

### S6. 128-bit integers

Rust has `i128`/`u128`; Yo has none (`grep -c i128 std/prelude.yo` = 0).
C has `__int128` on 64-bit GCC/clang targets but not on MSVC or wasm32,
and Yo's identity is portable C11 for every target. **Verdict: reject for
now;** `std/crypto` and `std/hash` use `u64` pairs with the
`overflowing_*` ops, which exist. Reopen if a measured workload needs it,
with a software fallback for the targets that lack it.

## 4. Toolchain candidates

### T1. Doc tests: compile **and run** the code blocks

**Yo today.** `AGENT_KNOWLEDGE_CONSOLIDATION.md` D4 plans to *compile* the
code blocks in the pack, skills and manuals (its line 82: "nothing compiles
documentation code blocks" today). Rust's `cargo test --doc` also **runs**
them, and that is what keeps examples true: an example that compiles but
panics is still wrong. **Verdict: adopt as the second half of D4:** a block
fenced ` ```yo ` with a `main` runs; one without compiles; ` ```yo ignore `
is skipped; failures name the file and block. Owned by that plan.

### T2. Warning levels — `--deny warnings` and a per-site allow

**Yo today.** `--deny` exists for the verifier's verdicts only
(`src/main.yo:1657`: `assumed,outside-subset,unproven`); the evaluator's
warnings (the collectively-covered match arm, the dead-arm warning) cannot
be promoted to errors in CI nor silenced at a site. Rust: `-D warnings`,
`#[allow(...)]`.

**Verdict: adopt `--deny warnings`** (one flag, so CI can refuse a warning
regression) and a per-expression `allow(code, expr)` prelude form for the
few deliberate cases; no lint-level machinery beyond that (single user, no
clippy). Small.

### T3. LSP: code actions, then inlay hints

**Yo today.** `src/lsp/` has completion, definition, hover, references,
rename, symbols, folding, signature help and diagnostics; no code actions
and no inlay hints. `yo fix` already produces structured repairs
(`LLM_AUTHORING_AUDIT_2026-09-19.md` §3.2 asks the LSP to carry them).
**Verdict: adopt code actions first** (the repairs exist; the LSP exposes
them), inlay hints for `:=` binding types second (a human-facing feature;
models read the hover). Both are protocol plumbing over existing data.

### T4. A fuzzing harness — `cargo fuzz`

**Yo today.** Sanitizers exist; no fuzz entry point. Because Yo emits C and
compiles with clang, libFuzzer is one flag away: `--sanitize fuzzer`
emitting `LLVMFuzzerTestOneInput` around a `fuzz("name", (data : ArrayList(u8)) => …)`
declaration. Safe mode's "no UB" claim and the parsers in std (`json`,
`toml`, `url`, `regex`, `http`) are exactly what fuzzing finds holes in.
**Verdict: adopt later,** after `yo bench` (same declaration machinery),
Linux and macOS clang only, with the corpus under `yo-out/`.

### T5. Panic backtraces — `RUST_BACKTRACE=1`

**Yo today.** A panic prints its message with file:row:col and aborts; no
stack. For an agent reading a failed test, the call chain is the
diagnosis. **Verdict: adopt:** `YO_BACKTRACE=1` prints a symbolized
backtrace on panic (`backtrace()` + `backtrace_symbols_fd` on glibc and
macOS, `CaptureStackBackTrace` on Windows, nothing on wasm), opt-in so the
abort path stays small. The `__yo_abort` runtime is the one place to
change.

### T6. Rejected toolchain items

- **`cargo semver-checks` / an API-diff gate.** `yo doc --format json`
  could feed one, but there is no backward-compatibility commitment to
  check against (single user). Reopen with a second user.
- **`[features]` in the manifest.** `-Dname=value` plus comptime `cond` is
  the same mechanism with no manifest grammar; a dependency's features would
  be the only reason, and dependencies are git paths today.
- **User-facing `inline`/`cold`/`noinline` attributes.** The codegen should
  mark panic paths cold itself (CODEGEN_PERFORMANCE CP3 territory); a
  user attribute is a knob a model will misuse.
- **`cargo expand`.** Macro definitions are gated behind
  `Pragma.AllowMacroDef`; `yo context` and `--emit-c` cover the inspection
  need.

## 5. Standing rejections this document adds

| Feature | Why not |
| --- | --- |
| variable shadowing (`let x = x.parse()`) | Yo's no-shadowing rule (`yo-syntax` cheatsheet, the `___` section) is what keeps a model's rebinding visible and the verifier's places unique; the Rust idiom becomes `x2 := x.parse()` |
| `PartialEq`/`PartialOrd` | already decided: `STD_API_AUDIT.md` D3.3, floats carry a total `cmp` with IEEE operators (L6) |
| `i128`/`u128` | S6: not portable C11 on every target |
| `Weak<T>` | the cycle collector is the `Weak` (RUST_REFERENCE_PATTERNS §4.1; an `Arc` graph needs `Acyclic`) |
| guard values (`MutexGuard`, `RefMut`, `Ref`) | decision 38 A and 41: closures and projections |
| `Cell<T>` | a `RefCell(T)` over a `Copy` payload |
| `Cow<'a, T>` | an explicit enum or ownership (catalog §4.4) |
| implicit `Deref` coercions | `s : &String` is the lent form of a `String`; a view is L1, explicit (decision 43) |
| editions, `#[deprecated]` | no backward compatibility, single user |
| `impl Iterator<Item = &T>` returns | decision 39 |

## 6. Suggested order

| Candidate | Size | Depends on | Suggested slot |
| --- | --- | --- | --- |
| L4 `unreachable`/`todo`/`unimplemented`, L7 `matches`, S4 `context` | small each | nothing | the next quiet week; one PR each |
| S1 iterator adapters | medium | nothing | now |
| T2 `--deny warnings` + `allow` | small | nothing | now |
| T5 backtraces | small | runtime only | now |
| S3 single-thread `OnceCell`/`Lazy` | small | decision 41's `RefCell` PR | with it |
| S5 `yo bench` | medium | CP0 opens | with CP0 |
| T3 code actions, inlay hints | medium | nothing | after `yo fix`'s four repairs |
| L5 record update, L3 labeled break | medium | V3b Generation B | after the flip |
| S2 container parity | medium | V2b | after V2b |
| L1 slice parameters | large | V3b Generation B; a design doc | after the flip, when the copy count justifies it |
| T1 doc tests run | medium | AGENT_KNOWLEDGE D4 | with D4 |
| T4 fuzzing | medium | S5's declaration machinery | after S5 |
| L8, L9 | verify first | — | — |

## Maintenance

A candidate that is adopted moves out of here into the plan that lands
it (or a short `plans/` doc of its own if it is large, L1 in particular),
with a dated line here saying where it went; a candidate the maintainer
rejects moves into §5 with the reason. Re-check the *(verify)* marks
against the tree before acting on any of them.
