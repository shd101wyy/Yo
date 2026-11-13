// Rust twin of tests/origins/unsound/field-write-block-local.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
struct S<'a> {
    o: Option<&'a Rc<X>>,
}
fn main() {
    let mut h = S { o: None };
    {
        let y = Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") });
        h.o = Some(&y);
    }
    match &h.o {
        Some(r) => println!("OUT: {}", r.s.len()),
        None => println!("none"),
    }
}
