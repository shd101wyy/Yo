# Regex Engine Implementation Plan (`std/regex`)

## Goal

Implement a regular expression engine **in pure Yo** with JavaScript-like APIs that work natively with Yo's UTF-8 `String` type. This serves two purposes: providing a production-quality regex library and stress-testing the Yo language itself.

## Architecture

```
Pattern String → Regex Lexer → Regex AST → NFA Compiler → NFA Bytecode
                                                              ↓
Input String (UTF-8) → NFA Simulator (Thompson) → Match Result
```

### Key Design Decisions

1. **Thompson NFA** as the core engine — guarantees O(n·m) worst-case (no catastrophic backtracking)
2. **UTF-8 native** — operates directly on UTF-8 bytes, decodes code points when needed for Unicode matching
3. **Bytecode-based** — compile pattern to bytecode, interpret for matching
4. **JavaScript-compatible syntax** — same regex syntax and semantics as ECMAScript
5. **No C dependency** — pure Yo implementation

### Data Flow

```
Regex.new(`\\d+`, `gi`)
  → lex: [ BACKSLASH_D, PLUS ]
  → parse: Repeat(CharClass(Digit), 1..∞, greedy)
  → compile: [ CHAR_CLASS(digit), SPLIT(0, 2), MATCH ]
  → store as Regex { bytecode, flags }

regex.exec(`abc123def`)
  → NFA simulation on UTF-8 bytes of `abc123def`
  → Match { text: `123`, index: 3, captures: [] }
```

---

## Types

### Core Types

```rust
// Compiled regex pattern
Regex :: object(
  _bytecode : ArrayList(u8),     // Compiled NFA bytecode
  _flags    : RegexFlags,        // Flags (global, ignoreCase, etc.)
  _pattern  : String,            // Original pattern string
  _n_groups : usize              // Number of capturing groups
);

// Match result from exec()
Match :: struct(
  value     : String,            // Matched text
  index     : usize,             // Start position (character index)
  groups    : ArrayList(Option(String)),  // Captured groups (index 0 = full match)
  input     : String             // Original input string
);

// Flags
RegexFlags :: struct(
  global      : bool,   // g - match all occurrences
  ignore_case : bool,   // i - case-insensitive
  multiline   : bool,   // m - ^ and $ match line boundaries
  dot_all     : bool,   // s - . matches newline
  unicode     : bool,   // u - full Unicode matching
  sticky      : bool    // y - match from lastIndex only
);

// Error type
RegexError :: enum(
  InvalidPattern(message: String, position: usize),
  InvalidFlags(message: String),
  InvalidEscape(message: String, position: usize),
  InvalidQuantifier(message: String, position: usize),
  UnbalancedParenthesis(position: usize),
  InvalidCharacterClass(message: String, position: usize)
);
```

### Internal Types (Pattern AST)

```rust
RegexNode :: enum(
  Literal(codepoint: rune),
  Dot,                                       // . (any char)
  CharClass(ranges: ArrayList(CharRange), negated: bool),
  Anchor(kind: AnchorKind),                  // ^, $, \b, \B
  Group(body: *(RegexNode), index: usize, name: Option(String)),
  NonCapturingGroup(body: *(RegexNode)),
  Alternation(left: *(RegexNode), right: *(RegexNode)),
  Sequence(nodes: ArrayList(*(RegexNode))),
  Quantifier(body: *(RegexNode), min: usize, max: Option(usize), greedy: bool),
  Backreference(index: usize),
  NamedBackreference(name: String),
  Lookahead(body: *(RegexNode), positive: bool),
  Lookbehind(body: *(RegexNode), positive: bool)
);

AnchorKind :: enum(Start, End, WordBoundary, NonWordBoundary);
CharRange :: struct(low: rune, high: rune);
```

### NFA Bytecode Instructions

```rust
OpCode :: enum(
  Char(codepoint: rune),         // Match single character
  CharClass(index: usize),       // Match character class (lookup table)
  AnyChar,                       // Match any character (. or dotAll .)
  Split(a: usize, b: usize),    // Non-deterministic branch (NFA fork)
  Jump(target: usize),           // Unconditional jump
  Save(slot: usize),            // Save capture position
  Match,                         // Accept state
  AssertStart,                   // ^ anchor
  AssertEnd,                     // $ anchor
  AssertWordBoundary,            // \b
  AssertNonWordBoundary,         // \B
  Backreference(index: usize),   // \1, \2, etc.
  LookaheadStart(positive: bool),
  LookaheadEnd,
  LookbehindStart(positive: bool),
  LookbehindEnd
);
```

---

## API Design (JavaScript-like)

### Regex Methods

```rust
// Constructor
Regex.new : (fn(pattern: String, (flags: String) ?= ``) -> Result(Regex, RegexError))

// Test if pattern matches anywhere in string
Regex.test : (fn(self: Self, input: String) -> bool)

// Find first match (returns None if no match)
Regex.exec : (fn(self: Self, input: String) -> Option(Match))

// Find all matches (returns iterator)
Regex.match_all : (fn(self: Self, input: String) -> ArrayList(Match))

// Get pattern source
Regex.source : (fn(self: Self) -> String)

// Get flags as string
Regex.flags_str : (fn(self: Self) -> String)
```

### String Integration Methods

```rust
// These extend the existing String type

// Match against regex, return first match
String.match : (fn(self: Self, regex: Regex) -> Option(Match))

// Match all against regex
String.match_all : (fn(self: Self, regex: Regex) -> ArrayList(Match))

// Replace first/all matches
String.replace : (fn(self: Self, regex: Regex, replacement: Self) -> Self)
String.replace_all : (fn(self: Self, regex: Regex, replacement: Self) -> Self)

// Search for match, return index
String.search : (fn(self: Self, regex: Regex) -> Option(usize))

// Split by regex
String.split : (fn(self: Self, regex: Regex) -> ArrayList(Self))
```

### Match Methods

```rust
// Get the full matched text
Match.text : (fn(self: Self) -> String)

// Get capture group by index (0 = full match)
Match.group : (fn(self: Self, index: usize) -> Option(String))

// Get capture group by name
Match.named_group : (fn(self: Self, name: String) -> Option(String))

// Get match start/end positions
Match.start : (fn(self: Self) -> usize)
Match.end : (fn(self: Self) -> usize)
```

---

## Current Status

**Phases 1-5: COMPLETE** — All 39 tests pass.

Implemented:

- Iterative stack-based parser (ParseFrame-based, avoids forward reference limitation)
- Thompson NFA compiler with `recur` for recursive node compilation
- Thompson NFA VM with priority-based thread scheduling
- Full Regex API: `new`, `test`, `exec`, `match_all`
- RegexMatch object with `value`, `index`, `input`, `groups`
- RegexFlags parsing (`g`, `i`, `m`, `s`, `u`, `y`)
- Non-greedy quantifiers (`*?`, `+?`, `??`)
- Anchors (`^`, `$`, `\b`)
- Non-capturing groups `(?:...)`
- Character classes: `[a-z]`, `[^0-9]`, `\d`, `\w`, `\s`
- Case-insensitive matching (ASCII)
- Counted quantifiers: `{n}`, `{n,m}`, `{n,}`
- Alternation `|`
- Capturing groups with nested group support
- Error handling for invalid patterns/quantifiers

Key design decisions:

- VM uses "match-and-break" strategy: when Match found, record it and kill lower-priority threads. This correctly handles both greedy (higher-priority continue threads extend in later gens) and non-greedy (lower-priority continue threads are killed, shortest match wins).
- Parser uses iterative stack-based approach with ParseFrame structs instead of recursive descent, working around Yo's forward method reference limitation.
- All recursive calls use `recur(self, args)` per Yo's recursion model.

**Next**: Phase 10 (Performance Optimization)

Phase 10 completed: Added literal prefix extraction and fast-scan optimization — the compiler extracts leading literal ASCII bytes from the pattern, and `exec`/`match_all` use `_find_prefix_pos` to skip non-matching start positions. Added early-break in `_codepoint_in_class` loops to stop once a match is found. Disabled prefix optimization for case-insensitive patterns. Fixed unsigned underflow in `_find_prefix_pos` when input is shorter than prefix. 8 new tests added (85 total).

Phase 9 completed: Added `search`, `replace`, `replace_all`, and `split` methods to Regex. Replacement patterns support `$&`, `$1`-`$9`, `${name}`, `` $` ``, `$'`, and `$$`. Split includes captured groups in results (JS-compatible). Avoided early returns in `split` and `replace_all` to prevent RC memory leaks detected by ASan.

Phase 7 completed: All four lookaround assertions (positive/negative lookahead/lookbehind) implemented. Uses a `_run_sub_vm` method that runs a mini Thompson simulation for sub-patterns. Lookbehind tries all start positions backwards with UTF-8 boundary handling. Fixed a shared seen-array bug where lookbehind `current`-list additions were blocking `next`-list thread expansion — solved with separate `next_seen` array.

Phase 6 completed: Named groups, numeric backreferences (\1-\9), and named backreferences (\k<name>) all working. Used a DeferredThread mechanism for multi-byte backreferences — threads that consume multiple bytes are deferred until the target byte position is reached. Also discovered and fixed a Yo compiler bug: `getSizeOfType` didn't account for C struct alignment padding (pointer+bool struct was calculated as 9 bytes instead of 16).

---

## Implementation Phases

### Phase 1: Core Pattern Parser ✅

**Goal**: Parse regex pattern strings into an AST.

**Features**:

- Literal characters
- Escape sequences: `\d`, `\D`, `\w`, `\W`, `\s`, `\S`, `\n`, `\t`, `\r`, `\\`, `\.`, etc.
- Character classes: `[a-z]`, `[^abc]`, `[a-zA-Z0-9]`
- Dot `.` (any char except newline)
- Alternation `|`
- Grouping `(...)` with capture indices
- Quantifiers: `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`

**Files**:

- `std/regex/parser.yo` — pattern lexer and parser

### Phase 2: NFA Compiler ✅

**Goal**: Compile regex AST to NFA bytecode.

**Implementation**:

- Thompson's construction algorithm
- Each AST node → bytecode fragment
- `Split` instructions for alternation and quantifiers
- `Save` instructions for capture groups
- Concatenation by sequencing fragments

**Files**:

- `std/regex/compiler.yo` — AST → bytecode compiler

### Phase 3: NFA Simulator ✅

**Goal**: Execute NFA bytecode against input strings.

**Implementation**:

- Thompson NFA simulation (parallel state tracking with state set)
- Track capture group positions during simulation
- UTF-8-aware character stepping (advance by 1-4 bytes per codepoint)
- Greedy vs non-greedy quantifier handling via `Split` ordering

**Files**:

- `std/regex/vm.yo` — NFA virtual machine / simulator

### Phase 4: Regex API & Match Type ✅

**Goal**: High-level API wrapping the engine.

**Implementation**:

- `Regex.new()` — parse + compile
- `Regex.test()` — run VM, return bool
- `Regex.exec()` — run VM, build Match
- `Match` type with group access
- `RegexFlags` parsing from string (`gi`, `ms`, etc.)

**Files**:

- `std/regex/regex.yo` — `Regex` type and methods
- `std/regex/match.yo` — `Match` type and methods
- `std/regex/flags.yo` — flag parsing

### Phase 5: Extended Features ✅

**Goal**: Non-capturing groups, anchors, non-greedy quantifiers.

**Features**:

- Non-capturing groups `(?:...)`
- Anchors: `^`, `$`, `\b`, `\B`
- Non-greedy quantifiers: `*?`, `+?`, `??`, `{n,m}?`
- Multiline flag (`m`) — `^`/`$` match line boundaries
- Dot-all flag (`s`) — `.` matches `\n`

### Phase 6: Named Groups & Backreferences ✅

**Goal**: Named capture groups and backreferences.

**Features**:

- Named groups: `(?<name>...)`
- Named backreferences: `\k<name>`
- Numeric backreferences: `\1`, `\2`, ...
- Note: Backreferences require backtracking (NFA extension or hybrid approach)

### Phase 7: Lookahead & Lookbehind ✅

**Goal**: Zero-width assertions.

**Features**:

- Positive lookahead: `(?=...)`
- Negative lookahead: `(?!...)`
- Positive lookbehind: `(?<=...)`
- Negative lookbehind: `(?<!...)`

### Phase 8: Unicode Property Support ✅

**Status**: Complete — Unicode property escapes (`\p{...}` / `\P{...}`) are implemented with range tables for common categories. The engine already handles UTF-8 correctly for all matching operations.

**Features implemented**:

- `\p{Name}` and `\P{Name}` (negated) Unicode property escapes
- General categories: L/Letter, Lu/Uppercase_Letter, Ll/Lowercase_Letter, N/Number, Nd/Digit, P/Punctuation, S/Symbol, Z/Separator, M/Mark, C/Other
- Script categories: ASCII, Latin, Greek, Cyrillic, Han, Hiragana, Katakana, Hangul, Arabic, Devanagari, Thai, Emoji
- Boolean properties: White_Space/space, Alphabetic/Alpha
- `u` (unicode) flag enables `\p{...}` (but works without flag too)
- `y` (sticky) flag — anchors matching to position 0 (exec) or consecutively from end of previous match (match_all)
- Range tables in `std/regex/unicode.yo` with compact representation

**Not yet implemented**:

- Full Unicode case folding for case-insensitive matching
- Exhaustive Unicode property tables (current tables cover practical use cases)

### Phase 9: String Integration ✅

**Goal**: Add regex-aware methods to `String`.

**Features**:

- Overloaded `String.replace` / `String.replace_all` accepting `Regex`
- `String.match` / `String.match_all` with `Regex`
- `String.search` with `Regex`
- `String.split` with `Regex`
- Replacement patterns: `$1`, `$&`, `` $` ``, `$'`, `${name}`

### Phase 10: Performance Optimization ✅

**Goal**: Make the engine fast for real-world usage.

**Implemented optimizations**:

- ✅ Literal prefix optimization (extract leading literal bytes, skip NFA start positions via fast byte scan)
- ✅ Early break in character class matching (stop iterating ranges once a match is found)
- ✅ Case-insensitive prefix disabled (prefix scan is byte-exact, incompatible with case folding)

**Not implemented** (diminishing returns for current use cases):

- One-pass NFA for simple patterns
- Character class bitmap (256-bit bitmap for ASCII fast path)
- Compiled DFA cache for hot patterns

---

## File Structure

```
std/regex/
├── parser.yo      — Pattern lexer and parser (pattern string → AST)
├── compiler.yo    — NFA compiler (AST → bytecode)
├── vm.yo          — NFA virtual machine / simulator
├── regex.yo       — Regex type, constructor, test/exec/match_all
├── match.yo       — Match type and methods
├── flags.yo       — RegexFlags parsing
├── node.yo        — AST node types (NodeKind, RegexNode, CharRange)
├── unicode.yo     — Unicode property range tables for \p{...}
├── error.yo       — RegexError (added 2026-08-25, STD_API_AUDIT D8)
└── index.yo       — Regex type + the package's whole public surface
```

> Note: `regex.yo` above is historical — the `Regex` type lives in `index.yo`.

### Public surface (STD_API_AUDIT D8, 2026-08-25)

`import("std/regex")` exports exactly three names — **`Regex`**, **`RegexMatch`**
and **`RegexError`**. Every other module in the package is an internal, and its
`export(...)` list is now trimmed to exactly what its siblings consume:

| module | exports | consumed by |
| --- | --- | --- |
| `node.yo` | `RegexNode`, `CharRange`, `GroupNameEntry` | parser, compiler, unicode, match, index |
| `parser.yo` | `RegexParser` | index |
| `compiler.yo` | `NfaCompiler`, `NfaProgram`, `ClassEntry` | vm, index |
| `vm.yo` | `NfaVm` | index |
| `flags.yo` | `RegexFlags` | vm, index |
| `match.yo` | `RegexMatch` | index (public) |
| `unicode.yo` | `unicode_property_ranges` | parser |
| `error.yo` | `RegexError` | parser, flags, index (public) |

Dropped as consumed-by-nobody: `NodeKind`, `AnchorKind` (node), `Instr`,
`InstrKind`, `GroupNameEntry` re-export (compiler), `NfaThread`, `VmMatch`,
`DecodedChar` (vm), and `RegexFlags` from the package barrel — nothing public
accepts or returns a `RegexFlags`, so it was a leaked internal.

### Capture slots

There is **no cap on capture groups**. The VM allocates `2 * (n_groups + 1)`
`usize` slots per live NFA thread, derived from the compiled program; nothing
errors and nothing truncates (measured: 120 groups all capture — pinned by
"more than 99 capture groups neither error nor truncate" in
`tests/regex/regex.test.yo`). A `MAX_SLOTS :: 200` constant in `vm.yo` claimed a
99-group ceiling, was referenced nowhere, and was deleted rather than turned
into a limit the engine never had. The only group-count limits that are real are
*syntactic*: `\1`–`\9` backreferences and `$1`–`$9` replacement references are
single-digit, so groups past 9 are reachable by name or by
`RegexMatch.group(i)`.

---

## Test Plan

Tests will live in `tests/regex/regex.test.yo` (and possibly split into multiple files).

We will write tests inspired by the **ECMAScript Test262** suite (`test/built-ins/RegExp/`), covering the same categories. Since Test262 tests are JavaScript files, we'll port the patterns and expected results to Yo syntax.

### Test Categories

#### 1. Literal Matching

```
Pattern: "abc"
  ✓ matches "abc" in "xabcy"
  ✓ returns correct index
  ✓ no match in "xyz"
  ✓ matches first occurrence without 'g' flag
```

#### 2. Character Classes

```
Pattern: "[a-z]"
  ✓ matches lowercase letters
  ✓ does not match uppercase or digits

Pattern: "[^abc]"
  ✓ matches any char except a, b, c

Pattern: "[a-zA-Z0-9_]"
  ✓ matches word characters

Built-in classes:
  ✓ \d matches digits [0-9]
  ✓ \D matches non-digits
  ✓ \w matches word chars [a-zA-Z0-9_]
  ✓ \W matches non-word chars
  ✓ \s matches whitespace [ \t\n\r\f\v]
  ✓ \S matches non-whitespace
```

#### 3. Dot (Any Character)

```
Pattern: "a.c"
  ✓ matches "abc", "a1c", "a c"
  ✓ does not match "ac" (dot requires one char)
  ✓ without 's' flag, dot does not match newline
  ✓ with 's' flag, dot matches newline
```

#### 4. Anchors

```
Pattern: "^abc"
  ✓ matches at start of string
  ✓ does not match in middle
  ✓ with 'm' flag, matches at start of line

Pattern: "abc$"
  ✓ matches at end of string
  ✓ with 'm' flag, matches at end of line

Pattern: "\bword\b"
  ✓ matches whole word "word"
  ✓ does not match "sword" or "words"
```

#### 5. Quantifiers

```
Pattern: "a*"
  ✓ matches zero or more 'a's
  ✓ matches empty string (zero 'a's)

Pattern: "a+"
  ✓ matches one or more 'a's
  ✓ does not match empty string

Pattern: "a?"
  ✓ matches zero or one 'a'

Pattern: "a{3}"
  ✓ matches exactly 3 'a's

Pattern: "a{2,4}"
  ✓ matches 2, 3, or 4 'a's (greedy: prefers 4)

Pattern: "a{2,}"
  ✓ matches 2 or more 'a's
```

#### 6. Non-Greedy Quantifiers

```
Pattern: "a+?" on "aaa"
  ✓ matches "a" (minimal match)

Pattern: "a*?" on "aaa"
  ✓ matches "" (minimal match)

Pattern: "<.+?>" on "<a><b>"
  ✓ matches "<a>" (not "<a><b>")
```

#### 7. Alternation

```
Pattern: "cat|dog"
  ✓ matches "cat"
  ✓ matches "dog"
  ✓ does not match "bird"

Pattern: "a(b|c)d"
  ✓ matches "abd" and "acd"
  ✓ does not match "ad" or "abcd"
```

#### 8. Capturing Groups

```
Pattern: "(a)(b)(c)"
  ✓ group(0) is "abc" (full match)
  ✓ group(1) is "a"
  ✓ group(2) is "b"
  ✓ group(3) is "c"

Pattern: "(\d+)-(\d+)"
  ✓ captures both number groups from "123-456"

Nested groups: "((a)(b))"
  ✓ group(1) is "ab"
  ✓ group(2) is "a"
  ✓ group(3) is "b"
```

#### 9. Non-Capturing Groups

```
Pattern: "(?:abc)+"
  ✓ matches "abcabc"
  ✓ does not create a capture group
```

#### 10. Named Groups

```
Pattern: "(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})"
  ✓ named_group("year") returns "2024"
  ✓ named_group("month") returns "03"
  ✓ named_group("day") returns "17"
```

#### 11. Backreferences

```
Pattern: "(a+)\1"
  ✓ matches "aa", "aaaa" but not "aaa"

Pattern: "(?<word>\w+)\s+\k<word>"
  ✓ matches "hello hello" (repeated word)
```

#### 12. Lookahead

```
Pattern: "foo(?=bar)"
  ✓ matches "foo" in "foobar"
  ✓ does not match "foo" in "foobaz"

Pattern: "foo(?!bar)"
  ✓ matches "foo" in "foobaz"
  ✓ does not match "foo" in "foobar"
```

#### 13. Lookbehind

```
Pattern: "(?<=@)\w+"
  ✓ matches "user" in "@user"

Pattern: "(?<!@)\w+"
  ✓ does not match if preceded by @
```

#### 14. Case-Insensitive Flag ('i')

```
Pattern: "abc" with 'i' flag
  ✓ matches "ABC", "Abc", "aBc"
```

#### 15. Global Flag ('g')

```
Pattern: "a" with 'g' flag on "ababa"
  ✓ match_all returns 3 matches at indices 0, 2, 4
```

#### 16. Multiline Flag ('m')

```
Pattern: "^abc" with 'm' on "xyz\nabc"
  ✓ matches "abc" at start of second line
```

#### 17. Escape Sequences

```
  ✓ \n matches newline
  ✓ \t matches tab
  ✓ \r matches carriage return
  ✓ \. matches literal dot
  ✓ \\ matches literal backslash
  ✓ \( matches literal open paren
  ✓ \x41 matches 'A' (hex escape)
  ✓ \u0041 matches 'A' (unicode escape)
```

#### 18. Unicode

```
Pattern: "." on "你好"
  ✓ matches "你" (full codepoint, not partial byte)

Pattern: "[\u4e00-\u9fff]+"
  ✓ matches Chinese characters

Pattern: "\p{Letter}" (Phase 8)
  ✓ matches any Unicode letter
```

#### 19. String Integration

```
`hello world`.replace(Regex.new(`world`), `Yo`)
  ✓ returns `hello Yo`

`a1b2c3`.replace_all(Regex.new(`\\d`), `X`)
  ✓ returns `aXbXcX`

`a,b,,c`.split(Regex.new(`,`))
  ✓ returns [`a`, `b`, ``, `c`]

`hello world`.search(Regex.new(`world`))
  ✓ returns Some(6)

`abc123def456`.match_all(Regex.new(`\\d+`))
  ✓ returns matches [`123`, `456`]
```

#### 20. Edge Cases

```
  ✓ Empty pattern `` matches empty string
  ✓ Empty input with `a*` matches (zero-length)
  ✓ Very long input doesn't stack overflow
  ✓ Nested quantifiers `(a+)+` don't cause exponential blowup (Thompson NFA guarantee)
  ✓ Invalid patterns return RegexError
  ✓ Unbalanced parentheses return error
  ✓ Invalid escape sequences return error
  ✓ Invalid quantifier ranges return error (e.g., {5,2})
  ✓ Null bytes in input handled correctly
  ✓ Pattern with only anchors `^$` matches empty string
```

#### 21. Replacement Patterns

```
`2024-03-17`.replace(Regex.new(`(\\d{4})-(\\d{2})-(\\d{2})`), `$2/$3/$1`)
  ✓ returns `03/17/2024`

$& — full match
$1, $2 — numbered groups
${name} — named groups
$` — text before match
$' — text after match
$$ — literal $
```

---

## Test262 Reference

We'll port test patterns from these Test262 directories:

- `test/built-ins/RegExp/` — constructor, static methods
- `test/built-ins/RegExp/prototype/exec/` — exec behavior
- `test/built-ins/RegExp/prototype/test/` — test behavior
- `test/built-ins/String/prototype/match/` — String.match
- `test/built-ins/String/prototype/replace/` — String.replace
- `test/built-ins/String/prototype/search/` — String.search
- `test/built-ins/String/prototype/split/` — String.split

The test patterns and expected outputs will be translated to Yo syntax. We won't run Test262 directly, but we'll ensure equivalent coverage.

---

## Notes

- **Backtracking**: Thompson NFA avoids catastrophic backtracking for most features. Backreferences (Phase 6) require a hybrid approach — use NFA for the main match, switch to backtracking only when backreferences are present.
- **Performance vs JavaScript**: We won't match V8's JIT-compiled regex immediately, but Thompson NFA gives predictable O(n·m) performance, which is often better than backtracking engines on adversarial inputs.
- **Memory**: The bytecode representation is compact. Each instruction is a few bytes. A typical pattern compiles to a few hundred bytes of bytecode.
- **str vs String**: The regex engine will operate on `String` (owned, UTF-8). A `str`-based API could be added later for zero-copy matching on borrowed slices.
- **This is a great language stress test**: Building a regex engine exercises generics, enums, pattern matching, iterators, error handling, pointer manipulation, and dynamic arrays — essentially all of Yo's core features.
