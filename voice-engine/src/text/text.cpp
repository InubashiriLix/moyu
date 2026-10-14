#include "text.hpp"
#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include <stdexcept>
namespace nv {
namespace {

// Return byte length of a valid code point at i, or 0 for invalid / truncated /
// overlong / surrogate input. Validates as it walks.
int utf8_decode(const std::string& s, std::size_t i, std::uint32_t& cp) {
    const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
    unsigned char c = p[i];
    if (c < 0x80) { cp = c; return 1; }
    if (c >= 0xC2 && c <= 0xDF) {
        if (i + 1 >= s.size() || (p[i + 1] & 0xC0) != 0x80) return 0;
        cp = ((c & 0x1F) << 6) | (p[i + 1] & 0x3F); return 2;
    }
    if (c >= 0xE0 && c <= 0xEF) {
        if (i + 2 >= s.size() || (p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80) return 0;
        std::uint32_t v = ((c & 0x0F) << 12) | ((p[i + 1] & 0x3F) << 6) | (p[i + 2] & 0x3F);
        if (v < 0x800 || (v >= 0xD800 && v <= 0xDFFF)) return 0;
        cp = v; return 3;
    }
    if (c >= 0xF0 && c <= 0xF4) {
        if (i + 3 >= s.size() || (p[i + 1] & 0xC0) != 0x80 || (p[i + 2] & 0xC0) != 0x80 || (p[i + 3] & 0xC0) != 0x80) return 0;
        std::uint32_t v = ((c & 0x07) << 18) | ((p[i + 1] & 0x3F) << 12) | ((p[i + 2] & 0x3F) << 6) | (p[i + 3] & 0x3F);
        if (v < 0x10000 || v > 0x10FFFF) return 0;
        cp = v; return 4;
    }
    return 0;
}

bool valid_utf8(const std::string& s) {
    for (std::size_t i = 0; i < s.size();) { std::uint32_t cp; int n = utf8_decode(s, i, cp); if (!n) return false; i += std::size_t(n); }
    return true;
}

bool is_space(std::uint32_t cp) { return cp == ' ' || cp == '\t' || cp == '\n' || cp == '\r' || cp == '\v' || cp == '\f' || cp == 0x3000; }

bool is_sentence_end(std::uint32_t cp) {
    switch (cp) {
        case 0x3002: case 0xFF01: case 0xFF1F: case 0xFF1B: case 0x2026:
        case '!': case '?': case '.': case ';': return true;
        default: return false;
    }
}

bool is_closing(std::uint32_t cp) {
    switch (cp) {
        case 0x201D: case 0x2019: case 0x300D: case 0x300F: case 0x3009: case 0x300B: case ')': case ']': return true;
        default: return false;
    }
}

int quote_dir(std::uint32_t cp) {
    switch (cp) {
        case 0x201C: case 0x300C: case 0x300E: case 0x2018: case '(': case '[': return 1;
        case 0x201D: case 0x300D: case 0x300F: case 0x2019: case ')': case ']': return -1;
        default: return 0;
    }
}

std::uint32_t last_significant(const std::string& s) {
    std::uint32_t last = 0;
    for (std::size_t i = 0; i < s.size();) { std::uint32_t cp; int n = utf8_decode(s, i, cp); if (n <= 0) break; if (!is_space(cp)) last = cp; i += std::size_t(n); }
    return last;
}

std::string window_tail(const std::string& s, std::size_t k) {
    std::vector<std::size_t> off; std::size_t i = 0;
    while (i < s.size()) { std::uint32_t cp; int n = utf8_decode(s, i, cp); off.push_back(i); i += std::size_t(n > 0 ? n : 1); }
    off.push_back(i);
    std::size_t m = off.size() - 1;
    return s.substr(m > k ? off[m - k] : 0);
}

std::string window_head(const std::string& s, std::size_t k) {
    std::size_t i = 0, c = 0;
    while (i < s.size() && c < k) { std::uint32_t cp; int n = utf8_decode(s, i, cp); i += std::size_t(n > 0 ? n : 1); ++c; }
    return s.substr(0, i);
}

// Emotion keyword groups: angry, sad, whisper, tense, happy.
const std::vector<std::string>& cue(int idx) {
    static const std::vector<std::vector<std::string>> cues = {
        {"愤怒", "怒吼", "咆哮", "厉声", "咬牙", "气愤"},
        {"悲伤", "伤心", "抽泣", "哽咽", "忧伤"},
        {"低声", "轻声", "悄声", "低语", "喃喃", "嘀咕", "嘟囔", "耳语", "细语"},
        {"紧张", "屏息", "屏住", "紧绷", "焦虑", "不安", "哆嗦"},
        {"高兴", "开心", "愉快", "兴奋", "雀跃"},
    };
    return cues[std::size_t(idx)];
}

int hits(const std::string& s, const std::vector<std::string>& w) {
    int c = 0;
    for (const std::string& x : w) for (std::size_t p = 0; (p = s.find(x, p)) != std::string::npos; p += x.size()) ++c;
    return c;
}

int pick(const std::string& s) {
    int best = 0, bi = -1;
    for (int k = 0; k < 5; ++k) { int c = hits(s, cue(k)); if (c > best) { best = c; bi = k; } }
    return bi;
}

bool is_dialogue(const std::string& s) {
    static const char* m[] = {"\u201C", "\u201D", "\u300C", "\u300D", "\u300E", "\u300F", "\"", "说道", "问道", "喊道", "答道", "说着"};
    for (const char* x : m) if (s.find(x) != std::string::npos) return true;
    return false;
}

// Neutral default; explicit override wins; automatic=false stays neutral.
// Nearby (windowed) context may inform emotion but is never echoed to output.
void classify(const std::string& text, const TextOptions& o, std::string& instruction, std::string& emotion) {
    emotion = "calm"; instruction = "平静地说";
    if (!o.instruction_override.empty()) { instruction = o.instruction_override; return; }
    if (!o.automatic) return;
    int idx = pick(text);
    if (idx < 0 && is_dialogue(text)) idx = pick(window_tail(o.preceding_context, 24) + window_head(o.following_context, 24));
    if (idx >= 0) {
        static const char* emo[5] = {"angry", "sad", "whisper", "tense", "happy"};
        static const char* ins[5] = {"愤怒地说", "悲伤地说", "低声地说", "紧张地说", "开心地说"};
        emotion = emo[idx]; instruction = ins[idx]; return;
    }
    std::uint32_t last = last_significant(text);  // ? / ! give only a mild tone shift
    if (last == 0xFF1F || last == '?') instruction = "平静地询问";
    else if (last == 0xFF01 || last == '!') instruction = "平静地强调";
}

void build_paragraph(const std::string& text, std::size_t ps, std::size_t pe, std::size_t target,
                     std::size_t maxc, const TextOptions& o, std::vector<Segment>& out) {
    std::vector<std::uint32_t> cps; std::vector<std::size_t> off; std::size_t i = ps;
    while (i < pe) { std::uint32_t cp; int n = utf8_decode(text, i, cp); off.push_back(i); cps.push_back(cp); i += std::size_t(n > 0 ? n : 1); }
    off.push_back(pe);
    std::size_t n = cps.size();
    std::vector<int> depth(n + 1, 0); int d = 0;
    for (std::size_t k = 0; k < n; ++k) {
        depth[k] = d;
        int q = quote_dir(cps[k]);
        if (q > 0) ++d; else if (q < 0 && d > 0) --d;
    }
    depth[n] = d;
    auto valid_break = [&](std::size_t a, std::size_t j) {  // quote-safe, punctuation-preferred
        if (j > n || depth[j] != 0 || j <= a) return false;
        if (j == n) return true;
        if (is_sentence_end(cps[j - 1])) return true;
        return j >= a + 2 && is_closing(cps[j - 1]) && is_sentence_end(cps[j - 2]);
    };
    std::size_t a = 0;
    while (a < n) {
        std::size_t tj = std::min(a + target, n), hj = std::min(a + maxc, n), chosen = 0;
        for (std::size_t j = std::min(std::max(a + 1, tj), hj); j <= hj; ++j) if (valid_break(a, j)) { chosen = j; break; }
        if (!chosen) for (std::size_t j = tj; j > a; --j) if (valid_break(a, j)) { chosen = j; break; }
        if (!chosen) chosen = hj;  // hard bound on an unpunctuated run
        if (chosen <= a) chosen = std::min(a + 1, n);
        std::size_t t0 = a, t1 = chosen;  // trim boundary whitespace only
        while (t0 < t1 && is_space(cps[t0])) ++t0;
        while (t1 > t0 && is_space(cps[t1 - 1])) --t1;
        if (t1 > t0) {
            Segment seg;
            seg.byte_begin = off[t0]; seg.byte_end = off[t1];
            seg.text = text.substr(seg.byte_begin, seg.byte_end - seg.byte_begin);
            TextOptions nearby=o;
            if(t0) nearby.preceding_context=text.substr(off[t0>24?t0-24:0],off[t0]-off[t0>24?t0-24:0]);
            if(t1<n) nearby.following_context=text.substr(off[t1],off[std::min(t1+24,n)]-off[t1]);
            classify(seg.text, nearby, seg.instruction, seg.emotion);
            out.push_back(std::move(seg));
        }
        a = chosen;
    }
}

}  // namespace

std::vector<Segment> segment_text(const std::string& text, const TextOptions& options) {
    std::vector<Segment> out;
    if (!valid_utf8(text)) throw std::invalid_argument("text is not valid UTF-8");
    std::size_t target = options.target_chars ? options.target_chars : 1;
    std::size_t maxc = options.max_chars ? options.max_chars : target;
    if (maxc < target) maxc = target;
    std::size_t i = 0, n = text.size();
    while (i < n) {  // paragraphs split on newlines, never merged across them
        while (i < n && (text[i] == '\n' || text[i] == '\r')) ++i;
        std::size_t ps = i;
        while (i < n && text[i] != '\n' && text[i] != '\r') ++i;
        if (i != ps) build_paragraph(text, ps, i, target, maxc, options, out);
    }
    return out;
}

}  // namespace nv
