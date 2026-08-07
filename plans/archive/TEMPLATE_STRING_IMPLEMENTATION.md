# Template String Implementation Plan

## Status: ✅ COMPLETED

Replace the Haskell-style backtick identifier (`` `abc` ``) with JavaScript-style template strings (`` `hello, ${expr}` ``).

## Current Behavior

- Backtick currently works as an infix operator identifier like Haskell: ``a `add` b``
- TokenType: `BacktickIdentifier`

## New Behavior

- Backtick becomes a template string literal with `${expr}` interpolation
- Returns `String` type (heap allocated), NOT `str` type
- Example: `` `hello, ${name}!` `` becomes `(("hello, ".to_string() + name.to_string()) + "!".to_string())`

## Implementation Steps

### Phase 1: Lexer Changes (`src/lexer.ts`)

1. Remove `BacktickIdentifier` token handling
2. Add new token type: `TemplateString`
3. Parse template strings with interpolation:
   - Track `${` as start of interpolation
   - Handle nested braces inside interpolations
   - Store template parts and expression positions

**Token Structure:**

```typescript
// New token type
TemplateString = "template_string";

// The value will contain the raw template with ${...} markers
// We'll parse interpolations in the parser
```

### Phase 2: Token Changes (`src/token.ts`)

1. Rename `BacktickIdentifier` to `TemplateString`
2. Update any references

### Phase 3: Parser Changes (`src/parser.ts`)

1. Handle `TemplateString` token
2. Parse the template string value to extract:
   - String literal parts
   - Expression parts (parse the code inside `${}`)
3. Generate AST that represents the concatenation

**AST Transformation:**

```
`hello, ${123} and ${true}.`
```

Becomes equivalent to:

```
((("hello, ".to_string() + (123).to_string()) + " and ".to_string()) + (true).to_string()) + ".".to_string()
```

### Phase 4: Evaluator Changes (`src/evaluator/`)

1. When encountering template string expressions, auto-import `std/fmt/to_string`
2. The AST transformation in parser should handle most of the work
3. Ensure `to_string` method calls are resolved correctly

### Phase 5: Codegen Changes (`src/codegen/`)

1. Template strings should already work if parser transforms them correctly
2. Verify C code generation works for the transformed AST

### Phase 6: VS Code Extension Changes

1. Update `yo.tmLanguage.json`:
   - Remove `infix-identifiers` pattern
   - Add `template-strings` pattern with interpolation support
2. Test syntax highlighting

## Detailed Token Parsing Strategy

For the lexer, we have two options:

### Option A: Single Token with Raw Value

Store the entire template string as one token, parse interpolations in parser.

**Pros:** Simpler lexer
**Cons:** More complex parser

### Option B: Multiple Tokens

Emit separate tokens for each part:

- `TemplateStringStart`: `` ` `` or `` `text${ ``
- `TemplateStringMiddle`: `}text${`
- `TemplateStringEnd`: `` }text` `` or `` ` ``

**Pros:** Cleaner separation, easier interpolation parsing
**Cons:** More complex lexer, need to track state

### Chosen Approach: Option A (Single Token)

We'll store the raw template string and parse interpolations in the parser. This is simpler and sufficient for our needs.

## Edge Cases to Handle

1. Empty template string: `` ` ` `` → `"".to_string()`
2. No interpolation: `` `hello` `` → `"hello".to_string()`
3. Only interpolation: `` `${x}` `` → `x.to_string()`
4. Nested braces in interpolation: `` `${obj.field}` ``
5. Escaped characters: `` `\n\t` `` → preserve escapes
6. Escaped dollar: `` `\${not interpolation}` ``
7. Adjacent interpolations: `` `${a}${b}` ``

## Auto-Import Strategy

When the parser encounters a template string:

1. Mark that `std/fmt/to_string` needs to be imported
2. In evaluator, ensure the import is processed before type checking
3. This registers `ToString` implementations for primitive types

## Testing

1. Basic template string: `` `hello` ``
2. Single interpolation: `` `hello, ${name}` ``
3. Multiple interpolations: `` `${a} + ${b} = ${c}` ``
4. Nested expressions: `` `result: ${(a + b)}` ``
5. Empty parts: `` `${a}${b}` ``
6. Complex expressions: `` `${obj.method()}` ``

## Files to Modify

1. `src/token.ts` - Update token type
2. `src/lexer.ts` - Parse template strings
3. `src/parser.ts` - Transform to concatenation AST
4. `src/evaluator/*.ts` - Auto-import handling
5. `vscode-extension/syntaxes/yo.tmLanguage.json` - Syntax highlighting
