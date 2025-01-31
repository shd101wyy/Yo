;; 定长用 ()，变长用 []
(fn main [] (begin 
  (println "Hello World!")
))

;; Variables
(let x 1) ;; immutable
(var y 2) ;; mutable

;; keyword
:use
:ret
;;; keyword cannot be used as value.  

;; atom
(let x 'this-is-an-atom)
;;; or
(let x (quote this-is-an-atom))

;; tuple (fixed-length)
(let unit '())           ;; ()
(let x '(1 a 3))         ;; (1 a 3)
(let x (quote (1 a 3)))  ;; (1 a 3)
;;; quasiquote
(let a 2)
(let x `(1 ~a 3)) ;; (1 2 3)
(let x (quasiquote (1 (unqoute a) 3))) ;; (1 2 3)
;;; unquote splicing
(let list '(2 3))
(let x `(1 ~@list 4)) ;; (1 2 3 4)


;; array & slice
(:: i32_array i32[5])
(let i32_array (array 1 2 3 4 5))
;;; or
(let i32_array [1 2 3 4 5])

(let i32_slice &i32_array[0:3]) ;; i32_slice :: *i32[]
;;; or
(let i32_slice &(slice i32_array 0 3))

(:: example [ i32 i32 -> void ])
(let example (fn [x y] (begin
  (= x 1) ;; // Error: x is immutable
  (= y 2) ;; // Error: y is immutable
)))

;; Type inference
(let my_symbol 'hi) ;; my_symbol : symbol

(::  my_string  *u8[])
(let my_string "hi") ;; my_string : *u8[]

;; extern
(extern "C"
  (length [*String -> i32])
)

(fn main [] (begin
  (var x (String.from "Hello World")) ;; x: String
  (defer (drop x)) ;;

  (let y &x) ;; y: *String

  (::  z *String)
  (let z &x) ;; z: *String

  (length x) ;; not allowed
  (length y) ;; allowed
  (length z) ;; allowed
))

;; Function declaraction
(:: add [i32 i32 -> i32])
(fn add [x y] (+ x y))

(:: last_void_expr [ -> void])
(fn last_void_expr [] (begin
  (println "Hello World!")
))

;;; example: swap
(:: swap [(*mut i32) (*mut i32) -> void])
(fn swap [x y] (begin
  (let temp *x)
  (= *x *y)
  (= *y temp)
))
(var x 1)
(var y 2)
(swap &x &y)
;; x: 2, y: 1

"""
QUESTION: Should we define :default in signature or function declaration?
>>> def test(a=1, b=2, c=a+1):
...     return a + b + c
Traceback (most recent call last):
  File "<stdin>", line 1, in <module>
NameError: name 'a' is not defined
"""
;;; default parameter value & named parameter
(:: add [(i32 :name x :default 1) (i32 :name y :default 2) -> i32])
(fn add [a b] (+ a b))
(add)           ;; 3
(add :y 3)      ;; 4
(add 2 3)       ;; 5
(add :y 3 :x 4) ;; 7

;;; generic function
(:: identity 
  (::forall [(T :: Type)] 
    :use [(Identity T)] 
    :ret [T -> T]))
(let identity (fn [x] x))


;;; dependency injection
(:: main [([*u8[] -> void] :implicit) 
          -> void])
(fn main [?raise] (begin
  (let x (?raise "Hello, world!"))
))

;; value constraint
(type NotZero i32 :where (!= _ 0))
(:: divide [i32 NotZero -> i32])
(fn divide [x y] (/ x y))

;; type constraint
(:: add
  (::forall [(T :: Type)]
    :use [(Integral T)]
    :ret [T T -> T]
))
(fn add [x y] (x + y))

;; closure
(:: add (closure* [i32 -> i32] ) )
(let add (closure [{:y 0}] [x] (begin 
  (= y (+ y x))
  y
)))
(add 1) ;; 1
(add 2) ;; 3

;; recur
(fn [x acc] (if 
  (== x 1)
  :then acc
  :else (recur (- x 1) (+ acc x)) ;; perform tail-call optimization
))

;; dependent types
(type Vector (::forall [(N :: i32)]
  (Array i32 N) ;; i32[N]
))

(:: add_vectors [(Vector N) (Vector N) -> (Vector N)])
(fn add_vectors [a b] (+ a b))

(::    v1 (Vector 3))
(let v1 [1, 2, 3])

;? (let v1 :: (Vector 3) [1, 2, 3])

(::    v2 (Vector 3))
(let v2 [4, 5, 6])

(add_vectors v1 v2) ;; [5, 7, 9]

;; generics
(class Show
  (::forall [(T :: Type)]
    {
      :show ([T -> String] :default (fn [x] (panic "Not implemented")))
    }
))
(instance (Show i32)
  {
    :show (fn [x] (String.from x))
  }
)

(class Length
  (::forall [T]
    {
      :length [T -> i32]
    }
))

(instance (::forall [T]
  (Length *T[])
  {
    :length (fn [x] x.length)
  }
))


(import "./show.mo" :only [Show (show :as another_show)])

;; cond
(cond
  (== x 1) (println "x is 1")
  (== x 2) (println "x is 2")
  :else   (println "x is not 1 or 2")
)

;; type synonym
;;; struct
(type (User :: Type) 
  {
    :active boolean
    :name String
    :age  i32
  })
;;; union
(type SomeNumber (| i32 f32))

(let user (User {
  :active true
  :name "Alice"
  :age  20
}))
;; or
(let user (User true "Alice" 20)) ;; QUESTION: Should we support this?

;;; Destructure the record
(let (User active name age) user)
(let {
  name :as username
  age
} user)

;; enum
(enum Option
  (forall [(T :: Type)]
    (Some T)
    None
  ))
(let some (Some 1))
(let none None)

(enum IpAddr
  (V4 u8 u8 u8 u8)
  (V6 u16 u16 u16 u16 u16 u16 u16 u16)
)

;; Pattern matching
(enum Coin
  Penny
  Nickel
  Dime
  Quarter
)

(:: value_in_cents [Coin -> i32])
(fn value_in_cents [coin] (
  match coin
    Penny   1
    Nickel  5
    Dime    10
    Quarter 25
))

(enum List
  (::forall [(T :: Type)])
  Nil
  (Cons T (Box (List T)))
)

(:: list_length (::forall [(T :: Type)] [(List T) -> i32]))
(fn list_length [list] (match list
    Nil        0
    (Cons _ xs) (+ 1 (list_length xs))
))

;; algebraic effect
(:: safe_divide
  [i32 i32 ((effect [*u8[] -> i32]) :implicit)
    -> i32])
(fn safe_divide [x y ?raise]
  (if (== y 0)
    :then (do (?raise "Division by zero"))
    :else (/ x y)))

(:: handle_resume [-> i32])
(fn handle_resume [] (begin
  (::     ?raise (effect [*u8[] -> i32]))
  (effect ?raise [msg] (resume 10))
  (+ 1 (safe_divide 3 0) 2) ;; 13
))

(:: handle_abort [-> i32])
(fn handle_abort [] (begin
  (::     ?raise (effect [*u8[] -> i32]))
  (effect ?raise [msg] (abort 10))
  (+ 1 (safe_divide 3 0) 2) ;; 10
))

;; macro
;; NOTE: Why not use ~, because ~ means bitwise not in C.
(macro if [cond then else]
  `(cond 
    ,cond ,then
    :else ,else))

(macro fn [name args body]
  `(let ,name (fn ,args ,body))
)
;;; unquote splicing
(macro fn [name args & body]
  `(let ,name (fn ,args ,@body))
)

(macro_expand
  (if (== x 1) (println "x is 1") (println "x is not 1")))
;; =>
(cond (== x 1) (println "x is 1") :else (println "x is not 1"))