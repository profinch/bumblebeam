# Passed as CMAKE_PROJECT_INCLUDE together with -DBPSCAN_DIR=<this folder>: defines
# the bpscan target at the end of the Beam root CMakeLists, so it inherits Beam's
# include dirs, flags and targets without touching the Beam tree.
# Runs for every project() call: act on the root one only.
if(CMAKE_CURRENT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
    get_property(_bpscan_done GLOBAL PROPERTY BPSCAN_INJECTED)
    if(NOT _bpscan_done)
        set_property(GLOBAL PROPERTY BPSCAN_INJECTED 1)
        cmake_language(DEFER DIRECTORY ${CMAKE_SOURCE_DIR}
            CALL include ${BPSCAN_DIR}/CMakeLists.txt)
    endif()
endif()
