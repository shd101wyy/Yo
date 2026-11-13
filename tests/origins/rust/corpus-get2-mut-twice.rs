// Rust twin of tests/origins/corpus/get2-mut-twice.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn first_mut(xs: &mut Vec<i32>) -> &mut i32 {
    &mut xs[0]
}
fn main() {
    let mut xs = Vec::new();
    xs.push(1);
    let a = first_mut(&mut xs);
    let b = first_mut(&mut xs);
    *a = 5;
    let _ = b;
}
