// Rust twin of tests/origins/corpus/words-then-write.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
struct Doc {
    text: i32,
}
fn words(d: &Doc) -> Vec<&i32> {
    let mut out = Vec::new();
    out.push(&d.text);
    out
}
fn main() {
    let mut doc = Doc { text: 1 };
    let w = words(&doc);
    doc.text = 2;
    let _ = w.len();
}
