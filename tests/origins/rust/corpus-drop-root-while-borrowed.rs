// Rust twin of tests/origins/corpus/drop-root-while-borrowed.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let x = String::from("a");
    let r = &x;
    drop(x);
    let _ = r.len();
}
