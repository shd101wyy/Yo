// Write an example main function that calls a closure function

use std::{cell::Ref, ops::Deref, rc::Rc};

#[derive(Debug)]
struct A {
    x: i32,
    y: i32,
}

#[derive(Debug)]
struct B<'a> {
    a: &'a mut A,
    b: i32,
}

fn main() {
    let mut xs: [i32; 3] = [1, 2, 3];
    let mut firstRef = &mut xs[0];
    println!("firstRef: {}", firstRef);
}
