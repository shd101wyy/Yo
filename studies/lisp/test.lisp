
(export 
    (let x 1))
(export 
    (let add 
        (-> 
            ([x : i32] [y : i32])
: i32
            (+ x y))))
