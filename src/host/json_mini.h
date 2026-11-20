#pragma once
// Minimal string_view-based JSON and HTTP rate-limit header parsing (no allocations).

#include <windows.h>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>

inline std::wstring Utf8ToWString(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring out(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), out.data(), n);
    return out;
}

inline bool EqualsIgnoreCase(std::string_view a, std::string_view b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        unsigned char ca = static_cast<unsigned char>(a[i]);
        unsigned char cb = static_cast<unsigned char>(b[i]);
        if (std::tolower(ca) != std::tolower(cb)) return false;
    }
    return true;
}

inline std::string EscapeJsonString(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (unsigned char c : s) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"':  out += "\\\""; break;
            case '\n': out += "\\n";  break;
            case '\r': break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char hex[8];
                    std::snprintf(hex, sizeof(hex), "\\u%04x", c);
                    out += hex;
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    return out;
}

inline void SkipJsonWs(std::string_view sv, size_t& pos) {
    while (pos < sv.size()) {
        char c = sv[pos];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') ++pos;
        else break;
    }
}

inline bool ParseJsonString(std::string_view sv, size_t& pos, std::string& out) {
    if (pos >= sv.size() || sv[pos] != '"') return false;
    ++pos;
    out.clear();
    while (pos < sv.size()) {
        char c = sv[pos++];
        if (c == '"') return true;
        if (c == '\\') {
            if (pos >= sv.size()) return false;
            char esc = sv[pos++];
            switch (esc) {
                case '"':  out.push_back('"');  break;
                case '\\': out.push_back('\\'); break;
                case '/':  out.push_back('/');  break;
                case 'b':  out.push_back('\b'); break;
                case 'f':  out.push_back('\f'); break;
                case 'n':  out.push_back('\n'); break;
                case 'r':  out.push_back('\r'); break;
                case 't':  out.push_back('\t'); break;
                case 'u': {
                    if (pos + 4 > sv.size()) return false;
                    unsigned int code = 0;
                    for (int k = 0; k < 4; ++k) {
                        char h = sv[pos++];
                        code <<= 4;
                        if (h >= '0' && h <= '9') code |= static_cast<unsigned int>(h - '0');
                        else if (h >= 'a' && h <= 'f') code |= static_cast<unsigned int>(10 + h - 'a');
                        else if (h >= 'A' && h <= 'F') code |= static_cast<unsigned int>(10 + h - 'A');
                    }
                    if (code < 0x80) out.push_back(static_cast<char>(code));
                    else out.push_back('?');
                    break;
                }
                default: out.push_back(esc); break;
            }
        } else {
            out.push_back(c);
        }
    }
    return false;
}

inline bool SkipJsonValue(std::string_view sv, size_t& pos) {
    SkipJsonWs(sv, pos);
    if (pos >= sv.size()) return false;
    char c = sv[pos];
    if (c == '"') {
        ++pos;
        while (pos < sv.size()) {
            char sc = sv[pos++];
            if (sc == '\\') {
                if (pos >= sv.size()) return false;
                ++pos;
            } else if (sc == '"') {
                return true;
            }
        }
        return false;
    }
    if (c == '{' || c == '[') {
        int depth = 0;
        bool inStr = false;
        bool escaped = false;
        while (pos < sv.size()) {
            char ch = sv[pos++];
            if (inStr) {
                if (escaped) escaped = false;
                else if (ch == '\\') escaped = true;
                else if (ch == '"') inStr = false;
            } else {
                if (ch == '"') inStr = true;
                else if (ch == '{' || ch == '[') ++depth;
                else if (ch == '}' || ch == ']') {
                    --depth;
                    if (depth == 0) return true;
                }
            }
        }
        return false;
    }
    while (pos < sv.size()) {
        char ch = sv[pos];
        if (ch == ',' || ch == '}' || ch == ']' || ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') break;
        ++pos;
    }
    return true;
}

template <typename Fn>
inline void ForEachJsonObjectField(std::string_view obj, Fn&& fn) {
    size_t pos = 0;
    SkipJsonWs(obj, pos);
    if (pos >= obj.size() || obj[pos] != '{') return;
    ++pos;

    while (pos < obj.size()) {
        SkipJsonWs(obj, pos);
        if (pos >= obj.size() || obj[pos] == '}') break;
        if (obj[pos] == ',') { ++pos; continue; }
        std::string key;
        if (!ParseJsonString(obj, pos, key)) break;
        SkipJsonWs(obj, pos);
        if (pos >= obj.size() || obj[pos] != ':') break;
        ++pos;
        SkipJsonWs(obj, pos);
        size_t valStart = pos;
        if (!SkipJsonValue(obj, pos)) break;
        std::string_view valRaw = obj.substr(valStart, pos - valStart);
        if (!fn(key, valRaw)) break;
    }
}

inline std::optional<std::string_view> JsonGetRaw(std::string_view obj, std::string_view targetKey, bool caseInsensitive = false) {
    std::optional<std::string_view> found;
    ForEachJsonObjectField(obj, [&](const std::string& key, std::string_view valRaw) -> bool {
        bool match = caseInsensitive ? EqualsIgnoreCase(key, targetKey) : (key == targetKey);
        if (match) {
            found = valRaw;
            return false;
        }
        return true;
    });
    return found;
}

inline std::optional<std::string> JsonUnquote(std::string_view raw) {
    size_t pos = 0;
    SkipJsonWs(raw, pos);
    if (pos >= raw.size() || raw[pos] != '"') return std::nullopt;
    std::string out;
    if (!ParseJsonString(raw, pos, out)) return std::nullopt;
    return out;
}

inline std::optional<std::string> JsonGetString(std::string_view obj, std::string_view targetKey, bool caseInsensitive = false) {
    auto raw = JsonGetRaw(obj, targetKey, caseInsensitive);
    if (!raw) return std::nullopt;
    return JsonUnquote(*raw);
}

inline std::optional<int> ParseJsonIntValue(std::string_view raw) {
    std::string buf;
    if (!raw.empty() && raw.front() == '"') {
        auto s = JsonUnquote(raw);
        if (!s || s->empty()) return std::nullopt;
        buf = std::move(*s);
    } else {
        buf.assign(raw.begin(), raw.end());
    }
    char* endPtr = nullptr;
    long long v = std::strtoll(buf.c_str(), &endPtr, 10);
    if (endPtr == buf.c_str()) return std::nullopt;
    return static_cast<int>(v);
}

inline std::optional<double> ParseJsonDoubleValue(std::string_view raw) {
    std::string buf;
    if (!raw.empty() && raw.front() == '"') {
        auto s = JsonUnquote(raw);
        if (!s || s->empty()) return std::nullopt;
        buf = std::move(*s);
    } else {
        buf.assign(raw.begin(), raw.end());
    }
    char* endPtr = nullptr;
    double v = std::strtod(buf.c_str(), &endPtr);
    if (endPtr == buf.c_str() || !std::isfinite(v)) return std::nullopt;
    return v;
}

inline std::optional<int> JsonGetInt(std::string_view obj, std::string_view targetKey, bool caseInsensitive = false) {
    auto raw = JsonGetRaw(obj, targetKey, caseInsensitive);
    if (!raw) return std::nullopt;
    return ParseJsonIntValue(*raw);
}

struct RateLimitHeaders {
    std::optional<int> limit;
    std::optional<int> remaining;
    std::optional<long long> resetAfterMs;
    std::optional<long long> retryAfterMs;
    std::optional<std::string> bucket;

    bool HasAny() const {
        return limit.has_value() || remaining.has_value() ||
               resetAfterMs.has_value() || retryAfterMs.has_value();
    }
};

inline RateLimitHeaders ParseRateLimitHeaders(std::string_view headersObj) {
    RateLimitHeaders out;
    ForEachJsonObjectField(headersObj, [&](const std::string& key, std::string_view valRaw) -> bool {
        if (EqualsIgnoreCase(key, "x-ratelimit-limit")) {
            out.limit = ParseJsonIntValue(valRaw);
        } else if (EqualsIgnoreCase(key, "x-ratelimit-remaining")) {
            out.remaining = ParseJsonIntValue(valRaw);
        } else if (EqualsIgnoreCase(key, "x-ratelimit-reset-after")) {
            auto sec = ParseJsonDoubleValue(valRaw);
            if (sec && *sec >= 0.0) {
                out.resetAfterMs = static_cast<long long>(std::llround(*sec * 1000.0));
            }
        } else if (EqualsIgnoreCase(key, "retry-after")) {
            auto sec = ParseJsonDoubleValue(valRaw);
            if (sec && *sec >= 0.0) {
                out.retryAfterMs = static_cast<long long>(std::llround(*sec * 1000.0));
            }
        } else if (EqualsIgnoreCase(key, "x-ratelimit-bucket")) {
            out.bucket = JsonUnquote(valRaw);
        }
        return true;
    });
    return out;
}
