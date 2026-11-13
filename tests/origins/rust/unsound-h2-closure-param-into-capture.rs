// Rust twin of tests/origins/unsound/h2-closure-param-into-capture.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn each(f: &mut impl FnMut(&String)) {
    let k = String::from("0123456789abcdefghijklmnopqrstuvwxyz");
    f(&k);
}
fn main() {
    let x = String::from("0123456789abcdefghijklmnopqrstuvwxyz");
    let mut slot: Option<&String> = None;
    each(&mut |v: &String| {
        slot = Some(v);
    });
    if let Some(r) = slot {
        println!("OUT: {}", r.len());
    }
}
