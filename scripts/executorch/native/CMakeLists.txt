cmake_minimum_required(VERSION 3.26)
project(komatose_executorch_probe LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
if(NOT EXECUTORCH_SOURCE)
  message(FATAL_ERROR "Set EXECUTORCH_SOURCE to the pinned ExecuTorch source checkout")
endif()
if(EXECUTORCH_PACKAGE_DIR)
  # Fast CPU/XNNPACK baseline using upstream's libtorch-free native libraries.
  # The source build below is still used for Vulkan and selective kernel builds.
  find_package(executorch 1.5.1 EXACT REQUIRED CONFIG
    COMPONENTS kernels_optimized backend_xnnpack
    PATHS ${EXECUTORCH_PACKAGE_DIR}/lib/cmake/executorch NO_DEFAULT_PATH)
  add_executable(komatose-et-runner runner.cpp)
  target_include_directories(komatose-et-runner PRIVATE ${EXECUTORCH_SOURCE}/third-party/json/include
    ${EXECUTORCH_SOURCE}/.. ${EXECUTORCH_SOURCE}/backends/xnnpack/third-party/pthreadpool/include)
  target_link_libraries(komatose-et-runner PRIVATE executorch::runtime executorch::kernels_optimized executorch::backend_xnnpack executorch::threadpool)
  target_compile_definitions(komatose-et-runner PRIVATE KOMATOSE_ET_THREADPOOL=1)
  return()
endif()
set(EXECUTORCH_BUILD_EXTENSION_MODULE ON CACHE BOOL "" FORCE)
set(EXECUTORCH_BUILD_EXTENSION_DATA_LOADER ON CACHE BOOL "" FORCE)
set(EXECUTORCH_BUILD_EXTENSION_TENSOR ON CACHE BOOL "" FORCE)
set(EXECUTORCH_BUILD_EXTENSION_FLAT_TENSOR ON CACHE BOOL "" FORCE)
set(EXECUTORCH_BUILD_EXTENSION_NAMED_DATA_MAP ON CACHE BOOL "" FORCE)
set(EXECUTORCH_BUILD_EXECUTOR_RUNNER OFF CACHE BOOL "" FORCE)
set(EXECUTORCH_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${EXECUTORCH_SOURCE} executorch)
add_executable(komatose-et-runner runner.cpp)
target_include_directories(komatose-et-runner PRIVATE ${EXECUTORCH_SOURCE}/third-party/json/include)
target_link_libraries(komatose-et-runner PRIVATE executorch extension_module_static extension_tensor)
if(TARGET extension_threadpool)
  target_link_libraries(komatose-et-runner PRIVATE extension_threadpool)
  target_compile_definitions(komatose-et-runner PRIVATE KOMATOSE_ET_THREADPOOL=1)
endif()
# Upstream targets already propagate whole-archive registration link options.
# Adding another whole-archive around them duplicates every registration.
if(EXECUTORCH_BUILD_KERNELS_OPTIMIZED)
  target_link_libraries(komatose-et-runner PRIVATE optimized_native_cpu_ops_lib)
else()
  target_link_libraries(komatose-et-runner PRIVATE portable_ops_lib)
endif()
if(EXECUTORCH_BUILD_XNNPACK)
  target_link_libraries(komatose-et-runner PRIVATE xnnpack_backend)
endif()
if(EXECUTORCH_BUILD_VULKAN)
  # v1.5.1 SharedObject.cpp uses std::find without including <algorithm>.
  # New GCC headers no longer supply it transitively. This build-only workaround
  # leaves the pinned upstream checkout and all model kernels unchanged.
  target_compile_options(vulkan_backend PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-includealgorithm>)
  target_link_libraries(komatose-et-runner PRIVATE vulkan_backend)
endif()
if(EXECUTORCH_BUILD_ROCM OR EXECUTORCH_BUILD_CUDA)
  target_link_libraries(komatose-et-runner PRIVATE aoti_cuda_backend)
endif()
