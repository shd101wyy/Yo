# Immutable UTF-8 String Design for Yo

## Overview

Yo has an immutable UTF-8 String type implemented natively in Yo without external dependencies.
The basic String implementation handles UTF-8 encoding/decoding, character indexing, and common operations.

For advanced Unicode features (normalization, complex case conversion, property queries), we can optionally
use the QuickJS Unicode library, but this is **not required** for basic String functionality.

## Implementation Status

### ✅ Implemented (Native Yo, No Dependencies)

- `String` object type with `ArrayList(u8)` storage
- `String.new()` - Create empty string
- `String.from_bytes(ArrayList(u8))` - Create from byte array (assumes valid UTF-8)
- `String.from(*([u8]))` - Create from byte slice by copying
- UTF-8 decoding (1-4 byte sequences) in `_decode_rune_at()`
- `length()` - Count Unicode characters (runes) by scanning UTF-8 start bytes
- `at(index)` - Get rune at character index (returns `Option(rune)`)
- `concat(other)` - Concatenate two strings
- `is_empty()` - Check if string is empty
- `as_bytes()` - Get internal byte array
- `rune` type for Unicode code points (U+0000 to U+10FFFF, excluding surrogates)
- Full emoji and multi-byte character support (tested with Chinese and emoji)

### 🚧 Planned (Native Yo)

- `String.from_utf8(bytes)` with validation - Returns `Result(String, StringError)` on invalid UTF-8
- `slice(start, end)` - Substring extraction
- `split(delimiter)` - String tokenization
- `trim()`, `trim_start()`, `trim_end()` - Whitespace removal
- `starts_with()`, `ends_with()`, `contains()` - Search operations
- Comparison operators (`==`, `<`, `>`, etc.)
- Hash implementation for HashMap keys

### 🔮 Future (Using QuickJS - Optional)

- Unicode normalization (NFC, NFD, NFKC, NFKD)
- Full Unicode case conversion (beyond ASCII)
- Unicode property queries (is_alphabetic, is_numeric with full Unicode tables)
- Grapheme cluster segmentation for complex emoji

## QuickJS Unicode Library Features

**Note:** The following QuickJS features are available but **NOT currently used** in the basic String implementation.
They are documented here for future reference when implementing advanced Unicode features.

### Available in `vendor/quickjs/cutils.h` and `cutils.c`:

1. **UTF-8 Encoding/Decoding**

   ```c
   // Encode a Unicode codepoint to UTF-8 bytes
   // Returns: number of bytes written (1-6)
   int unicode_to_utf8(uint8_t *buf, unsigned int c);

   // Decode a UTF-8 byte sequence to Unicode codepoint
   // Returns: codepoint value, or -1 on error
   // Updates *pp to point after the decoded character
   int unicode_from_utf8(const uint8_t *p, int max_len, const uint8_t **pp);
   ```

2. **Constants**

   ```c
   #define UTF8_CHAR_LEN_MAX 6  // Maximum bytes for one UTF-8 character
   ```

3. **Surrogate Pair Helpers** (for UTF-16 interop)
   ```c
   BOOL is_surrogate(uint32_t c);
   BOOL is_hi_surrogate(uint32_t c);
   BOOL is_lo_surrogate(uint32_t c);
   uint32_t get_hi_surrogate(uint32_t c);
   uint32_t get_lo_surrogate(uint32_t c);
   uint32_t from_surrogate(uint32_t hi, uint32_t lo);
   ```

### Available in `vendor/quickjs/libunicode.h` and `libunicode.c`:

1. **Unicode Normalization**

   ```c
   enum UnicodeNormalizationEnum {
       UNICODE_NFC,   // Canonical Composition
       UNICODE_NFD,   // Canonical Decomposition
       UNICODE_NFKC,  // Compatibility Composition
       UNICODE_NFKD   // Compatibility Decomposition
   };

   int unicode_normalize(uint32_t **pdst, const uint32_t *src, int src_len,
                         UnicodeNormalizationEnum n_type,
                         void *opaque,
                         void *(*realloc_func)(void *opaque, void *ptr, size_t size));
   ```

2. **Character Properties**

   ```c
   // Character classification
   int lre_is_cased(uint32_t c);
   int lre_is_case_ignorable(uint32_t c);
   int lre_is_id_start(uint32_t c);
   int lre_is_id_continue(uint32_t c);
   int lre_is_space(uint32_t c);

   // Case conversion (returns number of result codepoints, stores in res[])
   int lre_case_conv(uint32_t *res, uint32_t c, int conv_type);
   ```

3. **Unicode Categories**
   ```c
   int unicode_script(CharRange *cr, const char *script_name, int is_ext);
   int unicode_general_category(CharRange *cr, const char *gc_name);
   int unicode_prop(CharRange *cr, const char *prop_name);
   ```

## Proposed Immutable String Design

### Core Type

```rust
String :: object(
  // Internal UTF-8 byte buffer (immutable)
  _bytes : ArrayList(u8)
)
```

**Current Implementation:** The String type currently uses a simple design with just the byte buffer.
Lazy caching of character count, offset indices, and hash codes are **not yet implemented** but planned for future optimization.

**Future Optimizations (Not Implemented):**

```rust
// Potential future additions for performance
_char_count : Option(usize),        // Cached character count
_char_offsets : Option(ArrayList(usize)),  // Character-to-byte offset index
_hash : Option(usize)                // Cached hash for HashMap
```

## Character Representation: The `rune` Type

**✅ IMPLEMENTED:** Yo uses the `rune` type (not `Char`) for Unicode characters.

### Why `rune` instead of `Char`?

The name `rune` is chosen to:

- Avoid confusion with C's `char` type (which is 8-bit)
- Match Go's terminology (Go's `rune` is an `int32` representing a Unicode code point)
- Clearly indicate Unicode code points (32-bit values)

### Current Implementation

```rust
// In std/data/rune.yo
rune :: struct(c: u32)

rune.from_u32 :: fn(value: u32) -> Option(rune)  // Validates 0x0 to 0x10FFFF, excluding surrogates
rune.is_valid :: fn(value: u32) -> bool
// ... other methods

// String uses rune
String.at :: fn(self: Self, index: usize) -> Option(rune)
```

**Benefits:**

- ✅ Type-safe: can't accidentally use invalid codepoints
- ✅ Self-documenting: `rune` clearly means "Unicode code point"
- ✅ Can add helper methods (is_digit, is_whitespace, etc.)
- ✅ Zero runtime cost: struct with single field is optimized
- ✅ No confusion with C's `char` type
- ✅ Field access: `r.c` to get the codepoint value

**Similar to:**

- **Rust**: `char` is a distinct 4-byte type for Unicode scalar values
- **Go**: `rune` is an alias for `int32` representing Unicode code points
- **Swift**: `Character` is a distinct type
- **Python**: `str` of length 1 serves this purpose

### Updated Design with `rune`:

### Construction

```rust
// ✅ IMPLEMENTED
String.new :: fn() -> String                           // Create empty string
String.from_bytes :: fn(bytes: ArrayList(u8)) -> String // From byte array (assumes valid UTF-8)
String.from :: fn(slice: *([u8])) -> String            // From byte slice by copying

// 🚧 PLANNED
String.from_utf8 :: fn(bytes: ArrayList(u8)) -> Result(String, StringError)  // With validation
String.from_cstr :: fn(ptr: *(u8)) -> String           // From C null-terminated string
String.from_rune :: fn(r: rune) -> String              // From single character
String.repeat :: fn(r: rune, count: usize) -> String   // Repeat a character n times
```

### Basic Operations (All Return New Strings)

```rust
// ✅ IMPLEMENTED
concat :: fn(self: Self, other: Self) -> String        // Concatenate two strings
at :: fn(self: Self, index: usize) -> Option(rune)    // Get rune at character index (currently O(n))
as_bytes :: fn(self: Self) -> ArrayList(u8)            // Get internal byte array
is_empty :: fn(self: Self) -> bool                  // Check if empty
length :: fn(self: Self) -> usize                      // Character count (scans UTF-8 start bytes)

// 🚧 PLANNED
slice :: fn(self: Self, start: usize, end: usize) -> String  // Substring by character index
split :: fn(self: Self, delimiter: String) -> ArrayList(String)  // Split by delimiter
trim :: fn(self: Self) -> String                       // Trim whitespace
trim_start :: fn(self: Self) -> String
trim_end :: fn(self: Self) -> String
```

**Note on Performance:** The current `at()` implementation is O(n) as it scans from the beginning each time.
Future optimization will add lazy character offset indexing for O(1) access after first build.

### Indexing Strategy

**Lazy Character Offset Array:**

When `at()` or `length()` is called for the first time, we build an index array:

```
Example: String "Hi🎉"
UTF-8 bytes: ['H', 'i', 0xF0, 0x9F, 0x8E, 0x89]
Byte index:   0    1    2     3     4     5

After indexing:
_char_offsets: [0, 1, 2]  // char 0 at byte 0, char 1 at byte 1, char 2 at byte 2
_char_count: 3
```

**Performance:**

- First `at()` or `length()`: O(n) - builds index
- Subsequent `at()`: O(1) - uses cached index
- Memory cost: ~8 bytes per character (usize on 64-bit)

**Implementation:**

```c
// Build character offset index (called once, lazily)
void yo_string_build_char_index(String* s) {
    if (s->_char_offsets != NULL) return; // Already built

    ArrayList* offsets = arraylist_new();
    const uint8_t* p = s->_bytes->data;
    const uint8_t* end = p + s->_bytes->length;

    while (p < end) {
        arraylist_push(offsets, p - s->_bytes->data); // Store byte offset
        const uint8_t* prev = p;
        unicode_from_utf8(p, end - p, &p); // Advance to next char
    }

    s->_char_offsets = offsets;
    s->_char_count = offsets->length;
}

// O(1) character access (after index built)
uint32_t yo_string_char_at(String* s, size_t char_index) {
    yo_string_build_char_index(s); // Build if needed

    if (char_index >= s->_char_count) return -1; // Out of bounds

    size_t byte_offset = s->_char_offsets->data[char_index];
    const uint8_t* p = s->_bytes->data + byte_offset;
    const uint8_t* next;
    return unicode_from_utf8(p, s->_bytes->length - byte_offset, &next);
}
```

### Queries

```rust
// ✅ IMPLEMENTED
length :: fn(self: Self) -> usize                      // O(n) - counts UTF-8 start bytes
is_empty :: fn(self: Self) -> bool

// 🚧 PLANNED
starts_with :: fn(self: Self, prefix: String) -> bool
ends_with :: fn(self: Self, suffix: String) -> bool
contains :: fn(self: Self, substring: String) -> bool
find :: fn(self: Self, substring: String) -> Option(usize)  // Returns character index
```

### Case Operations

```rust
// 🔮 FUTURE (Will use QuickJS Unicode tables for full Unicode support)
to_lowercase :: fn(self: Self) -> String              // Full Unicode case conversion
to_uppercase :: fn(self: Self) -> String              // Full Unicode case conversion

// Could implement ASCII-only versions first without QuickJS:
to_ascii_lowercase :: fn(self: Self) -> String        // ASCII A-Z only
to_ascii_uppercase :: fn(self: Self) -> String        // ASCII a-z only
```

### Comparison

```rust
// Implement Eq trait for String
StringEq :: Eq(String, String)(
  (==) :: fn(a: String, b: String) -> bool
)

// Implement Ord trait for String (lexicographic)
StringOrd :: Ord(String, String)(
  compare :: fn(a: String, b: String) -> Ordering
)
```

### Hashing (for HashMap)

```rust
// Implement Hash trait for String
StringHash :: Hash(String)(
  hash :: fn(self: String) -> usize
)
```

### Conversion

```rust
// To byte array (returns copy or view?)
as_bytes :: fn(self: Self) -> ArrayList(u8)

// To C string (null-terminated, must be freed)
to_cstr :: fn(self: Self) -> *u8

// Parse to number
parse_i32 :: fn(self: Self) -> Result(i32, ParseError)
parse_f64 :: fn(self: Self) -> Result(f64, ParseError)
```

### Iteration

```rust
// Iterator over bytes
bytes :: fn(self: Self) -> ByteIterator

// Iterator over characters
chars :: fn(self: Self) -> CharIterator  // yields Char
```

## rune Type Definition

**✅ IMPLEMENTED** in `std/data/rune.yo`

```rust
/**
 * rune - A Unicode scalar value (code point)
 *
 * Represents a single Unicode character in the range U+0000 to U+10FFFF,
 * excluding surrogate code points (U+D800 to U+DFFF).
 *
 * The field `c` holds the codepoint value as a u32.
 *
 * Named `rune` (like Go) to avoid confusion with C's `char` type.
 */
rune :: struct(c: u32)

rune.from_u32 :: fn(value: u32) -> Option(rune)       // ✅ Validates Unicode range
rune.is_valid :: fn(value: u32) -> bool            // ✅ Check if valid codepoint

// 🚧 PLANNED - Basic character queries
is_ascii :: fn(self: rune) -> bool
is_digit :: fn(self: rune) -> bool
to_string :: fn(self: rune) -> String

// 🔮 FUTURE - Advanced queries (may use QuickJS Unicode tables)
is_whitespace :: fn(self: rune) -> bool
is_alphabetic :: fn(self: rune) -> bool
to_lowercase :: fn(self: rune) -> String              // Returns String (may expand to multiple chars)
to_uppercase :: fn(self: rune) -> String
```

### Common rune Constants (Future)

```rust
// 🚧 PLANNED - Useful character constants
RuneConstants :: module(
  NUL        :: rune(c: 0x00),      // Null
  TAB        :: rune(c: 0x09),      // Tab
  NEWLINE    :: rune(c: 0x0A),      // Line feed
  SPACE      :: rune(c: 0x20),      // Space
  ZERO       :: rune(c: 0x30),      // '0'
  NINE       :: rune(c: 0x39),      // '9'
  UPPERCASE_A :: rune(c: 0x41),     // 'A'
  UPPERCASE_Z :: rune(c: 0x5A),     // 'Z'
  LOWERCASE_A :: rune(c: 0x61),     // 'a'
  LOWERCASE_Z :: rune(c: 0x7A),     // 'z'

  // Unicode examples
  EMOJI_GRINNING :: rune(c: 0x1F600), // 😀
  EMOJI_EARTH    :: rune(c: 0x1F30D), // 🌍
)
```

## Implementation Strategy

### ✅ Phase 1: Basic Immutable String (COMPLETED)

- ✅ Implement core type with ArrayList(u8) storage
- ✅ Add `new()`, `from_bytes()`, `from()` constructors
- ✅ Implement `is_empty`, `as_bytes`, `length`, `concat`
- ✅ Implement `rune` type for Unicode code points
- ✅ Native UTF-8 decoding in `_decode_rune_at()` (1-4 byte sequences)
- ✅ Character access with `at()` returning `Option(rune)`
- ✅ Full emoji and multi-byte character support

### 🚧 Phase 2: Essential String Operations (IN PROGRESS)

- Add `from_utf8()` with UTF-8 validation
- Implement `slice()`, `split()`, `trim()`
- Add `starts_with`, `ends_with`, `contains`, `find`
- Implement basic comparison (Eq, Ord traits)
- Optimize `at()` with lazy character offset indexing

### 🚧 Phase 3: Hashing and HashMap Integration

- Implement Hash trait for String
- Add hash caching optimization
- Use String as HashMap key type

### 🔮 Phase 4: Advanced Unicode (Optional, Using QuickJS)

- Full Unicode case conversion (`to_lowercase`, `to_uppercase`)
- Unicode normalization (NFC, NFD, NFKC, NFKD)
- Unicode property queries (is_alphabetic, is_numeric with full tables)
- Grapheme cluster segmentation

**Decision:** QuickJS will only be used for advanced Unicode features, not basic String operations.

## C FFI Helpers (Only for Advanced Unicode Features)

**Note:** These are **NOT currently implemented** and will only be added if/when we need advanced Unicode features.

If we decide to use QuickJS for advanced features, we'll need wrapper functions:

```c
// yo_string.c - wrapper for QuickJS Unicode functions

#include "vendor/quickjs/cutils.h"
#include "vendor/quickjs/libunicode.h"

// Decode UTF-8 to codepoint
int32_t yo_utf8_decode(const uint8_t* bytes, size_t max_len, size_t* out_len) {
    const uint8_t* end;
    int32_t codepoint = unicode_from_utf8(bytes, max_len, &end);
    if (out_len) {
        *out_len = end - bytes;
    }
    return codepoint;
}

// Encode codepoint to UTF-8
size_t yo_utf8_encode(uint32_t codepoint, uint8_t* buf) {
    return unicode_to_utf8(buf, codepoint);
}

// Count UTF-8 characters in byte sequence
size_t yo_utf8_char_count(const uint8_t* bytes, size_t byte_len) {
    size_t count = 0;
    const uint8_t* p = bytes;
    const uint8_t* end = bytes + byte_len;

    while (p < end) {
        const uint8_t* prev = p;
        int32_t c = unicode_from_utf8(p, end - p, &p);
        if (c < 0 || p == prev) {
            break; // Invalid UTF-8
        }
        count++;
    }
    return count;
}

// Validate UTF-8 sequence
bool yo_utf8_validate(const uint8_t* bytes, size_t byte_len) {
    const uint8_t* p = bytes;
    const uint8_t* end = bytes + byte_len;

    while (p < end) {
        const uint8_t* prev = p;
        int32_t c = unicode_from_utf8(p, end - p, &p);
        if (c < 0 || p == prev) {
            return false;
        }
    }
    return true;
}
```

## Benefits of This Design

1. **Immutability**: Like JavaScript strings, safe for concurrent access, easier to reason about
2. **UTF-8 Native**: Efficient storage, compatible with C APIs and web standards
3. **Self-Contained**: Basic UTF-8 operations implemented natively in Yo, no external dependencies
4. **Type Safety**: `rune` type ensures valid Unicode code points, separate from raw `u32`
5. **Extensible**: Can optionally add QuickJS for advanced Unicode features without breaking existing code
6. **Zero Runtime Cost**: `rune` struct with single field compiles to same code as raw `u32`
7. **Memory Efficient**: Simple `ArrayList(u8)` storage, no overhead for basic use
8. **Future-Proof**: Design allows for optimizations (lazy indexing, hash caching) without API changes

## Comparison with Other Languages

| Feature      | JavaScript       | Rust             | Go             | Python 3       | Yo (Current)   |
| ------------ | ---------------- | ---------------- | -------------- | -------------- | -------------- |
| Mutability   | Immutable        | Immutable        | Immutable      | Immutable      | Immutable      |
| Encoding     | UTF-16           | UTF-8            | UTF-8          | UTF-8/UTF-32   | UTF-8          |
| Char Type    | None (string[0]) | `char` (4 bytes) | `rune` (int32) | `str[0]` (str) | `rune` (u32)   |
| Indexing     | O(1) by char     | O(1) by byte     | O(1) by byte   | O(1) by char   | O(n) by char†  |
| Concat       | Copy             | Zero-copy (Rc)   | Copy           | Copy           | Copy           |
| Dependencies | Built-in         | Built-in         | Built-in       | Built-in       | Self-contained |

† Future optimization: O(1) after lazy O(n) index build on first character access

## Next Steps

### Immediate Priorities

1. ✅ Basic String implementation (DONE)
2. 🚧 Add UTF-8 validation to `from_utf8()`
3. 🚧 Implement essential operations (`slice`, `split`, `trim`, `find`)
4. 🚧 Add comparison operators and Hash trait
5. 🚧 Optimize `at()` with lazy character offset indexing

### Future Work

- Consider using QuickJS for advanced Unicode features (case conversion, normalization)
- Implement string interning for frequently used strings
- Explore zero-copy string slicing (sharing byte arrays between parent and slices)
- Add comprehensive test suite for UTF-8 edge cases and invalid sequences

## Indexing Tradeoffs Summary

| Approach                      | Time                  | Space | Pros                               | Cons                           |
| ----------------------------- | --------------------- | ----- | ---------------------------------- | ------------------------------ |
| **Scan each time**            | O(n) per access       | O(1)  | Simple, no overhead                | Slow for repeated access       |
| **Lazy index array** (chosen) | O(1) after O(n) build | O(n)  | Fast after build, pay only if used | Memory cost                    |
| **UTF-32 encoding**           | O(1) always           | O(4n) | Always fast                        | 4x memory, incompatible with C |
| **Byte indexing only**        | O(1) always           | O(1)  | No overhead                        | User confusion, easy errors    |

**Our choice: Lazy index array** - best balance for immutable strings where indexing patterns are typically:

- Access many characters: index amortizes to O(1)
- Access few/no characters: no overhead
- Access once: same as scan approach

## Design Questions for Future Discussion

1. **QuickJS Integration**: When should we add QuickJS for advanced Unicode?
   - Only when users need normalization/full case conversion?
   - Make it optional via feature flag?
2. **Performance Optimizations**:
   - Should we add lazy character offset indexing now or wait for benchmarks?
   - Is hash caching worth the memory cost?
3. **Zero-Copy Slicing**:
   - Should we support string slicing with shared byte arrays (like Rust's `&str`)?
   - Would this complicate the ownership model?
4. **String Interning**:

   - Should we implement string interning for frequently used strings?
   - How would this interact with the garbage collector?

5. **Data Structures**:
   - Should we implement a "rope" data structure for efficient concatenation of large strings?
   - Or is simple copy sufficient for most use cases?
