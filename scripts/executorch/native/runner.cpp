// Standalone native feasibility runner: no Python, torch, or libtorch dependency.
#include <executorch/extension/module/module.h>
#include <executorch/extension/tensor/tensor_ptr.h>
#include <executorch/runtime/platform/runtime.h>
#include <executorch/runtime/kernel/operator_registry.h>
#ifdef KOMATOSE_ET_THREADPOOL
#include <executorch/extension/threadpool/threadpool.h>
#endif
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <set>
#include <sys/resource.h>

using nlohmann::json;
using executorch::extension::Module;
using executorch::runtime::EValue;
using executorch::aten::ScalarType;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
ScalarType scalar(const std::string& type) {
  if (type == "float32") return ScalarType::Float;
  if (type == "float64") return ScalarType::Double;
  if (type == "int64") return ScalarType::Long;
  if (type == "int32") return ScalarType::Int;
  if (type == "float16") return ScalarType::Half;
  if (type == "uint8") return ScalarType::Byte;
  if (type == "bool") return ScalarType::Bool;
  throw std::runtime_error("Unsupported case dtype: " + type);
}
std::string dtype(ScalarType type) {
  switch (type) {
    case ScalarType::Float: return "float32";
    case ScalarType::Double: return "float64";
    case ScalarType::Long: return "int64";
    case ScalarType::Int: return "int32";
    case ScalarType::Half: return "float16";
    case ScalarType::Byte: return "uint8";
    case ScalarType::Bool: return "bool";
    default: throw std::runtime_error("Unsupported output dtype");
  }
}
struct Case {
  std::vector<std::vector<uint64_t>> storage;
  std::vector<executorch::extension::TensorPtr> tensors;
  std::vector<EValue> inputs;
  std::string method;
};
Case read_case(const fs::path& file) {
  std::ifstream metadata(file);
  if (!metadata) throw std::runtime_error("Cannot read case " + file.string());
  json value; metadata >> value;
  if (value.at("schemaVersion") != 1) throw std::runtime_error("Unsupported case schema");
  Case result; result.method = value.value("method", "forward");
  for (const auto& input : value.at("inputs")) {
    auto type = scalar(input.at("dtype"));
    auto sizes = input.at("shape").get<std::vector<executorch::aten::SizesType>>();
    size_t bytes = executorch::runtime::elementSize(type);
    for (auto size : sizes) {
      if (size < 0 || (size && bytes > (1ULL << 32) / static_cast<size_t>(size)))
        throw std::runtime_error("Invalid or oversized tensor");
      bytes *= size;
    }
    if (bytes != input.at("bytes").get<size_t>()) throw std::runtime_error("Case byte count mismatch");
    fs::path tensor_file = file.parent_path() / input.at("file").get<std::string>();
    if (fs::file_size(tensor_file) != bytes) throw std::runtime_error("Tensor file size mismatch");
    result.storage.emplace_back((bytes + 7) / 8);
    std::ifstream data(tensor_file, std::ios::binary);
    data.read(reinterpret_cast<char*>(result.storage.back().data()), bytes);
    if (!data && bytes) throw std::runtime_error("Incomplete tensor file");
    auto tensor = executorch::extension::make_tensor_ptr(sizes, result.storage.back().data(), type);
    result.inputs.emplace_back(*tensor);
    result.tensors.emplace_back(std::move(tensor));
  }
  return result;
}
json execute(Module& module, Case& input, int repeat, int stability, const fs::path& output) {
  auto start = Clock::now();
  auto values = module.execute(input.method, input.inputs);
  if (!values.ok()) throw std::runtime_error("ExecuTorch execution error " + std::to_string(static_cast<int>(values.error())) +
    (values.error() == executorch::runtime::Error::OperatorMissing ? " (OperatorMissing)" : ""));
  json result = {{"firstMs", ms(start)}, {"warmedMs", json::array()}, {"outputs", json::array()}};
  for (int i = 0; i < repeat + stability; ++i) {
    start = Clock::now();
    auto next = module.execute(input.method, input.inputs);
    if (!next.ok()) throw std::runtime_error("Repeat execution error " + std::to_string(static_cast<int>(next.error())));
    if (i < repeat) result["warmedMs"].push_back(ms(start));
  }
  fs::create_directories(output);
  size_t index = 0;
  for (const auto& value : values.get()) {
    if (!value.isTensor()) throw std::runtime_error("Non-tensor output requires an explicit adapter");
    const auto& tensor = value.toTensor();
    std::vector<int64_t> sizes(tensor.sizes().begin(), tensor.sizes().end());
    auto name = "output-" + std::to_string(index++) + ".bin";
    std::ofstream data(output / name, std::ios::binary);
    // Delegates may return channels-last tensors. Serialize logical row-major
    // order, never assume the data pointer matches NumPy's contiguous layout.
    const auto* bytes = reinterpret_cast<const char*>(tensor.const_data_ptr());
    size_t item_size = executorch::runtime::elementSize(tensor.scalar_type());
    for (size_t linear = 0; linear < static_cast<size_t>(tensor.numel()); ++linear) {
      size_t remaining = linear, offset = 0;
      for (size_t axis = sizes.size(); axis-- > 0;) {
        offset += (remaining % sizes[axis]) * tensor.strides()[axis];
        remaining /= sizes[axis];
      }
      data.write(bytes + offset * item_size, item_size);
    }
    if (!data) throw std::runtime_error("Failed to write native output");
    result["outputs"].push_back({{"file", name}, {"dtype", dtype(tensor.scalar_type())}, {"shape", sizes}, {"bytes", tensor.nbytes()}});
  }
  rusage usage{}; getrusage(RUSAGE_SELF, &usage);
  result["peakRssBytes"] = usage.ru_maxrss * 1024;
  result["stabilityRuns"] = stability;
  std::set<std::string> libraries;
  std::ifstream maps("/proc/self/maps");
  std::string mapping;
  while (std::getline(maps, mapping)) {
    auto path = mapping.find('/');
    if (path != std::string::npos && mapping.find(".so", path) != std::string::npos)
      libraries.insert(mapping.substr(path));
  }
  result["loadedSharedLibraries"] = libraries;
  result["peakVramBytes"] = nullptr;
  result["peakVramReason"] = "Delegate does not expose per-process allocation peaks; do not substitute whole-card VRAM usage";
  return result;
}
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--operators") {
      json names = json::array();
      for (const auto& kernel : executorch::runtime::get_registered_kernels()) names.push_back(kernel.name_);
      std::cout << names.dump() << std::endl;
      return 0;
    }
    if (argc < 5) throw std::runtime_error("Usage: runner MODEL.pte CASE.json OUTPUT_DIR REPEATS [STABILITY] [VULKAN_DEVICE_INDEX]");
    int repeat = std::stoi(argv[4]);
    int stability = argc > 5 ? std::stoi(argv[5]) : 0;
    if (repeat < 0 || stability < 0 || repeat > 10000 || stability > 10000) throw std::runtime_error("Invalid repeat count");
    if (argc > 6) setenv("ETVK_DEVICE_INDEX", argv[6], 1);
    executorch::runtime::runtime_init();
#ifdef KOMATOSE_ET_THREADPOOL
    if (auto* pool = executorch::extension::threadpool::get_threadpool()) {
      pool->_unsafe_reset_threadpool(4); // Before inference; exporter also uses4.
    }
#endif
    auto start = Clock::now();
    std::vector<std::string> tensor_data;
    for (const auto& file : fs::directory_iterator(fs::path(argv[1]).parent_path())) {
      if (file.path().extension() == ".ptd") tensor_data.push_back(file.path().string());
    }
    Module module(argv[1], tensor_data, Module::LoadMode::Mmap);
    auto error = module.load();
    if (error != executorch::runtime::Error::Ok) throw std::runtime_error("Model load error " + std::to_string(static_cast<int>(error)));
    double load = ms(start);
    auto input = read_case(argv[2]);
    auto result = execute(module, input, repeat, stability, argv[3]);
    result["loadMs"] = load;
    result["schemaVersion"] = 1;
    // JSON-line requests reuse the loaded module and allow alternating shapes.
    std::cout << result.dump() << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
      auto request = json::parse(line);
      if (request.value("cmd", "run") == "stop") break;
      auto next = read_case(request.at("case").get<std::string>());
      std::cout << execute(module, next, request.value("repeat", 0), request.value("stability", 0), request.at("output").get<std::string>()).dump() << std::endl;
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << json({{"error", error.what()}}).dump() << std::endl;
    return 1;
  }
}
