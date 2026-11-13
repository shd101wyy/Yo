// Rust twin of tests/origins/corpus/rc-mut-through-deref.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    x: i32,
}
fn main() {
    let h = Rc::new(X { x: 1 });
    let r = &mut h.x;
    *r = 2;
}
