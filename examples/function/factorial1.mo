
let factorial: (x: i32)-> i32 = 
               (x: i32): i32 -> 
{
    let flag = (x == 0);
    if (flag) {
        1
    } else {
        x * factorial(x - 1)
    }
};