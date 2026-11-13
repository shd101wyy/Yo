// Rust twin of tests/origins/corpus/store-widen-mut-pointee.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn store<'a, T>(dst: &mut Option<&'a T>, v: &'a T) {
    *dst = Some(v);
}
fn main() {
    let x = 1;
    let mut slot = Some(&x);
    {
        let y = 2;
        store(&mut slot, &y);
    }
    let _ = slot.is_some();
}
