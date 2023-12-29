// Write an example main function that calls a closure function

fn increment(x: &mut i32) {
    *x = *x + 1;
}

fn main() {
    let mut x = 1;
    let y = &mut x;
    
    increment(y);

    let z = y;

    increment(y);
    
    // let z = y;
    // *z = *z + 1;
    // *y = *y + 2;
}
