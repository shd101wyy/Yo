// Write an example main function that calls a closure function

fn consume(data: String) {}

fn longest<'a>(x: &'a String, y: &'a String)-> &'a String {
    if x.len() > y.len() {
        x
    } else {
        y
    }
}


fn test_reference(x: &i32) {
    println!("{}", x);
}

fn main() {
    let mut x = 1;
    let x_ref = &mut x;

    test_reference(x_ref);
}