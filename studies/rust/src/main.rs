// Write an example main function that calls a closure function
#[derive(Debug)]
struct Holder {
    x: String
}

fn main() {
    let mut holder: Holder = Holder {
        x: String::from("Hi there")
    };
    let x = holder.x;
    print!("{}", x);
    print!("{:?}", holder);
}