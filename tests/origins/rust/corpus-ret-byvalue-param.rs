// Rust twin of tests/origins/corpus/ret-byvalue-param.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn own<'a>(v: i32) -> &'a i32 {
    &v
}
fn main() {
    let _ = own(1);
}
