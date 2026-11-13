// Rust twin of tests/origins/unsound/generic-result-second-arg-pushed.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn pick<T>(a: T, b: T, first: bool) -> T {
    if first { a } else { b }
}
fn main() {
    let mut xs: Vec<i32> = Vec::new();
    let mut ys: Vec<i32> = Vec::new();
    xs.push(1);
    ys.push(2);
    let rx = &xs[0];
    let ry = &ys[0];
    let picked = pick(rx, ry, false);
    let mut i = 0;
    while i < 1000 {
        ys.push(i);
        i += 1;
    }
    let v: i32 = *picked;
    println!("{}", v);
}
