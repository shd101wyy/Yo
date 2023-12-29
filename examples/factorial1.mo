
let factorial: (x: i32)-> i32 = 
               (x: i32)-> i32 
{
    if (x == 0) {
        1
    } else {
        x * factorial(x - 1)
    }
};