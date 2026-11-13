// Rust twin of tests/origins/corpus/fnmut-sequential-calls.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut f = {
        let mut n = 0;
        move || {
            n += 1;
            n
        }
    };
    let r = &mut f;
    let _a = r();
    let _b = f();
}
