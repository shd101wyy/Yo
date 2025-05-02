
x :: 12;
t :: (x,);

runt_x := 12;

// t :: (x, runt_x); // Expected error
t := (x, runt_x);