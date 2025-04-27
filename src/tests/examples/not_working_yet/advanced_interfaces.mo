def Iterator(compt(Self): Type): compt(Interface),
  interface
    Item: Type,
    next: ((&!(Self)) -> Option(this.Item))
;

impl Iterator(Counter),
  Item: u32,
  next: (fn(self) -> Option(this.Item) {
    // Implementation of the next method
    // ...
  });

// ==================================================

Point :: struct
  x: i32,
  y: i32;

def Add(compt(Self): Type, (compt(Rhs): Type) = Self): compt(Interface),
  interface
    Output: Type,
    add: (fn(self, other: Self) -> Self)
;

impl Add(Point),
  Output: Point,
  add: (fn(self, other) -> 
    Point
      x: (self.x + other.x),
      y: (self.y + other.y)
  )
;

// ==================================================

def Pilot(compt(Self): Type): Interface,
  interface
    fly: (fn(&(Self)) -> ())
;

def Wizard(compt(Self): Type): Interface,
  interface
    fly: (fn(&(Self)) -> ())
;

Human :: struct();

impl Pilot(Human),
  fly: (fn(self) -> println("Piloting!"))
;

impl Wizard(Human),
  fly: (fn(self) -> println("Wizarding!"))
; 

impl Human,
  fly: (fn(self: Human) -> println("Humaning!"))
;

person :: Human();
person.fly(); // Calls Human's fly method
Pilot.fly(&(person)); // Calls Pilot's fly method
Wizard.fly(&(person)); // Calls Wizard's fly method

// ==================================================

def Animal(compt(Self): Type): Interface,
  interface
    baby_name: (()-> String)
;

Dog :: struct();

impl Dog,
  baby_name: (fn()-> String.from("Spot"))
;

impl Animal(Dog),
  baby_name: (fn()-> String.from("puppy"))
;

Dog.baby_name(); // Spot
Animal(Dog).baby_name(); // error: No implementation found.
                        // QUESTION: Is this correct? ^^^
Dog.(Animal.baby_name)(); // puppy

// ==================================================
// Use => for defining the constraints.
OutlinePrint : ((compt(Self): Type)-> 
                  ((Display(Self),)=> compt(Interface)));

def OutlinePrint(compt(Self): Type): ((Display(Self),)=> Interface),
  interface
    outline_print: (fn(&(Self)) -> ())
;

// ==================================================

def PrintableAndComparable(compt(Self): Type): compt(Array(Interface, 3)),
  [Show(Self), Eq(Self), Ord(Self)]
;

def sort_and_print(compt(T): Type): ((...(PrintableAndComparable(T))) => String),
  show(sort(xs))
;

// ==================================================
forall(compt(X): Type) ->
  def identity(x: X)-> X,
    x
;

identity :: 
  (forall(compt(X): Type) ->
    ((fn(x: X): X) -> X))
;