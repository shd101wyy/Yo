// Rust twin of tests/origins/unsound/l1-holder-from-temporary-pos.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
struct H<'a> {
    r: &'a Rc<X>,
}
fn mk(x: &Rc<X>) -> H<'_> {
    H { r: x }
}
fn mk_x() -> Rc<X> {
    Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") })
}
fn main() {
    let x = mk_x();
    let h = mk(&x);
    let z = String::from("zzzzzzzzzzzzzzzzzzzzzz");
    println!("OUT: {} {}", h.r.s.len(), z.len());
}
