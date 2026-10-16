// audio_test.cpp -- backend-independent tests (no audio device required).
//
// Exercises WavWriter header/atomic-rename semantics and Cache key/format
// validation. Does NOT open an ALSA/Pulse device.
#include "audio.hpp"
#include <unistd.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace nv;

static int g_failures = 0;
#define CHECK(cond)                                                       \
    do {                                                                  \
        if (!(cond)) {                                                    \
            std::cerr << "FAIL " << __LINE__ << ": " #cond << "\n";       \
            ++g_failures;                                                 \
        }                                                                 \
    } while (0)

static std::uint32_t rd32(const unsigned char* d) {
    return d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24);
}
static std::uint16_t rd16(const unsigned char* d) {
    return static_cast<std::uint16_t>(d[0] | (d[1] << 8));
}

static fs::path make_tmpdir(const std::string& tag) {
    fs::path p = fs::temp_directory_path() / ("nv_audio_test_" + tag + "_" +
                   std::to_string(::getpid()));
    fs::remove_all(p);
    fs::create_directories(p);
    return p;
}

static void test_wav_roundtrip(const fs::path& dir) {
    const fs::path out = dir / "a.wav";
    std::vector<float> samples(1000);
    for (std::size_t i = 0; i < samples.size(); ++i)
        samples[i] = 0.5f * std::sin(0.05f * static_cast<float>(i));
    {
        WavWriter w(out.string());
        w.append(samples.data(), samples.size());
        CHECK(fs::exists(out.string() + ".partial"));  // not yet final
        CHECK(!fs::exists(out));
        w.complete();
    }
    CHECK(fs::exists(out));
    CHECK(!fs::exists(out.string() + ".partial"));

    std::vector<unsigned char> buf(44);
    std::ifstream in(out, std::ios::binary);
    in.read(reinterpret_cast<char*>(buf.data()), 44);
    CHECK(std::memcmp(buf.data(), "RIFF", 4) == 0);
    CHECK(std::memcmp(buf.data() + 8, "WAVE", 4) == 0);
    CHECK(std::memcmp(buf.data() + 12, "fmt ", 4) == 0);
    CHECK(rd32(&buf[16]) == 16);          // fmt chunk size
    CHECK(rd16(&buf[20]) == 1);           // PCM
    CHECK(rd16(&buf[22]) == 1);           // mono
    CHECK(rd32(&buf[24]) == 24000);       // sample rate
    CHECK(rd32(&buf[28]) == 48000);       // byte rate
    CHECK(rd16(&buf[32]) == 2);           // block align
    CHECK(rd16(&buf[34]) == 16);          // bits
    CHECK(std::memcmp(buf.data() + 36, "data", 4) == 0);
    const std::uint32_t data_bytes = static_cast<std::uint32_t>(samples.size() * 2);
    CHECK(rd32(&buf[40]) == data_bytes);          // data size
    CHECK(rd32(&buf[4]) == 36 + data_bytes);      // RIFF size
    CHECK(fs::file_size(out) == 44 + data_bytes);
}

static void test_wav_incomplete(const fs::path& dir) {
    const fs::path out = dir / "b.wav";
    float s = 0.1f;
    {
        WavWriter w(out.string());
        w.append(&s, 1);
        // no complete(): destructor must retain .partial and not finalize
    }
    CHECK(!fs::exists(out));
    CHECK(fs::exists(out.string() + ".partial"));
}

static void test_wav_rejects(const fs::path& dir) {
    const fs::path out = dir / "c.wav";
    WavWriter w(out.string());
    float nan_v = std::nanf("");
    bool threw = false;
    try { w.append(&nan_v, 1); } catch (const std::exception&) { threw = true; }
    CHECK(threw);  // NaN rejected
}

static void test_cache_key() {
    const std::string a = Cache::key({"ab", "c"});
    const std::string b = Cache::key({"a", "bc"});
    CHECK(!a.empty());
    CHECK(a.size() == 64);         // sha256 hex
    CHECK(a != b);                 // length-prefixing matters
    CHECK(a == Cache::key({"ab", "c"}));  // deterministic
    CHECK(!Cache::key({}).empty());
    CHECK(Cache::key({""}) != Cache::key({}));  // empty field distinct from none
}

static void test_cache_roundtrip(const fs::path& dir) {
    Cache c((dir / "cache").string(), 512ull * 1024 * 1024);
    const std::string k = Cache::key({"hello", "world"});
    std::vector<float> in(500);
    for (std::size_t i = 0; i < in.size(); ++i) in[i] = 0.25f * static_cast<float>(i);
    c.store(k, in);
    std::vector<float> out;
    CHECK(c.read(k, out));
    CHECK(out == in);

    std::vector<float> miss;
    CHECK(!c.read(Cache::key({"missing"}), miss));
}

static void test_cache_corrupt(const fs::path& dir) {
    const fs::path cd = dir / "cache2";
    Cache c(cd.string(), 512ull * 1024 * 1024);
    const std::string k = Cache::key({"corrupt"});
    std::vector<float> in(10, 0.5f);
    c.store(k, in);
    std::vector<float> out;
    CHECK(c.read(k, out));

    const fs::path f = cd / (k + ".nvac");
    // Bad magic.
    {
        std::vector<unsigned char> data;
        { std::ifstream i(f, std::ios::binary);
          data.assign(std::istreambuf_iterator<char>(i), std::istreambuf_iterator<char>()); }
        data[0] = 'X';
        { std::ofstream o(f, std::ios::binary | std::ios::trunc);
          o.write(reinterpret_cast<char*>(data.data()), data.size()); }
        CHECK(!c.read(k, out));
    }
    // Truncated to bad size.
    c.store(k, in);
    { std::error_code ec; fs::resize_file(f, 13, ec); }
    CHECK(!c.read(k, out));
    // Over-large count field (bounds).
    c.store(k, in);
    {
        std::vector<unsigned char> data;
        { std::ifstream i(f, std::ios::binary);
          data.assign(std::istreambuf_iterator<char>(i), std::istreambuf_iterator<char>()); }
        std::uint32_t big = 100000000u;
        std::memcpy(data.data() + 8, &big, 4);
        std::ofstream o(f, std::ios::binary | std::ios::trunc);
        o.write(reinterpret_cast<char*>(data.data()), data.size());
        CHECK(!c.read(k, out));
    }
    // Non-finite payload rejected on store.
    c.store(Cache::key({"nan"}),
            std::vector<float>{std::nanf("")});
    std::vector<float> nanout;
    CHECK(!c.read(Cache::key({"nan"}), nanout));
}

static void test_playback_recovery() {
    Playback playback(1, 4);
    std::vector<float> samples(96000, .25f), out(24000);
    auto push = [&](std::size_t n) { CHECK(playback.push(samples.data(), n, {})); };
    auto render = [&](std::size_t n) { playback.render(out.data(), n); };
    push(24000);
    render(24000);
    CHECK(playback.consumed() == 24000);
    render(240); // producer stalled: enter rebuffering
    CHECK(playback.buffering());
    push(2400); // a late decoder fragment must remain inaudible
    render(2400);
    CHECK(playback.consumed() == 24000);
    CHECK(out[0] == 0);
    push(24000);
    render(2400); // one second is still too little after starvation
    CHECK(playback.consumed() == 24000);
    push(21600); // two seconds accumulated: recover continuously
    CHECK(!playback.buffering());
    render(24000);
    CHECK(out[0] == .25f);
    CHECK(playback.consumed() == 48000);
    playback.pause(true);
    render(24000);
    CHECK(playback.consumed() == 48000);
    CHECK(!playback.buffering());
    playback.pause(false);
    render(24000);
    CHECK(playback.consumed() == 72000);
    render(240);
    push(2400);
    playback.finish(); // EOF flushes a tail shorter than the recovery threshold
    CHECK(!playback.buffering());
    render(2400);
    CHECK(playback.consumed() == 74400);
    CHECK(playback.drain({}));
    CHECK(playback.underruns() == 5280);
    playback.clear();
    CHECK(playback.consumed() == 0);
    CHECK(playback.underruns() == 0);
    push(24000); // a new request resets the enlarged recovery threshold
    CHECK(!playback.buffering());
    render(24000);
    CHECK(playback.consumed() == 24000);
    CHECK(!playback.push(samples.data(), 1, [] { return true; }));
}

int main() {
    fs::path dir = make_tmpdir("run");
    test_wav_roundtrip(dir);
    test_wav_incomplete(dir);
    test_wav_rejects(dir);
    test_cache_key();
    test_cache_roundtrip(dir);
    test_cache_corrupt(dir);
    test_playback_recovery();
    fs::remove_all(dir);
    if (g_failures) {
        std::cerr << g_failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "audio_test: all checks passed\n";
    return 0;
}
