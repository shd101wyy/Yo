// https://doc.rust-lang.org/book/ch20-02-advanced-traits.html

Iterator :: forall(Output: Type)->
  interface Self:Type, (
    next: ((self: &!(Self))-> Option(Output))
  );

def Iterator(Self: Type): Interface,
  forall(Output: Type)->
    interface
      next: ((self: &!(Self))-> Option(Output));

Fibonacci :: struct
  curr: u32,
  next: u32
;

method iterator/next(self: &!(Fibonacci)): u32, {
  current := self.curr;
  self.curr = self.next;
  self.next = current + self.next;
  return Some(current);
};

