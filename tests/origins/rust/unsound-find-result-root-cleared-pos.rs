// Rust twin of tests/origins/unsound/find-result-root-cleared-pos.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut xs: Vec<String> = Vec::new();
    xs.push(String::from("0123456789abcdefghijklmnopqrstuvwxyz"));
    xs.push(String::from("abcdefghijklmnopqrstuvwxyz0123456789"));
    let found = xs.iter().find(|v| v.len() > 10);
    match found {
        Some(s) => println!("OUT: {}", s.len()),
        None => println!("none"),
    }
    xs.clear();
}
