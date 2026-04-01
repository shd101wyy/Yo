# Cond branch RC temporary scope bug

## Status: Open (workaround available)

## Description

When `cond` has multiple branches where condition expressions create RC-owning temporary values (e.g., template strings or String objects), the drop for temporaries from later branches can be emitted at the wrong scope level in the generated C code.

## Example

```rust
_is_hostless :: (fn(proto: *(String)) -> bool)({
  (lower : String) = proto.*.to_lowercase();
  cond(
    lower.starts_with(`javascript`) => true,
    (lower == `javascript:`) => true,
    true => false
  )
});
```

The template strings `` `javascript` `` and `` `javascript:` `` create temporary `String` objects. The second temporary is only created inside the else-branch of the first condition check, but its drop is emitted at the function scope level, causing a C compilation error:

```c
// Generated C (simplified):
String temp1 = to_string("javascript");
bool check1 = starts_with(lower, temp1);
if (!check1) {
    String temp2 = to_string("javascript:");  // declared here
    bool check2 = equals(lower, temp2);
    result = check2;
    drop(temp2);  // correct drop inside scope
}
drop(temp2);  // BUG: temp2 not in scope here!
drop(temp1);
```

## Workaround

Use if-chains with early returns instead of multi-branch cond:

```rust
_is_hostless :: (fn(proto: *(String)) -> bool)({
  (lower : String) = proto.*.to_lowercase();
  if(lower.starts_with(`javascript`), { return true; });
  if((lower == `javascript:`), { return true; });
  false
});
```

Each `if` (which expands to a 2-branch cond) properly scopes its temporaries.

## Affected code

- `cond` with 3+ branches where non-first branch conditions create RC-typed temporaries
- Short-circuit `||`/`&&` with RC-typed operands may also be affected

## Root cause

Likely in `src/codegen/exprs/cond.ts` or the RC drop placement logic in `src/codegen/exprs/begin.ts`. The deferred drops for temporaries created inside conditional branches are being placed at the wrong scope level.
