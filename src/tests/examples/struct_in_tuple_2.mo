// Complicated case
// struct type inside tuple
Complex :: type ((struct(x: i32, y: boolean),),);
Complex0 :: Complex.0;
SomeStruct :: Complex.0.0;

(c: SomeStruct) = _(3, false);
(c: Complex0) = (_(3, true),);
(c: Complex) = ((_(3, true),),);
(c: Complex) = ((_(y: true, x: 1),),);


