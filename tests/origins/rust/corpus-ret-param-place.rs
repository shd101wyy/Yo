// Rust twin of tests/origins/corpus/ret-param-place.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn first(xs: &i32) -> &i32 {
    xs
}
fn main() {
    let x = 1;
    let r = first(&x);
    let _ = *r;
}
