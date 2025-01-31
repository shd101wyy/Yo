# AST

```typescript
quote {
  const x = 1;
}

// =>
(:const_assignment, :x, 1)
```

```typescript
quote add(1, 2)
// =>
(:add, [1, 2])

quote add(1, y: 2)
// =>
(:add, [1, 2], [(:y, 2)])
```

```typescript
quote { 
  const add = (a: i32, b: i32)=> i32 {
    return a + b;
  }
}
// =>
(:const=, 
  :add, 
  (:function, [/* no type parameters */], [(:a, :i32), (:b, :i32)], :i32, (:return, (:add, :a, :b))))
```