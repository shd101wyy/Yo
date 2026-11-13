// Rust twin of tests/origins/unsound/h5c-cond-arm-composite.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
fn flag(n: i32) -> bool {
    n > 2
}
fn main() {
    let x = Rc::new(X { s: String::from("x") });
    let mut y = Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") });
    let c = flag(1);
    let m = if c { Some(&x.s) } else { Some(&y.s) };
    y = Rc::new(X { s: String::from("z") });
    if let Some(r) = m {
        println!("OUT: {}", r.len());
    }
}
