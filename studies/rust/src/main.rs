// Write an example main function that calls a closure function

fn consume(data: String) {}

fn longest<'a>(x: &'a String, y: &'a String)-> &'a String {
    if x.len() > y.len() {
        x
    } else {
        y
    }
}

fn test<'a>()-> &'a i32 {
    let x = 5;
    &x
}

fn main() {
    let x = String::from("Hi");
    let y = String::from("Bye");
    let p:&String;
    {
        p = longest(&x, &y);
    }
    consume(x);
    println!("{}", p);
}