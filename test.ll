; ModuleID = 'main'
source_filename = "main"
target triple = "x86_64-unknown-linux-gnu"

declare i8* @malloc(i32)

define i32 @main() {
entry:
  %malloc = call i8* @malloc(i32 16)
  %malloc1 = bitcast i8* %malloc to { i32 (i8*)*, i8* }*
  %functionPtr = getelementptr { i32 (i8*)*, i8* }, { i32 (i8*)*, i8* }* %malloc1, i32 0, i32 0
  store i32 (i8*)* @lambda_1, i32 (i8*)** %functionPtr, align 8
  %malloc2 = call i8* @malloc(i32 0)
  %malloc3 = bitcast i8* %malloc2 to {}*
  %fn_freeVariablesPtr = getelementptr { i32 (i8*)*, i8* }, { i32 (i8*)*, i8* }* %malloc1, i32 0, i32 1
  %fn_casted_freeVariablesPtr = bitcast {}* %malloc3 to i8*
  store i8* %fn_casted_freeVariablesPtr, i8** %fn_freeVariablesPtr, align 8
  %0 = call i32 @test({ i32 (i8*)*, i8* }* %malloc1)
  ret i32 %0
}

define i32 @lambda_1(i8* %FREE_VARIABLES) {
entry:
  %fn_FREE_VARIABLES = bitcast i8* %FREE_VARIABLES to {}*
  ret i32 16
}

define i32 @test({ i32 (i8*)*, i8* }* %fn) {
entry:
  %callfn_freeVariablesPtr = getelementptr { i32 (i8*)*, i8* }, { i32 (i8*)*, i8* }* %fn, i32 0, i32 1
  %callfn_freeVariablesPtr1 = load i8*, i8** %callfn_freeVariablesPtr, align 8
  %functionPtr = getelementptr { i32 (i8*)*, i8* }, { i32 (i8*)*, i8* }* %fn, i32 0, i32 0
  %functionPtr2 = load i32 (i8*)*, i32 (i8*)** %functionPtr, align 8
  %0 = call i32 %functionPtr2(i8* %callfn_freeVariablesPtr1)
  ret i32 %0
}
