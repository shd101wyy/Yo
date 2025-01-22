// Write an example main function that calls a closure function
#[derive(Debug)]
struct Holder {
    x: String
}

fn set_value(arr: &mut [i32], index: usize, value: i32) {
    arr[index] = value;
}

fn set_value_2(mut arr: [i32; 3], index: usize, value: i32) {
    arr[index] = value;
}

fn set_value_3(mut arr: [i32], index: usize, value: i32) {
    arr[index] = value;
}

fn main() {
    let a = "Hello";
    let mut x = [1, 2, 3];
    let x_ref = &mut x[0..2];

    x_ref[0] = 10;


    set_value(x_ref, 0, 12);
}