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

fn test(x: &[String]) {
    println!("{:?}", x[2]);
}

fn main() {
    let mut x = 12;
    let mut xRef1 = &mut x;
    let mut xRef2 = xRef1;
    *xRef1 = 12;
    *xRef2 = 13;
}
