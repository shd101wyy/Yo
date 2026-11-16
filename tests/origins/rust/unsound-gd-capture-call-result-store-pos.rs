// Rust twin of tests/origins/unsound/gd-capture-call-result-store-pos.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
fn mkh(a: &Rc<X>) -> Option<&Rc<X>> {
    Some(a)
}
fn main() {
    let z = Rc::new(X { s: String::from("ABCDEFGHIJ") });
    let mut h: Option<&Rc<X>> = Some(&z);
    {
        let x = Rc::new(X { s: String::from("0123456789") });
        {
            let mut c = || {
                let s = &mut h;
                let rx = &x;
                *s = mkh(rx);
            };
            c();
        }
        match &h {
            Some(r) => println!("OUT: {}", &r.s[0..5]),
            None => println!("none"),
        }
    }
}
