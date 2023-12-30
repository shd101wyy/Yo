// Write an example main function that calls a closure function

fn consume(data: String) {
}

fn returnRef<'a>(x: &'a String)-> &'a String{
    x
}

fn main() {
    let mut x = String::from("Hi");
    // let xRef = &x;
    // let newRef = returnRef(xRef);
    // let anotherRef = returnRef(xRef);
    let xref = returnRef(&x);
    consume(x);
    println!("{}", xref)
}
