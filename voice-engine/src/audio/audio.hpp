#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
namespace nv {
class Playback {
public:
    Playback(double preroll_seconds=1, double max_seconds=30);
    ~Playback();
    bool open(std::string& error);
    bool push(const float*,std::size_t,const std::function<bool()>& cancelled);
    void pause(bool);
    void finish();
    bool drain(const std::function<bool()>& cancelled);
    void clear();
    std::size_t underruns() const;
    std::uint64_t consumed() const;
    bool buffering() const;
    // Device callback entry point; also permits a deterministic, device-free
    // audio clock in tests. Outputs silence while paused or awaiting preroll.
    void render(float*, std::size_t);
private:
    struct Impl; std::unique_ptr<Impl> impl_;
};
class WavWriter {
public:
    explicit WavWriter(const std::string& path);
    ~WavWriter();
    void append(const float*,std::size_t);
    void complete();
private:
    struct Impl; std::unique_ptr<Impl> impl_;
};
class Cache {
public:
    Cache(std::string directory,std::uint64_t max_bytes=512ULL*1024*1024);
    static std::string key(const std::vector<std::string>& fields);
    bool read(const std::string& key,std::vector<float>& samples);
    void store(const std::string& key,const std::vector<float>& samples);
private:
    std::string directory_; std::uint64_t max_bytes_;
};
}
