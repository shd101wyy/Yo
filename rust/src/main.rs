// Write an example main function that calls a closure function

use std::{cell::Ref, ops::Deref, rc::Rc};

#[derive(Debug)]
enum MySome<T> {
    Some(T),
    None,
}

fn test(mut x: i32) {
    x = 10;
    println!("x = {}", x);
}

fn main() {
    let x = 1;
    let y = &mut x;
    test(x);
    println!("x = {}", x);
}
