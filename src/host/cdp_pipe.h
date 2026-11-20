#pragma once
// Chromium CDP transport over --remote-debugging-pipe (no TCP port).
// Uses anonymous pipes inherited as CRT fd 3 (read) and fd 4 (write).

#include <windows.h>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "json_mini.h"

inline std::wstring FindLatestDiscordExe() {
    wchar_t localApp[MAX_PATH]{};
    GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH);
    std::wstring base = std::wstring(localApp) + L"\\Discord\\";
    std::wstring pattern = base + L"app-*";

    WIN32_FIND_DATAW fd{};
    HANDLE hFind = FindFirstFileW(pattern.c_str(), &fd);
    std::wstring bestDir;
    FILETIME bestTime{0, 0};
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
                if (bestDir.empty() || CompareFileTime(&fd.ftLastWriteTime, &bestTime) > 0) {
                    bestDir = fd.cFileName;
                    bestTime = fd.ftLastWriteTime;
                }
            }
        } while (FindNextFileW(hFind, &fd));
        FindClose(hFind);
    }
    if (bestDir.empty()) return L"";
    return base + bestDir + L"\\Discord.exe";
}

class CdpPipeConnection {
public:
    ~CdpPipeConnection() { Close(); }

    bool LaunchAndConnect() {
        Close();
        std::wstring discordExe = FindLatestDiscordExe();
        if (discordExe.empty()) return false;

        system("taskkill /IM Discord.exe /F >NUL 2>&1");
        Sleep(800);

        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;

        HANDLE hChildRead = nullptr, hParentWrite = nullptr;
        HANDLE hParentRead = nullptr, hChildWrite = nullptr;
        if (!CreatePipe(&hChildRead, &hParentWrite, &sa, 0)) return false;
        if (!CreatePipe(&hParentRead, &hChildWrite, &sa, 0)) {
            CloseHandle(hChildRead); CloseHandle(hParentWrite);
            return false;
        }
        // Only the child ends should be inherited
        SetHandleInformation(hParentWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(hParentRead, HANDLE_FLAG_INHERIT, 0);

        // Pack MSVC CRT fd table into STARTUPINFO.lpReserved2:
        // [int count=5][5 flags bytes][5 HANDLEs (64-bit)]
        // fd 3 = child read (hChildRead), fd 4 = child write (hChildWrite)
        constexpr int kCount = 5;
        constexpr unsigned char kFlagPipe = 0x01 | 0x08; // FOPEN | FPIPE
        std::vector<unsigned char> reserved(sizeof(int) + kCount + kCount * sizeof(HANDLE), 0);
        std::memcpy(reserved.data(), &kCount, sizeof(int));
        unsigned char* flags = reserved.data() + sizeof(int);
        HANDLE* handles = reinterpret_cast<HANDLE*>(flags + kCount);

        handles[0] = GetStdHandle(STD_INPUT_HANDLE);
        handles[1] = GetStdHandle(STD_OUTPUT_HANDLE);
        handles[2] = GetStdHandle(STD_ERROR_HANDLE);
        flags[3] = kFlagPipe; handles[3] = hChildRead;
        flags[4] = kFlagPipe; handles[4] = hChildWrite;

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        si.cbReserved2 = static_cast<WORD>(reserved.size());
        si.lpReserved2 = reserved.data();

        PROCESS_INFORMATION pi{};
        std::wstring cmd = L"\"" + discordExe + L"\" --remote-debugging-pipe";
        BOOL ok = CreateProcessW(
            discordExe.c_str(), cmd.data(), nullptr, nullptr, TRUE,
            0, nullptr, nullptr, &si, &pi
        );

        CloseHandle(hChildRead);
        CloseHandle(hChildWrite);

        if (!ok) {
            CloseHandle(hParentWrite);
            CloseHandle(hParentRead);
            return false;
        }

        CloseHandle(pi.hThread);
        hProcess_ = pi.hProcess;
        hWrite_ = hParentWrite;
        hRead_ = hParentRead;
        alive_ = true;
        return true;
    }

    bool IsAlive() const { return alive_.load() && hWrite_ != nullptr && hRead_ != nullptr; }

    void Close() {
        alive_ = false;
        if (hWrite_) { CloseHandle(hWrite_); hWrite_ = nullptr; }
        if (hRead_)  { CloseHandle(hRead_);  hRead_ = nullptr; }
        if (hProcess_) { CloseHandle(hProcess_); hProcess_ = nullptr; }
        sessionId_.clear();
        readBuf_.clear();
    }

    bool SendRaw(const std::string& json) {
        std::lock_guard<std::mutex> lk(writeMutex_);
        if (!alive_ || !hWrite_) return false;
        std::string frame = json;
        frame.push_back('\0');
        DWORD written = 0;
        if (!WriteFile(hWrite_, frame.data(), static_cast<DWORD>(frame.size()), &written, nullptr) || written != frame.size()) {
            alive_ = false;
            return false;
        }
        return true;
    }

    bool ReadMessage(std::string& outMsg, DWORD timeoutMs = 4000) {
        DWORD start = GetTickCount();
        while (alive_ && hRead_) {
            size_t nul = readBuf_.find('\0');
            if (nul != std::string::npos) {
                outMsg.assign(readBuf_.data(), nul);
                readBuf_.erase(0, nul + 1);
                return true;
            }
            DWORD avail = 0;
            if (!PeekNamedPipe(hRead_, nullptr, 0, nullptr, &avail, nullptr)) {
                alive_ = false;
                return false;
            }
            if (avail == 0) {
                if (GetTickCount() - start >= timeoutMs) return false;
                Sleep(10);
                continue;
            }
            char tmp[8192];
            DWORD toRead = avail < sizeof(tmp) ? avail : sizeof(tmp);
            DWORD got = 0;
            if (!ReadFile(hRead_, tmp, toRead, &got, nullptr) || got == 0) {
                alive_ = false;
                return false;
            }
            readBuf_.append(tmp, got);
        }
        return false;
    }

    bool AttachToDiscordPage(int maxWaitSeconds = 25) {
        for (int attempt = 0; attempt < maxWaitSeconds * 2 && alive_; ++attempt) {
            int id = nextId_++;
            if (!SendRaw("{\"id\":" + std::to_string(id) + ",\"method\":\"Target.getTargets\"}")) return false;
            std::string msg;
            while (ReadMessage(msg, 1200)) {
                if (msg.find("\"id\":" + std::to_string(id)) != std::string::npos) {
                    // Find a "type":"page" target with discord.com
                    size_t pos = 0;
                    while ((pos = msg.find("\"targetId\":\"", pos)) != std::string::npos) {
                        size_t objEnd = msg.find('}', pos);
                        if (objEnd == std::string::npos) break;
                        std::string slice = msg.substr(pos, objEnd - pos);
                        if (slice.find("\"type\":\"page\"") != std::string::npos && slice.find("discord.com") != std::string::npos) {
                            size_t tidStart = pos + 12;
                            size_t tidEnd = msg.find('"', tidStart);
                            std::string targetId = msg.substr(tidStart, tidEnd - tidStart);
                            int aid = nextId_++;
                            if (!SendRaw("{\"id\":" + std::to_string(aid) + ",\"method\":\"Target.attachToTarget\",\"params\":{\"targetId\":\"" + targetId + "\",\"flatten\":true}}")) return false;
                            std::string aMsg;
                            while (ReadMessage(aMsg, 2000)) {
                                size_t sPos = aMsg.find("\"sessionId\":\"");
                                if (aMsg.find("\"id\":" + std::to_string(aid)) != std::string::npos && sPos != std::string::npos) {
                                    size_t sStart = sPos + 13;
                                    size_t sEnd = aMsg.find('"', sStart);
                                    sessionId_ = aMsg.substr(sStart, sEnd - sStart);
                                    return !sessionId_.empty();
                                }
                            }
                        }
                        pos = objEnd + 1;
                    }
                    break;
                }
            }
            Sleep(500);
        }
        return false;
    }

    bool Eval(const std::string& js) {
        if (!alive_ || sessionId_.empty()) return false;
        int id = nextId_++;
        std::string payload = "{\"id\":" + std::to_string(id) +
            ",\"sessionId\":\"" + sessionId_ +
            "\",\"method\":\"Runtime.evaluate\",\"params\":{\"expression\":\"" +
            EscapeJsonString(js) + "\",\"returnByValue\":true}}";
        if (!SendRaw(payload)) return false;
        std::string msg;
        while (ReadMessage(msg, 4000)) {
            if (msg.find("\"id\":" + std::to_string(id)) != std::string::npos) return true;
        }
        return false;
    }

private:
    HANDLE hWrite_ = nullptr;
    HANDLE hRead_ = nullptr;
    HANDLE hProcess_ = nullptr;
    std::atomic<bool> alive_{false};
    std::atomic<int> nextId_{1};
    std::mutex writeMutex_;
    std::string sessionId_;
    std::string readBuf_;
};
