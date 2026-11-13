// Rust twin of tests/origins/unsound/h1r-flow-slot-lent-mut.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
fn store<'a>(dst: &mut Option<&'a Rc<X>>, v: &'a Rc<X>) {
    *dst = Some(v);
}
fn main() {
    let mut slot: Option<&Rc<X>> = None;
    {
        let y = Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") });
        store(&mut slot, &y);
    }
    if let Some(r) = slot {
        println!("OUT: {}", r.s.len());
    }
}
