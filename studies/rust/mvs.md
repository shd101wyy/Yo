> https://www.reddit.com/r/rust/comments/xjo523/the_val_programming_language/

It is all there in Rust's release notes, although admittedly they are cryptic. Let's decipher them!

The primary problem solved by the borrow checker is control over aliasing. It was introduced in Rust 0.3: "region pointers and borrow checking supersede alias analysis". Why the change? Because Rust couldn't get the alias analysis to work, due to theoretical problems. This is what is solved in Val's "mutable value semantics" paper.

For a while it seemed to work well. In Rust 0.4, "borrowed pointers are much more mature and recommended for use". But this borrow checker (which I consider to be borrow checker v0) worked very differently than now. It relied on notion of purity, for example. That's why you read in Rust 0.5 "more functions are pure now".

But purity was limiting, so it got replaced in Rust 0.6, "&mut is now unaliasable", the fundamental principle of borrow checker, which now can be called v1. (So &mut was aliasable in Rust 0.5? The answer is yes. That's why purity was needed.)

This led to in Rust 0.7 "at long last, argument modes no longer exist". Earlier in Rust 0.4, "argument modes are deprecated". Why the change? Because arguments modes work well with alias analysis, but not with borrow checker. This is what Graydon means by "no 1st-class borrows or lifetimes, only 2nd-class parameter modes". Val's inout is an argument mode.

Yes, all of this happened between 2012 and 2013. It was wild time.

On performance, Val's team made a prototype and benchmarked it, check the paper. From the paper's results, I am optimistic Val can be as fast as Rust without compromises.