; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %malloc = call i8* @malloc(i32 4)
  %malloc1 = bitcast i8* %malloc to { i32 }*
  %v = getelementptr { i32 }, { i32 }* %malloc1, i32 0, i32 0
  store i32 1, i32* %v, align 4
  %malloc2 = call i8* @malloc(i32 8)
  %malloc3 = bitcast i8* %malloc2 to { { i32 }* }*
  %ptr = getelementptr { { i32 }* }, { { i32 }* }* %malloc3, i32 0, i32 0
  store { i32 }* %malloc1, { i32 }** %ptr, align 8
  %0 = call i32 @lambda(i32 2, { { i32 }* }* %malloc3)
  ret i32 %0
}

define i32 @lambda(i32 %x, { { i32 }* }* %env) {
entry:
  %ptr = getelementptr { { i32 }* }, { { i32 }* }* %env, i32 0, i32 0
  %ptr1 = load { i32 }*, { i32 }** %ptr, align 8
  %v = getelementptr { i32 }, { i32 }* %ptr1, i32 0, i32 0
  %v2 = load i32, i32* %v, align 4
  %0 = add i32 %v2, %x
  ret i32 %0
}
