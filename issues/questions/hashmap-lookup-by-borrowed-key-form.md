# Looking up a `HashMap(String, V)` by a `str` (Rust's `Borrow<Q>`) is undecided (OPEN-DESIGN)

**Kind:** design question — an open decision, not a defect. Filed 2026-10-10
from the `plans/backlog/RUST_REFERENCE_PATTERNS.md` audit (§9), checked with
the session carrying the V3b stack: not decided anywhere in the migration.

## The hole

Rust's `HashMap<K, V>::get<Q>(&self, k: &Q) where K: Borrow<Q>, Q: Hash + Eq`
lets a `HashMap<String, V>` be probed with a `&str` and a `HashMap<Vec<u8>, V>`
with a `&[u8]`, with no allocation, because `String: Borrow<str>` promises
the two hash and compare identically.

std's `get` is `(fn(self : &Self, key : &K) -> Option(V))`
(`std/collections/hash_map.yo`), and the same holds for `contains_key`,
`remove`, `entry` and the `Index` impl. A `str`-keyed lookup on a
`String`-keyed map therefore allocates: `map.get(String.from(s))`. The
compiler's own symbol tables (`HashMap(String, …)` throughout `src/`)
pay this on every lookup from a token's text, and so will every ported
Rust program whose maps are keyed by owned strings.

## Options

1. **Status quo**: `String.from(s)` per lookup. Simple, allocates.
2. **A `Borrow(Q)` trait, as Rust**: `impl(String, Borrow(str))`,
   `impl(ArrayList(u8), Borrow(…))` once a byte view exists; `get` (and the
   other probing methods) become generic in `Q`:

   ```yo ignore
   get : (fn(generic(Q) : Type, imm(self) : Self, imm(key) : Q) -> Option(V))
     where(K <: Borrow(Q), Q <: (Hash, Eq(Q)))
   ```

   `K = Q` is the identity impl, so the common call is unchanged. Yo has no
   overloading, so this is one method, not a second `get_str`.
3. **An `Equivalent(K)` trait on the query type** (the `hashbrown`/`indexmap`
   shape): `impl(str, Equivalent(String))` says "a `str` hashes and compares
   like a `String`". Same call surface as 2, the impl lives on the query
   type rather than the key type, and it composes with newtype keys more
   easily (a `Symbol` newtype can declare itself equivalent to `str`).

## Recommendation

Option 3, after V2b (when `String` has a unique buffer and `str` is the
`Copy` view decision 36 made it). It is the Rust-shaped answer with the
impl on the side that knows the equivalence, it needs no new language
feature (a trait bound on a generic parameter), and the identity impl keeps
every existing call site. Until then option 1 stands and the catalog says
so. Not a VBD phase: a std PR with its own benchmark (`check ./src` symbol
lookups before and after).
