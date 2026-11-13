// Rust twin of tests/origins/unsound/h4r-store-widen-named-holder.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
struct Slot<'p, 'a> {
    dst: &'a mut Option<&'p Rc<X>>,
}
fn put<'p>(s: &mut Slot<'p, '_>, v: &'p Rc<X>) {
    *s.dst = Some(v);
}
fn main() {
    let x = Rc::new(X { s: String::from("x") });
    let mut slot = Some(&x);
    let mut s = Slot { dst: &mut slot };
    {
        let y = Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") });
        put(&mut s, &y);
    }
    if let Some(r) = slot {
        println!("OUT: {}", r.s.len());
    }
}
