// Rust twin of tests/origins/unsound/p9-two-phase-holder-argument-pos.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
struct H<'a> {
    r: &'a i32,
}
fn grow_then_add(xs: &mut Vec<i32>, n: i32) -> i32 {
    let mut i = 0;
    while i < 1000 {
        xs.push(7);
        i += 1;
    }
    n + xs[1000]
}
fn main() {
    let mut xs: Vec<i32> = Vec::new();
    xs.push(1);
    let h = H { r: &xs[0] };
    let v = grow_then_add(&mut xs, *h.r);
    println!("OUT: {}", v);
}
