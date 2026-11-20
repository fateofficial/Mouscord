#pragma once
// WinHTTP WebSocket CDP client; also sniffs rate-limit headers and handles native binding RPC.

#include <windows.h>
#include <winhttp.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

#include "json_mini.h"

inline bool ReadNextWsMessage(HINTERNET hWs, std::string& outMsg) {
    outMsg.clear();
    std::vector<char> buf(65536);
    constexpr size_t kMaxMsgBytes = 2 * 1024 * 1024;
    for (;;) {
        DWORD bytesRead = 0;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE bufType = WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE;
        DWORD err = WinHttpWebSocketReceive(
            hWs,
            buf.data(),
            static_cast<DWORD>(buf.size()),
            &bytesRead,
            &bufType
        );
        if (err != NO_ERROR || bufType == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
            return false;
        }
        if (bytesRead > 0 && outMsg.size() < kMaxMsgBytes) {
            size_t take = std::min(static_cast<size_t>(bytesRead), kMaxMsgBytes - outMsg.size());
            outMsg.append(buf.data(), take);
        }
        if (bufType == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE ||
            bufType == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
            return true;
        }
    }
}

struct TrackedDeleteReq {
    std::string requestId;
    std::string method;
    std::string url;
    bool forwardedHeaders = false;
};

class CdpConnection {
public:
    using BindingCallback = std::function<void(const std::string& payload)>;

    explicit CdpConnection(HINTERNET ws, BindingCallback onBinding = nullptr)
        : hWs_(ws), onBinding_(std::move(onBinding)) {}

    ~CdpConnection() {
        Close();
    }

    CdpConnection(const CdpConnection&) = delete;
    CdpConnection& operator=(const CdpConnection&) = delete;

    void Start() {
        readerThread_ = std::thread([this]() { ReaderLoop(); });
    }

    bool IsAlive() const {
        return alive_.load();
    }

    bool EnableNativeBinding(const std::string& bindingName = "__dcNativeHost") {
        return SendCommand("Runtime.addBinding", "{\"name\":\"" + EscapeJsonString(bindingName) + "\"}");
    }

    bool SendCommand(const std::string& method, const std::string& paramsJson,
                     std::string* outResp = nullptr, int timeoutMs = 5000) {
        if (!alive_.load()) return false;

        const int id = nextReqId_.fetch_add(1);
        auto slot = std::make_shared<WaitSlot>();
        {
            std::lock_guard<std::mutex> lk(waitMtx_);
            waiters_[id] = slot;
        }

        std::string payload;
        payload.reserve(method.size() + paramsJson.size() + 48);
        payload += "{\"id\":";
        payload += std::to_string(id);
        payload += ",\"method\":\"";
        payload += method;
        payload += "\"";
        if (!paramsJson.empty()) {
            payload += ",\"params\":";
            payload += paramsJson;
        }
        payload += "}";

        if (!SendRaw(payload)) {
            std::lock_guard<std::mutex> lk(waitMtx_);
            waiters_.erase(id);
            return false;
        }

        std::unique_lock<std::mutex> lk(waitMtx_);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        waitCv_.wait_until(lk, deadline, [&]() {
            return slot->ready || !alive_.load();
        });
        waiters_.erase(id);

        if (!slot->ready) return false;
        if (outResp) *outResp = std::move(slot->response);
        return true;
    }

    bool Eval(const std::string& expr, std::string* outResp = nullptr, int timeoutMs = 5000) {
        std::string params;
        params.reserve(expr.size() + 64);
        params += "{\"expression\":\"";
        params += EscapeJsonString(expr);
        params += "\",\"returnByValue\":true}";
        return SendCommand("Runtime.evaluate", params, outResp, timeoutMs);
    }

    bool EvalFireAndForget(const std::string& expr) {
        if (!alive_.load()) return false;
        const int id = nextReqId_.fetch_add(1);
        std::string payload;
        payload.reserve(expr.size() + 128);
        payload += "{\"id\":";
        payload += std::to_string(id);
        payload += ",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"";
        payload += EscapeJsonString(expr);
        payload += "\",\"returnByValue\":false}}";
        return SendRaw(payload);
    }

    void Close() {
        if (closed_.exchange(true)) return;
        alive_.store(false);
        waitCv_.notify_all();
        if (hWs_) {
            {
                std::lock_guard<std::mutex> lk(sendMtx_);
                WinHttpWebSocketShutdown(hWs_, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
            }
            if (readerThread_.joinable()) {
                readerThread_.join();
            }
            WinHttpCloseHandle(hWs_);
            hWs_ = nullptr;
        } else if (readerThread_.joinable()) {
            readerThread_.join();
        }
    }

private:
    struct WaitSlot {
        bool ready = false;
        std::string response;
    };

    bool SendRaw(const std::string& payload) {
        std::lock_guard<std::mutex> lk(sendMtx_);
        if (!hWs_ || !alive_.load()) return false;
        DWORD err = WinHttpWebSocketSend(
            hWs_,
            WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
            const_cast<char*>(payload.data()),
            static_cast<DWORD>(payload.size())
        );
        return err == NO_ERROR;
    }

    TrackedDeleteReq* FindTracked(std::string_view requestId) {
        for (auto& item : trackedDeleteReqs_) {
            if (item.requestId == requestId) return &item;
        }
        return nullptr;
    }

    void TrackRequest(const std::string& requestId, const std::string& method, const std::string& url) {
        if (auto* existing = FindTracked(requestId)) {
            existing->method = method;
            existing->url = url;
            return;
        }
        constexpr size_t kMaxTracked = 64;
        while (trackedDeleteReqs_.size() >= kMaxTracked) {
            trackedDeleteReqs_.pop_front();
        }
        trackedDeleteReqs_.push_back(TrackedDeleteReq{requestId, method, url, false});
    }

    void ForwardRateLimit(int status, const RateLimitHeaders& h) {
        std::string js;
        js.reserve(256);
        js += "if(window.__dcDeleteEngine&&window.__dcDeleteEngine.onServerRateLimit)"
              "window.__dcDeleteEngine.onServerRateLimit({status:";
        js += std::to_string(status);
        js += ",limit:";
        js += h.limit ? std::to_string(*h.limit) : "null";
        js += ",remaining:";
        js += h.remaining ? std::to_string(*h.remaining) : "null";
        js += ",resetAfterMs:";
        js += h.resetAfterMs ? std::to_string(*h.resetAfterMs) : "null";
        js += ",retryAfterMs:";
        js += h.retryAfterMs ? std::to_string(*h.retryAfterMs) : "null";
        if (h.bucket && !h.bucket->empty()) {
            js += ",bucket:\"";
            js += EscapeJsonString(*h.bucket);
            js += "\"";
        }
        js += ",ts:Date.now()});";
        EvalFireAndForget(js);
    }

    void HandleIncomingMessage(const std::string& msg) {
        if (auto respId = JsonGetInt(msg, "id")) {
            std::lock_guard<std::mutex> lk(waitMtx_);
            auto it = waiters_.find(*respId);
            if (it != waiters_.end()) {
                it->second->response = msg;
                it->second->ready = true;
                waitCv_.notify_all();
            }
            return;
        }

        auto method = JsonGetString(msg, "method");
        if (!method) return;

        if (*method == "Runtime.bindingCalled") {
            if (!onBinding_) return;
            auto params = JsonGetRaw(msg, "params");
            if (!params) return;
            if (auto payload = JsonGetString(*params, "payload")) {
                try { onBinding_(*payload); } catch (...) {}
            }
            return;
        }

        if (*method == "Network.requestWillBeSent") {
            auto params = JsonGetRaw(msg, "params");
            if (!params) return;
            auto requestId = JsonGetString(*params, "requestId");
            auto reqObj = JsonGetRaw(*params, "request");
            if (!requestId || !reqObj) return;
            auto httpMethod = JsonGetString(*reqObj, "method");
            auto url = JsonGetString(*reqObj, "url");
            if (httpMethod && url &&
                EqualsIgnoreCase(*httpMethod, "DELETE") &&
                url->find("/messages/") != std::string::npos) {
                TrackRequest(*requestId, "DELETE", *url);
            }
        } else if (*method == "Network.responseReceived") {
            auto params = JsonGetRaw(msg, "params");
            if (!params) return;
            auto requestId = JsonGetString(*params, "requestId");
            auto respObj = JsonGetRaw(*params, "response");
            if (!requestId || !respObj) return;

            auto status = JsonGetInt(*respObj, "status");
            auto url = JsonGetString(*respObj, "url");
            TrackedDeleteReq* tracked = FindTracked(*requestId);
            const bool isMessages429 = (status && *status == 429 && url && url->find("/messages/") != std::string::npos);

            if (!tracked && !isMessages429) return;

            RateLimitHeaders headers;
            if (auto headersObj = JsonGetRaw(*respObj, "headers")) {
                headers = ParseRateLimitHeaders(*headersObj);
            }

            if (tracked && tracked->forwardedHeaders && (!headers.HasAny() || !status || *status != 429)) {
                return;
            }

            if (headers.HasAny() || (status && *status == 429)) {
                if (!tracked && isMessages429) {
                    TrackRequest(*requestId, "UNKNOWN", *url);
                    tracked = FindTracked(*requestId);
                }
                if (tracked && headers.HasAny()) {
                    tracked->forwardedHeaders = true;
                }
                ForwardRateLimit(status.value_or(0), headers);
            }
        } else if (*method == "Network.responseReceivedExtraInfo") {
            auto params = JsonGetRaw(msg, "params");
            if (!params) return;
            auto requestId = JsonGetString(*params, "requestId");
            if (!requestId) return;

            TrackedDeleteReq* tracked = FindTracked(*requestId);
            if (!tracked || tracked->forwardedHeaders) return;

            auto statusCode = JsonGetInt(*params, "statusCode");
            RateLimitHeaders headers;
            if (auto headersObj = JsonGetRaw(*params, "headers")) {
                headers = ParseRateLimitHeaders(*headersObj);
            }

            if (headers.HasAny() || (statusCode && *statusCode == 429)) {
                if (headers.HasAny()) {
                    tracked->forwardedHeaders = true;
                }
                ForwardRateLimit(statusCode.value_or(204), headers);
            }
        }
    }

    void ReaderLoop() {
        std::string msg;
        while (alive_.load()) {
            if (!ReadNextWsMessage(hWs_, msg)) {
                break;
            }
            HandleIncomingMessage(msg);
        }
        alive_.store(false);
        waitCv_.notify_all();
    }

    HINTERNET hWs_ = nullptr;
    BindingCallback onBinding_;
    std::atomic<int> nextReqId_{1};
    std::atomic<bool> alive_{true};
    std::atomic<bool> closed_{false};

    std::mutex sendMtx_;
    std::mutex waitMtx_;
    std::condition_variable waitCv_;
    std::unordered_map<int, std::shared_ptr<WaitSlot>> waiters_;
    std::deque<TrackedDeleteReq> trackedDeleteReqs_;
    std::thread readerThread_;
};
