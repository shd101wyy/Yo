// Rust twin of tests/origins/unsound/p59-for-element-stored.yo (G-C: the oracle where the models coincide)
#![allow(warnings)]
fn main() {
    let mut xs: Vec<i32> = Vec::new();
    xs.push(1);
    let mut slot: Option<&i32> = None;
    for x in &xs {
        slot = Some(x);
    }
    let mut i = 0;
    while i < 1000 {
        xs.push(7);
        i += 1;
    }
    if let Some(r) = slot {
        println!("OUT: {}", r);
    }
}
