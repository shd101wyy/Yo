// Rust twin of tests/origins/corpus/match-arm-binding-origin.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut x = 1;
    let o = Some(&x);
    match o {
        Some(r) => {
            x = 2;
            let _ = *r;
        }
        None => (),
    }
}
