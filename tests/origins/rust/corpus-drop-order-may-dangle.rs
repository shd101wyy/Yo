// Rust twin of tests/origins/corpus/drop-order-may-dangle.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut out: Vec<&i32> = Vec::new();
    let x = 1;
    out.push(&x);
}
