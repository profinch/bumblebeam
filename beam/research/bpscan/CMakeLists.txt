# Included at the end of the Beam root CMakeLists via inject.cmake, see README.md.
add_executable(bpscan ${BPSCAN_DIR}/bpscan.cpp)
target_link_libraries(bpscan core sqlite)
