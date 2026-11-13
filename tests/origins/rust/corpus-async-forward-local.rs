// Rust twin of tests/origins/corpus/async-forward-local.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn forward<'a>() -> &'a i32 {
    let x = 1;
    &x
}
fn main() {
    let _ = forward();
}
