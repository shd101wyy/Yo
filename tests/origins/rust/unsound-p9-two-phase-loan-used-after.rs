// Rust twin of tests/origins/unsound/p9-two-phase-loan-used-after.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn first(xs: &Vec<String>) -> &String {
    &xs[0]
}
fn main() {
    let mut xs: Vec<String> = Vec::new();
    xs.push(String::from("0123456789abcdefghijklmnopqrstuvwxyz"));
    let e = first(&xs);
    xs.push(e.clone());
    println!("OUT: {}", e.len());
}
