# Removals

## `with` statement
- `with` statement such as

```typescript
function test() {
  with finally {
    // do something in the end
  }
  // some other code
}
```

Reason: It doesn't work well with linear types, especially the closure.  
Besides, I decided to switch the effect handler from using `with` to using `try`/`with`.  

## function signature **must** specify the return type

For easier type inference.  

## `if` and `match` needs to have braces

We use to support the following syntax:

```
if x > y {
  // ...
}
```

but this caused problem because the parser cannot distinguish between brace elision and a block.  

So we decided to remove this feature. And we require the following syntax:

```
if (x > y) {
  // ...
}
```