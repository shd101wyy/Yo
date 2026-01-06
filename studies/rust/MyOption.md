```rust
use std::mem;

enum MyOption<T> {
    MySome(T),
    MyNone,
}

use MyOption::{MySome, MyNone}; // Bringing Some and None into scope

fn main() {
    let some_value: MyOption<i32> = MySome(5);
    let another_value: MyOption<i32> = MyNone;

    match some_value {
        MySome(value) => println!("Value: {}", value),
        MyNone => println!("No value"),
    }
}
```
