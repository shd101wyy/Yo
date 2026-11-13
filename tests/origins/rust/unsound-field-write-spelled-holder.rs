// Rust twin of tests/origins/unsound/field-write-spelled-holder.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
struct S<'a> {
    o: Option<&'a String>,
}
fn main() {
    let z0 = String::from("z");
    let mut h = S { o: None };
    {
        let y = String::from("0123456789abcdefghijklmnopqrstuvwxyz");
        h.o = Some(&y);
    }
    if let Some(r) = h.o {
        println!("OUT: {}", r.len());
    }
}
