; ModuleID = 'main'
source_filename = "main"

define {} @test() {
entry:
  ret {} zeroinitializer
}

define {} @main() {
entry:
  %0 = call {} @test()
  ret {} %0
}
