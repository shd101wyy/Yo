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

struct C {
    a: String,
}

fn test(x: &[String]) {
    println!("{:?}", x[2]);
}

fn main() {
   let x = String::from("Hello, world!");
   let mut y = x;
   y.push_str("GG");
}
