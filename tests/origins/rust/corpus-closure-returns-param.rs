// Rust twin of tests/origins/corpus/closure-returns-param.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn apply(f: impl Fn(&i32) -> &i32, v: &i32) -> i32 {
    *f(v)
}
fn main() {
    let x = 1;
    let _ = apply(|v| v, &x);
}
