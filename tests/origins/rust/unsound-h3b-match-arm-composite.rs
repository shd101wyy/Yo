// Rust twin of tests/origins/unsound/h3b-match-arm-composite.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
fn main() {
    let mut o = Some(Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") }));
    let m = match &o {
        Some(h) => Some(&h.s),
        None => None,
    };
    o = None;
    if let Some(r) = m {
        println!("OUT: {}", r.len());
    }
}
