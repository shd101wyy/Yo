// Rust twin of tests/origins/unsound/p9-two-phase-holder-argument.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
struct H<'a> {
    r: &'a i32,
}
fn grow_then_read<'a>(xs: &mut Vec<i32>, h: H<'a>) -> i32 {
    let mut i = 0;
    while i < 1000 {
        xs.push(7);
        i += 1;
    }
    *h.r
}
fn main() {
    let mut xs: Vec<i32> = Vec::new();
    xs.push(1);
    let h = H { r: &xs[0] };
    let v = grow_then_read(&mut xs, h);
    println!("OUT: {}", v);
}
