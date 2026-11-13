// Rust twin of tests/origins/unsound/h6d-drop-holder-root-moved.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
use std::rc::Rc;
struct X {
    s: String,
}
struct H<'a> {
    r: &'a Rc<X>,
}
impl<'a> Drop for H<'a> {
    fn drop(&mut self) {
        println!("H dropped, read len {}", self.r.s.len());
    }
}
fn sink(v: Rc<X>) {
    println!("sink {}", v.s.len());
}
fn main() {
    let y = Rc::new(X { s: String::from("0123456789abcdefghijklmnopqrstuvwxyz") });
    let h = H { r: &y };
    sink(y);
    println!("end of main");
}
