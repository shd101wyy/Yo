```typescript
enum List {
  Nil,
  Cons(head: i32, tail: *<List>)
}

let main = ()-> {
  let one: *<List, true> = malloc<List>();
  let two: *<List, true> = malloc<List>();
  let three: *<List, true> = malloc<List>();

  (*three) = List.Cons(3, List.Nil);
  (*two) = List.Cons(2, three); // three is consumed
  (*one) = List.Cons(1, two);   // two is consumed
}
```
