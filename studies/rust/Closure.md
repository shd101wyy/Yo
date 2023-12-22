## Capturing the Environment with Closures

```typescript
@derive(Debug, PartialEq, Copy, Clone)
enum ShirtColor: Free {
  Red,
  Blue,
}

type Inventory: Linear = {
  shirts: Array<ShirtColor>,
}


```

## Capturing References or Moving Ownership

```rust
fn main() {
    let mut list = vec![1, 2, 3];
    
    
    println!("Before closure {:?}", list);
    {
        let mut my_closure = || {
            list.push(4); // list is a mutable reference
            println!("In closure {:?}", list);
        };
        my_closure();
    }
    println!("After closure {:?}", list);
}
```