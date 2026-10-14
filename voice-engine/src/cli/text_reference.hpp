#pragma once
#include <cstddef>
#include <string>
#include <vector>
namespace nv {
struct Segment { std::size_t byte_begin=0, byte_end=0; std::string text, instruction, emotion; };
struct TextOptions {
    std::size_t target_chars=80, max_chars=120;
    bool automatic=true;
    std::string instruction_override, preceding_context, following_context;
};
std::vector<Segment> segment_text(const std::string& text, const TextOptions& options = {});
}
