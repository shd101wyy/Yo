// Rust twin of tests/origins/corpus/copy-shared-holder.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
#[derive(Clone, Copy)]
struct View<'a> {
    r: &'a i32,
    n: i32,
}
fn main() {
    let x = 1;
    let v = View { r: &x, n: 0 };
    let w = v;
    let _ = *v.r;
    let _ = *w.r;
}
