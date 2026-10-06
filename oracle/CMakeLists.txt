# Blake2b reference (vendored from the Beam core)
add_library(bb_blake2b STATIC third_party/beam/blake/ref/blake2b-ref.c)
target_include_directories(bb_blake2b PUBLIC third_party/beam)

# bumblebeam's own BeamHash III checks: the library the pool and the miner link
add_library(bb_pow STATIC src/pow.cpp)
target_include_directories(bb_pow PUBLIC include)
target_link_libraries(bb_pow PRIVATE bb_blake2b)
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(bb_pow PRIVATE -Wall -Wextra -Werror)
endif()

# The unchanged Beam core reference, as the oracle for tests and tools
add_library(bb_ref STATIC third_party/beam/beamHashIII_impl.cpp src/ref.cpp src/vectors.cpp)
target_include_directories(bb_ref PUBLIC third_party/beam src)
target_compile_definitions(bb_ref PUBLIC ENABLE_MINING)
target_link_libraries(bb_ref PUBLIC bb_blake2b)

add_executable(bb-pow tools/bb_pow.cpp)
target_link_libraries(bb-pow PRIVATE bb_pow bb_ref)

add_executable(test_oracle tests/test_oracle.cpp)
target_link_libraries(test_oracle PRIVATE bb_pow bb_ref)
add_test(NAME oracle COMMAND test_oracle ${PROJECT_SOURCE_DIR}/vectors)

option(BB_SANITIZE "Build bb_pow and its test with ASan/UBSan" OFF)
if(BB_SANITIZE)
  foreach(t bb_pow test_oracle bb-pow)
    target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(${t} PRIVATE -fsanitize=address,undefined)
  endforeach()
endif()
