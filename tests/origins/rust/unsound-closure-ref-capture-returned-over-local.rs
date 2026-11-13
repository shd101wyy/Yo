// Rust twin of tests/origins/unsound/closure-ref-capture-returned-over-local.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn mk(k: i32) -> impl Fn() -> i32 {
    let x = Box::new(k);
    let y = &x;
    move || **y
}
fn main() {
    let g = mk(41);
    println!("OUT: {}", g());
}
