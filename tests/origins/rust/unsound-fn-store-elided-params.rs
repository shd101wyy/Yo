// Rust twin of tests/origins/unsound/fn-store-elided-params.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
fn store(v: &Rc<X>, s: &mut Option<&Rc<X>>) {
    *s = Some(v);
}
fn main() {
    let mut slot: Option<&Rc<X>> = None;
    {
        let k = Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") });
        store(&k, &mut slot);
    }
    match slot {
        Some(r) => println!("OUT: {}", r.s.len()),
        None => println!("none"),
    }
}
