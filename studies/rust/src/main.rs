// Write an example main function that calls a closure function

fn consume(data: String) {

}

fn test(flag: bool) {
    let x = String::from("Hello, world");
    if flag {
        let y = x;
        consume(y)
    } else {
    }
    let z = x;
}

fn main() {
    test(true)    
}
