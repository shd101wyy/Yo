;; 定长用 ()，变长用 []
(fn main [] (do 
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
(let x (Tuple 1 a 3))    ;; (1 2 3)
(let x (quasiquote (1 (unqoute a) 3))) ;; (1 2 3)
;;; unquote splicing
(let list '(2 3))
(let x `(1 ~@list 4)) ;; (1 2 3 4)


;; array & slice
(:: i32-array i32[5])
(let i32-array (Array 1 2 3 4 5))
;;; or
(let i32-array [1 2 3 4 5])

(let i32-slice &i32-array[0:3]) ;; i32-slice :: *i32[]
;;; or
(let i32-slice &(slice i32-array 0 3))

(::  example [ i32 i32 -> () ])
(let example (fn [x y] (do
  (set! x 1) ;; // Error: x is immutable
  (set! y 2) ;; // Error: y is immutable
)))

;; Type inference
(let my-symbol 'hi) ;; my-symbol : symbol

(::  my-string  *u8[])
(let my-string "hi") ;; my-string : *u8[]

;; extern
(extern "C"
  length :: [*String -> i32]
)

(fn main [] (do
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

(:: last-unit-expr [ -> ()])
(fn last-unit-expr [] (do
  (println "Hello World!")
  ()
))

;;; example: swap
(:: swap [(*mut i32) (*mut i32) -> ()])
(fn swap [x y] (do
  (let temp *x)
  (set! *x *y)
  (set! *y temp)
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
(:: add [
  i32 :label x :default 1  
  i32 :label y :default 2
  -> i32])
(fn add [a b] (+ a b))
(add)           ;; 3
(add :y 3)      ;; 4
(add 2 3)       ;; 5
(add :y 3 :x 4) ;; 7

;;; generic function
(:: identity
  (forall [T] 
    :require [(Identity T)] 
    [T -> T]))
(let identity (fn [x] x))


;;; dependency injection
(:: main [
          [*u8[] -> ()] :implicit true
          -> ()])
(fn main [?raise] (do
  (let x (?raise "Hello, world!"))
))

;; value constraint
(type NotZero i32 :where (!= _ 0))
(:: divide [i32 NotZero -> i32])
(fn divide [x y] (/ x y))

;; type constraint
(:: add
  (forall [T :: Type]
    :require [(Integral T)]
    [T T -> T]
))
(fn add [x y] (x + y))

;; closure
(::  add (closure* [i32 -> i32]))
(let add (closure [{:y 0}] [x] (do 
  (set! y (+ y x))
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
(type Vector (forall [(N :: i32)]
  (Array i32 N) ;; i32[N]
))

(:: add-vectors [(Vector N) (Vector N) -> (Vector N)])
(fn add-vectors [a b] (+ a b))

(::  v1 (Vector 3))
(let v1 [1, 2, 3])

;? (let v1 :: (Vector 3) [1, 2, 3])

(::    v2 (Vector 3))
(let v2 [4, 5, 6])

(add-vectors v1 v2) ;; [5, 7, 9]

;; destructuring
(let [a b] [1 2])  ;; a: 1, b: 2
(let (a b) '(1 2)) ;; a: 1, b: 2
(let some-record {
  :a 1
  :b 2
})
(let { a b } some-record)          ;; a: 1, b: 2
(let { another-a :a } some-record) ;; another-a: 1


;; generics
(class (Show T :: Type)
  show :: [T -> String] ;; :default (fn [x] (panic "Not implemented"))
)
(instance (Show boolean)
  show (fn [x] (if true "true" "false"))
)

(class (Eq a)
  eq :: [a a -> boolean]
)
(data Ordering
  LT
  EQ
  GT
)
(class (Ord a)
  :require [(Eq a)]
  compare :: [a a -> Ordering]
)

(class (Functor f)
  fmap :: (forall [a b] [(a -> b) (f a) -> (f b)])
)

;;; type constraints
(:: three-are-equal (forall [a]
  :require [(Eq a)]
  [a a a -> boolean]
))
(fn three-are-equal [x y z] (and (== x y) (== y z)))

(:: show-compare (forall [a]
  :require [(Show a) (Ord a)]
  [a a -> String]
))
(fn show-compare [x y] (match (compare x y)
  LT (concat (show x) " < " (show y))
  EQ (concat (show x) " = " (show y))
  GT (concat (show x) " > " (show y))
))

;;; instance dependencies
(instance
  (forall [a]
    :require [(Show a)] 
    (Show (Array a)))
  show (fn [x] (concat "[" (join ", " (map show x)) "]"))
)
(instance 
  (forall [a b] 
    :require [(Show a) (Show b)]
    (Show (Tuple a b)))
  show (fn [x] (concat "(" (show (fst x)) ", " (show (snd x)) ")")
))

;; cond
(cond
  (== x 1) (println "x is 1")
  (== x 2) (println "x is 2")
  :else    (println "x is not 1 or 2")
)

;; type synonym
;;; record
(type (User :: Type) 
  {
    active :: boolean
    name   :: String
    age    :: i32
  })
(let user (User {
  :active true
  :name "Alice"
  :age  20
}))
;; or
(let user (User true "Alice" 20)) ;; QUESTION: Should we support this?
                                  ;; Maybe not.  
;;; union
(type SomeNumber (| i32 f32))

;;; Destructure the record
(let (User active name age) user)
(let {
  name :as username
  age
} user)

;; algebraic datatype
(data (Option T)
  (Some
    T :label value
  )
  None)
(let some (Some 1))
(let none None)

(data)


(data IpAddr
  (V4 u8 u8 u8 u8)
  (V6 u16 u16 u16 u16 u16 u16 u16 u16))

;; Pattern matching
(data Coin
  Penny
  Nickel
  Dime
  Quarter)

(:: value-in-cents [Coin -> i32])
(fn value-in-cents [coin] (
  match coin
    Penny   1
    Nickel  5
    Dime    10
    Quarter 25
))

(data (List T)
  Nil
  (Cons 
    T              :label head
    (Box (List T)) :label tail
  ))

(:: list-length (forall [T :: Type] [(List T) -> i32]))
(fn list-length [list] (match list
    Nil        0
    (Cons _ xs) (+ 1 (list-length xs))
))

;; algebraic effect
(:: safe-divide
  [i32 i32 ((effect [*u8[] -> i32]) :implicit)
    -> i32])
(fn safe-divide [x y ?raise]
  (if (== y 0)
    :then (?raise "Division by zero")
    :else (/ x y)))

(:: handle-resume [-> i32])
(fn handle-resume [] (do
  (::     ?raise (effect [*u8[] -> i32]))
  (effect ?raise [msg] (resume 10))
  (+ 1 (safe-divide 3 0) 2) ;; 13
))

(:: handle-abort [-> i32])
(fn handle-abort [] (do
  (::     ?raise (effect [*u8[] -> i32]))
  (effect ?raise [msg] (abort 10))
  (+ 1 (safe-divide 3 0) 2) ;; 10
))

;; macro
;; NOTE: Why not use ~? Because ~ means bitwise not in C.
;; NOTE: Why use ~? Because , is getting ignored in Mo. , could be used anywhere to improve the readability.
(macro if [cond then else]
  `(cond 
    ~cond ~then
    :else ~else))

(macro fn [name args body]
  `(let ~name (fn ~args ,body))
)
;;; unquote splicing
;; NOTE: We use :rest here instead of & to avoid confusion with reference &x: (ref x)
(macro fn [name args :rest body]
  `(let ~name (fn ~args ~@body))
)

(macro-expand
  (if (== x 1) (println "x is 1") (println "x is not 1")))
;; =>
(cond (== x 1) (println "x is 1") :else (println "x is not 1"))

;; module
(import "./show.mo" :only {Show, another-show :show})
(import "./some-module.mo" :as some-module)

(let x 12)
(export x)
;; or
(export (let x 12))

(let 
  (= x 1)
  (mut (= y 2))
  (+ x y))