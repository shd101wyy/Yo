; ModuleID = 'main'
source_filename = "main"

define i32 @test() {
entry:
  ret i32 12
}

define i32 @main() {
entry:
  %0 = call i32 @test()
  ret i32 4
}
