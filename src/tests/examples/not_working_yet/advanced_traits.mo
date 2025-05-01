// https://doc.rust-lang.org/book/ch20-02-advanced-traits.html

Iterator :: trait Self: Type,
  Item: Type,
  next: ((&!(Self)) -> Option(Item))
;

Iterator Self: Counter,
  Item: u32,
  next: 
    fn(self)-> {
      // ...
    }

// ==================================================

Point :: struct
  x: i32,
  y: i32;

def Add(compt(Self): Type, compt(Rhs): Type): Type, // Question: Where is Self defined?
  trait 
    (Self: Type) = Self, // Is this correct?
    Output: Type,
    add: (fn(self: Self, other: Self) -> Self)
;
// QUESTION: How to express below correctly?:
// SomeConstraints :: (Type <: Add(?, ?)); // Doesn't look right.  
// 

Add(Point) Point,
  Output: Point,
  add: (fn(self, other) -> 
    Point
      x: (self.x + other.x),
      y: (self.y + other.y)
  )
;

// ==================================================

Pilot :: trait Self: Type,
  fly: (fn(&(Self)) -> ())
;
Wizard :: trait Self: Type,
  fly: (fn(&(Self)) -> ())

Human :: struct();

Pilot Human,
  fly: (fn(self) -> println("Piloting!"))
;

Wizard Human,
  fly: (fn(self) -> println("Wizarding!"))
;

def Human.fly(self: Human): (),
  println("Humaning!")
;

person :: Human();
person.fly(); // Calls Human's fly method
Pilot::fly(&(person)); // Calls Pilot's fly method
Wizard::fly(&(person)); // Calls Wizard's fly method

// ==================================================

Animal :: trait Self: Type,
  baby_name: (()-> String)
;

Dog :: struct();

def Dog.baby_name(): String,
  String.from("Spot")
;

Animal Dog,
  baby_name: (fn()-> String.from("puppy"))
;

Dog.baby_name(); // Spot
Animal.baby_name(); // puppy  
Dog.(Animal.baby_name)(); // puppy

// ==================================================

OutlinePrint :: trait Self: (Type <: (Display,)),
  (outline_print: ((&(Self)) -> ())) = (fn(self)-> {
    // ...
  })
;