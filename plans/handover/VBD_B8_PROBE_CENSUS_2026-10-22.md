# V2b B8 flip probe (N4): the census (2026-10-22/23)

**Status:** a record, 2026-10-23. The probe is the never-merged branch
`probe/v2b-b8-flip-census` (worktree `~/Workspace/Yo-wt/b8-probe`), based on
develop `e30c0d8ed`. It holds the B8 std change, the edits that unmask the
errors after it, and the issues the probe filed. The std flip is NOT for
landing. This doc is N4's output for `plans/VALUES_BY_DEFAULT.md`, B8:
"run the probe until it is clean; each remaining E0901 goes back into B3–B7".

## 0. Verdict

- **No SEED-only bug was found.** Every check error, crash, invalid C file
  and wrong runtime result that the probe hit reproduces the same way under
  the v0.2.68 seed and under a binary built from develop `e30c0d8ed`.
  - Per-file first errors over all 172 std files: identical under both.
  - The `check ./src` frontier: identical.
  - All 29 language-test files run: identical, failure for failure.
- **Eleven compiler bugs are filed** (§7). None is seed-specific: each is
  fixed on develop and reaches stage 1 through a release. Four of them block
  or bend the B8 std change itself, so a seed must carry their fixes before
  B8 can drop the workarounds:
  - **The raw-view gate rejects the generic `ArrayList(T)`**
    (`issues/2026-10-22-the-raw-view-gate-rejects-a-generic-buffer-owning-value-parameter.md`).
    Once `ArrayList(T)` is a value it owns its buffer outright, yet in a
    safe file the gate rejects a generic parameter such as
    `xs : &ArrayList(T)` (both binaries; the concrete `ArrayList(i32)` passes). `std/rand.yo` hit it, and the probe put
    `pragma(Pragma.AllowUnsafe)` on that file.
  - **The returning-arm false positive**
    (`issues/2026-10-22-a-move-in-a-returning-match-arm-leaks-into-the-continuation-when-the-scrutinee-is-a-call.md`):
    9 std sites took a `.clone()` that a fixed compiler would not need.
  - **A struct pattern on a newtype emits invalid C**
    (`issues/2026-10-22-a-struct-pattern-on-a-newtype-emits-a-field-access-the-c-type-does-not-have.md`).
    `String.into_bytes` cannot move its buffer out, so the probe clones it.
  - **An early return in a derive-generated body skips a value local's
    drop**
    (`issues/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md`).
    After B8, every `derive(FromJson)` error path leaks the fields that it
    has already decoded.
- **B8 has two prerequisites that no B-step owns yet** (§8):
  - **Decision 28's value-root argument rule.** `s.push_string(&s)` lends
    `&mut s` and `&s` at once. Develop accepts it (for a value `V` as well,
    `v.add(&v)`), and after the flip it reads a freed buffer.
  - **Decision 47's locals Generation B over std** (E0917 below module
    level). std is exempt from the rule today, so a write to a copy that used
    to be a shared handle is silent. That is how `OrderedMap`'s position
    index and `toml.yo`'s table cursor lose their writes.
- **The flip's std edit footprint:** 51 std files, 8 src files (src stops at
  the B5 wall, §4) and 26 test files.

## 1. What ran

| Item | Value |
| --- | --- |
| Base | develop `e30c0d8ed` (worktree `~/Workspace/Yo-wt/b8-probe-base`, detached) |
| Seed | v0.2.68, `/home/yiyiwang/.local/lib/yo/v0.2.68/bin/yo`, sha256 `fddf5dca0bbbfbe2…` |
| Tree binary | built from a tree whose `src/` and `std/` are byte-identical to `e30c0d8ed`, sha256 `863fe16d17193f45…` (`~/Workspace/Yo-wt/vbd-logs/b8-probe/yo-tree`) |
| Caps | every check/test step under `systemd-run --scope -p MemoryMax=12G -p MemorySwapMax=0`, `timeout` 1800–5400 s, inside a heavy-lock slot (never `exclusive`) |
| Logs and scripts | `~/Workspace/Yo-wt/vbd-logs/b8-probe/` (`scripts/unmask.py` is the error-driven unmasker, `scripts/aggregate.py` the census) |

The std change is the plan's B8 scope, with nothing else in it:

- `ArrayList :: (fn(comptime(T) : Type) -> comptime(Type))(struct(_ptr : ?*T, _length : usize, _capacity : usize))`, so the `ref(...)` is gone. `Drop`, `Trace` and `Clone` already existed.
- `String :: newtype(_bytes : ArrayList(u8))`, which was `Option(ArrayList(u8))`. All 223 `_bytes` sites in `std/string/string.yo` are rewritten.

The method was error-driven. Each check run stops a module at its first
error. The unmasker classified that error, applied the smallest edit that
let the check go on, and recorded the site as one JSON line. It repeated
this until the module checked clean or it hit an error it could not
classify (a STOP, edited by hand). The edits, by kind:

- `.clone()` on a `Clone` source;
- `__probe_dup(&x)` in a generic body (a comptime `Clone`/`Copy` dispatch
  added to `std/prelude.yo`, a stand-in for B6/B7);
- `__probe_read_elem(p)` for a read through an element pointer;
- a hoisted `.clone()` before an `io.async`/closure that captures a borrow;
- a `derive(T, Clone)` on a type that lacks it;
- `mut(...)` for decision 47.

Each count below is a lower bound, as the plan says: an error can hide the
rest of its function.

Not run:

- the full `src/` census (it stops at the B5 wall, §4);
- `yo compile`/codegen of `src/`;
- the fixpoint;
- `tests/internal`;
- the runtime of the eight test files that stop at check (§5).

## 2. std: `yo check ./std --std-path ./std`

On the bare flip, 71 of the 172 std files pass and 101 stop. All 101 stop
at `std/string/unicode.yo:2183` (`input`, an `ArrayList(u8)` copied out of a
`&` parameter), the same under both binaries.

With the probe's edits, **172/172 pass under the seed and under the tree
binary**: 73 s and 49 s on the branch's final std (`a1767e95a`), and 70 s
and 54 s on `689ce0ba9`. Each of the 48 unmask-edited files was also reverted
one at a time and re-checked under both binaries: the first error is
identical in 48 of 48.

### 2.1 The residual list: 328 sites

By kind:

| Sites | Kind | B-step |
| ---: | --- | --- |
| 132 | copy of a `&T` parameter or a `match`/`for` binding | B3 |
| 49 | field of a value (no partial moves) | B3 |
| 39 | element or projection of a borrowed value | B3, B6 |
| 28 | `io.async`/closure capture of a borrow (a hoisted clone) | B3 |
| 19 | use after a (conditional) move | B3 |
| 16 | match scrutinee taken by value | B3 |
| 12 | missing `derive(…, Clone)` | B3 |
| 9 | false positive: a move in a returning arm of a match on a call result (issue, §7) | compiler fix |
| 7 | copy out of a `&mut` binding (a match on a `&mut` receiver) | B3 |
| 6 | accessor copy in generic std code | B6 |
| 5 | closure moves an implicit capture (E0913) | B3 |
| 2 | sharing reliance (`std/encoding/toml.yo`: module-wide `cur`/`root` aliasing) | B3 (redesign) |
| 2 | raw-view gate: `std/async/channel.yo` (a real raw pointer through the `Waker`), `std/rand.yo` (the generic-`ArrayList(T)` bug, §7) | B3 / compiler fix |
| 1 | a derive arm copies its payload | B3 |
| 1 | a list of `ref` handles needs a handle-copy `Clone` (`RegexNode`) | B3 |

By directory: `std/encoding` 83, `std/regex` 49, `std/url` 40, `std/http`
38, `std/fs` 30, `std/cli` 21, `std/` root 16, `std/net` 15,
`std/string` 10, `std/process` 9, `std/fmt` 5, `std/collections` 5,
`std/crypto` 5, `std/async` 1, `std/testing` 1.

The manual accessors outside the census rows still need B6/B7's real
shapes. The probe made them copy:

- `ArrayList.get`, through `__probe_read_elem`;
- `ArrayList.into_iter`/`iter`/`chunks`/`windows`, whose iterators hold a
  `__probe_dup` of the list;
- `HashMap`'s `get`/entry/iter readers;
- the `BTreeMap`, `PriorityQueue` and `OrderedMap` iterators;
- `__borrow_guard` in the prelude, which copies the collection.

### 2.2 Against the B3 dry run

`VBD_B3_STD_EXPLICIT_COPY_LISTING_2026-10-22.md` (52 insertions, 162 listed
sites) predicted **200 of the 328 sites; 128 were not predicted.** Most of
the unpredicted sites fall into six kinds:

- 25 closure/`io.async` captures of a borrow;
- 16 uses after a move;
- 15 element projections;
- 12 match-by-value scrutinees;
- 12 missing `Clone` derives;
- the 9 false positives.

B3's plan should treat the dry run as about 60% of the work.

## 3. `src/`: `yo check ./src --std-path ./std` with the flipped std

With the std of `689ce0ba9` (every std file clean, before the test-driven
iterator edits) and develop's `src/`, **9 of 275 files pass under both
binaries**, with the same first errors. In cascade order:

| Files whose first error is here | Site | Error |
| ---: | --- | --- |
| 173 | `src/token.yo:300` | E0901: `lang` (`String`) copied out of a borrow |
| 147 | `src/expr.yo:9` | imports the token.yo failure |
| 37 | `std/collections/array_list.yo:1187` | the iterator's `_list : self` (B7) |
| 36 | `src/types/definitions.yo:93` | E0901: `self : ArrayList(Rc(Self))` copied |
| 10, 8, 6, 2 | `src/emitter.yo:225`, `src/utils.yo:171`, `src/cache.yo:89`, `src/diagnostics.yo:25` | E0901: a `String` parameter `s` copied |
| 3 each | `src/input_record.yo:97`, `src/cli_lang.yo:15`, `src/lock_file.yo:155`, `src/value.yo:11`, `src/env.yo:11` | E0917 on `g_touches` (a global), `lang`, a `TomlValue` element |
| 2 | `markdown_yo`'s `src/renderer.yo:515` (the store copy at the `yo.lock` pin) | E0901: `self.buf` (a field) |

The `markdown_yo` dependency fails too, so B8 needs a companion
`markdown_yo` release (the plan's N3) before `src/` can build.

## 4. `src/`: the sweep and the B5 wall

The sweep cleared 36 sites in 8 files: `cache.yo`, `cli_lang.yo`,
`diagnostics.yo`, `emitter.yo`, `input_record.yo`, `lock_file.yo`,
`token.yo` and `utils.yo`. By kind:

- 15 copies of a `&T`;
- 5 fields of a value;
- 3 module-level bindings;
- 3 match scrutinees;
- 2 module-level collections written through a handle;
- 2 missing derives;
- 1 each of: element projection, a `derive(Clone)` placed after its first
  copy, E0913, generic accessor, pointer deref, and the global below.

It stopped at `src/diagnostics.yo`: `g_pending_warnings.push(…)` is E0917.
Marking the global `mut(...)` turns every read into E0916 (a mutable global
cannot be lent). **Every collection global in `src/` needs B5 (`RefCell`
globals) before B8**, as the plan orders. The sweep cannot go further
without B5, so it stopped there.

## 5. Tests: check

The sweep ran `yo check --test-bodies` with the seed on the 36 test files the
plan's B8 Tier 1 names. Without `--test-bodies`, test-body errors are
swallowed. One swallowed error also breaks the next `derive` in the file:
`issues/2026-10-22-a-swallowed-test-body-error-inside-a-while-loop-breaks-the-next-derive.md`.

- `yo fix --migrate mut-bindings` (tree binary) marked 324 + 4 written
  bindings (decision 47 locals).
- The census has 105 sites:
  - 35 collection locals written without `mut` (before the migration);
  - 26 generic accessor copies (B6);
  - 18 uses after a move;
  - 12 element projections;
  - 3 missing derives;
  - 3 test expectations changed by B8;
  - 2 B5 globals;
  - 1 each: `&T` copy, match scrutinee, an iterator holding its source
    (B7), a `ref`-handle list `Clone`, a `&mut`-binding copy, and a test
    asserting sharing.
- Expectation edits that B8 owns:
  - `tests/cycle_collector.test.yo:751`: `ArrayList(RExprTwin)` can no
    longer form an `Rc` cycle, so the assertion is inverted. More flipped
    assertions follow from line 752 on.
  - `tests/copy_trait.test.yo:296`: the E0610 text names `String` as
    move-only.
  - `tests/collections/array_list_convenience.test.yo:242`: `shared.clone()`.
  - `tests/index.test.yo:1065`: `mut(xs)`.
- 28 files check clean.
- 8 files stop:

| File | Stops at | Needs |
| --- | --- | --- |
| `tests/collections/hash_map.test.yo` | `HashMapEntry` clone | B7 (entry API) |
| `tests/move_only.test.yo`, `tests/rc.test.yo` | E0916 on collection globals | B5 |
| `tests/async_await.test.yo` | E0912, a borrow of a global | B5 |
| `tests/copy_trait.test.yo` | the unmasker's capture-list edit at line 497 (`{ s.clone() }` is not a capture), plus expectation texts | hand edit |
| `tests/cycle_collector.test.yo` | more `can_form_rc_cycle` assertions from line 752 | B8 expectation edits |
| `tests/for_macro_borrow.test.yo` | `__BorrowGuard(C)(_c : …)` (prelude) copies the collection; the flag lives on an RC header a value list does not have | B7 (§3.10's guard split by path) |

`tests/collections/array_list_convenience.test.yo` stopped first and was then
cleared by hand (the `shared.clone()` above).

## 6. Runtime: the language tests under both binaries

The 29 test files that check clean were run with `yo test <file> --std-path
./std --parallel 1 -v` (ASan, the runner's default), plus `yo test ./std`
(its only two test files, 7 tests). The baseline is develop `e30c0d8ed`'s
own tree under the same binaries:

- under the seed, everything passes except `tests/cycle_collector.test.yo`
  and `tests/async_await.test.yo` (the seed lacks `__yo_cycle_collector_off`,
  a seed/std skew);
- under the tree binary, everything passes.

**Seed and tree agree on every file, failure for failure.**

| File | Pass / fail (both binaries) | Cause | Classification |
| --- | --- | --- | --- |
| 21 files (deque, hash_set, linked_list; base64, csv, hex, html, percent, utf16, utf8; every `tests/string/*` except `string.test.yo`; `for_macro_borrow_strict`; `index`; `array_list_convenience`; `comptime`) | all pass | | |
| `tests/collections/array_list.test.yo` | see §6.1 | | |
| `tests/collections/btree_map.test.yo` | 32 / 1 | "iter - mutate values through pointer": `BTreeMapIterPtr` holds a probe copy of the entries | probe artifact (B7) |
| `tests/collections/priority_queue.test.yo` | 24 / 1 | the same for `PriorityQueueIterPtr` | probe artifact (B7) |
| `tests/collections/ordered_map.test.yo` | 15 / 5 (4 ASan heap-use-after-free, 1 `unwrap` on `None`) | `_index_add`/`_index_drop`/`_index_bump` write a `match` binding of `self._index.get(&h)`. That was the bucket list's shared handle and is now a copy, so a `swap_remove` leaves the moved key's position stale and `_find_pos` compares a key that `swap_remove` has freed | sharing reliance, silent (decision 47 locals not enforced in std, §8) |
| `tests/encoding/toml.test.yo` | 11 / 25 | the parser's `cur`/`root` table aliasing | sharing reliance |
| `tests/encoding/json.test.yo` | 72 / 2 | "JsonValue Clone makes an independent tree": `b.pointer(…).unwrap().push(…)` writes a temporary copy. "derived decode missing field errors": 1-byte leak | sharing reliance (B6: `pointer` must project); **compiler bug** (§7, derive early return) |
| `tests/for_macro_borrow_user_collection.test.yo` | 3 / 1 | panic "container operation while an interior reference … borrows from it" in a read-only `&Self` method that runs `for(self.items, …)` | **compiler bug** (§7, mutation mask) |
| `tests/string/string.test.yo` | 202 / 100 with the struct-pattern `into_bytes`; 301 / 1 with the clone workaround | the batch of 100 fails at the C compiler (§7, newtype struct pattern). The remaining failure, "s.push_string(s) appends a copy of itself", is an ASan heap-use-after-free | **compiler bug**; decision 28's value-root rule is missing (§8) |

`tests/comptime.test.yo` first failed to compile in the run snapshot,
which lacked `tests/fixtures/` (`comptime_read_file`). With the fixtures
copied in, it passes 47/47 under both binaries.

### 6.1 `tests/collections/array_list.test.yo`

129 pass and 1 fails under both binaries. The failure is "ArrayList.iter pointers
alias the buffer — writing through one mutates the list": `ArrayListIterPtr`
holds a probe copy of the list, so the writes land in the copy. This is a
probe artifact; B7's iterator shapes own the real answer.

## 7. Bugs filed

Each has a reproducer under `issues/repros/`, which fails the same way under
the v0.2.68 seed and develop `e30c0d8ed`'s tree binary. None needs the flip.
None is fixed here.

| Issue | Severity | Effect on B8 |
| --- | --- | --- |
| `issues/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.md` | S1 | use-after-free; the collapse path in `src/codegen/exprs/cond.yo` skips the arm's dup |
| `issues/2026-10-22-the-raw-view-gate-rejects-a-generic-buffer-owning-value-parameter.md` | S2 | blocks safe generic `ArrayList(T)` code at stage 1 (probe: pragma on `std/rand.yo`) |
| `issues/2026-10-22-a-move-in-a-returning-match-arm-leaks-into-the-continuation-when-the-scrutinee-is-a-call.md` | S2 | 9 std false positives |
| `issues/2026-10-22-a-whole-value-destructuring-binds-move-only-fields-as-borrows.md` | S2 | `{ _bytes } := self` cannot move a field out |
| `issues/2026-10-22-a-struct-pattern-on-a-newtype-emits-a-field-access-the-c-type-does-not-have.md` | S2 | invalid C; `into_bytes` must clone |
| `issues/2026-10-22-clone-of-an-anonymous-record-element-copies-the-element-first.md` | S2 | an extra copy, then E0901 |
| `issues/2026-10-22-a-swallowed-test-body-error-inside-a-while-loop-breaks-the-next-derive.md` | S2 | misleading check results without `--test-bodies` |
| `issues/2026-10-23-a-read-only-method-iterating-a-value-field-asserts-its-receiver-unborrowed.md` | S2 | spurious borrow-flag panic |
| `issues/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md` | S2 | every `derive(FromJson)` error path leaks |
| `issues/2026-10-23-a-ref-payload-in-another-variant-makes-a-move-only-match-binding-a-borrow.md` | S2 | false E0901; on develop it blocks `derive(FromJson)` on structs with move-only fields |
| `issues/2026-10-22-a-move-in-one-cond-arm-is-reported-at-the-other-arm.md` | S3 | wrong note location |

## 8. The work list, by B-step

- **Compiler fixes, released before the B8 seed:** the eleven issues in
  §7. The raw-view gate, the newtype struct pattern, the derive early-return
  drop and the returning-arm false positive come first, because B8's std
  change itself works around them.
- **Decision 28's value-root rule** ("lands with V2b", no B-step yet). A
  `&mut` argument that overlaps another argument must be E0910 for a value
  root. Today `v.add(&v)` compiles. After B8, `s.push_string(&s)` is a
  use-after-free, and `tests/string/string.test.yo`'s self-push test has
  to become a compile-error case.
- **Decision 47's locals Generation B over std** (and src), before or in
  B8. `YO_AUDIT_MUT_BINDINGS=1 yo check ./std` (tree binary) lists 1,067
  unmarked written bindings on develop and 1,277 on the flipped std. The
  exemption (`global_mut_rule_applies`) hides each sharing-reliance write
  that the flip turns into a lost write. The audit counts one pattern
  binding: `ordered_map.yo:157`, the `_index_add` bucket. `_index_drop` and
  `_index_bump` are not in its output, so it is a lower bound too.
- **B3 (std hand edits):** §2.1's 328 sites, minus the 9 false positives.
  - `toml.yo`'s table cursor and `OrderedMap`'s position index need a
    redesign, not a clone.
  - `json.yo`'s `pointer(…)` needs a projection (B6).
- **B4 (src hand edits):** §3–4. The frontier is dominated by `String`
  parameters copied out of borrows.
- **B5 (collection globals):** the wall at `src/diagnostics.yo`, plus
  `tests/move_only`, `tests/rc` and `tests/async_await`.
- **B6 (accessors):** the 6 std and 26 test generic accessor copies, plus
  `ArrayList.get`, `HashMap` get/entry and `JsonValue.pointer`.
- **B7 (iteration and entries):**
  - `ArrayList`/`BTreeMap`/`PriorityQueue` iterators that hold their
    source;
  - `__borrow_guard`'s copy;
  - `HashMapEntry`;
  - the `IterPtr` mutation tests.
- **B8 itself:**
  - the §5 expectation edits;
  - the `markdown_yo` companion release (N3).

## 9. Re-running

```bash
L=~/Workspace/Yo-wt/vbd-logs/b8-probe
bash $L/scripts/check_std.sh <bin>                  # every std file, first error each
python3 -I $L/scripts/aggregate.py $L/census-std-seed.jsonl
python3 -I $L/scripts/cmp_tests.py flip-seed flip-tree   # runtime, seed vs tree
YO_AUDIT_MUT_BINDINGS=1 <tree-bin> check ./std --std-path ./std 2> mut.err
```
