// Rust twin of tests/origins/corpus/ret-local.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn pick(xs: &i32) -> &i32 {
    let y = 2;
    &y
}
fn main() {
    let x = 1;
    let _ = pick(&x);
}
