// Write an example main function that calls a closure function

use std::{cell::Ref, ops::Deref, rc::Rc};

enum MySome<T> {
    Some(T),
    None,
}

fn main() {
    let mut x = MySome::Some(12);
    let y = &mut x;
    match y {
        MySome::Some(i) => *i = 13,
        MySome::None => (),
    }
}
