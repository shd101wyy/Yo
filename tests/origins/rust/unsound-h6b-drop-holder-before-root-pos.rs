// Rust twin of tests/origins/unsound/h6b-drop-holder-before-root-pos.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
struct G<'a> {
    t: &'a Rc<X>,
}
impl<'a> Drop for G<'a> {
    fn drop(&mut self) {
        println!("G dropped, read len {}", self.t.s.len());
    }
}
fn long() -> Rc<X> {
    Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") })
}
fn main() {
    let x = long();
    let y = long();
    let mut g = G { t: &x };
    g = G { t: &y };
    println!("end of main");
}
