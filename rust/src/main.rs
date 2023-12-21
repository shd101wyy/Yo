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
    let mut x = 1;

    let mut closure = |y: i32| {
        return x + y
    };
    let mut closure2 = |y: i32| {
        x = x + 1;
        return x + y
    };
    closure(1);
    closure2(2);
}
