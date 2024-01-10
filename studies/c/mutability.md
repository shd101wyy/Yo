```typescript
let test = ()-> {
  // mutable variable
  {
    let x = 1;
    let p: *<i32> = &x;
    const cp: *<i32> = &x;
  }

  {
    const x = 1;
    let p: *const<i32> = &x;
    const cp: *const<i32> = &x;
  }
}
```

vs

```typescript
let test = ()-> {
  {
    let i: *linear<i32> = malloc<i32>();
    let p: *mut<i32> = @i;
    let cp: *<i32> = @p;
  }

  // mutable variable
  {
    let mut x = 1;
    let p: *mut<i32> = &mut x;
    let cp: *mut<i32> = &mut x;
  }

  {
    let x = 1;
    let p: *<i32> = &x;
    let cp: *<i32> = &x;
  }
}
```
