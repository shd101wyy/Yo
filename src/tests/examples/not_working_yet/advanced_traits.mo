// https://doc.rust-lang.org/book/ch20-02-advanced-traits.html

Iterator :: trait 
  Self: Type,
  Item: Type,
  next: ((&!(Self)) -> Option(Item))
;

impl Iterator, for: Counter,
  Item: u32,
  next: (fn(self)-> {
    // ...
  });

// ==================================================

Point :: struct
  x: i32,
  y: i32;

def Add(Self: Type, (Rhs: Type) = Self): Trait, // Question: Where is Self defined?
  trait 
    Self = Self, // Is this correct?
    Output: Type,
    add: (fn(self, other: Self) -> Self)
;
// QUESTION: How to express below correctly?:
// SomeConstraints :: (Type <: Add(?, ?)); // Doesn't look right.  
// 

impl Add(Point), for: Point,
  Output: Point,
  add: (fn(self, other) -> 
    Point
      x: (self.x + other.x),
      y: (self.y + other.y)
  )
;

// ==================================================

Pilot :: trait
  fly: (fn(&(Self)) -> ())
;
Wizard :: trait
  fly: (fn(&(Self)) -> ())

Human :: struct();

impl Pilot, for: Human,
  fly: (fn(self) -> println("Piloting!"))
;

impl Wizard, for: Human,
  fly: (fn(self) -> println("Wizarding!"))
;

impl Human,
  fly: (fn(self: Human) -> println("Humaning!"))
;

person :: Human();
person.fly(); // Calls Human's fly method
Pilot::fly(&(person)); // Calls Pilot's fly method
Wizard::fly(&(person)); // Calls Wizard's fly method

// ==================================================

Animal :: trait
  baby_name: (()-> String)
;

Dog :: struct();

impl Dog,
  baby_name: (fn()-> String.from("Spot"))
;

impl Animal, for: Dog,
  baby_name: (fn()-> String.from("puppy"))
;

Dog.baby_name(); // Spot
Animal.baby_name(); // error: No implementation found.  
Dog.(Animal.baby_name)(); // puppy

// ==================================================

OutlinePrint :: trait for: (Type <: (Display,)),
  (outline_print: (fn(&(Self)) -> ())) = (fn(self)-> {
    // ...
  })
;