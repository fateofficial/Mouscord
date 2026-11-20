#pragma once
// Launches Discord with debugging enabled and discovers its CDP targets.

#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <cstdlib>
#include <string>

#include "json_mini.h"

struct CdpTargetInfo {
    std::wstring wsPath;
    std::wstring title;
};

inline std::string HttpGetLocal(INTERNET_PORT port, const std::wstring& path) {
    std::string result;
    HINTERNET hSession = WinHttpOpen(L"DiscordSidebarHost/2.0", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0);
    if (!hSession) return result;
    HINTERNET hConnect = WinHttpConnect(hSession, L"127.0.0.1", port, 0);
    if (hConnect) {
        HINTERNET hReq = WinHttpOpenRequest(hConnect, L"GET", path.c_str(), nullptr, nullptr, nullptr, 0);
        if (hReq) {
            WinHttpSetTimeouts(hReq, 600, 600, 600, 600);
            if (WinHttpSendRequest(hReq, nullptr, 0, nullptr, 0, 0, 0) && WinHttpReceiveResponse(hReq, nullptr)) {
                DWORD avail = 0;
                while (WinHttpQueryDataAvailable(hReq, &avail) && avail > 0) {
                    std::string buf(avail, '\0');
                    DWORD read = 0;
                    if (WinHttpReadData(hReq, buf.data(), avail, &read)) {
                        result.append(buf.data(), read);
                    }
                }
            }
            WinHttpCloseHandle(hReq);
        }
        WinHttpCloseHandle(hConnect);
    }
    WinHttpCloseHandle(hSession);
    return result;
}

inline std::string ExtractJsonField(const std::string& obj, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t p = obj.find(needle);
    if (p == std::string::npos) return "";
    size_t colon = obj.find(':', p + needle.size());
    if (colon == std::string::npos) return "";
    size_t q1 = obj.find('"', colon + 1);
    if (q1 == std::string::npos) return "";
    size_t q2 = obj.find('"', q1 + 1);
    if (q2 == std::string::npos) return "";
    return obj.substr(q1 + 1, q2 - q1 - 1);
}

inline CdpTargetInfo FindDiscordPageTarget(const std::string& json) {
    CdpTargetInfo info;
    size_t pos = 0;
    while (pos < json.size()) {
        size_t objStart = json.find('{', pos);
        if (objStart == std::string::npos) break;
        size_t objEnd = json.find('}', objStart);
        if (objEnd == std::string::npos) break;
        std::string obj = json.substr(objStart, objEnd - objStart + 1);
        pos = objEnd + 1;

        if (ExtractJsonField(obj, "type") != "page") continue;
        std::string url = ExtractJsonField(obj, "webSocketDebuggerUrl");
        size_t slash = url.find("/devtools/page/");
        if (slash != std::string::npos) {
            info.wsPath = Utf8ToWString(url.substr(slash));
            info.title  = Utf8ToWString(ExtractJsonField(obj, "title"));
            return info;
        }
    }
    return info;
}

inline void LaunchDiscordWithCdp() {
    // CREATE_NO_WINDOW so taskkill does not flash a console.
    STARTUPINFOW si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::wstring killCmd = L"taskkill.exe /IM Discord.exe /F";
    if (CreateProcessW(nullptr, killCmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        WaitForSingleObject(pi.hProcess, 3000);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    Sleep(900);
    std::wstring discordExe = FindLatestDiscordExe();
    if (!discordExe.empty()) {
        std::wstring cmd = L"\"" + discordExe + L"\" --remote-debugging-port=9222";
        STARTUPINFOW si2{}; si2.cb = sizeof(si2);
        PROCESS_INFORMATION pi2{};
        if (CreateProcessW(discordExe.c_str(), cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si2, &pi2)) {
            CloseHandle(pi2.hThread);
            CloseHandle(pi2.hProcess);
            return;
        }
    }
    wchar_t localApp[MAX_PATH]{};
    GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH);
    std::wstring updateExe = std::wstring(localApp) + L"\\Discord\\Update.exe";
    std::wstring args = L"--processStart Discord.exe --process-start-args=\"--remote-debugging-port=9222\"";
    ShellExecuteW(nullptr, L"open", updateExe.c_str(), args.c_str(), nullptr, SW_SHOWNORMAL);
}
