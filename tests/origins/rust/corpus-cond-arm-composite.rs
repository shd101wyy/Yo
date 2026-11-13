// Rust twin of tests/origins/corpus/cond-arm-composite.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn flag(n: i32) -> bool {
    n > 2
}
fn main() {
    let x = 1;
    let mut y = 2;
    let c = flag(1);
    let m = if c { Some(&x) } else { Some(&y) };
    y = 3;
    match m {
        Some(r) => {
            let _ = *r;
        }
        None => (),
    }
}
