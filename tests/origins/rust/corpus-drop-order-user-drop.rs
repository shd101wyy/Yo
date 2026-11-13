// Rust twin of tests/origins/corpus/drop-order-user-drop.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
struct Log<'a> {
    items: Vec<&'a i32>,
}
impl<'a> Drop for Log<'a> {
    fn drop(&mut self) {
        let _ = self.items.len();
    }
}
fn main() {
    let mut log = Log { items: Vec::new() };
    let x = 1;
    log.items.push(&x);
}
