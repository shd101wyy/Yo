// struct
Point := struct {x: i32, y: i32};
point := Point {x: 1, y: 2};

Cm := struct i32;
cm := Cm 1;

// enum
Color := enum {
  Red = 1,
  Green,
  Blue
};

// tagged union
fn Option(T: Type): Type, 
  enum {
    Some(T),
    None
  };

// union
MyUnion := union {
  f1: i32,
  f2: f32
};
u := MyUnion {f1: 1};