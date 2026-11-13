// Rust twin of tests/origins/corpus/match-arm-composite.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
struct P {
    v: i32,
}
fn main() {
    let mut o = Some(P { v: 1 });
    let m = match &o {
        Some(h) => Some(&h.v),
        None => None,
    };
    o = None;
    match m {
        Some(r) => {
            let _ = *r;
        }
        None => (),
    }
}
