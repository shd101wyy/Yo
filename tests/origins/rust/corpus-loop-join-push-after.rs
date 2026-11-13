// Rust twin of tests/origins/corpus/loop-join-push-after.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut x = 0;
    let mut out: Vec<&i32> = Vec::new();
    let mut i = 0;
    while i < 3 {
        if i % 2 == 1 {
            out.push(&x);
        }
        i += 1;
    }
    let _ = out.len();
    x = 9;
}
