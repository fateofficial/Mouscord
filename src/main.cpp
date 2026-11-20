#define UNICODE
#define _UNICODE
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>

#include "host/json_mini.h"
#include "host/cdp_socket.h"
#include "host/cdp_pipe.h"
#include "host/discord_launcher.h"
#include "host/native_overlay.h"

#include "sidebar_css_payload.h"
#include "core_runtime_payload.h"
#include "discord_bridge_payload.h"
#include "vfx_shaders_payload.h"
#include "vfx_payload.h"
#include "mouse_cursor_payload.h"
#include "popout_chat_payload.h"
#include "snow_shader_payload.h"
#include "filter_payload.h"
#include "delete_engine_payload.h"
#include "sidebar_payload.h"

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "shell32.lib")

constexpr int IDC_BTN_LAUNCH   = 101;
constexpr int IDC_BTN_TOGGLE   = 102;
constexpr int IDC_BTN_REINJECT = 103;
constexpr int IDC_BTN_SWAP_PIN = 105;
constexpr int IDC_STATUS       = 104;

constexpr UINT_PTR TIMER_UI    = 1;
constexpr UINT WM_TRAYICON     = WM_APP + 1;
constexpr UINT ID_TRAY_TOGGLE  = 201;
constexpr UINT ID_TRAY_REINJ   = 202;
constexpr UINT ID_TRAY_SNOW    = 204;
constexpr UINT ID_TRAY_EXIT    = 203;
static NOTIFYICONDATAW g_nid{};
static NativeGpuOverlay g_overlay;

struct HostState {
    HWND hMain       = nullptr;
    HWND hBtnLaunch  = nullptr;
    HWND hBtnToggle  = nullptr;
    HWND hBtnReinj   = nullptr;
    HWND hBtnSwapPin = nullptr;
    HWND hStatus     = nullptr;

    std::atomic<bool> running{true};
    std::atomic<bool> connected{false};
    std::atomic<bool> pendingToggle{false};
    std::atomic<bool> pendingReinject{false};
    std::atomic<bool> pendingSwapPinned{false};

    std::mutex statusMutex;
    std::wstring statusText = L"Connecting to Discord CDP on 127.0.0.1:9222...";
    std::wstring lastDisplayedStatus;
};

static HostState g_host;

static void UpdateTrayStatus(const wchar_t* tip, const wchar_t* balloonTitle = nullptr, const wchar_t* balloonMsg = nullptr) {
    if (!g_nid.hWnd) return;
    g_nid.uFlags = NIF_TIP;
    lstrcpynW(g_nid.szTip, tip, ARRAYSIZE(g_nid.szTip));
    if (balloonTitle && balloonMsg) {
        g_nid.uFlags |= NIF_INFO;
        g_nid.dwInfoFlags = NIIF_INFO | NIIF_NOSOUND;
        lstrcpynW(g_nid.szInfoTitle, balloonTitle, ARRAYSIZE(g_nid.szInfoTitle));
        lstrcpynW(g_nid.szInfo, balloonMsg, ARRAYSIZE(g_nid.szInfo));
    }
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

static void SetStatus(const std::wstring& s) {
    std::lock_guard<std::mutex> lk(g_host.statusMutex);
    g_host.statusText = s;
}

template <typename ConnT>
static bool InjectModules(ConnT& conn, bool forceDestroyFirst) {
    if (forceDestroyFirst) {
        if (!conn.Eval(
            "if(window.__dcMsgSidebar&&window.__dcMsgSidebar.destroy)window.__dcMsgSidebar.destroy();"
            "if(window.__dcDeleteEngine&&window.__dcDeleteEngine.destroy)window.__dcDeleteEngine.destroy();"
            "if(window.__dcFilter&&window.__dcFilter.destroy)window.__dcFilter.destroy();"
            "if(window.__dcVfx&&window.__dcVfx.destroy)window.__dcVfx.destroy();"
            "if(window.__dcVfxShaders&&window.__dcVfxShaders.destroy)window.__dcVfxShaders.destroy();"
            "if(window.__dcBridge&&window.__dcBridge.destroy)window.__dcBridge.destroy();"
            "if(window.__dcSnowShader&&window.__dcSnowShader.destroy)window.__dcSnowShader.destroy();"
            "if(window.__dcMouseCursor&&window.__dcMouseCursor.destroy)window.__dcMouseCursor.destroy();"
            "if(window.__dcPopoutChat&&window.__dcPopoutChat.destroy)window.__dcPopoutChat.destroy();")) {
            return false;
        }
    }
    if (!conn.Eval(kSidebarCssPayloadJs)) return false;
    if (!conn.Eval(kCoreRuntimePayloadJs)) return false;
    if (!conn.Eval(kDiscordBridgePayloadJs)) return false;
    if (!conn.Eval(kVfxShadersPayloadJs)) return false;
    if (!conn.Eval(kVfxPayloadJs)) return false;
    if (!conn.Eval(kMouseCursorPayloadJs)) return false;
    if (!conn.Eval(kPopoutChatPayloadJs)) return false;
    if (!conn.Eval(kSnowShaderPayloadJs)) return false;
    if (!conn.Eval(kFilterPayloadJs)) return false;
    if (!conn.Eval(kDeleteEnginePayloadJs)) return false;
    if (!conn.Eval(kSidebarPayloadJs)) return false;
    return true;
}

static void CdpHostThread() {
    bool autoLaunchedOnce = false;
    while (g_host.running) {
        std::string listJson = HttpGetLocal(9222, L"/json");
        CdpTargetInfo target = FindDiscordPageTarget(listJson);
        if (target.wsPath.empty()) {
            g_host.connected = false;
            if (!autoLaunchedOnce) {
                autoLaunchedOnce = true;
                SetStatus(L"Restarting Discord with Mouscord...");
                LaunchDiscordWithCdp();
                for (int i = 0; i < 30 && g_host.running; ++i) Sleep(100);
                continue;
            }
            SetStatus(L"Waiting for Discord...");
            for (int i = 0; i < 10 && g_host.running; ++i) Sleep(100);
            continue;
        }

        HINTERNET hSession = WinHttpOpen(L"DiscordSidebarHost/2.0", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0);
        HINTERNET hConnect = hSession ? WinHttpConnect(hSession, L"127.0.0.1", 9222, 0) : nullptr;
        HINTERNET hReq = hConnect ? WinHttpOpenRequest(hConnect, L"GET", target.wsPath.c_str(), nullptr, nullptr, nullptr, 0) : nullptr;
        HINTERNET hWs = nullptr;

        if (hReq &&
            WinHttpSetOption(hReq, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) &&
            WinHttpSendRequest(hReq, nullptr, 0, nullptr, 0, 0, 0) &&
            WinHttpReceiveResponse(hReq, nullptr)) {
            hWs = WinHttpWebSocketCompleteUpgrade(hReq, 0);
            WinHttpCloseHandle(hReq);
            hReq = nullptr;
        }

        if (!hWs) {
            if (hReq) WinHttpCloseHandle(hReq);
            if (hConnect) WinHttpCloseHandle(hConnect);
            if (hSession) WinHttpCloseHandle(hSession);
            for (int i = 0; i < 10 && g_host.running; ++i) Sleep(100);
            continue;
        }

        {
            auto onBinding = [](const std::string& payload) {
                auto readNum = [&](const char* key, float defVal) -> float {
                    std::string pat = std::string("\"") + key + "\":";
                    size_t pos = payload.find(pat);
                    if (pos == std::string::npos) return defVal;
                    try { return std::stof(payload.substr(pos + pat.size())); } catch (...) { return defVal; }
                };
                auto readStr = [&](const char* key) -> std::string {
                    std::string pat = std::string("\"") + key + "\":\"";
                    size_t pos = payload.find(pat);
                    if (pos == std::string::npos) return {};
                    size_t s = pos + pat.size();
                    size_t e = payload.find('"', s);
                    return (e == std::string::npos) ? std::string{} : payload.substr(s, e - s);
                };
                std::string cmd = readStr("cmd");
                if (cmd == "snow") {
                    g_overlay.SetSnowEnabled(payload.find("\"on\":true") != std::string::npos);
                } else if (cmd == "mouse") {
                    bool show = (payload.find("\"show\":true") != std::string::npos);
                    g_overlay.SetMouseState(show, readNum("x", 0.0f), readNum("y", 0.0f),
                                            readNum("f", 1.0f), readNum("b", 0.0f),
                                            readNum("s", 1.0f) > 0.5f);
                } else if (cmd == "burst") {
                    g_overlay.SpawnParticleBurst(readNum("x", 0.0f), readNum("y", 0.0f),
                                                 readNum("w", 120.0f), readNum("h", 40.0f),
                                                 readStr("preset"));
                }
            };
            CdpConnection conn(hWs, onBinding);
            conn.Start();
            g_host.connected = true;

            conn.SendCommand("Runtime.enable", "");
            conn.EnableNativeBinding("__dcNativeHost");
            if (!InjectModules(conn, true) || !conn.SendCommand("Network.enable", "")) {
                g_host.connected = false;
                conn.Close();
                WinHttpCloseHandle(hConnect);
                WinHttpCloseHandle(hSession);
                Sleep(500);
                continue;
            }

            std::wstring label = target.title.empty() ? L"Discord" : target.title;
            SetStatus(L"Connected (" + label + L") — Native Modular Cleaner mounted inside Discord!\r\n"
                      L"Live rate-limit sniffer & Rspack Bridge active. Press Alt+M or click the right-edge tab.");
            UpdateTrayStatus(L"Mouscord — Connected to Discord (Alt+M)",
                             L"Mouscord Connected",
                             L"Ready inside Discord. Press Alt+M or click the right-edge tab.");

            int ticks = 0;
            while (g_host.running && conn.IsAlive()) {
                if (g_host.pendingReinject.exchange(false)) {
                    if (!InjectModules(conn, true)) break;
                }
                if (g_host.pendingToggle.exchange(false)) {
                    if (!conn.Eval("if(window.__dcMsgSidebar)window.__dcMsgSidebar.toggle();")) break;
                }
                if (g_host.pendingSwapPinned.exchange(false)) {
                    if (!conn.Eval("if(window.__dcMsgSidebar&&window.__dcMsgSidebar.swapPinned)window.__dcMsgSidebar.swapPinned();")) break;
                }

                if (++ticks >= 15) {
                    ticks = 0;
                    std::string hbResp;
                    if (!conn.Eval("(window.__dcCore && window.__dcBridge && window.__dcVfx && window.__dcFilter && window.__dcDeleteEngine && window.__dcMsgSidebar) ? 'ok' : 'missing'", &hbResp)) {
                        break;
                    }
                    if (hbResp.find("missing") != std::string::npos) {
                        if (!InjectModules(conn, false)) break;
                        if (!conn.SendCommand("Network.enable", "")) break;
                    }
                }
                Sleep(100);
            }

            if (!g_host.running && conn.IsAlive()) {
                conn.Eval(
                    "if(window.__dcMsgSidebar&&window.__dcMsgSidebar.destroy)window.__dcMsgSidebar.destroy();"
                    "if(window.__dcDeleteEngine&&window.__dcDeleteEngine.destroy)window.__dcDeleteEngine.destroy();"
                    "if(window.__dcFilter&&window.__dcFilter.destroy)window.__dcFilter.destroy();"
                    "if(window.__dcVfx&&window.__dcVfx.destroy)window.__dcVfx.destroy();"
                    "if(window.__dcVfxShaders&&window.__dcVfxShaders.destroy)window.__dcVfxShaders.destroy();"
                    "if(window.__dcBridge&&window.__dcBridge.destroy)window.__dcBridge.destroy();",
                    nullptr,
                    1500
                );
            }

            g_host.connected = false;
            UpdateTrayStatus(L"Mouscord — Waiting for Discord...");
            conn.Close();
        }

        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
    }
}

static void LayoutHostWindow(int w, int h) {
    const int pad = 10;
    const int btnH = 30;
    MoveWindow(g_host.hBtnLaunch,  pad,       pad, 145, btnH, TRUE);
    MoveWindow(g_host.hBtnToggle,  pad + 152, pad, 110, btnH, TRUE);
    MoveWindow(g_host.hBtnSwapPin, pad + 269, pad, 155, btnH, TRUE);
    MoveWindow(g_host.hBtnReinj,   pad + 431, pad, 85,  btnH, TRUE);

    int stY = pad + btnH + pad;
    MoveWindow(g_host.hStatus, pad, stY, (w > pad * 2 ? w - pad * 2 : 100), (h > stY + pad ? h - stY - pad : 50), TRUE);
}

static LRESULT CALLBACK HostWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            HFONT hFont = (HFONT)GetStockObject(DEFAULT_GUI_FONT);

            g_host.hBtnLaunch = CreateWindowW(
                L"BUTTON", L"Launch Discord (CDP)",
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_LAUNCH)), nullptr, nullptr
            );
            g_host.hBtnToggle = CreateWindowW(
                L"BUTTON", L"Toggle Sidebar",
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_TOGGLE)), nullptr, nullptr
            );
            g_host.hBtnSwapPin = CreateWindowW(
                L"BUTTON", L"Swap Pinned (Alt+W)",
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_SWAP_PIN)), nullptr, nullptr
            );
            g_host.hBtnReinj = CreateWindowW(
                L"BUTTON", L"Reload UI",
                WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BTN_REINJECT)), nullptr, nullptr
            );
            g_host.hStatus = CreateWindowExW(
                WS_EX_CLIENTEDGE, L"EDIT", L"Connecting to Discord CDP on 127.0.0.1:9222...",
                WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_READONLY,
                0, 0, 0, 0, hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_STATUS)), nullptr, nullptr
            );

            for (HWND c : {g_host.hBtnLaunch, g_host.hBtnToggle, g_host.hBtnSwapPin, g_host.hBtnReinj, g_host.hStatus}) {
                SendMessageW(c, WM_SETFONT, (WPARAM)hFont, TRUE);
            }

            SetTimer(hwnd, TIMER_UI, 250, nullptr);
            return 0;
        }
        case WM_TIMER: {
            if (wParam == TIMER_UI) {
                std::wstring st;
                {
                    std::lock_guard<std::mutex> lk(g_host.statusMutex);
                    st = g_host.statusText;
                }
                if (st != g_host.lastDisplayedStatus) {
                    g_host.lastDisplayedStatus = st;
                    SetWindowTextW(g_host.hStatus, st.c_str());
                }
            }
            return 0;
        }
        case WM_SIZE: {
            LayoutHostWindow(LOWORD(lParam), HIWORD(lParam));
            return 0;
        }
        case WM_COMMAND: {
            int id = LOWORD(wParam);
            if (id == IDC_BTN_LAUNCH) {
                LaunchDiscordWithCdp();
            } else if (id == IDC_BTN_TOGGLE) {
                g_host.pendingToggle = true;
            } else if (id == IDC_BTN_SWAP_PIN) {
                g_host.pendingSwapPinned = true;
            } else if (id == IDC_BTN_REINJECT) {
                g_host.pendingReinject = true;
            }
            return 0;
        }
        case WM_TRAYICON: {
            if (lParam == WM_RBUTTONUP || lParam == WM_CONTEXTMENU) {
                POINT pt;
                GetCursorPos(&pt);
                HMENU hMenu = CreatePopupMenu();
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_TOGGLE, L"Toggle Drawer (Alt+M)");
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_REINJ,  L"Reinject Modules");
                AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
                AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT,   L"Quit Cleaner Host");
                SetForegroundWindow(hwnd);
                UINT cmd = TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hwnd, nullptr);
                DestroyMenu(hMenu);
                if (cmd == ID_TRAY_TOGGLE) g_host.pendingToggle = true;
                else if (cmd == ID_TRAY_REINJ) g_host.pendingReinject = true;
                else if (cmd == ID_TRAY_EXIT) DestroyWindow(hwnd);
            } else if (lParam == WM_LBUTTONDBLCLK) {
                g_host.pendingToggle = true;
            } else if (lParam == NIN_BALLOONUSERCLICK) {
                if (g_host.connected.load()) g_host.pendingToggle = true;
                else LaunchDiscordWithCdp();
            }
            return 0;
        }
        case WM_DESTROY: {
            Shell_NotifyIconW(NIM_DELETE, &g_nid);
            g_host.running = false;
            KillTimer(hwnd, TIMER_UI);
            PostQuitMessage(0);
            return 0;
        }
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int nCmdShow) {
    (void)nCmdShow;
    HANDLE hSingleInst = CreateMutexW(nullptr, TRUE, L"Local\\MouscordSingleInstance");
    if (hSingleInst && GetLastError() == ERROR_ALREADY_EXISTS) {
        CloseHandle(hSingleInst);
        return 0;
    }
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    WNDCLASSW wc{};
    wc.lpfnWndProc = HostWndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = L"DiscordSidebarHost";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    RegisterClassW(&wc);

    g_host.hMain = CreateWindowExW(
        0, L"DiscordSidebarHost", L"Discord Native Cleaner Host  (Alt+M Sidebar | Alt+W Swap Pinned)",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
        CW_USEDEFAULT, CW_USEDEFAULT, 545, 160,
        nullptr, nullptr, hInst, nullptr
    );

    ShowWindow(g_host.hMain, SW_HIDE);
    UpdateWindow(g_host.hMain);

    // Add System Tray icon (right-click -> Toggle Drawer / Reinject / Quit)
    g_nid.cbSize = sizeof(g_nid);
    g_nid.hWnd = g_host.hMain;
    g_nid.uID = 1;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_TRAYICON;
    g_nid.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(101));
    if (!g_nid.hIcon) g_nid.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    lstrcpynW(g_nid.szTip, L"Mouscord (Right-click to Quit)", ARRAYSIZE(g_nid.szTip));
    Shell_NotifyIconW(NIM_ADD, &g_nid);

    g_overlay.Start(hInst);
    std::thread worker(CdpHostThread);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    g_host.running = false;
    g_overlay.Stop();
    if (worker.joinable()) worker.join();
    if (hSingleInst) CloseHandle(hSingleInst);
    return 0;
}
