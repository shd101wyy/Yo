// Rust twin of tests/origins/corpus/rc-handle-reassigned.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    x: i32,
}
fn main() {
    let mut h = Rc::new(X { x: 1 });
    let r = &h.x;
    h = Rc::new(X { x: 2 });
    let _ = *r;
}
