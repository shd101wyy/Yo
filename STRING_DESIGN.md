# Immutable UTF-8 String Design for Yo

## Overview

Based on QuickJS Unicode library investigation, we can implement an immutable UTF-8 String type for Yo.

## QuickJS Unicode Library Features

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

```yo
String :: object(
  // Internal UTF-8 byte buffer (immutable)
  _bytes : ArrayList(u8),
  
  // Cached character count (lazy computed)
  _char_count : Option(usize),
  
  // Character offset index: maps char_index -> byte_index (lazy computed)
  // This enables O(1) character indexing after first build
  _char_offsets : Option(ArrayList(usize)),
  
  // Hash code (lazy computed, for use in HashMap)
  _hash : Option(usize)
)
```

## Character Representation: Do We Need a Rune Type?

### Option 1: Use `u32` directly (simpler)
```yo
char_at :: fn(self: Self, index: usize) -> Option(u32)
String.from_char :: fn(codepoint: u32) -> Result(String, StringError)
```
**Pros:**
- Simple, no new type needed
- `u32` clearly indicates "this is a number"
- Works for bit manipulation, conversion

**Cons:**
- Less type-safe: any `u32` can be passed (including invalid codepoints)
- Less self-documenting: is this a codepoint or just a number?

### Option 2: Introduce `Char` type (recommended)
```yo
// Character type - a Unicode code point (0x0 to 0x10FFFF)
Char :: struct(c: u32)  // Named field for clarity

// Methods on Char
Char.from_u32 :: fn(value: u32) -> Option(Char)  // Validate range
Char.to_u32 :: fn(self: Char) -> u32
Char.is_ascii :: fn(self: Char) -> boolean
Char.is_whitespace :: fn(self: Char) -> boolean
Char.to_lowercase :: fn(self: Char) -> Char
Char.to_uppercase :: fn(self: Char) -> Char

// String now uses Char
char_at :: fn(self: String, index: usize) -> Option(Char)
String.from_char :: fn(ch: Char) -> String

// Usage:
my_char := Char.from_u32(0x1F389).unwrap()  // 🎉
codepoint := my_char.c  // Direct field access
```

**Pros:**
- ✅ Type-safe: can't accidentally use invalid codepoint
- ✅ Self-documenting: `Char` clearly means "Unicode character", `c` = codepoint
- ✅ Can add helper methods (is_digit, is_whitespace, etc.)
- ✅ Matches intuition: `Char` feels right for character operations
- ✅ Clear field access: `char.c` is more readable than `char.0` or unwrap
- ✅ Zero runtime cost: struct with single field is optimized

**Cons:**
- Minor: Need to specify field name in struct literal

### Option 3: Type alias (middle ground)
```yo
Char :: u32  // Type alias
```
**Pros:**
- Zero runtime cost
- Better documentation than raw `u32`

**Cons:**
- No type safety (just an alias)
- Can't add methods

## Recommendation: Use `Char` newtype

Similar to:
- **Rust**: `char` is a distinct 4-byte type for Unicode scalar values
- **Go**: `rune` is an alias for `int32` 
- **Swift**: `Character` is a distinct type
- **Python**: `str` of length 1 serves this purpose

### Updated Design with `Char`:

### Construction

```yo
// From UTF-8 byte array
String.from_utf8 :: fn(bytes: ArrayList(u8)) -> Result(String, StringError)

// From C string (null-terminated)
String.from_cstr :: fn(ptr: *u8) -> String

// From single character
String.from_char :: fn(ch: Char) -> String

// Empty string
String.empty :: fn() -> String

// Repeat a character n times
String.repeat :: fn(ch: Char, count: usize) -> String
```

### Basic Operations (All Return New Strings)

```yo
// Concatenation
concat :: fn(self: Self, other: Self) -> String

// Substring by byte index
slice_bytes :: fn(self: Self, start: usize, end: usize) -> Result(String, StringError)

// Substring by character index (slower, must iterate)
slice_chars :: fn(self: Self, start: usize, end: usize) -> Result(String, StringError)

// Get character at position
// O(n) on first call (builds index), O(1) thereafter
char_at :: fn(self: Self, index: usize) -> Option(Char)

// Split by delimiter
split :: fn(self: Self, delimiter: String) -> ArrayList(String)

// Trim whitespace
trim :: fn(self: Self) -> String
trim_start :: fn(self: Self) -> String
trim_end :: fn(self: Self) -> String
```

### Indexing Strategy

**Lazy Character Offset Array:**

When `char_at()` or `len_chars()` is called for the first time, we build an index array:

```
Example: String "Hi🎉"
UTF-8 bytes: ['H', 'i', 0xF0, 0x9F, 0x8E, 0x89]
Byte index:   0    1    2     3     4     5

After indexing:
_char_offsets: [0, 1, 2]  // char 0 at byte 0, char 1 at byte 1, char 2 at byte 2
_char_count: 3
```

**Performance:**
- First `char_at()` or `len_chars()`: O(n) - builds index
- Subsequent `char_at()`: O(1) - uses cached index
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

```yo
// Length in bytes (always O(1))
len_bytes :: fn(self: Self) -> usize

// Length in Unicode characters (O(n) first call, then O(1))
len_chars :: fn(self: Self) -> usize

// Check if empty
is_empty :: fn(self: Self) -> boolean

// Check if starts/ends with
starts_with :: fn(self: Self, prefix: String) -> boolean
ends_with :: fn(self: Self, suffix: String) -> boolean

// Check if contains
contains :: fn(self: Self, substring: String) -> boolean

// Find substring (returns byte index)
find :: fn(self: Self, substring: String) -> Option(usize)
```

### Case Operations

```yo
// Convert to lowercase (creates new string)
to_lowercase :: fn(self: Self) -> String

// Convert to uppercase (creates new string)
to_uppercase :: fn(self: Self) -> String
```

### Comparison

```yo
// Implement Eq trait for String
StringEq :: Eq(String, String)(
  (==) :: fn(a: String, b: String) -> boolean
)

// Implement Ord trait for String (lexicographic)
StringOrd :: Ord(String, String)(
  compare :: fn(a: String, b: String) -> Ordering
)
```

### Hashing (for HashMap)

```yo
// Implement Hash trait for String
StringHash :: Hash(String)(
  hash :: fn(self: String) -> usize
)
```

### Conversion

```yo
// To byte array (returns copy or view?)
as_bytes :: fn(self: Self) -> ArrayList(u8)

// To C string (null-terminated, must be freed)
to_cstr :: fn(self: Self) -> *u8

// Parse to number
parse_i32 :: fn(self: Self) -> Result(i32, ParseError)
parse_f64 :: fn(self: Self) -> Result(f64, ParseError)
```

### Iteration

```yo
// Iterator over bytes
bytes :: fn(self: Self) -> ByteIterator

// Iterator over characters
chars :: fn(self: Self) -> CharIterator  // yields Char
```

## Char Type Definition

```yo
/**
 * Char - A Unicode scalar value (code point)
 * 
 * Represents a single Unicode character in the range U+0000 to U+10FFFF,
 * excluding surrogate code points (U+D800 to U+DFFF).
 * 
 * The field `c` holds the codepoint value as a u32.
 * 
 * Similar to:
 * - Rust's `char` type
 * - Go's `rune` type  
 * - Swift's `Character` type
 */
Char :: struct(c: u32)

Char :: object(
  /**
   * Create a Char from a u32 value
   * Returns None if the value is not a valid Unicode scalar value
   */
  from_u32 :: fn(value: u32) -> Option(Char)
    cond(
      // Valid Unicode: 0x0 to 0x10FFFF, excluding surrogates
      (value <= 0x10FFFF) && !(value >= 0xD800 && value <= 0xDFFF) => .Some(Char(c: value)),
      true => .None
    ),
  
  /**
   * Convert Char back to u32
   */
  to_u32 :: fn(self: Char) -> u32
    self.c,  // Access codepoint field
  
  /**
   * Check if this is an ASCII character (U+0000 to U+007F)
   */
  is_ascii :: fn(self: Char) -> boolean
    self.c <= 0x7F,
  
  /**
   * Check if this is whitespace
   * Uses QuickJS's lre_is_space function
   */
  is_whitespace :: fn(self: Char) -> boolean
    extern_lre_is_space(self.c),
  
  /**
   * Check if this is a digit (0-9)
   */
  is_digit :: fn(self: Char) -> boolean
    self.c >= 0x30 && self.c <= 0x39,  // '0' to '9'
  
  /**
   * Check if this is alphabetic
   * Uses QuickJS's Unicode tables
   */
  is_alphabetic :: fn(self: Char) -> boolean
    extern_lre_is_id_start(self.c),
  
  /**
   * Convert to lowercase
   * Returns a String (case conversion can expand to multiple chars)
   */
  to_lowercase :: fn(self: Char) -> String
    extern_char_to_lowercase(self.c),
  
  /**
   * Convert to uppercase
   * Returns a String (case conversion can expand to multiple chars)
   */
  to_uppercase :: fn(self: Char) -> String
    extern_char_to_uppercase(self.c),
  
  /**
   * Convert Char to a String
   */
  to_string :: fn(self: Char) -> String
    String.from_char(self)
)

// Implement Eq for Char
CharEq :: Eq(Char, Char)(
  (==) :: fn(a: Char, b: Char) -> boolean
    U32Eq.(==)(a.c, b.c)
)

// Implement Ord for Char
CharOrd :: Ord(Char, Char)(
  compare :: fn(a: Char, b: Char) -> Ordering
    U32Ord.compare(a.c, b.c)
)
```

### Common Character Constants

```yo
// Useful character constants
CharConstants :: module(
  NUL        :: Char(c: 0x00),      // Null
  TAB        :: Char(c: 0x09),      // Tab
  NEWLINE    :: Char(c: 0x0A),      // Line feed
  SPACE      :: Char(c: 0x20),      // Space
  ZERO       :: Char(c: 0x30),      // '0'
  NINE       :: Char(c: 0x39),      // '9'
  UPPERCASE_A :: Char(c: 0x41),     // 'A'
  UPPERCASE_Z :: Char(c: 0x5A),     // 'Z'
  LOWERCASE_A :: Char(c: 0x61),     // 'a'
  LOWERCASE_Z :: Char(c: 0x7A),     // 'z'
  
  // Unicode examples
  EMOJI_PARTY :: Char(c: 0x1F389), // 🎉
  SNOWMAN     :: Char(c: 0x2603),  // ☃
)

// Usage examples:
// if (ch.c >= CharConstants.ZERO.c && ch.c <= CharConstants.NINE.c) { ... }
// if (CharEq.(==)(ch, CharConstants.NEWLINE)) { ... }
```

## Implementation Strategy

### Phase 1: Basic Immutable String
- Implement core type with ArrayList(u8) storage
- Add `from_utf8`, `from_cstr`, `empty` constructors
- Implement `len_bytes`, `is_empty`, `as_bytes`
- Add basic comparison (Eq trait)

### Phase 2: UTF-8 Operations (using QuickJS)
- Wrap `unicode_from_utf8` and `unicode_to_utf8`
- Implement `len_chars`, `char_at`
- Add `slice_chars` with proper UTF-8 boundary handling
- Validate UTF-8 sequences on construction

### Phase 3: String Operations
- Implement `concat`, `split`, `trim`
- Add `starts_with`, `ends_with`, `contains`, `find`
- Implement substring operations

### Phase 4: Advanced Unicode (using QuickJS libunicode)
- Add `to_lowercase`, `to_uppercase` using `lre_case_conv`
- Optional: normalization support (NFC, NFD, etc.)
- Optional: Unicode property queries

### Phase 5: Hashing and HashMap Integration
- Implement Hash trait for String
- Use in HashMap as key type
- Add hash caching optimization

## C FFI Helpers Needed

We'll need to create wrapper functions to call QuickJS utilities:

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
3. **Battle-tested**: Uses QuickJS's proven Unicode implementation
4. **Lazy Computation**: Character count, index, and hash computed only when needed
5. **O(1) Indexing**: Character offset array provides fast indexing after first build
6. **Memory Efficient**: Index only built when needed, shared across lifetime
7. **Zero-copy Views**: Can potentially share underlying byte arrays for substrings
8. **Type Safety**: Separate from raw byte arrays, enforces valid UTF-8

## Comparison with Other Languages

| Feature | JavaScript | Rust | Go | Python 3 | Proposed Yo |
|---------|-----------|------|-----|----------|-------------|
| Mutability | Immutable | Immutable | Immutable | Immutable | Immutable |
| Encoding | UTF-16 | UTF-8 | UTF-8 | UTF-8/UTF-32 | UTF-8 |
| Char Type | None (string[0]) | `char` (4 bytes) | `rune` (int32) | `str[0]` (str) | `Char` (u32) |
| Indexing | O(1) by char | O(1) by byte | O(1) by byte | O(1) by char | O(1) by char* |
| Concat | Copy | Zero-copy (Rc) | Copy | Copy | Copy (future: rope?) |

\* O(1) after lazy O(n) index build on first character access

## Next Steps

1. **Decision needed**: Should we implement this String type now, or proceed with HashMap using primitive types first?
2. **Compilation**: Need to ensure QuickJS's cutils.c and libunicode.c are compiled and linked
3. **Testing**: Create comprehensive test suite for UTF-8 edge cases
4. **Documentation**: Add examples of common string operations

## Indexing Tradeoffs Summary

| Approach | Time | Space | Pros | Cons |
|----------|------|-------|------|------|
| **Scan each time** | O(n) per access | O(1) | Simple, no overhead | Slow for repeated access |
| **Lazy index array** (chosen) | O(1) after O(n) build | O(n) | Fast after build, pay only if used | Memory cost |
| **UTF-32 encoding** | O(1) always | O(4n) | Always fast | 4x memory, incompatible with C |
| **Byte indexing only** | O(1) always | O(1) | No overhead | User confusion, easy errors |

**Our choice: Lazy index array** - best balance for immutable strings where indexing patterns are typically:
- Access many characters: index amortizes to O(1)
- Access few/no characters: no overhead
- Access once: same as scan approach

## Questions to Consider

1. Should String own its data or use reference counting for large strings?
2. Should we implement "string interning" for frequently used strings?
3. Should we support string slicing with zero-copy views (like Rust's &str)?
   - If yes, slices should share the parent's `_char_offsets` array
4. Should we implement a "rope" data structure for efficient concatenation?
5. Should `_char_offsets` be shared between parent and slice views?
