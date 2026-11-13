// Rust twin of tests/origins/corpus/store-same-origin.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn store<'a, T>(dst: &mut Option<&'a T>, v: &'a T) {
    *dst = Some(v);
}
fn main() {
    let x = 1;
    let mut slot: Option<&i32> = None;
    store(&mut slot, &x);
    let _ = slot.is_some();
}
