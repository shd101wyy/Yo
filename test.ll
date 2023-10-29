; ModuleID = 'main'
source_filename = "main"

declare float @sin(float)

define i32 @main() {
entry:
  %0 = call float @sin(float 1.000000e+00)
  ret i32 0
}
