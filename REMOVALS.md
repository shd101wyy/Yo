# Removals

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

