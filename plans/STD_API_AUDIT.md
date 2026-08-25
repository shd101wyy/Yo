# std API audit — the road to a stable, batteries-included standard library

**Status: IN PROGRESS (audit complete 2026-08-22; all §8 open questions DECIDED
by the user 2026-08-23; S0 correctness fixes underway).** Method: six parallel full-surface catalog sweeps (core/prelude,
collections+imm, strings+encoding, io/fs/os, net/async/sync, time/crypto/build)
over all 144 files / ~44k lines of `std/`, cross-checked against Rust std,
Python, and Node, plus repo-wide import-usage scans. Goal per the user: *"battery
included, like rust, python and nodejs … I hope the std API is stable so we wont
change much in the future."*

The audit found three kinds of work, in priority order:

1. **Correctness bugs** hiding in std (one security-grade) — fix first, no API
   debate needed (§2).
2. **Convention decisions + breaking renames/deletions** — everything breaking
   happens in ONE release window, before any stability promise (§3–§6).
3. **Additions** that make Yo batteries-included (§7), landed behind the now-fixed
   conventions so they never need to change again.

---

## 1. Guiding principles (the stability contract)

- **One blessed error style per situation** (§3 D1). Modules currently ship four
  styles, sometimes in one file.
- **One name per concept across the whole tree** (§3 D2). Today: 5 insert verbs,
  4 spellings of the length field, 2 `sleep`s, 2 `Writer`s, 3 `spawn`s.
- **Traits are the API.** Inherent methods that duplicate a trait (e.g.
  `HttpRequest.to_string`) become trait impls. Types that should compose
  (`Eq`/`Ord`/`Hash`/`Clone`/`ToString`) get the impls.
- **`sys/` is plumbing, `std/*` is the product.** Every user-relevant syscall
  gets a typed wrapper; underscore-private names never appear in `export(...)`.
- **Nothing dead ships.** Zero-consumer modules are deleted or promoted (wired in
  and tested) — never left ambient.
- After the breaking window closes: **additive-only** changes to stable modules;
  new modules enter via an `unstable` doc marker for one release before freezing.

---

## 2. Correctness bugs found by the audit (fix immediately, file in `issues/`)

Ranked by severity; none of these are API-design questions.

**Progress:** C1–C5 + C9 LANDED in PR #229 (2026-08-23, with red-first tests
under `tests/{http,net,time,crypto,fs}/`). C6, C8, C10, C12, C13 fixed
2026-08-23 (this tree; red-first where the failure is reachable — C10's
syscall failure is not, so it has no dedicated test). Notes against the
audit text: the C6 bool-arithmetic claim was STALE (no such impls exist —
only the f32/f64 bitwise four and the five unsigned `Negate`s were real);
C13's rwlock atomicity claim could not be found in the current source and
was left alone. **C12 uncovered TWO compiler bugs**: (1) a future's owned RC result
was NEVER dropped (empty sync-future dispose / warning-comment state-machine
dispose), so `Dispose` of any async-produced object never ran — fixed in
`src/codegen/exprs/async.yo` with inline-drop fallbacks
(issues/async-future-result-never-dropped.md; regression test in
tests/async_await.test.yo); (2) unmasked by (1): the async post-while
cond-branch cleanup re-executed on a stale `cond_branch_N` key,
over-releasing every RC slot it dropped — bug (1)'s leak had absorbed
exactly one extra drop per awaited result — fixed by consuming the key
after the guarded cleanup (`src/codegen/async/state_machine.yo`;
issues/async-postwhile-branch-cleanup-double-drop.md; gated by the
fs_walker tests). **C12 Windows follow-up (2026-08-24):** PR #238's two
Windows legs failed at the BufWriter Dispose test — the dispose flush used
CRT `_write`, but async-opened file fds wrap FILE_FLAG_OVERLAPPED handles
CRT `_write` cannot serve. Fixed with a per-platform positioned
`__yo_sync_write` runtime shim (POSIX: pwrite + ESPIPE fallback; Windows:
OVERLAPPED WriteFile with low-bit hEvent so completions never post to the
async loop's IOCP), surfaced as `std/sys/file.yo write_sync`; the CRT
`_write` binding is deleted from `std/libc/windows.yo`. **C11 FIXED
2026-08-24** (static-data rewrite + tests + scan-loop cleanup + the
`generic`→`forall` data bug — see the C11 row). Remaining: C7
(reclassified → O7, now DECIDED — lands with the S2 sweep) — §2 is
otherwise COMPLETE.

| # | Bug | Where |
|---|-----|-------|
| C1 | **`https://` is silently downgraded to cleartext HTTP** — client accepts the scheme, connects to :443, speaks plaintext. Until TLS exists, `fetch` must THROW `UnsupportedScheme` on https. | `std/http/client.yo:256-281` |
| C2 | `_make_sockaddr` hardcodes `::1` for EVERY IPv6 address (copy-pasted in tcp+udp); `accept` fabricates peer IP as `0.0.0.0`; `local_addr` echoes the bind arg so port-0 ephemeral binds report 0 (no `getsockname`) | `std/net/tcp.yo:44`, `std/net/udp.yo:42` |
| C3 | `lookup_host` imports `AF_INET6` but silently drops every AAAA record | `std/net/dns.yo` |
| C4 | `DateTime.to_string` always emits `Z`, ignoring the struct's own `utc_offset_secs` — non-UTC values stringify as UTC | `std/time/datetime.yo` |
| C5 | `crypto.random_range` is modulo-biased (no rejection sampling) — a bias defect in a module advertising crypto security; `random_f64` returns closed `[0,1]` not `[0,1)` | `std/crypto/random.yo` |
| C6 | `f32`/`f64` implement `BitAnd/BitOr/BitXor/BitNot` (C rejects float bitwise — likely doesn't even codegen); `bool` implements `Add/Sub/Mul/Div/Mod/Negate/shifts` (~290 lines); unsigned ints implement `Negate` | `std/prelude.yo` (impl blocks) |
| C7 | ~~GC `Trace` gaps in `imm/`~~ **RECLASSIFIED 2026-08-22 (wrong premise):** the imm family is ATOMIC RC, and `__yo_decr_rc_atomic` does no cycle bookkeeping by design (Arc pattern — atomic objects are never GC-tracked), so a `Trace` impl there would be dead code; the ArrayList analogy does not transfer (ArrayList is thread-local RC). The REAL issue: `Arc(V)` requires `V <: (Send, Acyclic)` while imm types require only `Send`, so a cycle routed through an imm structure leaks silently and unavoidably. → S2 decision (new **O7**): require `Acyclic` on imm element types like Arc does (breaking), or keep `Send`-only and document the leak. Module docs now warn either way. | `std/imm/*` |
| C8 | `Channel.send` DROPS the value on failure (`Result(unit, unit)`); Rust returns `SendError(T)` | `std/sync/channel.yo` |
| C9 | `walker.WalkOptions.follow_symlinks` is declared and never read | `std/fs/walker.yo` |
| C10 | `Instant.now()`/`DateTime.now_utc()` discard `clock_gettime`'s return code — a failing clock silently yields epoch | `std/time/instant.yo`, `datetime.yo` |
| C11 | **FIXED 2026-08-24.** `decode_html` carried three `// TODO: proper break` overflow hacks, and the module was UNTESTABLE — `html_entities.yo`'s runtime map build emitted one ~2,125-insert C function that CRASHED clang at -O0 (why zero tests existed). Landed: static-data blob rewrite (2,256→76 lines), the test suite (`tests/encoding/html.test.yo`), the scan-loop cleanup — plus a data bug found by re-encoding: `generic` was a mangled `forall`, so `&forall;` never decoded. issues/fixed/html-entities-runtime-map-uncompilable-in-tests.md | `std/encoding/html.yo` |
| C12 | ~~`TempDir`/`TempFile` doc says "RAII-managed" but neither implements `Dispose`; `BufWriter` has no `Dispose` so buffered bytes are silently lost~~ **ALREADY DONE — row was stale, corrected 2026-08-25.** Verified: `std/sys/bufio/buf_writer.yo:173` has a `Dispose` impl (best-effort sync flush) and `std/fs/temp.yo` has six `Dispose` references. NOTE the BufWriter `Dispose` is load-bearing for D5: a SYNC `dispose` cannot await an async `Writer.write`, which is exactly what makes "BufWriter wraps any Writer" structurally hard | `std/sys/bufio`, `std/fs/temp.yo` |
| C13 | `sync/rwlock` doc claims atomicity it doesn't have; `mutex.yo` doc says `Drop` where the trait is `Dispose`; `Channel`/`WaitGroup` doc examples call `Thread.spawn(() => …)` against the real `(io : Io)` signature; `imm/map.yo` docstring demos an `Index` impl the type doesn't have; `ArgParser` doc shows three methods that don't exist; `toml.yo` doc imports a nonexistent `std/encoding` barrel | various |
| C14 | **`File` never tracked its position** — `read`/`write_string`/`write_bytes` hardcoded the pread/pwrite OFFSET to 0, so repeated reads returned the same bytes, repeated writes overwrote at the start, `seek` was a silent no-op (it moved the DESCRIPTOR's position, which positional I/O ignores) and `position()` always answered 0. **FIXED 2026-08-25 (PR #277)** with `File._pos` and three red-first tests. Found by the D5 scoping survey, NOT by this section | `std/fs/file.yo` |
| C15 | **`RwLock.write_unlock` never woke blocked readers** — its `_readers > 0` branch is unreachable by the lock's own exclusion invariant, so only `_write_cv.signal()` ever ran and readers parked in `_read_cv.wait` were never woken. Not a latency bug: the red-first test HANGS for the full 300 s (rc=124). The existing test "readers wait for writer across threads" joins the writer BEFORE spawning readers, so it never blocks one. **FIXED 2026-08-25** — broadcast to readers AND signal a writer. Found by the D7 scoping survey | `std/sync/rwlock.yo` |
| C16 | A trait `?=` DEFAULT that awaits `Self.<async method>` is never monomorphized — the emitted C function is hollow (`void*` params, body of `// Failed to transpile` comments) while `check` and `compile` are both green. Blocks D5's default methods (`read_to_end`, `write_all`, `lines()`). OPEN — issues/trait-default-awaiting-self-async-method-emits-hollow-fn.md | compiler |
| C17 | `Dyn(trait)` whose method returns `Impl(Future(...))` emits the on-demand Future struct INTO the middle of the open vtable typedef; clang rejects it with 7 errors. Blocks one of the two spellings of "BufReader/BufWriter wrap ANY Reader/Writer". OPEN — issues/dyn-trait-with-future-returning-method-splices-struct-into-vtable.md | compiler |
| C18 | **A struct literal that OMITS a required field is silently accepted** — `yo check` says "evaluator OK", the field is uninitialised, and the program SIGSEGVs. This directly undermines §1's "additive-only changes to stable modules" promise: adding a field to a stable struct silently breaks every construction site not updated. OPEN — issues/struct-literal-missing-field-silently-accepted.md | compiler |
| C19 | Passing a C `int` where `i32` is declared is accepted by the evaluator; codegen then splices a Yo type expression into a C identifier (`__yo_dyn_box_unknown_fn(T : Type) -> Type`) and clang fails with `expected ')'`. Loud, but the diagnostic names nothing the user wrote. OPEN — issues/int-vs-i32-mismatch-reaches-codegen-and-emits-malformed-c.md | compiler |

---

## 3. Cross-cutting decisions (each becomes a short ADR section when implemented)

### D1 — Error handling: three blessed styles, no fourth

**ADR WRITTEN 2026-08-25** — D1 and D2 are now encoded as conventions in
`.github/instructions/yo-design.instructions.md` ("std error handling: three
blessed styles, no fourth" and "std naming conventions"), so a future std change
is told the rule without having to read this plan. The *enforcement* — migrating
the existing violations — is still the S2 sweep.

- **Effects (`exn : Exception` / `IoExn`)** for I/O and anything on the `io` path
  (fs, net, http, process). Already dominant; bufio's `Future(Result(_, IoError), Io)`
  and env's `Result(_, String)` migrate to it.
- **`Result(T, TypedError)`** for pure fallible transforms: parsing, decoding,
  conversion. Every error type is a real enum implementing `Error()` — kills
  `Result(_, String)` (`toml_parse`, `Regex.new`, `base64_decode_string`,
  `env.cwd`).
- **`Option(T)`** only for lookups where absence is not an error.

Supporting prelude work: `AnyError` downcast (`is(T)`/`as(T)`), a
`derive_rule(Error, …)` so error enums stop hand-writing `ToString` + `Error()`,
and `Error.source` actually used for chaining (`wrap`/`context` helper).

### D2 — Naming conventions (the rename sweep, §5, enforces these)

| Concept | Blessed name | Displaces |
|---|---|---|
| element count | `len()`; `is_empty()` on EVERY container | pub `size` fields, missing `is_empty` on ArrayList |
| map insert | `insert(k, v) -> Option(V)` (old value) | `set` (HashMap/BTreeMap/OrderedMap) |
| set insert | `insert(v) -> bool` | `add` (HashSet) |
| sequence append | `push` / `push_front` / `push_back` | — |
| membership | `contains` (seq/set), `contains_key` (map) | BTreeMap's missing both |
| value iterator | `into_iter()`; pointer iterator `iter()` | `iter_ptr`, OrderedMap's value-`iter` |
| accessors | bare noun, no `get_` prefix | `ParsedArgs.get_flag`, reflection `get_info` |
| byte codecs | `encode` / `decode` | ~~`to_ascii`/`to_unicode` (punycode)~~ — module deleted, §6 |
| text formats | `parse` / `stringify` | `decode_html` (→ `html_decode` + new `html_encode`) |
| conversion | `from_` / `to_` / `into_` (Rust discipline) | `to_cstr` vs `to_c_str` pair |
| comptime twins | `Comptime` prefix on traits, `comptime_` on methods — and fix the one infix outlier (`to_comptime_string`) | — |

### D3 — Prelude trait additions (the deepest gap in the whole audit)

**Progress (S1 chunk 1, 2026-08-23, branch s1-prelude-traits):** D3.1
`Default` trait + impls (all int/float primitives, bool, `Option(T)`→`.None`,
`String`→empty, `ArrayList(T)`→empty) and `Option.unwrap_or_default`; D3.2
`From`/`Into` traits + the lossless integer/float widening seed impls
(`into(T)` disambiguates by its type argument like `try_into`; multiple
`From` impls on one type are selected with the explicit
`(T <: From(S)).from(v)` dispatch form — Yo has no overloading); D3.3
`Ord.cmp -> Ordering` with a `<`/`==`-derived default, float TOTAL-order
overrides (NaNs equal, greater than +inf) and float `Hash` DELETED per the
no-PartialOrd decision; `ComptimeOrd`/`ComptimeToString` exported; dead
`Exponentiation`/`ComptimeExponentiation` deleted. `derive(Default)` is
DEFERRED to the next chunk: emitting `(FieldType <: Default).default()` per
field needs a Type→source-expr rendering the derive surface
(`TypeFieldInfo.field_type : Type`) doesn't expose yet — needs either a
`Type.to_expr` builtin or per-field type names guaranteed reparseable.

**CORRECTION + LANDED (2026-08-25, branch s1/derive-default):** that deferral
was based on an incomplete survey — the derive surface DOES expose field types
(`Type.get_struct_fields(T).get(i).field_type`), and a reparseable NAME is not
needed in the first place. `derive(Default)` now emits
`Self(f : (Type.get_struct_fields(Self).get(i).field_type <: Default).default(), …)`
— reaching each field's type as a VALUE by index, which needs no name and no
import at the use site. Structs only: an enum has no canonical default variant
(Rust needs an explicit `#[default]`; guessing the first variant would be a
silent choice).

Getting there surfaced THREE pre-existing defects, all fixed in the same change
rather than routed around:
1. `Type.to_comptime_string` is a DISPLAY renderer returning
   `<struct:…>` / `<enum:…>` for every INSTANTIATED generic — and two shipped
   derive rules fed it back into generated source. So `derive(Clone)` failed on
   every generic struct, and `derive(FromJson)` failed on every struct with an
   `Option(…)` / `ArrayList(…)` field. Both rewritten name-free (`Self(…)` and
   the indexing form); the renderer gained the doc comment it never had.
   issues/fixed/derive-rules-name-types-through-a-display-renderer.md
2. `(T <: Trait).static_method()` bound `Self` to the TRAIT rather than to `T`,
   so a generic static whose body constructs `Self(…)` failed with "Receiver
   type is undefined when implementing trait" — while the plain `T.method()`
   form worked, which is what isolated it.
   issues/fixed/subtype-dispatch-binds-self-to-the-trait.md
3. (process, not code) #260 landed without its re-recorded `help-compile`
   golden, leaving develop red until #261.
**PR #240 opened 2026-08-24 (stacked on #238)** after the full local battery:
check 154+262, suite 2823/2823 under the S1 stage-1, gates green after
re-recording the 2 legitimately-drifted CLI goldens (`check-watch-once` expr
count, `lsp-completion` type ids + the new `default` entry), FIXPOINT_HOLDS.

**Progress (S1 chunk 2, 2026-08-24, branch s1-option-result, stacked on
chunk 1):** D3.7 Option/Result completion — Option gains `expect`,
`is_some_and`, `inspect`, `take`/`replace` (`inout(self)`, per the prelude's
Index/Hash precedent), `zip` (returns `Option(IterPair(T, B))`; defined after
`IterPair`), `transpose`; Result gains `unwrap_or`, `unwrap_or_default`,
`expect`/`expect_err`, `inspect`/`inspect_err`, `flatten`, `transpose`; both
gain `Ord` (`None` before every `Some`; every `Ok` before every `Err`; `cmp`
via the chunk-1 default) and `Hash` (variant tag mixed into the inner hash),
and `ToString` in `std/fmt/to_string.yo` (`Some(42)` / `Ok(1)` forms — so
`println(opt)` compiles). `expect` takes `msg : str` and forwards to
`__yo_panic` (prelude cannot import std/assert). NOT taken: `is_ok_and`/
`is_err_and` (not in the audit list), Rust's `get_or_insert` family (needs
`inout` chaining ergonomics first). Tests: 5 new cases in
tests/prelude.test.yo (18/18) — note closures capture locals BY VALUE, so
side-effect tests observe through an ArrayList.

**Progress (S1 chunk 3, 2026-08-24, branch s1-iterators, stacked on
chunk 2):** D3.4 iterator completion (minus `collect`/`rev`/`flat_map` —
see below) — consuming methods `find`, `position`, `last`, `nth`, `sum`
(`A <: (Add(A), Default)`; `Add(T, Output := T)` binding syntax is NOT
supported on parameterized trait constructors — plain bounds + per-call
resolution works), `min`/`max` (`A <: Ord(A)`, first-of-equals /
last-of-equals); new combinators `chain`, `take_while`, `skip_while`,
`filter_map`, `peekable` (with inherent `peek()`); `filter`'s callback
asymmetry FIXED — the predicate now takes the element BY VALUE like `map`
(breaking, in-window; 3 test files swept). **Two compiler findings en
route:** (1) variable-bound combinator receivers with a structurally-erased
type param (`m := xs.map(f); m.for_each(g)`) failed generic-impl matching —
pre-existing, latent; FIXED for map/filter_map/chain by walking the SomeT
resolution-chain cell in `_bind_forall_from_type_args`
(issues/varbound-combinator-receiver-impl-match.md). (2) `flat_map` is
DEFERRED entirely: its doubly-derived `B` (through `F → M → Item`) ships
under-resolved in the stamped type — var-bound fails at eval (empty `F`
cell), chained fails at CODEGEN (abstract-keyed specialization,
`B_id_B_wcforall` in the mangled name, incompatible C struct split) — needs
the stamping-side fix first (same issue doc, REMAINING section). Also
deferred, each needing new machinery: `collect`/`FromIterator`
(trait-generic-method prototyping), `rev`/`DoubleEndedIterator` (pairs with
D3.5 Range iteration). Tests: 10 new cases in
tests/iterator_combinators.test.yo (28/28). **Both deferrals are now
CLOSED — see chunk 7 below.**

**Progress (S1 chunk 7, 2026-08-24, branch fix/comptime-type-arg-binding):**
the last two D3.4 items, `collect` and `rev`, **land together with the
compiler bug that blocked `collect`**.

- `rev` / `DoubleEndedIterator`: a new prelude trait (`Item` + `next_back`),
  the `IterRev(I)` adaptor — itself double-ended, so `.rev().rev()` is the
  identity — and a blanket `rev` in its OWN impl block, so the
  `DoubleEndedIterator` bound sits on a bare-SomeT receiver pattern, the only
  shape where an impl where-clause is actually enforced during generic-impl
  matching (`rev` on a forward-only iterator then fails at method resolution
  rather than late in specialization). `next_back` impls: all 20
  `Range`/`RangeInclusive` forms (the inclusive one mirrors the forward
  canonical-empty sentinel exactly, so `T.MIN ..= x` terminates from the back),
  `ArrayListIter` and `_ArrayIter` via a `_back_taken` COUNTER (a counter, not
  a back cursor, so the forward guard keeps reading `_list._length` live and
  nothing has to coerce the comptime value-generic `N` into a runtime field),
  and `DequeIter`/`DequeIterPtr` with ZERO new fields — `_pos` + `_remaining`
  already bracket both ends. Adaptor `next_back` impls (on `IterMap` etc.) are
  DEFERRED: a nominal receiver pattern is not discriminated by its
  where-clause, so such an impl would claim `DoubleEndedIterator` whether or
  not its source is one.
- `collect` / `FromIterator`: the trait keeps TWO MONOMORPHIC statics
  (`from_iter_new` + `from_iter_add`) and the iteration loop lives in the
  blanket `collect`, which is what removes the "trait-generic-method
  prototyping" the deferral named — std declares such a method exactly once
  (`CustomAllocator.realloc`) and has never dispatched it. The element assoc
  type is named `Elem`, NOT `Item`, because the assoc-type registry is keyed by
  (type id, label) with no trait discrimination and takes the first match — an
  `Item` here would collide with the collection's own `IntoIterator.Item`,
  benign for `ArrayList` but genuinely divergent for `HashMap`
  (`Bucket(K, V)`). `from_iter_add` returns the accumulator so one signature
  covers reference collections and the value newtype `String`. Impls:
  `ArrayList`, `HashSet`, `Deque`, `String`. `HashMap`/`BTreeMap` are NOT
  included: collecting a map needs the element type to be a constructed pair
  (`Elem := IterPair(K, V)`), i.e. recovery by unifying an associated type
  against a CONSTRUCTED pattern — nothing in std does that today and it is the
  same two-hop family as the `flat_map` deferral. Once that lands, a map impl is
  four lines.
- **Compiler bug fixed en route** (the actual blocker):
  `evaluate_function_call` routed ANY call whose arguments are all `TypeVal`s
  into the CTFE type-constructor path, so an ordinary function whose only
  parameter is `comptime(C) : Type` came back under-resolved — and worse, had
  its body CTFE-executed. The gate now consults the callee's DECLARED
  signature (every real type constructor is declared `-> comptime(Type)`)
  instead of the shape of the arguments;
  issues/fixed/comptime-type-argument-alone-does-not-bind-the-generic.md.
- SECOND pre-existing bug surfaced: `.rev().rev()` does not compile —
  instantiating a generic struct over ITSELF mints two C type identities
  (`IterRev(IterRev(Range(i32)))` twice under two struct ids). Reproduced
  identically on the previous compiler, so it is not from this branch;
  `IterRev` is just the first std adaptor whose own type is a legal argument to
  itself. Filed with a reproducer in
  issues/nested-same-adaptor-instantiation-identity-split.md; the tests cover
  `.rev()` and point there for the nested case.
- HONEST LIMIT, stated rather than papered over: `.map(f).collect(C)` at TWO
  different Item types in one module still trips the pre-existing shared-stamp
  pollution (issues/iterator-chain-shared-stamp-cross-item-pollution.md), and
  no spelling of `collect` fixes that — the pollution lives in the shared
  `IterMap` stamp, not in the consumer. Tests keep every mapped chain at one
  Item type.

**Progress (S1 chunk 5, 2026-08-24, branch s1-tostring, stacked on
chunk 3):** D3.8 ToString completion — the eight C-interop integers
(`int`/`uint`/`short`/`ushort`/`long`/`ulong`/`longlong`/`ulonglong`) plus
`longdouble` (`%Lg`), and containers: `ArrayList(T)`/`Array(T, N)` print as
`[a, b, c]` where `T <: ToString` (nests through Option/Result's chunk-2
impls), so `println(list)` compiles. `to_string.yo` now imports ArrayList
(no cycle — array_list does not import fmt). The `unit` ToString impl now
SHIPS (2026-08-24, branch fix/inout-unit-ref-spill): the invalid C
ref-spill for an `inout(self)` receiver of type unit is fixed in codegen
(`((void*)0)` — the callee's `void* self` is never read;
issues/fixed/inout-unit-receiver-void-ref-spill.md), so `().to_string()`
compiles and returns `"()"`. **D3.8 is COMPLETE**: the carve-out found
while landing it — `unit` in a C *declaration* position was emitted as
`void`, so a by-value `unit` parameter (hence `println(())`), a `unit`
struct field, a tuple containing `unit` and `ArrayList(unit)` all failed to
compile — is fixed too (branch codegen/unit-storage-byte,
issues/fixed/unit-typed-params-and-fields-emit-c-void.md). Storage
positions now spell a type whose C rendering is exactly `void` as a
one-byte placeholder (`get_storage_type_string`), and the matching empty
argument slot is filled; return position keeps `void`, so the guard fires
only where today's C is already invalid and the emitted C for every
compiling program is byte-identical (verified: 8/8 corpus files, same
sha256). Tests: 2 chunk-5 cases + 1 unit case in tests/fmt.test.yo (6/6)
plus tests/unit_as_value_type.test.yo (6/6).

**Progress (S1 chunk 4, 2026-08-24, branch fix/range-op-era-split —
UNPARKED, compiler fix + std landed together):** D3.5 implemented on the
std side (`RangeOp`/`RangeInclusiveOp` for all ten integer types;
`Iterator` for `Range(T)`/`RangeInclusive(T)`, the inclusive form flipping
to canonical-empty after yielding `end` so `start..=T.MAX` terminates).
The blocker — `..`-built values living in their own TYPE ERA so no trait
impl ever dispatched on an operator-built range — was a compiler bug one
level deeper than first recorded: `substitute()` KEEPS the
trait-definition era's struct id/ctor-fid when rewriting `Range(Self)`'s
type arguments, so the operator's stamped result was an instance the ctor
memo never issued. Fixed by canonicalizing the operator-dispatch result
stamp through the CTFE ctor memo
(`canonicalize_instantiation_via_ctfe_memo`, evaluator/calls/comptime_fn.yo
+ the operator arm of calls/function.yo) — record:
issues/fixed/range-op-result-era-split-blocks-iteration.md. En route,
found (pre-existing, OPEN, not range-specific): an Item-binding combinator
(`min`/`max`/`sum`) after `.map` at a SECOND Item type adopts the FIRST
call's Item — the combinator-chain shared-stamp pollution,
issues/iterator-chain-shared-stamp-cross-item-pollution.md (same
under-resolution family as the flat_map residual). Tests: 4 range cases in
tests/iterator_combinators.test.yo (32/32).

**Progress (S1 chunk 6, 2026-08-24, branch s1-intoiter, stacked on the
chunk-4 fix branch):** D3.6 — every collection's inherent `into_iter` is now
a real `IntoIterator` TRAIT impl (ArrayList, HashMap → `Bucket(K,V)`,
HashSet, Deque, LinkedList, PriorityQueue, BTreeMap → `BTreeEntry(K,V)`,
plus `Array(T, N)` in the prelude), so `where(C <: IntoIterator)` /
`IntoIterator(Item := X)` generic code finally dispatches; the `for` macro
and all 394 collections tests are unaffected. DEFERRED: a blanket
IntoIterator TRAIT impl for every Iterator (so ranges/combinator chains
satisfy the bound too) — needs assoc-of-assoc (`Item := I.Item`) in a
blanket impl; the inherent blanket `into_iter` still serves the `for`
macro. FOUND (pre-existing — third face of the under-resolution
family): piling several instantiations of one where-bound generic leaves a
later instantiation's GC trace calls abstract-keyed → C compile failure;
minimal trigger LinkedList-then-BTreeMap. The C-compile symptom is FIXED
(branch fix/where-bound-gc-trace: traverse emission no longer delegates to
a never-emitted hard-generic trace spec;
issues/fixed/where-bound-intoiterator-gc-trace-abstract-key.md) — the
era-copy family root stays open via the flat_map/shared-stamp issues. Tests: 1 new case
in tests/iterator_combinators.test.yo (33/33), scoped away from the
landmine with a pointer at the issue.

1. **`Default`** trait + derive. Unblocks `unwrap_or_default`, map `or_default`.
2. **`From(T)` / `Into(T)`** (the prelude header already *claims* they exist).
3. **`Ordering` wired in**: `Ord` gains `cmp(self, rhs) -> Ordering` (default
   implemented via `<`/`==`), sort APIs take comparators via it. Today `Ordering`
   is a dead enum.
   **No `PartialEq`/`PartialOrd` split (decided with the user 2026-08-23,
   same taste as single-`ToString`/O5):** Rust's split exists to quarantine
   IEEE floats; Yo takes the smaller surface instead — (a) `cmp` is
   contractually a TOTAL order for every std impl; floats use a NaN-total
   order (all NaNs compare Equal to each other and Greater than every
   number incl. +inf; -0 == +0 — deliberately SIMPLER than IEEE
   `totalOrder`, and consistent with `==`) while the `<`/`==` OPERATORS
   keep plain IEEE behavior; (b) float `Hash` is DELETED (today's impl is
   `u64(i32(self))` — it truncates, so 0.5 and 0.9 already collide), which
   makes `HashMap(f64, …)` a compile error and kills the invariant-breaking
   case without a trait split; (c) if a real partial-order use case appears,
   `PartialOrd` can be ADDED additively later — the reverse is impossible.
4. **Iterator completion**: `collect` (via a `FromIterator` trait), `sum`, `min`,
   `max`, `find`, `position`, `last`, `nth`, `chain`, `flat_map`, `rev` (with
   `DoubleEndedIterator`), `take_while`, `skip_while`, `filter_map`, `peekable`.
   Fix `filter`'s callback asymmetry (`*(A)` vs `map`'s `A`).
5. **`Range(T) <: Iterator`** and `RangeOp` for all integer types — `for(0..10, …)`
   must work; today ranges don't iterate and only `usize` can even form one.
6. **`IntoIterator` actually implemented** by every collection (the `for` macro
   currently works by duck typing; generic `where(C <: IntoIterator)` code is
   impossible).
7. **`Option`/`Result` completion**: `expect`, `unwrap_or_default`,
   `Result.unwrap_or`, `flatten`, `transpose`, `inspect`, `is_some_and`, `take`,
   `replace`, `zip` — plus `Eq`/`Ord`/`Hash`/`ToString` impls so
   `println(opt)` compiles and options can key maps.
8. **`ToString` for every remaining primitive** (C-interop ints, `unit`) and
   containers (`Array`, `ArrayList`, `Option`, `Result`) — `println(list)` must
   work. Decide `Debug`-vs-`Display` split: recommendation — keep single
   `ToString` (Yo is not Rust; one string form), but route derive output through
   a `Formatter` so pretty/compact can be added additively later.
9. **`Hasher` design review**: `Hash` returning bare `u64` blocks DoS-resistant
   seeding and composite hashing. **DECIDED (user, 2026-08-24): full
   Rust-style `Hasher` trait** — `hash(self, hasher : inout(H))` writing into
   a streaming hasher (`write_u8`/…/`write_u64`, `finish`), with pluggable
   algorithms per map (SipHash-class seeded default; a fast unseeded option
   possible later). Breaking; lands in the S2 window with its own design
   round first (Hasher/BuildHasher shape, per-map seeding, derive(Hash)
   rework, every existing `Hash` impl + HashMap/HashSet/OrderedMap driver
   rewritten). The alternatives considered — keep bare `u64` forever, or a
   fold-style `hash(self, state : u64) -> u64` middle ground — were
   declined in favor of the most future-proof surface.

   **DESIGN ROUND STARTED 2026-08-25 — and it found a BLOCKER before any design
   debate.** The decided shape, transcribed from Rust
   (`fn hash<H: Hasher>(&self, state: &mut H)`), is in Yo:

   ```rust
   Hash :: trait(
     hash : (fn(generic(H : Type), inout(self) : Self, inout(hasher) : H) -> unit)
   );
   ```

   That is EXACTLY the shape that miscompiles. A trait method carrying its own
   `generic(...)` reads a PRIMITIVE `inout(self)` receiver as a POINTER — the
   emitted C is `(uint64_t)(self)` where `(*self)` is meant — so every primitive
   `Hash` impl would feed the hasher stack ADDRESSES instead of values. It is
   silent: no diagnostic, no crash, and #260's re-enabled `-w` diagnostics cannot
   see it because the bad cast is explicit. It was caught only by writing the
   trait and asserting a known FNV-1a value.
   issues/generic-trait-method-reads-primitive-inout-self-as-pointer.md.

   Isolation: the bug needs all three of (a) the method's own `generic(...)`,
   (b) an `inout(self)` receiver, (c) a PRIMITIVE receiver type. A struct
   receiver and a by-value `self` are both fine, and the non-receiver
   `inout(hasher) : H` parameter's write-back works — so the fault is
   specifically the scalar receiver's value read.

   **Consequence for phasing:** that fix is a PREREQUISITE for D3.9, not a
   parallel nicety. It is the third site in the `Variable.is_ref` family, after
   #258 (folded-const specialization) and
   issues/derive-tostring-on-a-generic-struct-emits-invalid-c.md (address-of-a-
   field in a generic impl); a single repair to ref-ness propagation may well
   cover all three, and they should be attacked together.

   Also confirmed while probing, worth recording so it is not re-derived: the
   `inout` marker goes on the LABEL, never the type — `inout(hasher) : H`, and
   `hasher : inout(H)` fails with `Variable "inout" not found`. The shipping
   bare-`u64` `Hash` is UNAFFECTED by all of this: its impls are non-generic
   (`(hash) : ((self) -> u64(self))`), so condition (a) never holds.
10. **Format specs**: template strings gain `${v:spec}` (width/precision/fill/
    align/hex) routed through `fmt.Writer`'s existing primitives — the engine
    exists, nothing connects it.

    **SEPARATOR DECIDED (user, 2026-08-25): `:`**, i.e. `${total:>10.2}`, matching
    Rust and Python exactly. A design round recommended `@` instead, on the
    grounds that `@` is an operator CHARACTER with no operator TOKEN
    (`src/token.yo` vs the closed tables in `src/lexer.yo`), so a depth-0 `@`
    cannot occur in any valid expression at all — making the split rule total
    with no fallback and no residual. The user chose familiarity over that
    proof. The accepted cost, recorded so it is not rediscovered as a surprise:
    `${name:T}` with no space, where `T` is both a spec kind letter and a type in
    scope, is a silent reinterpretation rather than an error, and `yo fmt` cannot
    normalize it away because it re-emits templates from the raw source slice.
    Zero occurrences exist today. Re-verified 2026-08-25 across the whole tree:
    of the 9 colon-bearing `${…}` matches, 7 end in `)` before the colon is
    reached (the colon sits inside a call's arguments or inside `String.from(":")`),
    1 is in a doc comment, and 1 is a plain `str` literal that is not a template
    at all. The backward walk stops on `)` at its first character in every case,
    so the split is safe on the current corpus.

    **Stage 1 (the engine) LANDED 2026-08-25 (PR #259)** — full battery: suite
    2886/2886, CLI scorecard 51/0/0, gates green, `STAGE3_RC=0 FIXPOINT_HOLDS`,
    hollow sweep `SWEEP_GATE_OK` with zero allowlisted failures; tests in
    `tests/format_specs.test.yo` (7). `std/fmt/spec.yo` (the `FormatSpec` vocabulary: total `parse`,
    `pad`, and a `pad_numeric` that puts zero fill BETWEEN the sign/prefix and
    the digits — `write_padded` pads outside the sign, which made `-0000042` and
    `0x0000002a` unreachable) plus `std/fmt/format.yo` (the `Format` protocol:
    concrete impls for the ten integers with radix and sign-magnitude so
    `i64.MIN` does not overflow, the floats via `Writer.write_f64`, and ONE
    blanket over every `ToString` type for width/fill/align/truncate). Three
    assumptions were proven by compile first: the `i64.MIN` magnitude trick is
    exact, a bare-`T` blanket TRAIT impl is legal (unprecedented in std), and a
    concrete impl wins over the blanket.

    It was blocked by two codegen faults it surfaced — a blanket-impl result
    bound to a local lost its body (a SILENT wrong answer: ten spaces instead of
    `   Some(4)`), and `FormatSpec.pad` with a local `String` emitted invalid C.
    Both turned out to be ONE bug, far broader than the formatter: a specialized
    generic's `inout` parameter lost its by-ref binding whenever the argument
    folded to a comptime constant, so codegen's two channels disagreed (the C
    signature from the spec Func meta stayed a pointer, the body read the env's
    `Variable.is_ref` and treated it as a value). Fixed in #258
    (issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md), which
    also un-blocked this; the second manifestation was silent only because
    `--release` passed a bare `-w`, since decoupled. Stage 1 tests: 7/7 in
    tests/format_specs.test.yo, including the inline-`Option` receiver shape that
    used to crash.

    **Stage 2** — the `${expr:spec}` parser sugar — is then a contained change:
    `parse_template_string` (`src/parser.yo`) peels the spec off the right end of
    an interpolation's raw text with a backward walk over a closed spec charset
    that excludes `)`, `]`, `}`, quotes, comma and whitespace (so it physically
    cannot cross out of a call or into a string literal), requires the character
    before the run to be `:` and the one before THAT to be a non-space (which is
    what preserves spaced colon-pairs), and lowers to `e.format("<spec>")` at the
    same site where `make_ts_call` builds `e.to_string()` today.

    **Stage 2 LANDED 2026-08-25.** The split rule as implemented, and why it is
    safe without any depth or quote tracking: the backward walk runs over a
    CLOSED character set — alphanumerics plus `. < > ^ + - # * _ = ~` — that
    deliberately EXCLUDES `)`, `]`, `}`, quotes, comma and whitespace, so it can
    physically never cross out of a call's argument list, out of a bracket, or
    into a string literal. Three further conditions, all required: the run must
    be non-empty, the character before it must be `:`, and the character before
    THAT must not be whitespace — which is what preserves a spaced colon-pair
    (`${a : b}` keeps its meaning while `${x:>8}` splits).

    The auto-import is gated on whether any spec appeared: a file with no specs
    still imports `std/fmt/to_string`, so its import closure, lowering and
    alloc_id sequence stay byte-identical, and only a file that actually uses a
    spec pulls in `std/fmt/format`. Spec text can never contain a quote or a
    backslash — the character set excludes both — so the synthesized StringLit
    needs no escaping.

    Tests: `tests/template_string_specs.test.yo`, which deliberately does NOT
    import std/fmt (the parser's auto-import is half of what is under test),
    mixes a spec'd and an unspec'd interpolation in one template, and pins the
    negative cases (`${String.from(":")}` and a colon inside a nested call
    argument must not split).

### D4 — String indexing model (the one genuinely hard call)

`String.len()` is rune-count O(n), `Index` returns a BYTE, `at()`/`substring()`/
`index_of()` are char-indexed, and `starts_with(position)` is ~~byte-indexed~~
**a BROKEN char walk** — `_has_prefix` (`std/string/string.yo:883`) increments
its char counter when it *sees* a lead byte and then steps one byte, so for
`"你好"` with `position = 1` it stops mid-character at byte 1 rather than byte 3.
`_index_of_impl`'s `from_index` skip has the identical shape and defect. So
`position` is neither basis. Mixed bases in one type is the worst of both
worlds (regex pays a `_byte_to_char_index` conversion per match).

**D4 is not introducing a new convention — it is ending a 2-vs-2 split.** The
comparison table below omits two string types that are ALREADY byte-based:
`str.len()` is bytes (`std/prelude.yo:5756`) with `slice_copy` a byte range
(`:5772`), and `StringBuilder.len()` is bytes
(`std/string/string_builder.yo:45`). Byte-indexing `String` puts it on the same
footing as the two types it interoperates with most, which is a stronger
argument than consistency with Rust/Go alone.

**The measured migration plan is `plans/STD_API_AUDIT_D4_PLAN.md`** — per-method
contracts, exact call-site counts, a 50-site ASCII-invariance classification, the
trap list, the PR sequence, and an explicit UNMEASURED section. Read it before
starting: it corrects three claims in this section and finds five surfaces this
section does not name (the `Pattern` trait's five index-carrying signatures,
`slice_copy`/`slice_copy_inclusive` behind the `s(a..b)` sugar, the comptime
string builtins riding on `substring`, `Token.character`'s open byte-indexing
audit, and `RegexMatch.index()`'s public basis change). It also finds that D4
**fixes seven live bugs** where a byte index is already being fed to a char
`substring`.

**DECIDED (O1, 2026-08-23): go byte-indexed like Rust/Go.** `len()` = bytes O(1);
`chars()`/`char_indices()` for rune walks; `char_len()` for the O(n) count;
all find/slice APIs byte-indexed with a documented char-boundary contract.
This is THE breaking change to do before stability — it cannot be done after.

~~**Step 1 of that plan (PR 1, additive vocabulary)**~~ **LANDED 2026-08-26.**
`String` and `imm.String` both gained `char_len()`, `char_indices()`,
`is_char_boundary()`, `floor_char_boundary()`, `ceil_char_boundary()` and
`try_substring()`, and `imm.String` gained `chars()`. All of it is built on
`std/encoding/utf8.yo` (D8, #286) — no second decoder, no second width table.
Nothing existing changed: the only line REMOVED anywhere in that PR was
`export(String);` in `std/imm/string.yo`, replaced by a longer export list.
`char_len() == len()` on both types today, which is exactly what makes the
D4 PR 2 migration a provable no-op. Coverage is
`tests/string/string_char_api.test.yo` (17 tests) plus a 6-test section in
`tests/imm_string.test.yo`, every assertion multibyte with hand-computed byte
offsets. The remaining D4 steps (PRs 2-9) are unchanged and still in
`plans/STD_API_AUDIT_D4_PLAN.md` §4.

**SCOPE EXTENDED (user, 2026-08-25): `std/imm/string` is IN, and so is the
`imm.String` → `ImmString` rename** (moved here from the §4 imm row, which had it
as an open "or drop if COW String lands" question — it is now part of this one
decision).

The reason is sharper than consistency. The two string types already disagree on
what the SAME method name means:

| | `std/string` `String` | `std/imm/string` `String` |
| --- | --- | --- |
| `len()` | runes, O(n) | runes, O(n) (`:83`) |
| `index_of()` | **char** index | **byte** index (`:255`) |
| slice | `substring()` char-indexed | `slice()` **byte** range (`:199`) |
| byte access | `Index` → byte | `byte_at()` (`:116`) |
| `at()` | char → rune | char → rune (`:577`) |

So `index_of` returns a byte offset on one type and a character offset on the
other. Code moved between them — or an offset from one fed into the other's
slice — would be silently wrong on any non-ASCII input.

**MEASURED 2026-08-25: that hazard is UNREALIZED.** There are zero cross-type
index feeds in the tree, and `imm.String` has zero production consumers. The imm
half of D4 is therefore cheap insurance rather than a bug fix — which changes
its priority: it can land AFTER the `String` flip instead of blocking it. See
`plans/STD_API_AUDIT_D4_PLAN.md` §7.

Applying D4 to `imm.String` is SMALL: it is already byte-indexed where it counts
(`slice`, `index_of`, `byte_at`). The work is `len()` → bytes O(1), fold away the
now-redundant `bytes_len()` (it exists only because `len()` took the name for the
rune count), add `char_len()`, and give it `chars()`/`char_indices()`.

**Related doc defect, FIXED 2026-08-25 ahead of this work** (it was wrong today
and would otherwise have shipped in v0.2.17): `docs/en-US/DESIGN.md`,
`docs/zh-CN/DESIGN.md` and `std/string/string.yo`'s own header all called
`std/string`'s `String` an "Immutable String". It is growable — `push_str`,
`push_string`, `push_byte`, `reserve`, `clear` all take `inout(self)` — and the
source comment contradicted itself in consecutive lines. The immutable one is
`std/imm/string`. Corrected in all four places; the naming confusion that error
reflects is exactly what the `ImmString` rename above is for.

### D5 — Async I/O traits + the fd problem

**Byte-count carry-over from S2 chunk 2 (2026-08-25).** Chunk 2 moved the NET
byte counts to `usize` (TcpStream read/write_str/write_string/write_bytes,
UdpSocket send_to/recv/recv_from/send), which is the shape this section
specifies. The FILE and BUFIO sides were deliberately NOT converted with them,
and must land here rather than as a stray rename, because they are not merely a
different integer type — they are three different error models:

| | returns | error style |
| --- | --- | --- |
| `TcpStream.read` | `Future(usize, IoExn)` | throws (DONE) |
| `File.read` | `Future(i32, IoExn)` | throws |
| `BufReader.read` | `Future(Result(i32, IoError), Io)` | Result + `IoError` + `Io` effect |

Converting `File.read` alone would still leave bufio split three ways, so the
`usize` change rides with this section's `IoExn` adoption and the
`std/sys/bufio` → `std/io` move. Until then `TcpStream.read` and `File.read`
disagree on their count type — a KNOWN transient, tracked here.

`std/io.Reader`/`Writer` were sync, orphaned (zero implementors), and
incompatible with the async model — **DELETED 2026-08-25** (§6 round 2), so
`std/io/` is now an empty namespace waiting for this redesign. Redesign: async `Reader`/`Writer` traits
(`read(buf, io) -> Future(usize, IoExn)`), implemented by `File`, `TcpStream`,
`BufReader`, `BufWriter`, `Stdin`/`Stdout`; default methods `read_to_end`,
`read_to_string`, `write_all`, `lines()`; `io.copy(r, w)`. BufReader/BufWriter
move from `std/sys/bufio` to `std/io`, wrap any Reader/Writer (not raw fds),
and adopt `IoExn`. New `std/io/stdio.yo`: `stdin()/stdout()/stderr()` typed
handles (kills the `BufReader.new(i32(0))` magic number in the compiler's LSP).

### D6 — TLS position

No TLS in tree; C1 makes https throw for now. **DECIDED (O2, 2026-08-23):
`std/crypto/tls.yo` over platform libraries (SecureTransport/Schannel/OpenSSL)
via the existing `pkg_config` mechanism, behind one `TlsStream` type
implementing the D5 traits.** Until it lands, std honestly refuses https.

### D7 — sync/concurrency shape

- `Mutex(T).with_lock` closure style is the flagship — extend it: `RwLock(T)`
  becomes generic with `with_read`/`with_write` guards.
- Delete the parallel C-tier (`mutex_t`, `cond_t`) — **DONE 2026-08-25** (§6
  round 2); no `RawMutex` was needed after all, `Cond.wait` already took
  `*(__YO_THREAD_SYNC_TYPE)` and only the deleted `cond_t.wait` wanted
  `mutex_t`. Still to do: stop exporting `__MutexUnlocker` (**DONE**, round 1)
  and `__YO_THREAD_SYNC_TYPE` (blocked — the compiler itself consumes it).
- ~~Atomics: `fetch_add/sub/and/or/xor/min/max` for ALL integer atomics (today
  only `AtomicI32` has add/sub), `fence`, receiver convention unified.~~
  **DONE 2026-08-25** (`std/sync/atomic.yo`, `tests/sync/atomic.test.yo`,
  both `THREAD_SAFETY.md`). The row's premise re-measured and held: all 11
  atomic types carried `new/load/store/swap/compare_exchange`, and `fetch_add`
  / `fetch_sub` existed on `AtomicI32` alone. Now every one of the 10 INTEGER
  types carries all seven `fetch_*` ops; `AtomicBool` deliberately carries
  none (it is not an integer atomic, and Rust's `fetch_and/or/xor`-on-bool is
  a separate request, not this row). `fence(order)` added, over the C11
  ordering model `MemoryOrder` already models — `atomic_thread_fence` was
  already bound in `std/libc/stdatomic.yo`, so no new C surface.

  **Receiver — the row is right, and the inconsistency is cross-module, not
  within the file.** Every method in `atomic.yo` already used `inout(self)`,
  so the file was internally uniform; what it was out of step with is the rest
  of `std/sync`, where every other `atomic(ref(...))` type (`Mutex`, `RwLock`,
  `Cond`, `Channel`, `Once`, `WaitGroup`) takes `self : Self`. Unified ON
  `self : Self` (46 receivers rewritten): an atomic IS a shared handle,
  mutation goes through the C11 operation rather than a Yo place-write, so
  `inout` only demanded a mutable binding at every call site without buying a
  guarantee — and `&(self.field)` under a by-value receiver was already proven
  legal by `Mutex._raw_lock`. `compare_exchange` keeps `inout(expected)`,
  which really is written back. No call site in `std/`, `src/` or `tests/`
  needed a change (going from `inout` to by-value only ever relaxes the call
  site); `once`/`waitgroup`/`channel`/`mutex`/`rwlock`/`thread_safety`/
  `async_await` test files all re-run green.

  **Lowering — measured, and NOT what the row assumed.** `AtomicI32` keeps a
  native lowering for `fetch_add/sub/and/or/xor` (the C11
  `atomic_fetch_*_explicit` generic macros). It is the ONLY type that can:
  a `c_include` binding is keyed by C symbol name (`extern_name = label`,
  `src/evaluator/exprs/c_include.yo`) with no aliasing form, and Yo has no
  overloading, so each `_Generic` macro gets exactly one Yo binding — and
  `std/libc/stdatomic.yo` spent it on `*(atomic_int)`. The other nine types,
  and `fetch_min`/`fetch_max` everywhere (C11 has no atomic min/max at all),
  run a strong compare-exchange loop over that type's existing
  `__yo_atomic_compare_exchange_*` primitive. Lock-free, same return value,
  same wrapping semantics — verified: Yo's RUNTIME integer arithmetic wraps
  two's-complement exactly like C11 `atomic_fetch_*` (its COMPTIME arithmetic
  traps instead, which is why the wrap tests build their expectation from a
  runtime-annotated local).

  **Deliberately NOT done: native `__yo_atomic_fetch_*_<type>` runtime
  wrappers.** They would be ~70 `static inline` C functions in
  `src/codegen/types/generation.yo` next to the existing
  `__yo_atomic_load_*` / `_store_*` / `_exchange_*` / `_compare_exchange_*`
  block. That is a SEED-GATED change, not a free win: an `extern("Yo", …)`
  symbol is supplied by the compiler's emitted preamble, so std may not call
  one until a seed carrying it ships. CI would cope (test.yml's suite legs run
  the TREE-BUILT compiler with `YO_STD=$PWD/std`), but the change is
  unverifiable against an installed seed, which is what every local
  `yo test tests/sync/atomic.test.yo` uses. Schedule it with the other
  seed-gated follow-ups (`plans/backlog/SEED_VERSION_AUTOMATION.md`); the API
  and the tests do not change when it lands, only the emitted C.

  Review round (2026-08-26) added five **unsigned-comparison** `fetch_min` /
  `fetch_max` tests (`AtomicU8/U16/U32/U64/Usize`). The original min/max tests
  only used small operands (2, 9, 13, 40), where a signed and an unsigned
  comparison agree — a signed-comparison mutation confined to `AtomicU8`
  passed the whole file. The new tests pin the boundary (all-ones vs 1) and
  catch exactly that mutation. `AtomicUsize` wraps its sentinel from a runtime
  zero rather than spelling a literal, because `usize` is 32-bit on wasm32.
  The implementation was already correct — this closes a test gap, not a bug.

  Found en route: **`yo test --std-path <dir>` silently tests the INSTALLED
  std** — the batch compile is a spawned child and `src/main.yo` forwards
  `--c-compiler`/`--target`/`--sanitize`/… but not `--std-path`, unlike
  `build_runner.yo`, which does. Use `YO_STD` for `yo test`.
  → `issues/fixed/yo-test-does-not-forward-std-path-to-batch-compile.md` (FIXED in this batch)
- `Once` gains `OnceCell(T)`-style `get_or_init`.
- Merge `std/worker` into `std/thread` as `ThreadPool` (explicit object:
  `spawn -> JoinHandle`-analog, `join_all`, `shutdown`); `Thread.spawn` should
  carry a result (`join() -> T`) and panic propagation.
- `WaitGroup`: delete (Go transplant) — replaced by `ThreadPool.join_all` +
  a new `Barrier`/`Semaphore` pair. **Do it in that order**: §6 round 2 measured
  5 live test-file consumers, so the deletion must ride WITH the replacement.
- **Async-aware sync is a P0 addition** (§7): async `Channel`, async `Mutex`,
  `select`/timeout — today any `ch.recv()` inside a future parks the entire
  single-threaded event loop, and the prelude DOCUMENTS `Channel` as the way to
  deliver results from `!Send` JoinHandles. Footgun with no safe path.

### D8 — module layout

- `std/os/env.yo` merges into `std/env.yo` (dir helpers return `Path`); `std/os/`
  then holds only `signal.yo` — flatten. `fs/temp` uses the merged `temp_dir()`
  (kills the 3rd copy of that logic; also consult `TMPDIR` on macOS).
- ~~One shared `std/encoding/utf8.yo` (validate/decode_rune_at/encode_rune) —
  SIX private UTF-8 decoders exist today~~ **DONE 2026-08-25** — the module
  exists and every private copy in `std/` is routed through it (the count was
  low: **eleven** files, not six — see the note below). The
  `String.from_bytes` half did **not** land as written; read the correction.

  **The module.** `std/encoding/utf8.yo`, 15 exported names:
  `Utf8Error`, `Decoded`, `is_continuation`, `is_boundary`, `sequence_len`,
  `step_len`, `encoded_len`, `decode`, `decode_parts`, `decode_lossy`,
  `encode`, `encode_into`, `encode_lossy_into`, `validate`, `validate_range`.
  Design points worth not re-litigating:

  - **Two entry points per direction, strict and lossy**, mirroring Rust's
    `from_utf8` vs Go's `DecodeRune`. `decode` returns
    `Result(Decoded, Utf8Error)` (D1 style 2: a pure fallible decode);
    `decode_lossy` never fails, substitutes U+FFFD and always advances by at
    least one byte so a scan over corrupt input terminates. `encode_into` takes
    a `rune` and is infallible; `encode_lossy_into` takes a raw `u32` — the
    shape JSON `\uXXXX`, UTF-16 code units and C `towlower` all produce — and
    substitutes U+FFFD, so nothing in `std` can emit CESU-8 by accident any more.
  - **`decode_parts(b0, b1, b2, b3, available, index)` is the real core**, and
    is public. `decode` is a thin `ArrayList(u8)` wrapper over it. It exists
    because `std/imm/string.yo` holds a raw `*(u8)` + len, and copying into a
    list to decode one rune would cost an allocation per rune — the
    "must not allocate" case the D8 row anticipated. That is the ONE decoder
    whose *fetch* stayed local; its bit-twiddling and validation did not.
  - **`Utf8Error` has NO `ToString`/`Error()` impl, by construction.** Those
    traits live in `std/fmt` / `std/error`, both of which import
    `std/string` — and `std/string/string.yo` is a consumer of this module, so
    importing them here would close a cycle right through the core of `std`.
    `Utf8Error` instead carries inherent `message() -> str` and
    `index() -> usize`. Precedent: `AllocError` in `std/allocator.yo` has no
    impls for the same layering reason. **This is load-bearing for D4** — the
    byte-indexing rework has to be able to import this module from
    `std/string/string.yo`, and it can only do that while this module stays
    below `std/error`. `StringError.InvalidUtf8(cause : Utf8Error)` is how the
    detail reaches a throwable error.
  - **`decode` and `validate_range` both carry an ASCII fast path**, and it is
    not decoration. This decoder replaced copies that fetched only the bytes
    they needed, and it now runs under the compiler's own lexer
    (`src/lexer.yo` / `src/parser.yo` call `StringBuilder.write_rune` per
    character, and `String.at`/`substring` walk runes) — fetching four
    `Option(u8)`s for every `'a'` would have been a real regression against
    what it replaced. One compare, one fetch, done.
  - Validation is RFC 3629 strict: `0xC0`/`0xC1` and `0xF5`..`0xFF` are not
    lead bytes at all, overlong forms, surrogates (U+D800..U+DFFF) and scalars
    above U+10FFFF are each their own error variant.
  - `sequence_len` is the strict width (`0` = not a lead byte); `step_len` is
    that clamped to 1. **Every** rune-walking loop in `std` now calls
    `step_len` — that alone replaced **14** copies of the same four-arm
    `cond` table (3 in `string.yo`, 10 in `regex/index.yo`, 1 in
    `imm/string.yo`). `regex/vm.yo`'s two backwards scans were boundary tests,
    not width tables, and went to `is_boundary` / `is_continuation`; there are
    10 boundary-test call sites in all (7 in `string.yo`, 2 in `regex/vm.yo`,
    1 in `imm/string.yo`).

  **The count in this row was wrong: eleven files carried UTF-8 bit twiddling,
  not six**, and three of them were encoders the row did not mention.
  What was routed:

  | file | what it had | now |
  |---|---|---|
  | `std/string/string.yo` | `_decode_rune_at`, 3 width tables, 6 boundary tests | `utf8.decode` / `step_len` / `is_boundary` |
  | `std/imm/string.yo` | `_decode_rune_at` (ptr), width table, boundary test | `utf8.decode_parts` (no allocation) / `step_len` / `is_boundary` |
  | `std/string/unicode.yo` | `_DecodeResult` + `_decode_utf8` + `_encode_utf8` | `utf8.decode_lossy` / `encode_lossy_into` |
  | `std/string/string_builder.yo` | `write_rune` encoder | `utf8.encode_into` |
  | `std/fmt/writer.yo` | `write_rune` encoder | `utf8.encode_into` |
  | `std/fmt/to_string.yo` | `rune`'s `ToString` encoder (stack `Array(u8,5)` + `from_cstr`) | `utf8.encode_lossy_into` |
  | `std/encoding/json.yo` | `_push_utf8` (`/` and `%` — its "no `<<`/`>>`" comment was stale) | `utf8.encode_lossy_into` |
  | `std/encoding/utf16.yo` | a decoder AND an encoder | `utf8.decode_lossy` / `encode_lossy_into` |
  | `std/regex/parser.yo` | `_read_codepoint` | `utf8.decode_lossy` |
  | `std/regex/vm.yo` | `_decode_codepoint`, 2 boundary scans | `utf8.decode_lossy` / `is_boundary` / `is_continuation` |
  | `std/regex/index.yo` | 10 identical width tables | `utf8.step_len` |

  **Three latent bugs fell out of the unification** (all pre-existing, all
  invisible to the old copies):

  1. `std/regex/parser.yo` and `std/regex/vm.yo` both read
     `_bytes(pos + 1..3)` **unconditionally** after seeing a multi-byte lead
     byte — a truncated tail at the end of the subject indexed past the end.
     `decode_lossy` bounds-checks.
  2. `std/encoding/utf16.yo`'s `utf16_to_utf8` rejected an unpaired HIGH
     surrogate but let an unpaired **LOW** surrogate fall through and wrote it
     out as a 3-byte CESU-8 sequence — invalid UTF-8, contradicting the
     function's own "throws on unpaired surrogates" doc. Fixed, red-first test
     in `tests/encoding/utf16.test.yo`.
  3. `base64_decode_string` handed arbitrary decoded bytes to the unchecked
     `String.from_bytes` and returned a `String` that need not be UTF-8 at all.
     It now validates. Red-first test in `tests/encoding/base64.test.yo`.
     (Its `Result(_, String)` error style is still D1-illegal — that is the
     §6 "fold into the primary pair" row, untouched here.)

  Also found, filed, NOT fixed:
  `issues/unicode-case-conversion-ignores-locale-so-non-ascii-is-unchanged.md`
  — `unicode_to_lowercase`/`unicode_to_uppercase` leave every non-ASCII letter
  unchanged, because `towlower`/`towupper` run in the `"C"` locale. Verified
  pre-existing by A/B (byte-identical output before and after the routing).
  The module has zero consumers and zero tests, which is why nobody noticed.
  This is the real content of the string row's "Unicode-correct `to_lowercase`".

- **CORRECTION to this row (2026-08-25): `String.from_bytes` did NOT become
  validating, and `from_bytes_unchecked` was NOT added. Both are blocked, and
  the blocker is not going away by itself.** What landed instead:
  `String.from_utf8(bytes) -> Result(Self, StringError)` — the validating
  constructor, Rust's name, D1 style 2 — plus a rewritten `from_bytes` doc
  comment saying in so many words that it is the *unchecked* constructor.
  Two names for the two behaviours, no dead alias.

  Measured, not guessed:

  - **`String.from_bytes` has ~170 call sites** (re-measured 2026-08-26 with
    `grep -ro '\.from_bytes(' <dir> --include='*.yo'`): 38 in `std/`, 54 in
    `src/`, 52 in `tests/` — **and 26 in `vendor/markdown_yo`**, which
    `src/doc/render_html.yo:41` imports by source path. Changing the name or
    the return type therefore breaks `yo check ./src` and `yo build` until a
    companion commit is pushed upstream and the submodule pointer is bumped
    (the standing rule in `plans/`/memory: *vendor needs COMPANION commits for
    std API changes*). That is a cross-repo change, not a std sweep.
  - **A three-name transitional shape (`from_bytes` + `from_bytes_unchecked` +
    `from_utf8`) was rejected** as a straight D2 violation with a dead alias in
    it. When the vendor bump happens, the rename `from_bytes` →
    `from_bytes_unchecked` becomes a pure mechanical sweep with no control-flow
    change; do it then, in one commit, together with the vendor bump.
  - **`String.from_cstr` must NOT start validating**, against what the §6
    `StringError` correction below suggests. `std/fmt/to_string.yo` calls it
    **22 times** — it is how every integer and float becomes a `String`, i.e.
    every `${x}` in every template string in the compiler. The bytes are
    `snprintf` output, so validation would be a guaranteed-passing scan on the
    hottest string path in the tree. `StringError.InvalidUtf8` is wired up by
    `from_utf8` instead, which is all §6 actually needed to stop the variant
    being dead.
  - `StringError.InvalidUtf8` now carries `cause : Utf8Error`, so the caller
    learns *what* was wrong and at *which byte*, not just "not UTF-8".

  **One behaviour change on a hot path, measured after the fact (2026-08-26).**
  Routing `rune`'s `ToString` through `encode_lossy_into` replaced a stack
  `Array(u8, 5)` + `String.from_cstr(...)`, and `from_cstr` stops at the first
  NUL byte. So `${rune}` changed for exactly two inputs, both previously
  broken:

  | input | before | after |
  |---|---|---|
  | `rune(char : 0)` | `""` (0 bytes — the NUL was eaten by `strlen`) | a 1-byte NUL string |
  | a hand-built surrogate `rune` | 3-byte CESU-8 (`ED A0 80` for U+D800) | U+FFFD (`EF BF BD`) |

  Every other code point is byte-identical (UTF-8 for a non-zero scalar never
  contains a `0x00` byte). A/B'd with the same driver against the pre-change
  `std`. The only in-tree caller that could hit either is
  `std/encoding/html_char_utils.from_code_point`, and `html.yo` guards it with
  `is_valid_entity_code`, which already rejects both 0 and the surrogate block
  — so no `std` behaviour moved.
- `EncodingError` moves out of `hex.yo` into `std/encoding/error.yo`.
- ~~Regex internals (`parser/node/compiler/vm` exports) go private; `MAX_SLOTS`
  documented; typed `RegexError`.~~ **DONE 2026-08-25** (branch
  `s2/d8-regex-internals`). Three findings against the row as written:
  1. *"Internals go private" has no language mechanism.* Yo's only visibility
     control is the `export(...)` list, and `index.yo` must import from its
     siblings, so a sibling cannot stop exporting what `index.yo` consumes.
     What was measurable and done: every sub-module's export list trimmed to
     exactly what its in-package consumers actually use — dropping `NodeKind`,
     `AnchorKind` (node), `Instr`, `InstrKind` and the `GroupNameEntry`
     re-export (compiler), `NfaThread`, `VmMatch`, `DecodedChar` (vm) — plus
     four unused imports in `index.yo` and four in `vm.yo`. Each internal file
     now carries a `//!` header saying it is not public API. The package's real
     public surface is `index.yo`'s export list, cut from
     `Regex, RegexMatch, RegexFlags` to `Regex, RegexMatch, RegexError`:
     nothing public accepts or returns a `RegexFlags` (flags reach the engine
     as the `Regex.new` string argument), so it was a leaked internal.
  2. *`MAX_SLOTS` was DEAD, not undocumented.* `MAX_SLOTS :: 200` in `vm.yo`
     was referenced nowhere and bounded nothing; the VM sizes capture slots as
     `2 * (n_groups + 1)` with no cap. **Measured**: a 120-group pattern
     compiles, matches and reports all 120 groups — no error, no truncation.
     So there is no silent truncation to file as a bug. The constant was
     deleted (nothing dead ships) and the real behaviour documented in `vm.yo`,
     in `Regex.new`'s doc comment and in `plans/REGEX_ENGINE.md`, pinned by a
     test. The only real group-count limits are syntactic (`\1`–`\9`,
     `$1`–`$9`).
  3. *Typed `RegexError`* — new `std/regex/error.yo`, a closed 14-variant enum
     with `ToString` + `Error()` per D1, replacing `Result(_, String)` in
     `parser.yo` (18 message sites), `flags.yo` (7) and `Regex.new`. Every
     variant carries what the caller needs to report the fault (byte offset,
     group number/name, property name, flag byte); no `Other(msg : String)`
     escape hatch. One test per variant (`tests/regex/regex.test.yo`,
     140 → 156 tests). The compiler's own call site
     (`src/main.yo` `--test-name-pattern`) needed no change — it interpolates
     the error, which now resolves through `ToString`.

  Found en route, filed not fixed:
  `issues/template-string-backslash-before-interpolation-eats-both.md` — a
  literal `\\` immediately before `${...}` in a template string eats the
  backslash AND silently disables the interpolation (lexer's escaped-dollar
  marker collides with a real backslash). It corrupted a `RegexError` message
  until a runtime read of the output caught it.
- `std/glob` stays the matcher; `fs.walker` gains `pattern` option + a
  `glob(pattern, io)` expansion function (the Python/Node meaning).

---

## 4. Per-module verdicts

| Module | Verdict | Notes |
|---|---|---|
| prelude | FIX + EXTEND | D3 traits; C6 impl removals; export `ComptimeOrd`/`ComptimeToString` (defined, never exported); delete dead `Exponentiation`, commented-out blocks; `if` macro deletion is seed-gated (owner: next seed bump after v0.2.16) |
| error/assert | EXTEND | downcast, derive(Error), context; narrow `error.yo`'s blanket `open(import(./string|./fmt))` re-export |
| fmt | FIX + EXTEND | delete `display.yo` (zero users) or wire it; format specs (D3.10); collapse 4 print bodies; dedupe 15 snprintf helpers |
| spec/ | FREEZE AS DOC | identity stubs; mark experimental, exclude from stability promise |
| collections/* | RENAME + EXTEND | §5 renames; entry API, `retain/extend/drain`, `binary_search`, real `sort` (not O(n²) insertion), `sort_by`; HashSet = HashMap(T, unit) to kill ~500 duplicated SwissTable lines; hide pub `ctrl/data/…` fields; `BTreeMap` → rename `FlatMap` OR implement a real B-tree with `range()` (recommend: real B-tree, keep name); add `BTreeSet`; `PriorityQueue`: keep name, add comparator ctor, DOCUMENT min-heap |
| imm/* | KEEP (O4) + FIX | stays in std (decided 2026-08-23); require `Acyclic` element bounds per O7, add iteration + `Index` where doc'd, rename `imm.String` → `ImmString` (**folded into D4** 2026-08-25 — decided, no longer conditional on COW `String`), dedupe set pair; mark unstable until exercised |
| string | FIX + EXTEND | D4 indexing; Unicode-correct `to_lowercase` (+ `to_ascii_*` variants); `Pattern` impl for `rune` + `Regex`; `replace*` Pattern-generic; `parse_f64`/radix; `split_once`, `strip_prefix/suffix`, ~~`char_indices`~~ (landed 2026-08-26 with the rest of the D4 PR-1 vocabulary); move `panic_dyn`/`assert_dyn` to assert; delete dead `StringError`, one of `to_cstr`/`to_c_str` |
| encoding | STANDARDIZE | D2 verbs; one error style per D1; utf8 module; add `html_encode` (XSS!); percent-encoding module (P0 — nothing in std can build a safe query string); base32; CSV (P1); toml: floats/arrays/dates/serializer + `ToToml`/`FromToml` derives to mirror json (P1) |
| json | EXTEND | enum representation for derives (open question O3); `JsonValue.Object` O(n) parallel arrays → keep repr, add index map if profiling demands |
| regex | POLISH | `Regex.escape`, optional-flags `new`, callback replace, lazy `find_iter`, group byte-spans, ~~typed error, private internals~~ (**both DONE 2026-08-25**, D8) |
| url | EXTEND | percent-encode/decode integration, `query_pairs`/`SearchParams`, `join` (RFC 3986 §5 — needed by http redirects), builder/setters; ~~wire punycode into host handling (or delete punycode)~~ — DELETED, §6 round 1 |
| io | REDESIGN | D5 |
| fs | EXTEND + POLISH | wrappers: `copy`, `remove_dir_all` (compiler implements it TWICE as workaround — `src/fetch.yo:80`, `src/version_cache.yo:72`), `read_link`, `set_permissions`, `set_len`, `try_exists`, `watch` (sys/events exists); `OpenOptions` builder; `File.from_fd`; Metadata: real `btime`, `permissions()`, stop `metadata` re-stat by path; DirEntry `path()`; walker: lazy option + glob filter; complete the `_str`/`_cstr` variant matrix or (better) collapse it with a `Pattern`-style `AsPath` trait |
| path | FIX + EXTEND | `join(str)`, `push`, `strip_prefix` (rename of `relative_from`, fallible), `Hash`/`Ord`/`Clone`, Windows separator in `to_string`, `ancestors`, PATH split/join; revisit eager `..` normalization (symlink semantics); ~~delete dead `PathError`~~ **DONE** (deleted 2026-08-25, §6 round 2) or make `new` fallible |
| env | MERGE (D8) | + `remove`, `vars()` iteration, `str` keys |
| process | EXTEND | `Child`/`spawn`/`Stdio` piping, `env`/`current_dir` on Command, builder returns `Self`, `ExitStatus.code() -> Option(i32)`, hide `raw` |
| cli | EXTEND or DROP-TO-PACKAGE | typed values, required enforcement, `--` , repeated opts, help-not-an-error; needs tty/color access (D8 wrappers). Recommendation: keep minimal-but-correct in std |
| net | FIX + EXTEND | C2/C3; `Shutdown` enum; `Reader`/`Writer` impls (D5); `incoming()`; UDP `connect` (its own doc references it), typed `recv_from`; `UnixStream`/`UnixListener` (sys/unix.yo fully plumbed — lowest-effort high-value gap); `parse_v6`, `SocketAddr.parse`, `Eq`/`Hash` on addr types; RFC 5952 V6 formatting |
| http | FIX + EXTEND | C1; timeouts (dead `Timeout` variant becomes real), redirects (needs `Url.join`), chunked decoding, binary bodies (`Output`-style bytes + `text()`/`json()` accessors), keep-alive; **server (P1)**: `parse_request`, `HttpServer` on `TcpListener`, router-free minimal core; collapse `FetchOptions` into `HttpRequest` |
| async | PROMOTE | becomes the combinator home: `join_all`, `race`, `any`, `timeout`, ~~async `sleep(Duration)`~~ (LANDED 2026-08-25 as `std/time/sleep.yo`'s `sleep(Duration, io)` per §5 — do NOT add a second one here; re-export it if `std/async` wants the name), interval, cancellation story for `JoinHandle` (`abort()`), async channel/mutex (D7) |
| thread/worker/sync | REDESIGN (D7) | |
| time | EXTEND | `Duration`: `Add/Sub` operator impls, `Eq/Ord/Hash`, `from_secs_f64`, `subsec_*`, consts; **make std USE it** (timeouts, sleeps — today zero consumers outside time/); `Instant` `add/sub`, `Eq/Ord`; `DateTime`: RFC3339 `parse`/`format` (C4 fix first), component ctor, arithmetic, `Eq/Ord`; ~~ONE `sleep(Duration, io)` async + `sleep_blocking(Duration)`~~ **DONE 2026-08-25 (§5)** |
| crypto | EXTEND | streaming `Digest` trait unifying Sha256/Md5 (+ streaming Md5); SHA-1, SHA-512, **HMAC** (blocks JWT/SigV4/webhooks), CRC32, constant-time compare; fix C5; new `std/rand` module: seedable PCG/xoshiro PRNG, `shuffle`, `choice`, ranges — infallible, non-crypto, clearly separated from `crypto/random` |
| log | REWRITE (zero users = free window) | levels + `Off`, `ToString`-generic message, lazy eval, timestamps, target/module, writer sink (file/buffer), thread-safe; keep the free-function facade |
| testing | EXTEND | `assert_eq`/`assert_ne`/`assert_approx` (diff-printing), `bench`: auto-calibration, black_box, stddev/percentiles |
| gc/allocator | POLISH | `gc.stats()`; allocator: DECIDED (O6, 2026-08-23), **DONE** (deleted 2026-08-25, §6 round 2) — DELETE `CustomAllocator` (zero implementors incl. `GlobalAllocator`); per-heap control, if ever needed, arrives as a process-global runtime hook, not a type parameter |
| build | KEEP (already coherent) | Zig-shaped, comptime-correct; only additive evolution |

---

## 5. The rename/breaking sweep (one release — a PATCH bump, staying on v0.2.xx)

**Versioning decision (user, 2026-08-24): no minor release for this.** Yo is
pre-stability; breaking std changes ship in ordinary v0.2.x patch releases
rather than opening a "0.3.0" window. The sweep below is still ONE release's
worth of coordinated renames — it just lands as the next patch version.

Everything in D2/D4 plus these specific renames. Each is mechanical; land as a
small number of PRs with tree-wide fixups (compiler + std + tests + docs):

- ~~`HashMap.set`→`insert`, `HashSet.add`→`insert`, `BTreeMap.set`→`insert`,
  `OrderedMap.set`→`insert`~~ **DONE 2026-08-25 (S2 chunk 1)** — plus
  `TomlTable.set`→`insert`, since D2 is "one name per concept across the whole
  tree" and a TOML table set is a map insert. The returns still leak
  `HashMapError`; that half is separate.

  Method note, because grep cannot do this rename: `.add(` in this tree is
  overwhelmingly POINTER ARITHMETIC, so the sweep was driven by the compiler as
  oracle (`yo check ./src` names the failing receiver, rewrite, repeat). Two
  over-reaches were caught that way and reverted: `env.set(KEY, VALUE)` is
  `setenv`, not a map insert (26 sites across 5 files), and `imm.Vec.set(idx, val)`
  is index REPLACEMENT, a different concept that keeps its name. A third was
  invisible to `yo check` entirely — six `result_set.add(...)` sites inside
  hash_set.yo's own union/intersection helpers live in generic bodies that
  `check` does not instantiate, and only the test run surfaced them.

  **The verification lesson of this chunk, which every later chunk inherits:
  `yo check ./std` 152/152 + `yo check ./src` 262/262 + `yo build` rc=0 were ALL
  green while the tree was broken.** Four classes of call site are structurally
  invisible to check: macro `quote(...)` bodies (never evaluated until expansion
  — hash_set's literal builder held two), generic trait-impl bodies
  (`FromIterator.from_iter_add`), generic helpers inside the defining module (the
  six above), and async closure bodies. The last class does not even error: the
  missed `followed.add(canon_s)` in `std/fs/walker.yo`'s symlink-follow loop
  became a `// Failed to transpile` stub, so `walk_with` returned an EMPTY list
  and `yo fetch`, `yo version`, `public-safe-report` and `unsafe-report` all kept
  building while traversing nothing. Its only trace in the whole battery was two
  cli-case goldens moving from `Scanned 1 .yo file(s)` to `Scanned 0` — which is
  why a re-recorded golden must be READ, never just recorded. Filed as
  issues/ftt-stub-in-live-closure-falls-off-non-void-function.md (the emitted C
  is a value-returning function with no return statement: undefined behaviour),
  with a standalone repro.

  So the gate for a rename chunk is the FULL suite plus the golden DIFF, not
  check/build. Grep separately inside `quote(`, `impl(` and `io.async(` bodies —
  the compiler will not name those for you.
- `ArrayList`: ~~add `is_empty`~~ **DONE 2026-08-25** (it was the ONLY container
  missing it — btree_map, deque, hash_map, hash_set, linked_list, ordered_map,
  priority_queue and String all already had one, so D2's "is_empty on EVERY
  container" was a one-method gap, landed additively ahead of the breaking
  sweep); `remove(start,count)`→`drain(range)`, add single-`remove(idx) -> T`,
  and `iter()` pointer iterator for symmetry — **deferred to S2 chunk 3** (the
  collections chunk) rather than chunk 2: `remove` is a name shared with
  `HashMap.remove`/`HashSet.remove`, so it needs the compiler-as-oracle
  treatment rather than a textual sweep, and it changes the return type from
  `Result(usize, ArrayListError)` to an element — a different blast radius from
  chunk 2's fs/net renames
- ~~`HashMap.iter_ptr`→`iter`~~ **DONE 2026-08-25** (no collision: HashMap had
  `into_iter` for values and `iter_ptr` for pointers, exactly D2's split);
  OrderedMap iterators get real `Iterator` impls
- ~~`?(T)` spelling in btree_map/deque → `Option(T)`~~ **DONE 2026-08-25 (S2
  chunk 4)** — but NOT as "pick one everywhere". The counts decided it: of 140
  `?(…)` uses in std, **130 are `?(*(…))`** — a nullable RAW POINTER, almost all
  at the C boundary (`?(*(char))`, `?(*(FILE))`, `?(*(void))` in std/libc/*).
  That is a real idiom, not an inconsistency, and it stays. Only the **10**
  value-typed uses became `Option(T)`. Three of them were OUTSIDE this item's
  stated scope — `std/sync/channel.yo` (2) and `std/fs/walker.yo` (1) — so the
  "btree_map/deque" framing was incomplete
- ~~maps `min()`/`max()` → `first_entry`/`last_entry`; sets keep `min`/`max`~~
  **DONE 2026-08-25 (S2 chunk 4)** — only `BTreeMap` had the map form (it
  returns `Option(MapEntry(K,V))`, i.e. a whole entry, which is exactly why the
  name had to change); `imm/sorted_set` keeps `min`/`max` because it returns the
  ELEMENT, and the `Iterator` combinators' `min()`/`max()` are a third, unrelated
  thing. 2 declarations + 8 call sites
- ~~`Bucket`/`BTreeEntry`/`OrderedMapEntry`/`Pair` → one `MapEntry(K,V)`~~
  **DONE 2026-08-25 (S2 chunk 3)** — all four were literally
  `struct(key : K, value : V)`, so this was one concept under four names. The
  shared type lives in a NEW `std/collections/entry.yo` (user approved new
  `.yo` files, 2026-08-25); it is deliberately NOT in the prelude, where growth
  has a measured self-emit memory cost
  (issues/std-s1-prelude-growth-tripled-self-emit-memory.md), and NOT in
  `hash_map.yo`, which would have made `std/imm/map` depend on a
  `std/collections` map. Each map module re-exports `MapEntry`, so
  `{ BTreeMap, MapEntry } :: import("std/collections/btree_map")` still works.

  TWO traps, both of which a textual sweep would have walked into:
   - **Prelude `IterPair(A, B)` is NOT a map entry.** It is
     `struct(_0 : A, _1 : B)` — POSITIONAL, produced by `zip` (D3.4). It was
     left alone; a map entry is NAMED (`key`/`value`).
   - **Most `\bPair\b` matches are TEST-LOCAL structs of unrelated shape** —
     `struct(first : i32, second : i32)` (tests/index.test.yo:533),
     `atomic(ref(struct(a : i32, b : u32)))` (tests/privilege_pragma.test.yo:88),
     a `ref(...)` (tests/codegen-bootstrap/borrowed_field_return.yo:27). Only
     two files import std's `Pair`. `Bucket`/`BTreeEntry`/`OrderedMapEntry` are
     unambiguous and were swept tree-wide; `Pair` was done by explicit file
     list.

  `Bucket` was additionally referenced in ~35 `src/` COMMENTS documenting
  type-identity hazards (`tk2/Bucket`, cache collisions). Those were updated
  too — it is the same type under a new name, and a comment naming a type that
  no longer exists is not navigable.
- ~~`canonical`→`canonicalize`; `relative_from`→`strip_prefix`~~ **DONE
  2026-08-25** — the `canonical` FAMILY moved together
  (`canonical_str`/`canonical_cstr` too), since leaving the siblings behind would
  have created exactly the split-vocabulary D2 exists to prevent;
  ~~`created_time`→`status_changed_time`~~ **DONE 2026-08-25 (S2 chunk 2)** — it
  returned `ctime_sec()`, which on POSIX is the status-change time, so the old
  name was actively wrong (ctime moves on chmod/rename/link-count changes and can
  postdate mtime); the method's own comment already said "Status change time".
  Zero call sites. A real `created_time` (btime) is **still open** and is a
  feature, not a rename: `Statx` requests `STATX_BASIC_STATS` (0x7ff), which
  excludes `STATX_BTIME` (0x800), and there is no `btime_sec()` accessor — plus
  it needs per-platform work (statx btime / `st_birthtime` / Windows
  CreationTime)
- ~~`File.read_string`/free `read_string`→`read_to_string`~~ **DONE 2026-08-25**
  (family: `read_string_str`/`read_string_cstr` moved with it)
- ~~`read_file`→`read` / `write_file`→`write`~~ **DONE 2026-08-25 (S2 chunk 2)**,
  but NOT as this list originally specified. Writing it out exposed a flaw in the
  spec: `read_file` returns BYTES while `write_file` takes a `String`, so
  `read_file`→`read` + `write_file`→`write` would have produced a `read` that
  returns bytes and a `write` that takes a String — leaving the actual byte
  counterpart of `read` named `write_bytes`. That is precisely the split
  vocabulary D2 exists to prevent. **Decision (user, 2026-08-25): symmetric
  pairs.**

  | new name | was | payload |
  | --- | --- | --- |
  | `read` | `read_file` | bytes |
  | `write` | `write_bytes` | bytes |
  | `read_to_string` | (unchanged) | String |
  | `write_string` | `write_file` | String |

  `read_str`/`read_cstr` and `write_string_str`/`write_string_cstr` moved with
  their families. This matches `std::fs::read` / `std::fs::write` exactly (Rust
  needs no `write_string` only because `AsRef<[u8]>` covers `&str`; Yo has no
  such coercion, so the String half is a named function). 150 occurrences across
  25 files.

  Collision check, done before the rename and clean: `std/sys/file.yo` does
  export free `read`/`write` at the fd level and `File.read` is a method, but
  nothing in std/, src/ or tests/ uses a glob `open(import(...))` on either
  module (every import is destructuring); no file imports both `fs/file` and
  `sys/file`; neither name is in the prelude; and `std/fmt` (glob-imported by
  `fs/file.yo`) exports no `read`/`write`.

  **Correction 2026-08-25:** that last check was stated with the wrong evidence.
  It listed the union of exports across `std/fmt/*.yo`
  (Alignment/Format/FormatSpec/ToString/Writer/eprint/eprintln/print/println),
  but a glob `open(import("../fmt"))` resolves to the PACKAGE ENTRY POINT,
  `std/fmt/index.yo`, which exports only **7** names — ToString, Format,
  FormatSpec, println, print, eprintln, eprint. `Writer` and `Alignment` come
  from the sibling `std/fmt/writer.yo:21,214`, which a glob does NOT pull in.
  The conclusion is unchanged and in fact stronger (fewer names in scope), but
  the reasoning matters for the NEXT check: when D5 introduces an I/O `Writer`
  trait, the three files that glob-import `std/fmt` (`fs/file.yo`, `net/tcp.yo`,
  `net/udp.yo`) will see no clash — because `fmt`'s `Writer` was never in their
  scope to begin with.

  Method note: `write_bytes` and `write_string` are ALSO method names on four
  writer types (File, TcpStream, Writer, BufWriter). Only the free functions
  moved — the method vocabulary is deliberately shared and stays put.

- `Http` inherent `to_string`→`ToString` impl; ~~`TcpStream.shutdown(i32)`→
  `shutdown(Shutdown)`~~ **DONE 2026-08-25 (S2 chunk 2)** — new `Shutdown` enum
  (`Read`/`Write`/`Both`, matching `std::net::Shutdown`) plus a private
  `_shutdown_to_how` mapping to SHUT_RD/SHUT_WR/SHUT_RDWR, following the existing
  `SeekFrom`/`_seek_from_to_whence` idiom; the sys layer keeps its `i32` `how`,
  since that IS the syscall boundary; ~~net `read/write` return `usize`~~ **DONE
  2026-08-25 (S2 chunk 2)** — 8 methods (TcpStream `read`/`write_str`/
  `write_string`/`write_bytes`, UdpSocket `send_to`/`recv`/`recv_from`/`send`).
  `NetError.check` itself stays `i32`: it is also used for file descriptors
  (`fd := NetError.check(raw_fd, ...)`), so the conversion is at the eight
  byte-count call sites. This also SHARPENED `std/http/client.yo`, whose read
  loop tested `n <= i32(0)` — conflating "error" with EOF. Errors throw, so a
  count is never negative; the test is now `n == usize(0)`, i.e. EOF only
- ~~`punycode.to_ascii`/`to_unicode`→`domain_to_ascii`/`domain_to_unicode`~~
  **OBSOLETE 2026-08-25** — §6 round 1 DELETED `std/encoding/punycode.yo`
  outright (zero importers, 343 untested spec-sensitive lines), so there is
  nothing left to rename. Verified: zero `punycode` references in std/, src/
  or tests/. If IDN support returns it comes back with tests and a `Url`
  integration, and it gets these names then
- ~~two `sleep`s → `time.sleep(Duration, io)` async + `time.sleep_blocking(Duration)`~~
  **DONE 2026-08-25 (S2, branch `s2/sleep-duration`)** — `std/time/sleep.yo` now
  exports both: `sleep(Duration, io) -> Impl(Future(unit))` (an `io.async` block
  awaiting the sys timer) and `sleep_blocking(Duration) -> unit`. `std/sys/timer.yo`
  is UNCHANGED and keeps its raw `sleep(milliseconds : u64) -> IoFuture`: `sys/` is
  the syscall boundary, the same call the `Shutdown`/`SeekFrom` split already makes.
  16 blocking call sites migrated (`src/main.yo` ×1, `tests/sync/{channel,rwlock,
  waitgroup}.test.yo` ×15); `tests/imm_threading.test.yo` had an unused `sleep`
  import, dropped. The async call sites left on `std/sys/timer` are the sys-layer
  tests themselves plus `src/check_watch.yo` — see the deferred note below.
  New coverage: `tests/time/sleep.test.yo` (4 tests), including an overlap test
  proving `sleep` suspends rather than blocks the loop.
  **Found en route and FIXED in the same batch:** a codegen miscompilation — a
  function whose body is ONE inline-builtin call was emitted with the CALLER's
  arguments, silently discarding the body's own argument expressions
  (`issues/fixed/inline-builtin-alias-drops-body-arguments.md`). The predicate
  now also requires the body to pass its parameters through unchanged and in
  order. `sleep_blocking` still ships the two-statement body, but as a SEED
  GATE rather than a workaround: `yo build` compiles this tree with the seed,
  which predates the fix, so the one-expression form breaks the bootstrap
  (loudly — clang rejects the seed's output). Scheduled at
  `plans/backlog/SEED_VERSION_AUTOMATION.md`.
  **Deferred:** migrating `src/check_watch.yo` off `std/sys/timer` — it is the one
  non-test consumer of the async sleep, and an async call-shape change inside the
  compiler tree cannot be validated without a `yo build` / `compile src/main.yo`.
- `str.join(items)` receiver-as-separator: keep (Python style is fine) but
  document; `index_of`/`last_index_of` keep (JS names are the local norm) —
  the D2 table is the arbiter wherever vocabularies mix

## 6. Deletions (all pre-stability; each verified zero/near-zero usage by grep)

**Progress (S2 deletions, round 1, 2026-08-25, branch std/s2-deletions):** four
targets removed after re-verifying zero usage by grep — `std/alg/hash.yo` (0
importers; its docstring's "Used internally by `HashMap` and `HashSet`" was
false, and the FNV consolidation it hints at belongs to the D3.9 Hasher redesign,
which rewrites every `Hash` impl anyway), `std/encoding/punycode.yo` (0 importers
including `url`; 343 untested spec-sensitive lines — IDN support should return
with tests and a `Url` integration, not sit dormant in a stable std),
`std/fmt/display.yo` (0 call sites, not re-exported, and a parameterized trait
misusing its `T` as the self type — also settled against by O5's single-`ToString`
decision; `std/fmt/writer.yo` STAYS, it is used by `std/net/addr.yo`), and
`std/collections/list_view.yo` plus its test (superseded by the copying range
forms; the `ListView` recommendation in
`.github/instructions/yo-syntax.instructions.md` is updated). `std/alg/` is now
empty and gone.

**Export hygiene, partial:** `__MutexUnlocker` is no longer exported from
`std/sync/mutex.yo` (used only inside that file). The other underscore-prefixed
exports do NOT come off by simple deletion, and the audit row overstates how
mechanical they are:

- `std/libc/*` (`_exit`, `_Exit`, `_IOFBF`, `_putenv_s`, `_NSGetExecutablePath`,
  …) and `std/sys/externs.yo`'s `__yo_async_*` are REAL C symbol names — they
  must keep them; ~90 of the ~101 underscore exports are these.
- `std/fs/types.yo`'s three converters and `std/encoding/html_entities.yo`'s two
  builders are consumed by a SIBLING module (`fs/file.yo`, `encoding/html.yo`),
  so unexporting them breaks the import. They need either a module-private
  visibility mechanism (which Yo does not have) or a rename that admits they are
  internal-but-shared — a D8 layout question, not a sweep.
- `__YO_THREAD_SYNC_TYPE` is consumed by `std/sync/cond.yo` AND by the compiler
  itself (`src/codegen/parallelism/runtime.yo`, `src/codegen/types/generation.yo`,
  `src/codegen/functions/gc_runtime.yo`, `src/evaluator/trait_checking.yo`), so it
  is D7 work.

**`std/collections/linked_list.yo` is KEPT for now**, against the table's
recommendation, for a concrete reason: it is the load-bearing half of the #249
regression trigger (`tests/where_clause_fn_inference.test.yo` instantiates one
where-bound generic at LinkedList and then at BTreeMap — the minimal
era-copy/GC-trace reproducer). Deleting it forces substituting a different
collection pair that cannot be verified to still reproduce the original bug, so
the deletion would trade a real regression test for 514 lines. Revisit if that
test is ever re-expressed without it.

**Progress (S2 deletions, round 2 — the remainder, 2026-08-25, branch
`s2/s6r2-rest`).** Every remaining §6 row was re-measured against `std/`, `src/`,
`tests/`, a POPULATED `vendor/` and both `docs/` trees before acting.

DELETED (each verified zero consumers repo-wide, including vendor and docs):

- **`mutex_t` (`std/sync/mutex.yo`) and `cond_t` (`std/sync/cond.yo`)** — the
  parallel C-tier D7 asks to delete. Their only cross-file link was `cond.yo`
  importing `mutex_t` for `cond_t.wait`; nothing else in the repo named either.
  D7's "introduce opaque `RawMutex` for `Cond`'s signature" turned out to be
  unnecessary: `Cond.wait` already takes `*(__YO_THREAD_SYNC_TYPE)`, so only
  `cond_t.wait` needed `mutex_t` and both went together. `Mutex(T)`/`Cond` and
  everything built on them (`RwLock`, `Channel`, `WaitGroup`) are untouched.
- **`std/io/reader.yo` + `std/io/writer.yo`** — zero implementors, as the row
  says; the sole consumer was `tests/io/reader_writer.test.yo`, whose `TestBuf`
  implements both. The two trait declarations MOVED INTO that test rather than
  dying with the files: it is the only coverage in the suite of a user trait
  whose methods take raw `*(u8)` plus an `Exception`. `std/io/` is now empty and
  gone — which is the namespace D5 wants for the async `Reader`/`Writer` and the
  `std/sys/bufio` move.
- **`std/env.yo`'s `raw_args`, `argv`, `argc`** — see the row correction below.
- **`std/prelude.yo`'s `export();` no-op and the commented-out `c_macro` IDEA
  block** (25 lines).
- **`ArgKind`/`ArgDef` came off `std/cli/arg_parser.yo`'s `export(...)`** — they
  appear only inside `ArgParser`'s private `_args` field, never in a public
  signature, and nothing outside the file names them.

**Row correction — the `raw_args`/`argc`/`argv` row is misfiled and misnamed.**
It sits under "underscore-private names in `export(...)`", but none of the three
is underscore-prefixed and they are not "duplicates" of each other. Measured:

- `raw_args` — 2 hits, its own declaration and its own `export`. Zero consumers
  anywhere. Genuinely dead; deleted.
- `argv` — declaration + `export`, zero callers. `args()` reads the `__yo_argv`
  extern DIRECTLY rather than going through it. Deleted.
- `argc` — declaration + `export`, and ONE internal caller: `args()`. So the
  function was live but its export was not. Deleted by inlining the extern at
  the single call site (`len := usize(__yo_argc)`), which also makes `args()`
  symmetric with the `__yo_argv` read two lines below it.

`src/public_safe_report.yo`'s `_name_is_raw_pointer_api` hardcodes `"argv"` and
`"argc"` in its raw-pointer-API exemption list. That is a name-pattern allowlist
mirroring the retired TS `RAW_POINTER_API_PATTERNS`, not a consumer, and its
cli-case golden runs against its own fixture — left alone deliberately.

NOT DELETED, with the measurement that blocks each:

- **`WaitGroup` — KEEP.** The row says "Go transplant; replaced per D7", but D7's
  replacement (`ThreadPool.join_all` + a `Barrier`/`Semaphore` pair) does not
  exist yet, and `WaitGroup` is not dead: FIVE test files use it as a real
  primitive (`tests/imm_threading`, `tests/sync/{channel,once,rwlock,waitgroup}`),
  `plans/THREAD_SAFETY.md` records it as an in-scope fixed primitive (finding 2,
  `_count` → `AtomicI32`), and `src/doc/render_html_assets.yo` lists it as a
  highlighter builtin. Delete it WITH its replacement, not before.
- **`base64_decode_string` — NEEDS-DECISION; the row's evidence is only half
  true.** `base64_encode_string` really is a pure duplicate — it is literally
  `_encode_with(input.as_bytes(), _STD_ALPHA, true)`, i.e. `base64_encode` with
  an `as_bytes()`. `base64_decode_string` is NOT: it strips ASCII whitespace
  before decoding (`tests/encoding/base64.test.yo` has a "decode_string with
  whitespace" case), returns `Result(String, String)` instead of throwing via
  `Exception`, and yields a `String` rather than `ArrayList(u8)`. "Fold into the
  primary pair" therefore means deciding whether `base64_decode` GAINS
  whitespace tolerance — a behaviour change, not a deletion. Deleting only the
  encode half would leave the API asymmetric, so both were left in place.
- **Regex internals (`parser`/`node`/`compiler`/`vm` exports) — D8, not a
  sweep.** Same shape as the `fs/types` converters the round-1 note describes:
  `index.yo` imports `RegexParser`, `NfaCompiler`, `NfaProgram`, `Instr`,
  `InstrKind`, `ClassEntry`, `GroupNameEntry`, `NfaVm`, `VmMatch`, and
  `vm`/`match`/`parser`/`compiler`/`unicode` import `node`'s types from each
  other. Unexporting breaks the imports; Yo has no module-private visibility.
- **`ExprInfo.popped_env_frame` — clean but out of scope here.** Confirmed dead:
  the only write was removed with the eval-phase leak fix, and what remains is
  the field declaration plus two `Option(Frame).None` initialisers in
  `src/expr_info.yo`. Removing it is a COMPILER struct change that needs a
  rebuild + fixpoint battery to land safely, which this std-scoped branch cannot
  run — schedule it with a compiler change, not with a std deletion.

**New finding, not in the table: `__yo_c_macro_defined` / `__yo_c_macro_value`
(`std/prelude.yo:168-169`) are dead externs.** They are declared in the prelude's
`extern("Yo", ...)` block, but `grep -rn c_macro src/` returns NOTHING — there is
no `BF_*` constant and no evaluator handler for either, so a call could never
resolve. The commented-out `c_macro` block deleted above was their only textual
justification. Deleting the two declarations is a follow-up (it needs its own
verification that an unresolved prelude extern is not load-bearing elsewhere).



| Target | Evidence |
|---|---|
| `std/alg/hash.yo` | zero importers; docstring false; FNV constants re-inlined in both String hashes — inline or wire in |
| ~~`std/encoding/punycode.yo`~~ **DELETED** | zero importers incl. url; 343 untested spec-sensitive lines; ALSO duplicated at `vendor/markdown_yo` — deleted in §6 round 1 |
| `std/collections/list_view.yo` | test-only, no Index/iter/consumers; superseded by `slice_copy` |
| `std/collections/linked_list.yo` | test-only, 510 lines; `Deque` covers it (decide: delete vs keep-as-is; recommend delete) |
| ~~`mutex_t`, `cond_t`~~ **DELETED** | zero in-tree users, duplicate `Mutex`/`Cond` unsafely — deleted in §6 round 2; `Cond.wait` already took `*(__YO_THREAD_SYNC_TYPE)`, so D7's `RawMutex` was not needed |
| `WaitGroup` **KEPT** | Go transplant, but NOT dead: 5 test files use it, `THREAD_SAFETY.md` records it as fixed-and-in-scope, and D7's replacement (`ThreadPool.join_all` + `Barrier`/`Semaphore`) does not exist yet — delete WITH the replacement, see the round-2 note |
| ~~`std/io/{reader,writer}.yo` current traits~~ **DELETED** | zero implementors — replaced by D5 redesign; deleted in §6 round 2, the two trait decls moved into `tests/io/reader_writer.test.yo` (its `TestBuf` was the only implementor and the only coverage of a `*(u8)`+`Exception` user trait). `std/io/` is now empty, which is the namespace D5 wants |
| `std/fmt/display.yo` | zero call sites, not re-exported, malformed trait shape |
| ~~`StringError`~~, ~~`PathError`~~ **DELETED**, dead variants (`HashMapError.KeyNotFound` — dead but BLOCKED, `HttpError.Timeout`* etc.) | never constructed (*Timeout/TooManyRedirects/ResponseTooLarge become REAL when the features land — don't delete, implement). **`StringError` RECLASSIFIED 2026-08-25 — see the note below; it belongs with the starred ones.** |
| `base64_{encode,decode}_string` **NEEDS-DECISION** | only `encode_string` is a pure duplicate (`base64_encode(s.as_bytes())`); `decode_string` ALSO strips whitespace and returns `Result` — "fold in" is a behaviour decision about `base64_decode`, not a deletion. See the round-2 note |
| ~~`ExprInfo.popped_env_frame`-class dead fields, prelude commented-out blocks, `export();` no-op~~ **ALL DELETED** | the two prelude items in §6 round 2; `popped_env_frame` in PR #283 — it is a COMPILER struct change, so it took the rebuild + full fixpoint battery round 2 said to schedule it with |
| underscore-private names in `export(...)` (fs/types converters, ~~`__MutexUnlocker`~~, regex internals, ~~`ArgDef`~~, ~~`raw_args`/`argc`/`argv`~~) | export hygiene sweep. `ArgDef` (+`ArgKind`) unexported and all three env fns DELETED in round 2 — but the row MISNAMES that last group: none is underscore-prefixed and they are not duplicates of each other (round-2 note has the per-name measurement). Regex internals are cross-module consumed = D8, like fs/types |

**§6 CORRECTION (2026-08-25): do NOT delete `StringError` — wire it up.** The row
above groups it with `PathError` on the evidence "never constructed". Both halves
of that are true, but they mean opposite things:

- `PathError` is genuinely dead: declared at `std/path.yo:7`, exported at :13, and
  referenced nowhere else in std, src, tests or vendor. Delete (or make `Path.new`
  fallible, as the path row already suggests).
- `StringError` is the declared error type of `String.from_cstr`, whose every
  path returns `.Ok` — so the `Result` is VACUOUS and callers unwrap for nothing.
  The reason no variant is ever constructed is that `from_cstr` never validates:
  it `strlen`s and copies the bytes. `String.from_bytes` (`:55`) does not validate
  either, and does not even return a `Result`.

  So `StringError.InvalidUtf8` is not a leftover — it is the error a MISSING check
  would raise. Deleting it locks in the missing validation and throws away the
  vocabulary needed to add it. D8 already asks for exactly that check
  ("`String.from_bytes` starts validating (or gains `from_bytes_unchecked`)"), so
  the two items are the same work: validate in `from_bytes`/`from_cstr`, construct
  `InvalidUtf8`, and the type becomes live. That also makes `from_cstr`'s `Result`
  honest instead of vacuous.

  `StringError.IndexOutOfBounds(index, length)` should be reviewed in the same
  pass — it is the natural error for the D4 byte-indexed API's bounds failures.

**§6 ROUND 2 RECORD (2026-08-25) — three items, two landed, one BLOCKED by a
compiler bug.** Each was re-verified by grep across `std/ src/ tests/` (and
`vendor/`, which must be read from a worktree with submodules initialized —
a fresh worktree has them EMPTY, so a vendor grep there is vacuous).

- **`PathError` — DELETED.** Confirmed exactly 2 repo-wide `.yo` hits, both in
  `std/path.yo` (decl :7, export :13); `EmptyPath` and `InvalidPath` each occur
  once, at their own declaration. No `ToString`, no `Error()` impl, so it could
  never have been reported.
- **`CustomAllocator` + `Allocator :: Dyn(CustomAllocator)` — DELETED.**
  Confirmed 4 hits, all in `std/allocator.yo`, and ZERO implementors: the only
  `impl` mentioning an allocator is `GlobalAllocator :: impl({...})`, a bare
  module of raw `extern` bindings that does not implement the trait. The
  separate `Allocator` enum in `std/build.yo` (`System`/`Mimalloc`) is
  unrelated and untouched — every `Allocator` reference in `docs/` is that one.
- **`AllocError.{InvalidSize,InvalidAlignment,InvalidPointer}` — DELETED.**
  Each occurred once, at its declaration. `AllocError` is now single-variant
  (`OutOfMemory`), which is legal — `src/error.yo:13` `ErrorKind :: enum(Overflow)`
  is existing precedent — and `OutOfMemory` has no structural collision partner
  anywhere in `std/` or `src/`.
- **`HashMapError.{KeyNotFound,CapacityOverflow}` and
  `HashSetError.{ElementNotFound,CapacityOverflow}` — NOT DELETED.** The
  variants really are dead (one occurrence each, at their declarations), but
  removing them makes `HashMapError` and `HashSetError` *structurally
  identical* (`enum(AllocError(error : AllocError))`), and that trips a
  compiler bug: any module importing both `hash_map.yo` and `hash_set.yo` then
  fails to evaluate with `Type mismatch for type member "error": Expected:
  HashMapError Got: HashSetError` at `hash_set.yo:219`. Filed as
  `issues/structurally-identical-error-enums-in-two-generic-impls-collide.md`
  with reproducer `issues/repros/hashmap-hashset-error-enums-collide.yo`.
  Trimming either enum alone is fine; only the pair collides. **Fix the
  compiler first, then land this trim.**

**Method note for the rest of §6: a passing targeted test can be vacuous here.**
With both enums trimmed, `tests/collections/hash_map.test.yo` still reported
61 passed / 61 total, because it imports only `hash_map.yo` and the two enums
never meet. The bug was caught only by a standalone `yo compile` + **run** of a
program importing both. Gate std deletions on a program that actually exercises
the changed declarations at runtime, not on the nearest existing test file.

## 7. Additions ranked (post-sweep, additive, batteries-included)

**P0 — unblock real programs**
1. `std/encoding/percent.yo` (percent-encode/decode) + URL/query integration
2. ~~`std/encoding/utf8.yo` (D8)~~ **DONE 2026-08-25** (see D8) + `html_encode`
3. `std/io` redesign with stdio handles (D5)
4. `fs.copy`, `fs.remove_dir_all`, `read_link`, `set_permissions`, `try_exists`
5. `process.Child`/`spawn`/`Stdio`
6. async combinators + async channel/mutex + `timeout` (D7)
7. `crypto`: HMAC, SHA-1, SHA-512, CRC32, `Digest` trait; `std/rand`
8. prelude D3 items 1–8 (Default, From/Into, cmp, iterator/Option/Result completion, Range iteration)
9. `Duration` integration everywhere a timeout/interval appears
10. `net.UnixStream`/`UnixListener`

**P0+ — user-requested (2026-08-23), tracked with this campaign**
- ~~`yo <subcommand> --help` per-subcommand help~~ **DONE** (verified
  2026-08-25): `_subcommand_help_text` in `src/main.yo` answers
  `yo <sub> --help` / `-h` LOCALLY — before the `.yo-version` pre-dispatch, so
  help never needs a cached binary or a network — with the scan stopping at
  `--` so a program's own `--help` after `--` is not intercepted, and an
  unknown subcommand falling back to the top-level usage. `yo version --help`
  now prints the actions including `list --remote`. (Note for future readers:
  an INSTALLED older `yo` on PATH still errors, which is what made this look
  open — check against a binary built from the tree.)
- Replace the two `curl` shell-outs (`src/version_cache.yo:454,512` — bundle
  download + releases list, both https against the GitHub API) with
  `std/http`. **Blocked on TLS (D6/O2)**: std's fetch deliberately refuses
  https since C1, so the sequence is TLS `TlsStream` first, then the swap —
  doing it earlier would silently downgrade the toolchain's release channel
  to cleartext.

**P1 — expected of a modern std**
HTTP server + chunked/redirect/timeout client; TLS (D6); CSV; DateTime
parse/format; `fs.watch`; testing `assert_eq` family; log rewrite; glob
expansion; `Semaphore`/`Barrier`; `ThreadPool`; format specs; entry API +
`binary_search` + real sort; tty/terminal-size wrappers (cli needs them)

**P2 — nice-to-have / decide-later**
WebSocket; YAML/XML (lean package-ecosystem); msgpack/CBOR; base58;
`BTreeSet`+range queries (with the real B-tree); bitset; `SmallVec`; LRU cache;
mmap/file-lock/statfs wrappers; `gc.stats`; DNS SRV/TXT/reverse

## 8. Open questions — ALL DECIDED (user, 2026-08-23)

- **O1 (D4)**: **DECIDED — byte-indexed, matching Rust.** `len()` = bytes O(1),
  `chars()`/`char_indices()` for rune walks, `char_len()` for the O(n) count,
  find/slice APIs byte-indexed with a char-boundary contract. The additive half
  (`char_len`/`char_indices`/`is_char_boundary`/`floor_char_boundary`/
  `ceil_char_boundary`/`try_substring`, on both string types) **landed
  2026-08-26**; the basis flip itself is still ahead (D4 plan PRs 2-9).
- **O2 (D6)**: **DECIDED — platform TLS libraries via `pkg_config`**
  (SecureTransport/Schannel/OpenSSL), behind one `TlsStream` implementing the
  D5 traits. Until it lands, https throws `UnsupportedScheme` (C1).
- **O3**: **DECIDED — externally tagged** `{"Variant": {...}}` (serde default).
- **O4**: **DECIDED — keep `imm/` in std for now.** Fix bugs, mark unstable
  until it has real consumers; revisit promotion at stability time.
- **O5**: **DECIDED — single `ToString`.** No `Debug`/`Display` split; derive
  output routed through a `Formatter` so pretty/compact can be added additively.
- **O6**: **DECIDED — delete `CustomAllocator`** — **DONE 2026-08-25** (§6 round 2) (zero implementors, never
  plumbs into collections). Rationale recorded: Yo objects are reference-
  counted, so a per-collection allocator parameter would have to flow through
  every RC header alloc/free — the Zig model doesn't fit. If per-heap control
  is ever needed, the additive path is a process-global allocator hook at the
  runtime-C level (Rust `#[global_allocator]` model — the mechanism the
  existing `--allocator system|mimalloc` flag already proves out), not a
  type-level parameter.
- **O7**: **DECIDED — require `Acyclic` on imm element types, like `Arc`.**
  The invariant is: atomic RC is only sound for acyclic data (no GC tracking),
  so `atomic(...)` of a non-`Acyclic` type is a BUG, not a feature request.
  Breaking bound added to the imm family in S2; additionally audit that no
  other std surface hands out atomic RC over non-`Acyclic` payloads.

## 9. Phasing

1. **S0 — correctness (immediately post-release):** §2 C1–C13, each with a
   red-first test. No API changes beyond C1's throw.
2. **S1 — conventions ADR + prelude traits (D1–D3):** the foundation everything
   else builds on.
3. **S2 — the breaking sweep (§5 + §6 + D4/D5/D7/D8):** one release window —
   a v0.2.x PATCH bump, per the §5 versioning decision (no minor release);
   compiler tree migrates in the same PRs (it is the biggest std
   consumer and the best test).
4. **S3 — P0 additions.**
5. **S4 — P1 additions.**
6. **S5 — stability freeze:** stable/unstable markers in `yo doc` output,
   additive-only policy documented in `yo-design.instructions.md`.

Every stage gates on: `yo check ./std && yo check ./src`, the full language
suite, the internal suite for touched areas, `gates_fast.sh` + fixpoint, and
docs in both `docs/en-US` and `docs/zh-CN` for user-visible surface.
