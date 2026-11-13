// Rust twin of tests/origins/unsound/proj-ret-local-box-deref.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn get(a: &String) -> &String {
    let b = Box::new(String::from("0123456789abcdefghijklmnopqrstuvwxyz"));
    &*b
}
fn main() {
    let k = String::from("k");
    println!("OUT: {}", get(&k));
}
