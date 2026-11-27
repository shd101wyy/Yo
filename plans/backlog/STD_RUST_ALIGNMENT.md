# std against Rust's std: names aligned, shapes not (STD_RUST_ALIGNMENT)

**Status: BACKLOG, adopted 2026-11-25: the findings, class D, the S-0..S-6 / P-1..P-4 PR plan, and all six open questions (Q4-Q6 by the coordinator; Q1-Q3 answered by the maintainer the same day, §6).**
Source: Fable 5.2's audit of `std/` against Rust's std (VERDICTS-82), delivered 2026-11-25 on origin/develop `8da9761d1`. The
audit read signature dumps of the 110 non-test `std/` files outside `std/libc` and `std/sys` (the prelude, collections,
string, fmt, io, fs, path, env, time, sync, thread, process, net, error, hash and mem signature by signature, the rest by
exported names) and ran probes against a v0.2.79 + 40 commits binary whose std matches develop. Probe ids (`a1`..`d5`) below
name that probe set, kept with the audit and not in this repository; every claim a probe backs also holds on the tree.
Inputs: `VALUES_BY_DEFAULT.md` decisions 20, 39, 43, 49; [`REFERENCES_AND_ORIGINS`](REFERENCES_AND_ORIGINS.md) §3 and §8;
VERDICTS-70, -73, -74, -78; [`RUST_ADOPTION_CANDIDATES`](RUST_ADOPTION_CANDIDATES.md).

**Decided by the maintainer: `ArrayList` is not renamed to `Vec`** (a mathematical vector has a fixed size; this type grows).
It is recorded in class D (§4) and applied to the names that follow it (`Deque`, `PriorityQueue`).

**Progress.** S-0 (the compiler's Rust-name hints and the pack and docs class-D list) is the first PR; S-1 to S-6, L-1 and P-1 to
P-4 are not started.

## 1. Headline

- The 2026-09 audit fixed names (D9–D18) and they have held: `push`/`pop`/`insert`/`remove`/`len`/`is_empty`/`contains_key`/`with_capacity`/`retain`/`dedup`/`swap_remove`/`split_off`/`truncate`, the `checked_`/`wrapping_`/`saturating_`/`overflowing_` integer families, `Rc`/`Arc`/`Weak` (`new`, `clone`, `downgrade`, `upgrade`, `get_mut`, `make_mut`, `try_unwrap`), `mem.replace`/`take`/`swap`, `Hasher`, `Duration`/`Instant`/`SystemTime`, `Command`/`Child`/`ExitStatus`/`Output`, `TcpListener`/`TcpStream`/`UdpSocket`, `OpenOptions` and the `fs` verbs are Rust's names. I found few plain renames left (§2 rows 9–11).
- What a Rust-trained model trips on today is the **shape std took while references could not be returned or stored** (decisions 20 and 39): closures receive `&T`, getters copy, `iter()` yields raw pointers, `keys()`/`chars()` consume, text is `&String`, and `str` has four methods. Decision 43 and N3 already say these become Rust's shapes; std has not followed. Every one of the proposals in rows 1–5 type-checks on today's binary as user code (probes a2, a3, d1, d5; a2, a3, d1 and d5 also compile and run).
- **No std proposal below needs a seed split**: each changes `std/` and its `src/` callers in one PR, and the seed builds that tree with `--std-path ./std`. The compiler item is separate: Q1's `try` builtin (§6) needs a seed split; the hint table (§3.6) is diagnostics only and needs none. `src/` names the std methods this plan touches in three places: the `for` desugar (`into_iter`, unchanged), the template lowering (`push_str`, unchanged) and the verifier's model of `get`/`get_cloned` (`src/verifier/vc.yo:5251`, changed with §3.4); `types/flowability.yo`'s help text also spells `xs.get(i)`.

## 2. Findings, ranked by frequency of use × surprise

Counts are `git grep` call sites on develop (`src` / `std` non-test / `tests`).

| # | Class | API | Yo today (probe) | Rust | Proposal | Cost; seed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | C | closure parameters of `Option`/`Result`/`Iterator` combinators | every closure gets `&T`: `x.map(a => (a * i32(2)))` is E0926 (a1), and `yo-design`'s own example is that line. `Option.map` borrows `self`, `Result.map` consumes it. Over a borrowed walk the item is `&&T` (`x.*.*`, a5c) | `map`, `and_then`, `map_err`, `unwrap_or_else`, `for_each`, `fold`, `any`, `all`, `position`, `filter_map` take the item by value; `filter`, `find`, `take_while`, `skip_while`, `inspect` take `&Item` | §3.1 | `.map(` 7/8/41, `.fold(` 4/0/13, `.for_each(` 2/4/21, `.and_then(` 1/0/8, the rest ≤ 6 each: about 25 `src`, 40 `std`, 250 test sites. One PR, no split |
| 2 | B then C | `str` has no read API | `"a,b".split(",")`, `.trim()`, `.contains()`, `.starts_with()`, `.chars()`, `.is_empty()`, `.parse(T)`, `.to_owned()` are E0610 on a literal and on a `&str` parameter (b2, c1–c8); beyond `len`, `ptr`, `bytes(i)`, the comparisons and `to_string` it has nothing. `String` has them all | they are `str`'s; `String` reaches them by coercion | §3.2 | stage 1 moves bodies, adds about 35 delegates; no caller changes. Needs `as_str` (S3b-`str` PR E), so the v0.2.80 seed |
| 3 | C | text parameters | 290 `&String` parameters in std against 84 `&str`. `Path.new("/tmp")`, `Command.new("ls").arg("-l")`, `u.push_str(&t)` are E0601 (c17, b7, c21: `Expected: "String"`, `Given: "comptime_str"`, no help line), and so is `takes(&s)` at a `&str` slot (a6). `m.get("a")` on a `HashMap(String, V)` is E0601 (b1) | `&str`; `Borrow<Q>` on map lookups; `AsRef<Path>` in `fs` | §3.3 | 290 signatures and their callers; a census sweep. Post-VBD. No split |
| 4 | C | element getters | `xs.get(i) -> Option(T)` copies: E0901 on any non-`Copy` element (a4), so `src/` calls `get_cloned` 5,652 times. Same in `first`/`last`, `HashMap.get`, `Deque.front`/`back`/`get`, `BTreeMap.get`, `PriorityQueue.peek`, each with a `_cloned` twin. No `get_mut` (c31) | `get -> Option<&T>`, `get_mut`, `.cloned()`, `.copied()` | §3.4 (decision 43 already says so: VBD line 9068) | `.get_cloned(` 5,652/50/392 (textual rewrite); `.get(` 1,728/127/748 (typed rewrite). Post-VBD. `vc.yo:5251` in the same PR |
| 5 | C | borrowing iteration | `xs.iter()` yields `*T` and is rejected in safe code with an uncoded error (c32); the reference cursor exists only as `(&xs).into_iter()`. `m.keys()`, `m.values()`, `s.chars()`, `s.bytes()`, `s.lines()`, `xs.chunks(n)`, `xs.windows(n)` take `self` by value (a8, a9: E0901); `src/` writes `s.clone().chars()` 30 times | `iter`/`iter_mut`/`keys`/`values`/`values_mut`/`chars` borrow; `into_iter`/`into_keys`/`into_values` consume | §3.5 | `.iter()` 2/13/22, `.keys()`+`.values()` 6/2/15, `.keys_cloned()` 44/3/2, `.chars()` 35/8/62. One PR for collections, strings with row 2 |
| 6 | lang | error propagation | no `?`, no `try`; every propagation is a four-line `match` | `?` | Q1 | a builtin: seed split |
| 7 | B | first-line failures | `Vec` → E0401 "did you mean `Rc`?" (d3). `import("std/collections")` → uncoded "Module not found" (d2). `f64(2.0).sqrt()` → E0610 until `import("std/math")` (c14). `assert`, `String`, `println` each need an import | prelude + `use std::collections::HashMap` | a Rust-name hint table in the compiler (§3.6); barrel `index.yo` modules (Q2, PR S-6); explicit imports stay (Q3) | the table is compiler-only, no split; S-6 is additive std |
| 8 | C | `HashMap.entry` | `m.entry(k, e => { e.and_modify(n => …); e.or_insert(&v); })`; `m.entry(k).or_insert(v)` is E0603 (c30); `or_insert(&V) -> V` returns a clone | `entry(k).or_insert(v) -> &mut V`, `or_insert_with`, `or_default`, `and_modify` | `Entry(K, V, p)` as a value. **Not expressible today**: a `&mut(V, p)` result from a consumed holder is "the projection borrows no argument" (d4, d4b, d4d). Until then `get_or_insert`/`get_or_insert_with`/`update_with` are the forms | waits for the parity item; then `.entry(` 1/2/24 |
| 9 | B | small missing pieces | `Ordering` has no `Eq`: `a.cmp(&b) == .Less` fails (c16). No `Ord.max`/`min` (c10; `clamp` exists). No `Option.as_ref`/`as_mut`/`is_none_or`/`xor`/`insert`/`get_or_insert_with`, no `Result.is_ok_and`/`is_err_and`. No `xs.join(sep)`/`concat` (b6), `as_slice` (c25), `extend` over an iterable (c28), `first_mut`/`last_mut`. `RUST_ADOPTION_CANDIDATES` S1's adapter list is still absent (`flat_map`, `min_by_key`, `max_by_key`, `product`, `partition`, `find_map`, `reduce`, `step_by`, `flatten`), with `cloned`/`copied` | present | add them (§4, PR S-2); `derive(Ordering, Eq, Ord, Hash)` plus `is_lt`/`is_le`/`is_gt`/`is_ge`/`is_eq`/`is_ne`/`reverse`/`then`/`then_with`; `min`/`max`/`clamp` as provided methods of `Ord` | additive |
| 10 | A | tuples, not pair structs | `enumerate`/`zip`/`char_indices`/`Option.zip`/`env.vars` yield `IterPair(A, B)` (`_0`, `_1`); owned map iteration, `get_key_value`, `pop_first`, `remove_entry` yield `MapEntry(K, V)`, while `for(&m, (k, v) => …)` yields a `Tuple` | `(A, B)` everywhere | `Tuple(A, B)`; delete `IterPair` and `MapEntry`; `first_entry`/`last_entry` → `first_key_value`/`last_key_value` | `IterPair` 1/37/4, `MapEntry` 27/113/30 |
| 11 | A | plain renames and signature fixes | see §3.7 | | | about 250 `src` sites in 90 files, mechanical |
| 12 | C | conversions | `From.from(value : &Source)`, `Into.into(self : &Self, T)`, `TryFrom`/`TryInto` likewise; `FromIterator.from_iter_add(acc, item : &Elem)` clones every collected item | by value | by value (d5 runs); `from_iter_add(acc : Self, item : Self.Elem)` | no `From` impl outside the prelude's numeric ones; `.into(` 0/1/3. Rides PR S-1 |
| 13 | A/C | `std/io` traits | `Reader`/`Writer` with `read(buf : *u8, size : usize, io)`; `BufReader.read_line -> Option(String)`; no `read_to_end`/`read_exact`/`write_all` as provided methods; `TcpStream.write_str`/`write_string`/`write_bytes` | `Read`/`Write`/`BufRead`/`Seek` over `&mut [u8]`/`&[u8]` | `Read.read(self, buf : &mut [u8], io)`, `Write.write(self, buf : &[u8], io)`, provided `read_to_end`, `read_to_string`, `read_exact`, `write_all`; `BufRead.read_line(self, buf : &mut String, io) -> usize`, `lines()` | `Reader`/`Writer` 3/75/65; with IO-1c, post-VBD |
| 14 | C | `Error.source` | `-> Option(Box(Dyn(Error, Clone)))`, a clone per step; `AnyError` carries an interim `Clone` bound | `Option<&(dyn Error + 'static)>` | `source : (fn(self : &Self) -> Option(&Dyn(Error)))`; drop `Clone` from `AnyError` | post-VBD; needs `Option(&Dyn(...))` results |

## 3. The proposals

### 3.1 Closures take what Rust's take (row 1)

```yo ignore
// Option(T). Result(T, E) the same way: map, map_err, and_then, or_else, unwrap_or_else, map_or, map_or_else.
map : (fn(generic(B : Type), self : Self, f : Impl(FnOnce(a : T) -> B)) -> Option(B))
and_then : (fn(generic(B : Type), self : Self, f : Impl(FnOnce(a : T) -> Option(B))) -> Option(B))
is_some_and : (fn(self : Self, f : Impl(FnOnce(a : T) -> bool)) -> bool)
filter : (fn(self : Self, predicate : Impl(FnOnce(a : &T) -> bool)) -> Option(T)) // &T, as Rust
as_ref : (fn(self : &Self) -> Option(&T))
as_mut : (fn(self : &mut Self) -> Option(&mut T))
// on Option(&T): copied (T <: Copy), cloned (T <: Clone)
// Iterator: by value in map, for_each, fold (acc and item), any, all, position, filter_map;
// &A stays in filter, find, take_while, skip_while, inspect, and in retain / sort_by_key.
map : (fn(generic(A : Type, B : Type, F : Type), self : Self, f : F, where(Self <: Iterator(Item := A), F <: (FnMut(item : A) -> B))) -> IterMap(Self, B, F))
```

- Receivers consume (`unwrap` already does); `opt.as_ref().map(…)` is the borrowed form, as in Rust. The closure is passed by value, not `&mut Impl(FnMut)`: it runs once, so it may move its captures.
- After this, `xs.iter().map(x => (x.* * i32(2)))` is Rust's `|x| *x * 2`, and `.filter(x => (x.*.* > i32(1)))` is Rust's `|x| **x > 1`. The double star stops being a Yo oddity and becomes the one a model already knows.
- To file (S3, diagnostics): a type error inside an adapter's closure is reported as E0610 `No method "collect" on IterMap(…)` (a5; the real error is `x.* * i32(2)` at `x : &&i32`).

### 3.2 The read API lives on `str` (row 2)

- **Stage 1 (B).** Move the bodies of the read-only family from `String` to `str`, with today's return types, and give `String` a one-line delegate for each (VERDICTS-73 §7 leaves "which methods move" to a per-family decision; this is the decision for the whole family): `len is_empty is_ascii is_char_boundary contains starts_with ends_with find rfind split splitn rsplit split_once split_whitespace lines chars bytes char_indices trim trim_start trim_end trim_matches trim_start_matches trim_end_matches strip_prefix strip_suffix replace replacen to_uppercase to_lowercase to_ascii_uppercase to_ascii_lowercase eq_ignore_ascii_case repeat parse to_owned as_bytes`. `String.as_str()` arrives with S3b-`str` PR E's family (VERDICTS-74); `as_bytes() -> &[u8]` is added here.
- In the same PR: `FromString`/`from_string(s : &String)` → `FromStr`/`from_str(s : &str)` (the doc comment's reason, "there is no conversion from `String` to `str`", ends with PR E); `str.bytes(i)` → `as_bytes()(i)` (4/16/3 uses), which frees `bytes()` for the iterator; the `Option`-returning `parse_i32`/`parse_i64`/`parse_u32`/`parse_u64`/`parse_f64`/`parse_bool` are deleted for `parse(T)` (78 `src` sites; D12 kept them "one release" in September) and `parse_i64_radix_res` becomes `i64.from_str_radix(s, radix)`; `chars`/`bytes`/`char_indices`/`lines` take `self : &Self` and hold `&(str, p)`.
- **Stage 2 (C), post-VBD.** `trim*`, `strip_prefix`/`strip_suffix` return `&str`; `split_once -> Option(Tuple(&str, &str))`; `split`/`lines`/`split_whitespace` become lazy iterators of `&str`. It waits for N2's collections of references: without `ArrayList(&str)` the most common Rust line, `s.split(',').collect::<Vec<&str>>()`, has no spelling, and an iterator-returning `split` would be worse than today's list. See Q5.

### 3.3 Text parameters are `&str` (row 3)

- A read-only text parameter is `s : &str`. A caller holding a `String` writes `s.as_str()`; a literal fits as it is, and stops allocating (`Path.new("/tmp")` builds a `String` from a template today).
- **No generic `AsRef(str)` bound on ordinary text parameters.** It would recover Rust's coercion, but it turns 290 checked bodies into deferred generic ones, which no std gate evaluates (`issues/questions/2026-11-17-uninstantiated-std-generic-bodies-escape-every-std-gate.md`). Instead E0601 at a `&String` argument in a `&str` slot gets a structured repair, "write `s.as_str()`", which `yo fix` applies. This is the Yo-specific shape of Rust's `&String`→`&str` coercion: one diagnostic, one mechanical repair.
- `push_string(&String)` is deleted for `push_str(other.as_str())` (1,274 `src` sites, textual), in the same sweep.
- Generic bounds stay where Rust itself is generic: `Pattern` (as today); **`Borrow(Q)`** on `HashMap`/`HashSet`/`BTreeMap` `get`/`get_mut`/`contains_key`/`remove` (`issues/questions/hashmap-lookup-by-borrowed-key-form.md`, option 2: `impl(String, Borrow(str))`, `impl(ArrayList(T), Borrow([T]))`, the identity impl); and **`AsPath`** for `fs`: `generic(P : ?Sized), path : &P, where(P <: AsPath)` with impls for `str`, `String` and `Path`. `Path` is a parsed struct (`_prefix`, `_segments`), so it cannot be `AsRef(Path)`'s free view; `AsPath` is the honest name. It deletes the 32 `_str`/`_cstr` twins in `std/fs` (`open_str`, `read_to_string_str`, `exists_str`, …) and the `where(P <: ToString)` parameters that stand in for it today (`Path.join`, `Path.push`, `env.get`), which accept any printable value.

### 3.4 Getters lend (row 4)

```yo ignore
get : (fn(self : &Self, index : usize) -> Option(&T)) // ArrayList, Deque; first, last, front, back, peek likewise
get_mut : (fn(self : &mut Self, index : usize) -> Option(&mut T)) // plus first_mut, last_mut, front_mut, back_mut
get : (fn(generic(Q : ?Sized), self : &Self, key : &Q, where(K <: Borrow(Q), Q <: (Hash, Eq(Q)))) -> Option(&V)) // maps; get_mut likewise
get_key_value : (fn(…) -> Option(Tuple(&K, &V)))
```

- `get_cloned`, `first_cloned`, `last_cloned`, `front_cloned`, `back_cloned`, `peek_cloned`, `get_key_value_cloned`, `get_index_cloned`, `first_entry_cloned`, `last_entry_cloned`, and decision 20's `with(i, body)` are deleted: `xs.get(i).cloned()`, `xs(i).clone()`, `xs.get_mut(i)`. Probe a3 is `get_ref` written in user code today.
- `get_mut`, `first_mut`, `last_mut` are additive and land early (PR S-2); the flip of `get` is the sweep.

### 3.5 `iter()` lends, `into_*` consumes (row 5)

```yo ignore
iter : (fn(self : &Self) -> ArrayListIter(T, self)) // today's ArrayListCursor; d1 is this as a free function
iter_mut : (fn(self : &mut Self) -> ArrayListIterMut(T, self)) // today's ArrayListCursorMut
// maps: iter -> Tuple(&K, &V), iter_mut -> Tuple(&K, &mut V), keys, values, values_mut borrow;
// into_keys(self), into_values(self) are today's keys()/values(). Sets: iter. Deque: iter, iter_mut.
```

- Type names follow Rust's: `XIntoIter` (owning, today's `XIter`), `XIter`, `XIterMut`. The raw walk becomes `iter_raw() -> XRawIter(T)`, for unsafe-capable files only; yo-design's naming table row "pointer iterator: `iter()`" is replaced.
- `keys_cloned`/`values_cloned`/`items_cloned` are deleted for `m.keys().cloned().collect(ArrayList(K))` (49 `src` sites).
- `chunks`/`windows` move to `[T]` as borrowing iterators of `&[T]` once a `[T]` range is a place (S3b-`str` PR B's rider); `slice(start, end) -> Result` and `slice_copy*` are deleted for `xs(a .. b).to_owned()`, and `extend_cloned(&ArrayList)` becomes `extend_from_slice(&[T])`.

### 3.6 The Rust-name table (row 7)

One table in the compiler, read by E0401, E0610 and the module-not-found path, and printed in the pack (class D is its source):

| A model writes | Help |
| --- | --- |
| `Vec`, `vec![…]`, `VecDeque`, `BinaryHeap`, `PathBuf`, `char`, `Cell`, `MutexGuard` | `ArrayList` (`std/collections/array-list`), `ArrayList(T).from([…])`, `Deque`, `PriorityQueue`, `Path`, `rune`, `RefCell`, `m.with_lock(v => …)` |
| `import("std/collections")` and any std directory without an `index.yo` | the directory's modules, listed (the five directories of Q2 gain an `index.yo` in S-6) |
| `x.sqrt()` and the other float methods; `assert`, `panic`, `println`, `String` unbound | the import line (Q3: no extended prelude, the hint names the import) |
| `f(&s)` at a `&str` slot; `s.len()` through a handle | `s.as_str()`; `.*` (E0623, decided) |

### 3.7 Renames and signature fixes (row 11, class A)

| Today | Becomes | Sites (`src`/`std`/`tests`) |
| --- | --- | --- |
| `String.index_of`, `last_index_of` | `find`, `rfind` (c19); `ArrayList.index_of` stays, and gains `iter().position(…)` | ≤ 88/24/101 (shared with lists) |
| `String.push_rune(r)`; `sep.join(&items)` | `push(r)`; `items.join(sep)` on `[String]`, with `concat` | 2/1/3; ≤ 69/0/14 |
| `sort_by(less : (a, b) -> bool)`, `sort_unstable_by` | `sort_by(compare : (a, b) -> Ordering)` (b5 is E0601 today) | 0/2/5 |
| `env.get(k) -> Option(String)`, `env.set`, `env.remove`, `cwd()`, `chdir(p)`; `home_dir`/`config_dir`/`cache_dir -> Option(String)`, `temp_dir -> String` | `env.var(k) -> Result(String, VarError)`, `set_var`, `remove_var`, `current_dir()`, `set_current_dir(p)`; the four return `Path` | 62/16/128 |
| `get_hardware_threads()`, `get_thread_id()`, `get_cpu_id()` (the `get_` prefix D2 bans) | `available_parallelism()`, `thread_id()`, `cpu_id()` | 18/12/11 |
| `Cond`, `signal`, `broadcast`; `Once.call`; `OnceCell` (the atomic one) | `Condvar`, `notify_one`, `notify_all`; `call_once`; `OnceLock` | 10/33/39 |
| `Channel.recv -> Option(T)` but `Receiver.recv -> Result(T, TryRecvError)` (whose `.Empty` a blocking `recv` never returns) | both `recv -> Result(T, RecvError)`; `try_recv` keeps `TryRecvError`; `send -> Result(unit, T)` stays (the value comes back, which is what `SendError<T>` is for) | 0/7/67 |
| `HashSet.union`/`intersection`/`difference`/`symmetric_difference -> Result(Self, HashSetError)`; `ArrayList.shrink_to_fit -> Result` | `-> Self`; `-> unit` (D9: an allocation failure panics) | few |
| `replace_first`, `replace_all` ("deprecated aliases still exported") | deleted (`replacen(p, to, 1)`, `replace`) | few |
| `Metadata.size()`, `DirEntry.name()`, `process.pid()` | `len()`, `file_name()`, `process.id()` | few |

## 4. Class D: divergences to keep, and to print in the pack and `docs/` so models stop expecting the Rust form

| Yo | Rust | Reason |
| --- | --- | --- |
| `ArrayList(T)`, `std/collections/array-list` | `Vec<T>` | Maintainer: in mathematics a vector has a fixed size; this type grows. Decided, not open |
| `Deque`, `ArrayList(T).from([…])`, and `to_owned()` on a slice (proposed, §3.5) | `VecDeque`, `vec![…]`, `to_vec()` | They follow `ArrayList`: no std name says `Vec` |
| `PriorityQueue`, `OrderedMap`, `StringBuilder`, `WaitGroup`, `Semaphore` | `BinaryHeap`, (indexmap), `String` + `write!`, none | The same reasoning: the name of the abstract type, not of one implementation; the last four have no Rust std counterpart |
| `rune` | `char` | `char` is C's 8-bit type and FFI needs it |
| `Path` (one owned, parsed type) with `AsPath` | `Path`/`PathBuf`/`AsRef<Path>` | No unsized path view; `Path` is what Rust calls `PathBuf` |
| `Eq(T)`, `Ord(T)` | `PartialEq`/`Eq`, `PartialOrd`/`Ord` | D3.3: floats carry a total `cmp`; no split |
| `Negate`, `Mod`, `BitLeftShift`, `BitRightShift`, `LogicalNot`, `BitNot` | `Neg`, `Rem`, `Shl`, `Shr`, `Not` | Yo's own names today. VERDICTS-82's reason here ("the compiler finds them by name, so a rename is a seed split") was false and is retracted: `src/` keys on no operator trait name, and the released v0.2.79 `yo` checks `./std` and `src/main.yo` against a std that binds `Rem`, `Neg`, `Shl`, `Shr` (VERDICTS-87 §2). `Mod`, `Negate`, `BitLeftShift`, `BitRightShift` become `Rem`, `Neg`, `Shl`, `Shr` in v0.2.81 (§9); `LogicalNot` and `BitNot` stay and `Not` stays unbound |
| `it.collect(ArrayList(i32))`, `s.parse(i32)`, `x.into(i64)` | turbofish or inference from the result | The type is an argument: Yo does not infer from the result type |
| `s.as_str()`, `&xs.*`, `h.*.field` | deref coercion, auto-deref | VERDICTS-73/74 |
| `m.with_lock(v => …)`, `rw.with_read`/`with_write`, `cell.with`/`with_mut` | `lock()` guards, `borrow()`/`borrow_mut()` | Decisions 38 A and 41; a guard cannot have `g.*` outside the prelude (E0622). No poisoning, so no `.unwrap()` on a lock |
| `exn : Exception`, `io : Io`, `-> Impl(Future(T, IoExn))` on every `fs`/`net`/`process` call; `Thread(T).spawn((io : Io) => …)`, `join() -> T` | `io::Result<T>`, blocking calls, `thread::spawn`, `JoinHandle<T>` | Effects and the `Io` interface; `JoinHandle` is the async task's handle |
| `new((alloc : Option(Allocator)) ?= .None)`, `clone_in(a)` | `new_in` (unstable) | Explicit allocators |
| `unwrap`/`expect` are E0611 outside tests and unsafe-capable files | everywhere | Safe mode |
| `ArcWeak`, `MemoryOrder` | `sync::Weak`, `atomic::Ordering` | One flat prelude namespace: `Weak` and `Ordering` are taken |
| `Duration` over signed `i64`; `as_millis() -> i64` | `u64` seconds, `u128` millis | No 128-bit integers (S6); a negative span is representable |
| `json`/`toml` `parse`/`stringify` | serde's `from_str`/`to_string` | D2: one verb pair for every text format |
| `BTreeMap` | `BTreeMap` | Same name and order; it is a sorted array today (O(n) insert). Say so in its doc until it is a tree |

## 5. PR plan

Order inside a release is top to bottom. Every PR: `check ./src`, `check ./std`, `yo build --std-path ./std` when `src/` changed, the named tests one file per call, `scripts/cli-diff-test.sh` (std changed), fmt with the tree binary, `check-issue-refs.sh`; the pack, `yo-design`'s naming table and both `docs/` languages in the same PR.

| PR | Release | Content | Depends on | Extra gates |
| --- | --- | --- | --- | --- |
| S-0 | v0.2.80 or v0.2.81 | compiler: the Rust-name table (§3.6); the E0601 `as_str()` repair once PR E is in; file the E0610 misattribution (§3.1) and the uncoded safe-code raw-pointer error (c32); a help line on E0601 for a literal at a `&String` slot (b1, b7) until P-2 removes the slot | nothing | cli-cases `explain`/`fix`; `diagnostics-registry` |
| S-1 | **v0.2.81**, after VERDICTS-78 Q3 PR 1 (both edit the prelude and `std/fmt`) and after F1/F2 | §3.1; row 12 (`From`/`Into`/`TryFrom`/`TryInto`, `from_iter_add` by value); `IterPair` → `Tuple` (row 10, first half) | v0.2.80 seed only for ordering | `option-result-combinators`, the iterator and `prelude` tests, `async/stream` (its own `map`/`filter`), `yo compile src/main.yo --skip-c-compiler` |
| S-2 | **v0.2.81** | row 9, all additive; `get_mut`/`first_mut`/`last_mut`/`values_mut` | S-1 (`Option(&T).cloned`) | each addition has a test |
| S-3 | **v0.2.81** | §3.5 for collections; `MapEntry` → `Tuple` (row 10, second half) | S-1 | the collection tests, `tests/origins` corpus and model, `for`-desugar tests, `yo verify ./std/collections` |
| S-4 | **v0.2.81** | §3.7, as two PRs: collections/strings/sync, then env/thread/fs/process | S-3 for `find` vs `position` | the renamed modules' tests; test-name strings rewritten (the D2 rule) |
| S-5 | **v0.2.81 if PR E shipped in v0.2.80, else v0.2.82** | §3.2 stage 1, with `FromStr` and the string iterators | the seed that carries PR E and P12 | `string*`, `fmt`, `encoding/*` tests; callers change only at the `parse_*` (78 `src`), `FromString` (0/24/20) and `str.bytes(i)` (4/16/3) sites |
| S-6 | **v0.2.81** | Q2: re-export-only `index.yo` modules for `std/collections`, `std/fs`, `std/time`, `std/sync` and `std/net`; `std/process/index.yo` already re-exports all of `std/process/command` (`Command` among it), a test pins `{ Command } :: import("std/process")`; `yo-design`'s "no catch-all `index.yo`" rule is amended in this PR to allow a re-export-only `index.yo`; the compiler's directory-import help (S-0) then applies to the directories that still have none | nothing | a test per `index.yo` (each name resolves through the barrel and through its module); `yo check ./std`; cli-diff; the load cost of a barrel measured on `yo check src/main.yo` (a barrel that costs more than noise keeps the rule and stays out) |
| P-1 | v0.2.83+ | §3.4: a recorder binary for the typed `.get(` rewrite (F1's method), a textual one for `_cloned`; the verifier's `get` model | S-2 | the fixpoint; C emit-diff reviewed, not required empty |
| P-2 | v0.2.83+ | §3.3: `&str` parameters by module group (string, encoding, http/url, regex, cli/log, process/env), `Borrow`, `AsPath`; `push_string` deleted | S-0's repair, S-5 | per group |
| P-3 | v0.2.83+ | §3.2 stage 2 and the slice views of §3.5 | N2 (collections of references) | origins corpus rows for views |
| P-4 | v0.2.83+ | row 13 with IO-1c; row 14; row 8 when a consumed holder can return its origin | IO-1c; the parity item | — |
| L-1 | first post-VBD language item | Q1: the `try(expr)` builtin (`.Err(e)` returns `.Err(From.from(e))` from the enclosing `fn`, `.None` returns `.None`); not a macro, not `?` | S-1 (`From` by value) | seed split: the builtin lands first, the std and `src/` uses after the seed carries it; `option-result-combinators`, an error-propagation test file, `yo explain` |

Why S-1 to S-4 go into v0.2.81 and not later: they are small (under 100 `src` sites each except the renames), they are what the pack and the docs teach, and v0.2.81 already rewrites the same pages for `Display`/`Debug`. Why P-1 and P-2 wait: each is a tree-wide call-site sweep, and v0.2.81–82 need quiet call sites while implicit dup and drop are deleted.

## 6. Questions

| # | Question | Recommendation | Confidence | Resolution (2026-11-25) |
| --- | --- | --- | --- | --- |
| Q1 | `?`. It is the most frequent Rust idiom with no Yo spelling, and row 12 is its prerequisite (`From` by value for the error conversion) | A builtin `try(expr)`: on `.Err(e)` return `.Err(From.from(e))` from the enclosing `fn`, on `.None` return `.None`. Not a macro (macros are being removed) and not `?` (`?T` is `Option(T)`). First post-VBD language item; seed split | 0.7 | Maintainer: adopted. `try(expr)` is a builtin, not a macro; the first post-VBD language item (PR L-1, seed split) |
| Q2 | Barrel modules: `std/collections`, `std/fs`, `std/time`, `std/sync`, `std/net`, and `Command` from `std/process`. yo-design forbids a catch-all `index.yo` | Add the six, re-export only. A model's first line is `{ HashMap } :: import("std/collections")`. The load cost of a barrel is not measured; if it is material, keep the rule and rely on §3.6's listing | 0.65 | Maintainer: adopted for `std/collections`, `std/fs`, `std/time`, `std/sync`, `std/net`, re-export only; `std/process/index.yo` already re-exports `Command`. `yo-design`'s "no catch-all `index.yo`" rule is amended to allow a re-export-only `index.yo` (PR S-6, v0.2.81) |
| Q3 | An extended prelude: `String`, `print`/`println`/`eprintln`, `assert`/`panic` bound without an import (the prelude module itself imports nothing) | Yes, as compiler auto-imports of those names, post-VBD; `ArrayList` and the float methods of `std/math` with them. Until then §3.6 names the import | 0.6 | Maintainer: rejected. Imports stay explicit and there is no extended prelude (explicit over implicit). A template string already yields a `String` whose methods need no import; naming `String` (`String.from`) needs one (E0401), and the Rust-name hints name the import |
| Q4 | After §3.4, keep `get_cloned` as a convenience (decision 43's text) or delete it | Delete: the rewrite is textual, Rust has no such name, and D2 allows one name per operation | 0.7 | Coordinator: adopted (delete `get_cloned` after P-1) |
| Q5 | §3.2 stage 2: views and a lazy `split`, or keep owned results for good | Views, with N2. The semantically exact types, no allocation, and the `.to_string()` a model appends keeps working. Owned results are more forgiving of Python-shaped code (`parts.len()`), which is the argument against | 0.65 | Coordinator: adopted (views, with N2) |
| Q6 | `Cell(T)` (`issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`) | Add it for `T <: Copy`: `new`, `get`, `set`, `replace`, `take`. A counter in an `Rc` is the common case and `c.with(v => v.*)` is the surprise | 0.65 | Coordinator: adopted (`Cell(T)` for `T <: Copy`, v0.2.81 with S-2) |

## 7. Not verified

- Counts are text matches; `.get(`, `.index_of(` and `.join(&` include receivers that are not the type named. P-1 and P-2 need a census before sizing.
- That the reference cursor works as a method returning `ArrayListIter(T, self)` is inferred from d1 (a free function) and from `get_or_insert -> &mut(V, self)`; not probed as a method.
- PR E's surface (`as_str`, `String` ranges) is read from VERDICTS-74; it is not on the probe binary (`s.*` on a `String` is E0621 there, a7; `as_str` is E0610, c22).
- `http`, `url`, `regex`, `crypto`, `encoding`, `cli`, `log`, `rand`, `term` were read for names only. Their text parameters fall under §3.3; I found no other Rust-facing shape issue there, and did not compare `rand` to the `rand` crate.
- The load cost of a barrel `index.yo` (Q2) is not measured; PR S-6 measures it before merging.

## 8. Adoption (2026-11-25)

- Coordinator: adopted the findings (§2), class D (§4; `ArrayList` kept by the maintainer's decision, `Deque` and
  `PriorityQueue` likewise), the PR plan S-0..S-5 and P-1..P-4 (§5), and Q4-Q6 (S-6 and L-1 follow from the maintainer's answers below). S-0 is a v0.2.80 rider if it is ready
  before the cut, else v0.2.81. `Cell(T)` (Q6) is part of S-2.
- Maintainer, on the three questions that touch standing policy:
  - Q1: add `try(expr)` as a builtin (PR L-1), the first language item after VBD;
  - Q2: add re-export-only `index.yo` modules for `std/collections`, `std/fs`, `std/time`, `std/sync` and `std/net`
    (PR S-6, v0.2.81); `std/process/index.yo` already re-exports `Command`; `yo-design`'s "no catch-all `index.yo`" rule is
    amended in that PR;
  - Q3: keep explicit imports, no extended prelude. The Rust-name hints (§3.6) name the import.

## 9. Operator-trait names and `Ord.cmp` in std (VERDICTS-87, adopted 2026-11-26)

**Status: adopted by the coordinator; the maintainer approved Fable's recommendation in advance (2026-11-26).** Source: VERDICTS-87 (Fable 5.2), measured against origin/develop `1f8482b1f`. It retracts the reason §4 gave for the operator-trait row ("the compiler finds them by name, so a rename is a seed split"): `src/` keys on no operator trait name, and the released v0.2.79 `yo` checks `./std` and `src/main.yo` against a std that binds `Rem`, `Neg`, `Shl`, `Shr`.

Decisions:

- **Q1.** `Mod` → `Rem`, `Negate` → `Neg`, `BitLeftShift` → `Shl`, `BitRightShift` → `Shr`, and the four `Comptime*` twins; members unchanged (`(%)`, `neg`, `(<<)`, `(>>)`, `Output`). `LogicalNot` and `BitNot` keep their names; `Not` stays unbound and its hint row is reworded.
- **Q2.** `Eq(Rhs)` and `Ord(Rhs)` stay: no rename, no `PartialEq`/`PartialOrd` split. std's `Ord`-bounded algorithms must call `cmp` (today none does).
- **Q3.** No other prelude trait is renamed. Optional rider on S-1: `FromIterator.Elem` → `Item`.
- **Q4.** No seed split, no `yo fix`, no hint rows for the old names (a stale name gets E0401 and a did-you-mean).

| PR | Release | Content | Extra gates |
| --- | --- | --- | --- |
| V87-A | **v0.2.81, first PR after the v0.2.80 cut** | The scripted rename (`rename.sh` in VERDICTS-87's probes, regenerated on the tip; read each `Mod` hit outside `std/`) over `std/`, `tests/`, `docs/`, `pack/`, `.github/instructions/`, `plans/reference/` and §4 of this plan. `src/diagnostics.yo`: delete the `Neg`, `Rem`, `Shl`, `Shr` hint rows and reword `Not` to "`!` is `LogicalNot` and yields `bool`; Rust's `!` on an integer is `~`, `BitNot`". `Rem`'s doc comment says "remainder, sign of the dividend; `rem_euclid` for the non-negative one". Comments in three `src/` files; AGENTS.md's historical-names table gains the row | `yo build` (`src/` changed); the `prelude`, `parameter-modes` and operator tests; `scripts/cli-diff-test.sh` with `a-rust-operator-trait-name-...` moved to `Not` and `lsp-analysis-resilience` re-recorded |
| V87-B | v0.2.81 | std only: every `Ord`-bounded algorithm calls `cmp` (`sort`, `sort_unstable`, `sort_by_key`, `binary_search`, `BTreeMap`, `PriorityQueue`, `Iterator.min`/`max`); NaN rows in their tests; the `Ord` doc comment states the rule "code that needs a total order calls `cmp`; the operators are the type's own and are partial on floats". Fixes `issues/fixed/2026-11-26-std-ord-bounded-algorithms-never-call-cmp.md` | the collection tests; `yo verify ./std/collections` |
| V87-C | v0.2.81, with S-0's follow-ups | Diagnostics: `derive` consults the Rust-name table; a bare `Eq`/`Ord` in a derive or a bound says "write `Eq(P)`"; `!` at an integer slot names `~`; a moved operand of a unary operator is E0901. Fixes `issues/fixed/2026-11-26-rust-shaped-trait-spellings-get-no-useful-help.md` | cli-cases; `diagnostics-registry` |
| V87-D | v0.2.81 | Prelude: the `(-)` and `(~)` dispatchers return `_Self.Output`, comptime twins included; `BitNot` leaves `longdouble`; and, if the maintainer keeps the recommendation in `issues/fixed/2026-11-26-should-bang-on-a-number-be-deleted.md`, the 22 numeric `LogicalNot` impls are deleted. Fixes the `Negate.Output`/`BitNot.Output` and `~longdouble` issues of 2026-11-26 | `prelude`; a test with `Output` different from `Self`; a `~longdouble` rejection test |

Order against the rest of v0.2.81: A is a script, so it goes first and S-1 and VERDICTS-78's PR 1 (all three edit the prelude) rebase over it. The example repositories get a grep and, if anything matches, a companion commit.

Filed with it: `issues/fixed/2026-11-26-std-ord-bounded-algorithms-never-call-cmp.md`, `issues/fixed/2026-11-26-bitnot-on-a-longdouble-passes-check-and-emits-invalid-c.md`, `issues/fixed/2026-11-26-negate-and-bitnot-output-are-ignored-by-the-unary-dispatchers.md`, `issues/2026-11-26-a-supertrait-clause-applying-a-parametric-trait-to-self-is-unsatisfiable.md`, `issues/fixed/2026-11-26-rust-shaped-trait-spellings-get-no-useful-help.md`, and the question `issues/fixed/2026-11-26-should-bang-on-a-number-be-deleted.md`. If the maintainer later prefers Rust's four comparison traits (VERDICTS-87 §4, option S), the supertrait issue is generation A of that route.
