// Rust twin of tests/origins/corpus/call-arg-overlap.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn both(a: &mut Vec<i32>, b: &Vec<i32>) {
    a.push(b.len() as i32);
}
fn main() {
    let mut xs: Vec<i32> = Vec::new();
    both(&mut xs, &xs);
}
