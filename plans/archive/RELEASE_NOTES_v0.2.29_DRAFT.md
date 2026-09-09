# v0.2.29

> **ARCHIVED 2026-09-08 — v0.2.29 shipped.** This was the pre-release draft; the
> published notes are on the GitHub release
> (https://github.com/shd101wyy/Yo/releases/tag/v0.2.29), edited in from this
> file because the workflow fills the body from the last commit message only.

The **std API stabilization campaign's additive phase (§4 P1)** takes its two
biggest steps: the **Collections** and **Text** groups are now complete
against the audit list, and `std/math` gives `f64`/`f32` a real surface for the
first time. Alongside them, **six compiler bugs are fixed** — four of them found
by writing the std code that should have just worked, and two of those were
silently emitting invalid C behind a green `yo check`.

`yo verify` also arrives as a subcommand, and the LSP gets two rounds of audit
fixes.

## Highlights

### Collections — the §4 list is empty

- **A real single-probe `HashMap.entry` API** (#486). `entry(key)` resolves the
  slot in ONE walk of the probe sequence — hashbrown's
  `find_or_find_insert_slot` — and `or_insert` / `or_insert_with` /
  `and_modify` / `remove` read off it. The three accessors that stood in for it
  (`get_or_insert`, `get_or_insert_with`, `update_with`) each walked the
  sequence TWICE while their own doc comment claimed one; they are now
  one-liners over `entry`, so the comment is finally true.
- `HashMap` `retain` / `extend` / `FromIterator`, `BTreeMap.range` +
  `FromIterator` (#486).
- **`ArrayList` has all 18 rows** (#483, #488): `first`/`last`/`insert`/`append`/
  `swap`/`swap_remove`/`truncate`/`split_off`/`reserve`/`dedup`/`starts_with`/
  `ends_with`/`resize`/`fill`/`sort_by_key`/`binary_search_by`/`chunks`/`windows`.
- **`IntoIterator` on all six `imm` collections** (#492), so `for`, `collect`
  and every combinator work over them. `List` walks its cons chain and `Vec` its
  flat array — O(1) per step; the four hash/tree containers delegate to the
  `List` their existing `entries()`/`to_list()` already returned, and say so
  rather than implying laziness.

### Text — the `String` list is empty

- `trim_start_matches` / `trim_end_matches` / `trim_matches`, `rsplit`,
  `push_rune`, `insert` / `insert_str` / `remove` / `pop` (#489).
- **`chars().rev()` works** (#490). D4 promised it; no string iterator
  implemented `DoubleEndedIterator`, so the prelude's blanket `rev` had nothing
  to attach to. All four now do, with an exclusive back cursor, so forward and
  backward iteration compose on ONE iterator.
- **`lines()` strips the CR of a CRLF** (#490), as Rust's does. A Windows
  `\r\n` file previously left the carriage return on the end of every line,
  where it compares unequal against every literal. Exactly one `\r` goes, so
  `"a\r\r\n"` still yields `"a\r"`.

### Core

- **Every integer gets `checked_` / `wrapping_` / `saturating_` /
  `overflowing_` arithmetic**, plus `abs`/`pow`/`clamp` (#481, #483) — landed as
  ONE generic impl over an `Integer` marker trait rather than ten copies.
- **`std/math`** (#488): ~45 inherent methods on `f64` and the `f32` subset C
  has single-precision entry points for, plus the mathematical and limit
  constants. Not in the prelude because the prelude imports nothing and has no
  `c_include`; `std/string/rune.yo` sets the precedent for giving a primitive
  type methods from an ordinary module.
- **`error_is(err, T)` and `Context`** (#493). `Context` is the type that makes
  `Error.source` worth having — nothing in the tree overrode it before, so
  every error chain was one link long.
- **`bench` gets `black_box` and `bench_auto`** (#494), and **`log` gets a
  `Sink` trait and `YO_LOG`** (#494). The `Sink` makes the log module testable
  for the first time: its own test file previously said it could only assert
  filter behaviour "because output goes to a real fd".

### Concurrency

- **`try_recv` returns `Result(T, TryRecvError)`** (#495) — see Breaking.
- **`Semaphore.with_permit`** (#495), the `with_lock`-shaped guard for permits.

## ⚠️ Breaking changes (patch-release policy)

- **`Channel.try_recv` returns `Result(T, TryRecvError)`** instead of
  `Option(T)` (#495). The old `Option` collapsed the two answers a polling
  caller must act on differently: `.None` meant both "nothing buffered yet,
  retry" and "closed and drained, no value will ever arrive". `TryRecvError` is
  `Empty` | `Disconnected`. A loop that was `while(v.is_some(), ...)` becomes
  `while(v.is_ok(), ...)`.

**Deprecated aliases kept one more release:** `derive(ToString)` and
`json_parse_result`, introduced as aliases in v0.2.28, are still present. They
were slated for removal here; keeping them one more cycle so the removal is a
deliberate, announced change rather than a side effect of this batch.

## Compiler fixes

Four of these were found by writing std code that should have just worked, and
two of them emitted invalid C behind a green `yo check`.

- **A `c_include`d constant now emits its header** (#487). Header collection
  only ever fired for `.Func` callees, so a GLOBAL never contributed one:
  reading `M_PI` alone emitted `use of undeclared identifier` with no
  `#include <math.h>` anywhere. It hid for as long as it did because every
  program touching `stdout`/`stderr` also calls `fprintf` from the same header.
- **A non-finite comptime float constant now emits valid C** (#487). C `%g`
  renders them `inf` / `-inf` / `nan`, none of which carries a radix point, so
  the float-literal emitter appended `.0` and produced `inf.0`. They now emit
  the C11 `HUGE_VAL` / `HUGE_VALF` / `NAN`.
- **`_USE_MATH_DEFINES` on Windows** (#487). `M_PI` and the rest of the `M_*`
  family are a POSIX extension; the MS CRT defines them only under that macro.
- **A local named after a C-interop type now shadows it** (#483).
  `long := ArrayList(i32).new()` was silently unreachable, because builtin type
  names resolved from a hard-coded table BEFORE any environment lookup. Scoped
  to the C-interop vocabulary (`int`, `char`, `long`, `void`, …) — ordinary
  English words people name variables.
- **`to_expr` accepts a template literal** (#483), and a swallowed `tests/http`
  handler is fixed.
- **Type-unification errors are anchored at the argument / call** rather than a
  synthetic row-0 token (#496).

## Also in this release

- **`yo verify`** — a Z3 solver harness and subcommand (#484).
- **LSP**: analysis state survives parse and eval errors, identity-based rename,
  UTF-16/UTF-32 position negotiation, member go-to-definition, import-list
  completion, readable names for instantiated generics (#485, #491).
- **`ensures(...)` names the return** via the labeled return (#475).

## Known limitations recorded, not papered over

Nine issues were filed with reproducers rather than worked around. The ones
that shape the API you see:

- `std/math` ships **without** `INFINITY` / `NEG_INFINITY` / `NAN`: their only
  comptime spelling is an overflowing literal, which the v0.2.28 **seed** still
  miscompiles. They arrive next release, now that this one moves the seed.
- `ErrorChain` / `root_cause` are absent: `Dyn(SelfTrait)` never unifies with
  `Dyn(ThatTrait)`, so `err.source()`'s result cannot be held at
  `Option(AnyError)` and the chain cannot be walked past one link.
- `error_is` is a free function, not `err.is(T)`: a blanket inherent method on a
  `Dyn` receiver is dispatched through the vtable, where no slot exists.
- `black_box` takes scalars only. The address-based version that would accept
  aggregates double-drops an RC value — found by CI's Linux ASan leg, filed with
  the isolation table.
- `Mutex.try_lock`, `RwLock.try_*` and `Condvar.wait_timeout` need a new C
  runtime macro, so they wait on the seed this release provides.
