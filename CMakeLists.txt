cmake_minimum_required(VERSION 3.20)
project(bumblebeam LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

enable_testing()
add_subdirectory(oracle)
