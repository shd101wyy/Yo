// Rust twin of tests/origins/corpus/swap-inferred-locals.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn swap<'a>(a: &mut &'a i32, b: &mut &'a i32) {
    let t = *a;
    *a = *b;
    *b = t;
}
fn main() {
    let x = 1;
    let y = 2;
    let mut ra = &x;
    let mut rb = &y;
    swap(&mut ra, &mut rb);
    let _ = *ra + *rb;
}
