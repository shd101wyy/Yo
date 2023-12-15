// Write an example main function that calls a closure function

use std::{cell::Ref, ops::Deref, rc::Rc};

fn consume(s: String) {
    println!("I consumed a String: {}", s);
}

fn random_bool() -> bool {
    // Create a random number
    return true
}

fn main() {
    let my_string = String::from("Hello, world!");
    if random_bool() {
        let add = |x: i32, y: i32| {
            let a = my_string;
            let another_closure = || {
                let b = my_string;
                x + y
            };
            another_closure()
        };
        println!("add(1, 2) = {}", add(1, 2));
    } else {
        consume(my_string);
    }
}
