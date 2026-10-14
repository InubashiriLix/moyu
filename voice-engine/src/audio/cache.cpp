// cache.cpp -- SHA256-keyed float32 sample cache.
//
// File format (little-endian): magic 'N','V','A','C' + uint32 version + uint32
// sample_count + sample_count * float32.  Writes go to a unique temporary in
// the cache directory and are atomically renamed into place.  Best-effort: any
// failure simply yields a cache miss.  Exceptions from filesystem / allocation
// are caught and swallowed (documented best-effort behaviour).
#include "audio.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include <openssl/evp.h>
#include <unistd.h>  // getpid

namespace nv {
namespace {
namespace fs = std::filesystem;

constexpr char kMagic[4] = {'N', 'V', 'A', 'C'};
constexpr std::uint32_t kVersion = 1;
constexpr char kExt[] = ".nvac";
constexpr std::size_t kSampleRate = 24000;
constexpr std::size_t kMaxSeconds = 60;  // data bounded to <= 60s
constexpr std::size_t kMaxSamples = kSampleRate * kMaxSeconds;
constexpr std::size_t kHeaderBytes = 12;  // magic(4) + version(4) + count(4)

std::string to_hex(const unsigned char* d, std::size_t n) {
    static const char* h = "0123456789abcdef";
    std::string s(n * 2, '0');
    for (std::size_t i = 0; i < n; ++i) {
        s[i * 2] = h[d[i] >> 4];
        s[i * 2 + 1] = h[d[i] & 0xF];
    }
    return s;
}

std::string unique_temp_name(const std::string& key) {
    static std::atomic<std::uint64_t> counter{0};
    std::uint64_t nonce = counter.fetch_add(1, std::memory_order_relaxed);
    std::ostringstream oss;
    oss << key << ".tmp."
        << static_cast<unsigned long long>(::getpid()) << "."
        << std::hash<std::thread::id>{}(std::this_thread::get_id()) << "."
        << nonce;
    return oss.str();
}

// LRU prune by last_write_time. Only touches *.nvac files inside `directory`.
void prune_cache(const std::string& directory, std::uint64_t max_bytes) {
    try {
        std::error_code ec;
        struct Entry { fs::path path; std::uintmax_t size; fs::file_time_type t; };
        std::vector<Entry> entries;
        std::uintmax_t total = 0;
        for (auto it = fs::directory_iterator(directory, ec);
             !ec && it != fs::directory_iterator(); it.increment(ec)) {
            const fs::path& p = it->path();
            if (p.extension() != kExt) continue;  // only own cache files
            std::error_code ec2;
            if (!it->is_regular_file(ec2) || ec2) continue;
            auto sz = it->file_size(ec2);
            if (ec2) continue;
            auto ft = fs::last_write_time(p, ec2);
            if (ec2) continue;
            entries.push_back({p, sz, ft});
            total += sz;
        }
        if (total <= max_bytes) return;
        std::sort(entries.begin(), entries.end(),
                  [](const Entry& a, const Entry& b) { return a.t < b.t; });
        for (const auto& e : entries) {
            if (total <= max_bytes) break;
            std::error_code rmc;
            fs::remove(e.path, rmc);
            if (!rmc) total -= std::min<std::uintmax_t>(total, e.size);
        }
    } catch (...) {
    }
}
}  // namespace

std::string Cache::key(const std::vector<std::string>& fields) {
    std::vector<unsigned char> buf;
    buf.reserve(64);
    for (const auto& f : fields) {
        // Length-prefixed so ["ab","c"] and ["a","bc"] differ.
        std::uint64_t len = f.size();
        for (int i = 0; i < 8; ++i) buf.push_back(static_cast<unsigned char>(len >> (i * 8)));
        buf.insert(buf.end(), f.begin(), f.end());
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int dlen = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return std::string();
    std::string out;
    if (EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) == 1 &&
        EVP_DigestUpdate(ctx, buf.data(), buf.size()) == 1 &&
        EVP_DigestFinal_ex(ctx, digest, &dlen) == 1) {
        out = to_hex(digest, dlen);
    }
    EVP_MD_CTX_free(ctx);
    return out;
}

Cache::Cache(std::string directory, std::uint64_t max_bytes)
    : directory_(std::move(directory)), max_bytes_(max_bytes) {}

bool Cache::read(const std::string& key, std::vector<float>& samples) {
    const std::string path = (fs::path(directory_) / (key + kExt)).string();
    std::error_code ec;
    std::uintmax_t sz = fs::file_size(path, ec);
    if (ec) return false;
    if (sz < kHeaderBytes) return false;
    std::uintmax_t payload = sz - kHeaderBytes;
    if (payload % sizeof(float) != 0) return false;

    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    unsigned char hdr[kHeaderBytes];
    in.read(reinterpret_cast<char*>(hdr), kHeaderBytes);
    if (!in || std::memcmp(hdr, kMagic, 4) != 0) return false;
    std::uint32_t ver, cnt;
    std::memcpy(&ver, hdr + 4, 4);
    std::memcpy(&cnt, hdr + 8, 4);
    if (ver != kVersion) return false;
    if (static_cast<std::uintmax_t>(cnt) * sizeof(float) != payload) return false;
    if (cnt > kMaxSamples) return false;  // bounded to <= 60s
    std::vector<float> tmp(cnt);
    if (cnt) {
        in.read(reinterpret_cast<char*>(tmp.data()), static_cast<std::streamsize>(payload));
        if (!in) return false;
    }
    for (float v : tmp) {
        if (!std::isfinite(v)) return false;  // reject corrupt / NaN data
    }
    samples = std::move(tmp);
    fs::last_write_time(path, fs::file_time_type::clock::now(), ec);
    return true;
}

void Cache::store(const std::string& key, const std::vector<float>& samples) {
    if (samples.size() > kMaxSamples) return;  // refuse > 60s
    for (float v : samples) {
        if (!std::isfinite(v)) return;  // never persist non-finite data
    }
    try {
        std::error_code ec;
        fs::create_directories(directory_, ec);
        if (ec) return;
        const fs::path dir(directory_);
        const fs::path final = dir / (key + kExt);
        const fs::path tmp = dir / unique_temp_name(key);
        {
            std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
            if (!out) return;
            unsigned char hdr[kHeaderBytes];
            std::memcpy(hdr, kMagic, 4);
            std::uint32_t ver = kVersion, cnt = static_cast<std::uint32_t>(samples.size());
            std::memcpy(hdr + 4, &ver, 4);
            std::memcpy(hdr + 8, &cnt, 4);
            out.write(reinterpret_cast<const char*>(hdr), kHeaderBytes);
            if (!samples.empty())
                out.write(reinterpret_cast<const char*>(samples.data()),
                          static_cast<std::streamsize>(samples.size() * sizeof(float)));
            out.flush();
            if (!out) {
                std::error_code rmc;
                fs::remove(tmp, rmc);
                return;
            }
        }
        fs::rename(tmp, final, ec);  // atomic replace
        if (ec) {
            std::error_code rmc;
            fs::remove(tmp, rmc);
            return;
        }
        prune_cache(directory_, max_bytes_);
    } catch (...) {
        // Best-effort: cache failures are silently ignored (returns as a miss).
    }
}

}  // namespace nv
