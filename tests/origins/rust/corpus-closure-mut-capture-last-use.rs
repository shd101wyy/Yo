// Rust twin of tests/origins/corpus/closure-mut-capture-last-use.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut n = 0;
    let mut bump = || {
        n += 1;
    };
    bump();
    bump();
    println!("{}", n);
}
