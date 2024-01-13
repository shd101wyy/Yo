// Write an example main function that calls a closure function
fn consume<T>(data: T) {}

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

fn test_string_reference(x: &String) {
    println!("{}", x);
}

struct Holder<'a> {
    x: &'a String,
}

fn set_x<'a>(holder: &'a mut Holder<'a>, x: &'a String) {
    // holder.x = x;
}

fn test_mut(x: &mut Holder) {
}


fn test<'a>() {
    let a = String::from("hello");
    let mut holder = Holder { x: &a };
    let x = String::from("World");
    {
        // let holder_ref = &mut holder;
        // test_mut(&mut holder);
        set_x(&mut holder, &x);
    }


    let b = 1;
    let b_ref = &b;
    let b_ref2 = b_ref;

    // consume(x);
    // consume(holder);
}

fn main() {}