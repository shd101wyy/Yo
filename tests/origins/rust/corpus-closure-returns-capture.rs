// Rust twin of tests/origins/corpus/closure-returns-capture.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn apply(f: impl Fn(&i32) -> &i32, v: &i32) -> i32 {
    *f(v)
}
fn main() {
    let x = 1;
    let y = 2;
    let c = &y;
    let _ = apply(|_v: &i32| -> &i32 { c }, &x);
}
