#pragma once
// Click-through Direct3D 11 + DirectComposition overlay that tracks the Discord window.
// Renders snow, dissolve particles and the animated mouse cursor outside Electron's compositor.

#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_3.h>
#include <dcomp.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "d3dcompiler.lib")

using Microsoft::WRL::ComPtr;

class NativeGpuOverlay {
public:
    ~NativeGpuOverlay() { Stop(); }

    void Start(HINSTANCE hInst) {
        if (running_.exchange(true)) return;
        hInst_ = hInst;
        worker_ = std::thread([this]() { RunLoop(); });
    }

    void Stop() {
        if (!running_.exchange(false)) return;
        if (hOverlay_) PostMessageW(hOverlay_, WM_CLOSE, 0, 0);
        if (worker_.joinable()) worker_.join();
    }

    void SetSnowEnabled(bool on) { snowEnabled_.store(on); }
    bool IsSnowEnabled() const { return snowEnabled_.load(); }
    void ToggleSnow() { snowEnabled_.store(!snowEnabled_.load()); }

    void SetMouseState(bool visible, float x, float y, float facing, float boop, bool hat) {
        std::lock_guard<std::mutex> lk(stateMtx_);
        bool wasBoop = (mouseBoop_ > 0.5f);
        mouseVisible_ = visible;
        mouseX_ = x;
        mouseY_ = y;
        mouseFacing_ = (facing < 0.0f) ? -1.0f : 1.0f;
        mouseBoop_ = boop;
        mouseHat_ = hat;
        if (visible && boop > 0.6f && !wasBoop) {
            pendingBursts_.push_back({ x - 8.0f, y - 8.0f, 16.0f, 16.0f, 0, 18 });
        }
    }

    void SpawnParticleBurst(float x, float y, float w, float h, const std::string& preset) {
        int style = 0; // fairy
        if (preset == "fire" || preset == "ember") style = 1;
        else if (preset == "frost" || preset == "ice") style = 2;
        else if (preset == "sakura" || preset == "petal") style = 3;
        else if (preset == "void" || preset == "nebula") style = 4;
        else if (preset == "glitch" || preset == "cyber") style = 5;
        std::lock_guard<std::mutex> lk(stateMtx_);
        if (pendingBursts_.size() < 32) {
            pendingBursts_.push_back({ x, y, (std::max)(8.0f, w), (std::max)(8.0f, h), style, 130 });
        }
    }

private:
    struct FlakeVert {
        float x, y, depth, phase;
    };

    struct ParticleGPU {
        float x, y, size, alpha;
        float r, g, b, kind; // kind: 0=soft dot, 1=star sparkle
    };

    struct ParticleSim {
        float x, y, vx, vy, grav, size, life, maxLife;
        float r, g, b, kind, phase;
    };

    struct BurstReq {
        float x, y, w, h;
        int style;
        int count;
    };

    struct MouseCB {
        float pos[2];     // pixel x, y
        float res[2];     // screen w, h
        float facing;     // +1 or -1
        float boop;       // 0..1
        float time;       // seconds
        float hat;        // 1=santa, 0=none
        float tail[12];   // 6 tail nodes (x,y) in pixels
    };

    static constexpr int MAX_PARTICLES = 2048;

    static HWND FindDiscordMainWindow() {
        struct Ctx { HWND found = nullptr; } ctx;
        EnumWindows([](HWND hwnd, LPARAM lp) -> BOOL {
            if (!IsWindowVisible(hwnd)) return TRUE;
            wchar_t cls[128]{};
            GetClassNameW(hwnd, cls, 128);
            if (wcscmp(cls, L"Chrome_WidgetWin_1") != 0) return TRUE;
            wchar_t title[256]{};
            GetWindowTextW(hwnd, title, 256);
            if (wcsstr(title, L"Discord") != nullptr) {
                reinterpret_cast<Ctx*>(lp)->found = hwnd;
                return FALSE;
            }
            return TRUE;
        }, reinterpret_cast<LPARAM>(&ctx));
        return ctx.found;
    }

    static LRESULT CALLBACK OverlayWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
        if (msg == WM_NCHITTEST) return HTTRANSPARENT;
        if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }
        return DefWindowProcW(hwnd, msg, wp, lp);
    }

    bool InitD3D(HWND hwnd, int w, int h) {
        D3D_FEATURE_LEVEL fl;
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, nullptr, 0,
                                     D3D11_SDK_VERSION, &device_, &fl, &ctx_))) {
            return false;
        }

        ComPtr<IDXGIDevice> dxgiDev;
        device_.As(&dxgiDev);
        ComPtr<IDXGIFactory2> factory;
        if (FAILED(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)))) return false;

        DXGI_SWAP_CHAIN_DESC1 scd{};
        scd.Width = static_cast<UINT>(w > 0 ? w : 640);
        scd.Height = static_cast<UINT>(h > 0 ? h : 480);
        scd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        scd.BufferCount = 2;
        scd.SampleDesc.Count = 1;
        scd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        scd.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;

        if (FAILED(factory->CreateSwapChainForComposition(dxgiDev.Get(), &scd, nullptr, &swapChain_))) return false;
        if (FAILED(DCompositionCreateDevice(dxgiDev.Get(), IID_PPV_ARGS(&dcompDev_)))) return false;
        if (FAILED(dcompDev_->CreateTargetForHwnd(hwnd, TRUE, &dcompTarget_))) return false;
        if (FAILED(dcompDev_->CreateVisual(&dcompVisual_))) return false;
        dcompVisual_->SetContent(swapChain_.Get());
        dcompTarget_->SetRoot(dcompVisual_.Get());
        dcompDev_->Commit();

        CreateRTV();

        D3D11_BLEND_DESC bd{};
        bd.RenderTarget[0].BlendEnable = TRUE;
        bd.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        device_->CreateBlendState(&bd, &blend_);

        D3D11_RASTERIZER_DESC rd{};
        rd.FillMode = D3D11_FILL_SOLID;
        rd.CullMode = D3D11_CULL_NONE;
        rd.DepthClipEnable = TRUE;
        device_->CreateRasterizerState(&rd, &raster_);

        return InitSnowPipeline() && InitParticlePipeline() && InitMousePipeline();
    }

    void CreateRTV() {
        rtv_.Reset();
        ComPtr<ID3D11Texture2D> bb;
        if (SUCCEEDED(swapChain_->GetBuffer(0, IID_PPV_ARGS(&bb)))) {
            device_->CreateRenderTargetView(bb.Get(), nullptr, &rtv_);
        }
    }

    bool InitSnowPipeline() {
        const char* hlsl = R"(
            cbuffer CB : register(b0) { float uTime; float uAspect; float2 uPad; };
            struct PSIn { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float alpha : COLOR0; };
            static const float2 Q[6] = {
                float2(-1,-1), float2(-1,1), float2(1,-1),
                float2(-1,1),  float2(1,1),  float2(1,-1)
            };
            PSIn VSMain(float4 seed : POSITION, uint vid : SV_VertexID) {
                float depth = seed.z;
                float speed = lerp(0.025, 0.11, depth);
                float wind  = lerp(0.012, 0.045, depth);
                float y = frac(seed.y - uTime * speed);
                float x = frac(seed.x + sin(uTime * (0.4 + depth * 0.5) + seed.w) * wind + uTime * wind * 0.35);
                float2 q = Q[vid % 6];
                float sz = lerp(0.0028, 0.0072, depth);
                PSIn o;
                o.pos = float4((x * 2.0 - 1.0) + q.x * sz / uAspect, (y * 2.0 - 1.0) + q.y * sz, 0.0, 1.0);
                o.uv = q;
                float tw = 0.72 + 0.28 * sin(uTime * (1.8 + depth * 2.5) + seed.w);
                o.alpha = lerp(0.16, 0.48, depth) * tw;
                return o;
            }
            float4 PSMain(PSIn i) : SV_TARGET {
                float d = length(i.uv);
                if (d > 1.0) discard;
                float soft = smoothstep(1.0, 0.2, d);
                float a = soft * i.alpha;
                return float4(float3(0.92, 0.96, 1.0) * a, a);
            }
        )";
        ComPtr<ID3DBlob> vsB, psB;
        if (FAILED(D3DCompile(hlsl, strlen(hlsl), nullptr, nullptr, nullptr, "VSMain", "vs_5_0", 0, 0, &vsB, nullptr))) return false;
        if (FAILED(D3DCompile(hlsl, strlen(hlsl), nullptr, nullptr, nullptr, "PSMain", "ps_5_0", 0, 0, &psB, nullptr))) return false;
        device_->CreateVertexShader(vsB->GetBufferPointer(), vsB->GetBufferSize(), nullptr, &snowVs_);
        device_->CreatePixelShader(psB->GetBufferPointer(), psB->GetBufferSize(), nullptr, &snowPs_);

        D3D11_INPUT_ELEMENT_DESC ied = { "POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D11_INPUT_PER_INSTANCE_DATA, 1 };
        device_->CreateInputLayout(&ied, 1, vsB->GetBufferPointer(), vsB->GetBufferSize(), &snowLayout_);

        std::mt19937 rng(2026);
        std::uniform_real_distribution<float> U(0.0f, 1.0f);
        std::vector<FlakeVert> flakes(240);
        for (auto& f : flakes) {
            f.x = U(rng);
            f.y = U(rng);
            f.depth = 0.18f + std::pow(U(rng), 1.8f) * 0.82f;
            f.phase = U(rng) * 6.283185f;
        }
        D3D11_BUFFER_DESC vbd{};
        vbd.ByteWidth = static_cast<UINT>(flakes.size() * sizeof(FlakeVert));
        vbd.Usage = D3D11_USAGE_IMMUTABLE;
        vbd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
        D3D11_SUBRESOURCE_DATA vsd{ flakes.data(), 0, 0 };
        device_->CreateBuffer(&vbd, &vsd, &snowVb_);

        D3D11_BUFFER_DESC cbd{};
        cbd.ByteWidth = 16;
        cbd.Usage = D3D11_USAGE_DYNAMIC;
        cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        device_->CreateBuffer(&cbd, nullptr, &snowCb_);
        return true;
    }

    bool InitParticlePipeline() {
        const char* hlsl = R"(
            cbuffer PCB : register(b0) { float2 uRes; float2 uPad; };
            struct PSIn { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 col : COLOR0; float kind : TEXCOORD1; };
            static const float2 Q[6] = {
                float2(-1,-1), float2(-1,1), float2(1,-1),
                float2(-1,1),  float2(1,1),  float2(1,-1)
            };
            PSIn VSMain(float4 geom : POSITION, float4 colKind : COLOR, uint vid : SV_VertexID) {
                float2 q = Q[vid % 6];
                float2 px = geom.xy + q * geom.z;
                float2 ndc = float2((px.x / uRes.x) * 2.0 - 1.0, 1.0 - (px.y / uRes.y) * 2.0);
                PSIn o;
                o.pos = float4(ndc, 0.0, 1.0);
                o.uv = q;
                o.col = float4(colKind.rgb, geom.w);
                o.kind = colKind.w;
                return o;
            }
            float4 PSMain(PSIn i) : SV_TARGET {
                float d = length(i.uv);
                if (d > 1.0) discard;
                float mask = smoothstep(1.0, 0.12, d);
                if (i.kind > 0.5) {
                    // 4-point star sparkle
                    float sx = max(0.0, 1.0 - abs(i.uv.x) * 4.2) * (1.0 - abs(i.uv.y));
                    float sy = max(0.0, 1.0 - abs(i.uv.y) * 4.2) * (1.0 - abs(i.uv.x));
                    mask = saturate(mask * 0.45 + max(sx, sy) * 1.1);
                }
                float a = mask * i.col.a;
                return float4(i.col.rgb * a, a);
            }
        )";
        ComPtr<ID3DBlob> vsB, psB;
        if (FAILED(D3DCompile(hlsl, strlen(hlsl), nullptr, nullptr, nullptr, "VSMain", "vs_5_0", 0, 0, &vsB, nullptr))) return false;
        if (FAILED(D3DCompile(hlsl, strlen(hlsl), nullptr, nullptr, nullptr, "PSMain", "ps_5_0", 0, 0, &psB, nullptr))) return false;
        device_->CreateVertexShader(vsB->GetBufferPointer(), vsB->GetBufferSize(), nullptr, &partVs_);
        device_->CreatePixelShader(psB->GetBufferPointer(), psB->GetBufferSize(), nullptr, &partPs_);

        D3D11_INPUT_ELEMENT_DESC ied[2] = {
            { "POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0,  D3D11_INPUT_PER_INSTANCE_DATA, 1 },
            { "COLOR",    0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D11_INPUT_PER_INSTANCE_DATA, 1 }
        };
        device_->CreateInputLayout(ied, 2, vsB->GetBufferPointer(), vsB->GetBufferSize(), &partLayout_);

        D3D11_BUFFER_DESC vbd{};
        vbd.ByteWidth = static_cast<UINT>(MAX_PARTICLES * sizeof(ParticleGPU));
        vbd.Usage = D3D11_USAGE_DYNAMIC;
        vbd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
        vbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        device_->CreateBuffer(&vbd, nullptr, &partVb_);

        D3D11_BUFFER_DESC cbd{};
        cbd.ByteWidth = 16;
        cbd.Usage = D3D11_USAGE_DYNAMIC;
        cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        device_->CreateBuffer(&cbd, nullptr, &partCb_);
        return true;
    }

    bool InitMousePipeline() {
        const char* hlsl = R"(
            cbuffer MCB : register(b0) {
                float2 uPos; float2 uRes;
                float uFacing; float uBoop; float uTime; float uHat;
                float4 uTail01; float4 uTail23; float4 uTail45;
            };
            struct PSIn { float4 pos : SV_POSITION; float2 px : TEXCOORD0; };
            static const float2 Q[6] = {
                float2(-1,-1), float2(-1,1), float2(1,-1),
                float2(-1,1),  float2(1,1),  float2(1,-1)
            };
            PSIn VSMain(uint vid : SV_VertexID) {
                float2 q = Q[vid % 6];
                float2 px = uPos + q * 72.0;
                float2 ndc = float2((px.x / uRes.x) * 2.0 - 1.0, 1.0 - (px.y / uRes.y) * 2.0);
                PSIn o;
                o.pos = float4(ndc, 0.0, 1.0);
                o.px = px;
                return o;
            }
            float sdSeg(float2 p, float2 a, float2 b) {
                float2 pa = p - a, ba = b - a;
                float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
                return length(pa - ba * h);
            }
            float sdEllipse(float2 p, float2 r) {
                return (length(p / r) - 1.0) * min(r.x, r.y);
            }
            void blendOver(inout float4 dst, float3 rgb, float a) {
                dst.rgb = rgb * a + dst.rgb * (1.0 - a);
                dst.a   = a + dst.a * (1.0 - a);
            }
            float4 PSMain(PSIn i) : SV_TARGET {
                float4 col = float4(0, 0, 0, 0);
                float2 p = i.px;

                // 1. 5-segment Verlet tail (smoothly tapered, zero visible joint steps)
                float2 t[6] = { uTail01.xy, uTail01.zw, uTail23.xy, uTail23.zw, uTail45.xy, uTail45.zw };
                float td = 999.0;
                [unroll] for (int k = 0; k < 5; k++) {
                    float2 pa = p - t[k], ba = t[k + 1] - t[k];
                    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
                    float w = lerp(1.7, 0.70, (k + h) / 5.0);
                    td = min(td, length(pa - ba * h) - w);
                }
                blendOver(col, float3(0.32, 0.22, 0.26), smoothstep(0.6, -0.3, td - 0.9));
                blendOver(col, float3(0.96, 0.64, 0.74), smoothstep(0.6, -0.3, td));

                // Local mouse coords (flipped by facing, squash & stretch on boop)
                float2 lp = p - uPos;
                lp.x *= uFacing;
                float sq = 1.0 + uBoop * 0.16;
                lp.x /= sq;
                lp.y *= sq;

                // 2. Soft ground shadow
                float sh = sdEllipse(lp - float2(0.0, 9.5), float2(13.6, 4.0));
                blendOver(col, float3(0.0, 0.0, 0.0), smoothstep(2.5, -1.5, sh) * 0.26);

                // 3. Back ear
                float earB = length(lp - float2(-1.6, -11.8)) - 5.4;
                blendOver(col, float3(0.22, 0.24, 0.30), smoothstep(0.6, -0.3, earB - 1.1));
                blendOver(col, float3(0.90, 0.92, 0.96), smoothstep(0.6, -0.3, earB));
                float earBi = length(lp - float2(-1.2, -11.5)) - 3.1;
                blendOver(col, float3(0.97, 0.70, 0.78), smoothstep(0.6, -0.3, earBi));

                // 4. White mouse body (outlined + soft belly shading)
                float body = sdEllipse(lp - float2(0.5, 1.5), float2(13.6, 9.0));
                blendOver(col, float3(0.22, 0.24, 0.30), smoothstep(0.6, -0.3, body - 1.2));
                float3 bodyCol = lerp(float3(0.99, 0.99, 1.0), float3(0.86, 0.88, 0.94), saturate((lp.y + 4.0) / 14.0));
                blendOver(col, bodyCol, smoothstep(0.6, -0.3, body));

                // 5. Santa hat (slightly tilted to hug head, cone clipped cleanly at brim)
                if (uHat > 0.5) {
                    float bob = sin(uTime * 5.0) * 1.1;
                    float2 hp0 = lp - float2(5.6, -8.3);
                    float ca = 0.985, sa = -0.174; // ~-10 deg natural tilt
                    float2 hp = float2(hp0.x * ca - hp0.y * sa, hp0.x * sa + hp0.y * ca);
                    float hatCone = max(sdSeg(hp, float2(-3.2, -1.2), float2(-9.0 + bob, -14.0)) - lerp(4.6, 1.4, saturate(-hp.y / 12.0)), hp.y - 0.5);
                    blendOver(col, float3(0.32, 0.08, 0.12), smoothstep(0.6, -0.3, hatCone - 1.1));
                    float3 redCol = lerp(float3(0.95, 0.22, 0.28), float3(0.74, 0.10, 0.16), saturate((hp.x + 8.0) / 14.0));
                    blendOver(col, redCol, smoothstep(0.6, -0.3, hatCone));
                    float brim = sdSeg(hp, float2(-7.0, 0.4), float2(3.5, -0.8)) - 2.3;
                    blendOver(col, float3(0.25, 0.27, 0.33), smoothstep(0.6, -0.3, brim - 1.0));
                    blendOver(col, float3(0.99, 0.99, 1.0), smoothstep(0.6, -0.3, brim));
                    float pom = length(hp - float2(-9.5 + bob, -14.5)) - 2.8;
                    blendOver(col, float3(0.25, 0.27, 0.33), smoothstep(0.6, -0.3, pom - 1.0));
                    blendOver(col, float3(0.99, 0.99, 1.0), smoothstep(0.6, -0.3, pom));
                }

                // 6. Front ear (in front of hat, base clipped cleanly into head)
                float earClip = lp.y - (lp.x + 4.8) * (-0.16) + 5.4;
                float earF = max(length(lp - float2(-4.8, -8.2)) - 6.4, earClip);
                blendOver(col, float3(0.22, 0.24, 0.30), smoothstep(0.6, -0.3, earF - 1.1));
                blendOver(col, float3(0.97, 0.98, 1.0), smoothstep(0.6, -0.3, earF));
                float earFi = max(length(lp - float2(-4.3, -8.0)) - 3.7, earClip + 0.6);
                blendOver(col, float3(0.99, 0.72, 0.80), smoothstep(0.6, -0.3, earFi));

                // 7. Soft pink cheek blush
                float blush = length(lp - float2(7.2, 2.2)) - 2.6;
                blendOver(col, float3(1.0, 0.66, 0.76), smoothstep(2.0, -1.0, blush) * 0.45);

                // 8. Glossy dark eye + double catchlight
                float eye = length(lp - float2(7.6, -1.6)) - 2.3;
                blendOver(col, float3(0.09, 0.10, 0.14), smoothstep(0.5, -0.3, eye));
                float spec1 = length(lp - float2(8.3, -2.3)) - 0.85;
                blendOver(col, float3(1.0, 1.0, 1.0), smoothstep(0.4, -0.2, spec1));
                float spec2 = length(lp - float2(6.9, -0.8)) - 0.4;
                blendOver(col, float3(1.0, 1.0, 1.0), smoothstep(0.3, -0.2, spec2) * 0.7);

                // 9. Upturned pink nose + tiny cute smile + delicate thin whiskers
                float nose = length(lp - float2(14.6, -0.8)) - 2.2;
                blendOver(col, float3(0.45, 0.18, 0.26), smoothstep(0.5, -0.3, nose - 0.8));
                blendOver(col, float3(0.99, 0.56, 0.68), smoothstep(0.5, -0.3, nose));
                float smile = abs(length(lp - float2(11.6, 1.6)) - 2.1) - 0.35;
                if (lp.y > 2.4 && lp.x > 10.2 && lp.x < 13.4) {
                    blendOver(col, float3(0.28, 0.28, 0.34), smoothstep(0.5, -0.2, smile));
                }
                float w1 = sdSeg(lp, float2(13.0, 2.0), float2(20.6, 0.5)) - 0.26;
                float w2 = sdSeg(lp, float2(13.0, 2.9), float2(20.6, 3.6)) - 0.26;
                blendOver(col, float3(0.50, 0.53, 0.62), smoothstep(0.5, -0.2, min(w1, w2)) * 0.82);

                if (col.a < 0.01) discard;
                return col;
            }
        )";
        ComPtr<ID3DBlob> vsB, psB;
        if (FAILED(D3DCompile(hlsl, strlen(hlsl), nullptr, nullptr, nullptr, "VSMain", "vs_5_0", 0, 0, &vsB, nullptr))) return false;
        if (FAILED(D3DCompile(hlsl, strlen(hlsl), nullptr, nullptr, nullptr, "PSMain", "ps_5_0", 0, 0, &psB, nullptr))) return false;
        device_->CreateVertexShader(vsB->GetBufferPointer(), vsB->GetBufferSize(), nullptr, &mouseVs_);
        device_->CreatePixelShader(psB->GetBufferPointer(), psB->GetBufferSize(), nullptr, &mousePs_);

        D3D11_BUFFER_DESC cbd{};
        cbd.ByteWidth = ((sizeof(MouseCB) + 15) / 16) * 16;
        cbd.Usage = D3D11_USAGE_DYNAMIC;
        cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        device_->CreateBuffer(&cbd, nullptr, &mouseCb_);
        return true;
    }

    void SpawnBurstInternal(const BurstReq& req, std::mt19937& rng) {
        std::uniform_real_distribution<float> U(0.0f, 1.0f);
        for (int i = 0; i < req.count && static_cast<int>(particles_.size()) < MAX_PARTICLES; ++i) {
            ParticleSim p{};
            p.x = req.x + U(rng) * req.w;
            p.y = req.y + U(rng) * req.h;
            p.phase = U(rng) * 6.283185f;
            p.maxLife = 0.45f + U(rng) * 0.55f;
            p.life = p.maxLife;
            p.size = 2.2f + U(rng) * 4.6f;
            p.kind = (U(rng) < 0.35f) ? 1.0f : 0.0f;

            if (req.style == 1) { // fire
                p.vx = (U(rng) - 0.5f) * 90.0f;
                p.vy = -60.0f - U(rng) * 140.0f;
                p.grav = -40.0f;
                p.r = 1.0f; p.g = 0.35f + U(rng) * 0.5f; p.b = 0.1f;
            } else if (req.style == 2) { // frost
                p.vx = (U(rng) - 0.5f) * 80.0f;
                p.vy = -20.0f + U(rng) * 70.0f;
                p.grav = 35.0f;
                p.r = 0.65f + U(rng) * 0.3f; p.g = 0.90f + U(rng) * 0.1f; p.b = 1.0f;
            } else if (req.style == 3) { // sakura
                p.vx = 25.0f + U(rng) * 70.0f;
                p.vy = -30.0f + U(rng) * 60.0f;
                p.grav = 25.0f;
                p.r = 1.0f; p.g = 0.68f + U(rng) * 0.2f; p.b = 0.82f + U(rng) * 0.14f;
            } else if (req.style == 4) { // void
                p.vx = (U(rng) - 0.5f) * 110.0f;
                p.vy = -45.0f - U(rng) * 60.0f;
                p.grav = -15.0f;
                p.r = 0.55f + U(rng) * 0.3f; p.g = 0.25f + U(rng) * 0.25f; p.b = 1.0f;
            } else if (req.style == 5) { // glitch
                p.vx = (U(rng) - 0.5f) * 220.0f;
                p.vy = (U(rng) - 0.5f) * 60.0f;
                p.grav = 0.0f;
                bool cyan = U(rng) < 0.5f;
                p.r = cyan ? 0.1f : 1.0f; p.g = cyan ? 0.95f : 0.15f; p.b = 0.95f;
            } else { // fairy (default)
                p.vx = (U(rng) - 0.5f) * 95.0f;
                p.vy = -45.0f - U(rng) * 95.0f;
                p.grav = -20.0f;
                float pick = U(rng);
                if (pick < 0.33f) { p.r = 0.85f; p.g = 0.72f; p.b = 1.0f; }
                else if (pick < 0.66f) { p.r = 1.0f; p.g = 0.86f; p.b = 0.55f; }
                else { p.r = 1.0f; p.g = 0.72f; p.b = 0.90f; }
            }
            particles_.push_back(p);
        }
    }

    void StepTail(float mx, float my, float facing, float tSec) {
        if (!tailInit_) {
            for (int i = 0; i < 6; ++i) {
                tailX_[i] = tailOX_[i] = mx - facing * (12.0f + i * 5.5f);
                tailY_[i] = tailOY_[i] = my + 4.0f;
            }
            tailInit_ = true;
        }
        float ax = mx - facing * 12.0f, ay = my + 4.0f;
        tailX_[0] = ax; tailY_[0] = ay;
        float wag = std::sin(tSec * 5.2f) * 0.35f;
        for (int i = 1; i < 6; ++i) {
            float dx = (tailX_[i] - tailOX_[i]) * 0.86f;
            float dy = (tailY_[i] - tailOY_[i]) * 0.86f;
            tailOX_[i] = tailX_[i]; tailOY_[i] = tailY_[i];
            tailX_[i] += dx - facing * 0.18f;
            tailY_[i] += dy + 0.12f + wag * (i / 6.0f);
        }
        for (int iter = 0; iter < 3; ++iter) {
            tailX_[0] = ax; tailY_[0] = ay;
            for (int i = 1; i < 6; ++i) {
                float dx = tailX_[i] - tailX_[i - 1];
                float dy = tailY_[i] - tailY_[i - 1];
                float d = std::hypot(dx, dy);
                if (d < 0.001f) d = 0.001f;
                float diff = (d - 5.5f) / d;
                if (i == 1) {
                    tailX_[i] -= dx * diff; tailY_[i] -= dy * diff;
                } else {
                    tailX_[i - 1] += dx * diff * 0.35f; tailY_[i - 1] += dy * diff * 0.35f;
                    tailX_[i] -= dx * diff * 0.65f; tailY_[i] -= dy * diff * 0.65f;
                }
            }
        }
    }

    void RunLoop() {
        WNDCLASSW wc{};
        wc.lpfnWndProc = OverlayWndProc;
        wc.hInstance = hInst_;
        wc.lpszClassName = L"MouscordGpuOverlay";
        RegisterClassW(&wc);

        hOverlay_ = CreateWindowExW(
            WS_EX_NOREDIRECTIONBITMAP | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            L"MouscordGpuOverlay", L"", WS_POPUP,
            0, 0, 640, 480, nullptr, nullptr, hInst_, nullptr
        );
        if (!hOverlay_) return;

        if (!InitD3D(hOverlay_, 640, 480)) {
            DestroyWindow(hOverlay_);
            hOverlay_ = nullptr;
            return;
        }

        std::mt19937 rng(4242);
        std::vector<ParticleGPU> gpuBuf;
        gpuBuf.reserve(MAX_PARTICLES);

        int curX = -99999, curY = -99999, curW = 640, curH = 480;
        bool wasVisible = false;
        DWORD tStart = GetTickCount();
        DWORD tPrev = tStart;
        MSG msg{};

        while (running_) {
            while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
                if (msg.message == WM_QUIT) { running_ = false; break; }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if (!running_) break;

            // Drain incoming bursts & snapshot mouse state
            bool mVis = false, mHat = true;
            float mX = 0, mY = 0, mFac = 1.0f, mBoop = 0.0f;
            {
                std::lock_guard<std::mutex> lk(stateMtx_);
                mVis = mouseVisible_;
                mX = mouseX_; mY = mouseY_;
                mFac = mouseFacing_; mBoop = mouseBoop_;
                mHat = mouseHat_;
                for (const auto& b : pendingBursts_) SpawnBurstInternal(b, rng);
                pendingBursts_.clear();
            }

            HWND hDiscord = FindDiscordMainWindow();
            bool anyActive = snowEnabled_.load() || mVis || !particles_.empty();
            bool shouldShow = anyActive && hDiscord != nullptr && !IsIconic(hDiscord);
            if (!shouldShow) {
                if (wasVisible) { ShowWindow(hOverlay_, SW_HIDE); wasVisible = false; }
                Sleep(40);
                tPrev = GetTickCount();
                continue;
            }

            RECT rc{};
            GetWindowRect(hDiscord, &rc);
            int w = rc.right - rc.left;
            int h = rc.bottom - rc.top;
            if (w > 100 && h > 100) {
                HWND hAboveDiscord = GetWindow(hDiscord, GW_HWNDPREV);
                bool zOrderWrong = (hAboveDiscord != hOverlay_);
                if (!wasVisible || zOrderWrong || rc.left != curX || rc.top != curY || w != curW || h != curH) {
                    curX = rc.left; curY = rc.top;
                    HWND insertAfter = (hAboveDiscord && hAboveDiscord != hOverlay_) ? hAboveDiscord : HWND_TOP;
                    SetWindowPos(hOverlay_, insertAfter, rc.left, rc.top, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    wasVisible = true;
                }
                if (w != curW || h != curH) {
                    curW = w; curH = h;
                    rtv_.Reset();
                    swapChain_->ResizeBuffers(0, static_cast<UINT>(w), static_cast<UINT>(h), DXGI_FORMAT_UNKNOWN, 0);
                    CreateRTV();
                }

                DWORD tNow = GetTickCount();
                float dt = (std::min)(0.05f, (tNow - tPrev) * 0.001f);
                tPrev = tNow;
                float tSec = (tNow - tStart) * 0.001f;

                float clear[4] = { 0, 0, 0, 0 };
                ctx_->OMSetRenderTargets(1, rtv_.GetAddressOf(), nullptr);
                ctx_->ClearRenderTargetView(rtv_.Get(), clear);
                D3D11_VIEWPORT vp{ 0, 0, static_cast<float>(curW), static_cast<float>(curH), 0, 1 };
                ctx_->RSSetViewports(1, &vp);
                ctx_->RSSetState(raster_.Get());
                float bf[4] = { 0, 0, 0, 0 };
                ctx_->OMSetBlendState(blend_.Get(), bf, 0xffffffff);
                ctx_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);

                // Pass 1: Snow
                if (snowEnabled_.load()) {
                    D3D11_MAPPED_SUBRESOURCE ms{};
                    if (SUCCEEDED(ctx_->Map(snowCb_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
                        float cbData[4] = { tSec, static_cast<float>(curW) / static_cast<float>(curH), 0, 0 };
                        memcpy(ms.pData, cbData, sizeof(cbData));
                        ctx_->Unmap(snowCb_.Get(), 0);
                    }
                    UINT stride = sizeof(FlakeVert), offset = 0;
                    ctx_->IASetInputLayout(snowLayout_.Get());
                    ctx_->IASetVertexBuffers(0, 1, snowVb_.GetAddressOf(), &stride, &offset);
                    ctx_->VSSetShader(snowVs_.Get(), nullptr, 0);
                    ctx_->VSSetConstantBuffers(0, 1, snowCb_.GetAddressOf());
                    ctx_->PSSetShader(snowPs_.Get(), nullptr, 0);
                    ctx_->DrawInstanced(6, 240, 0, 0);
                }

                // Pass 2: Dissolve & Sparkle Particles
                if (!particles_.empty()) {
                    gpuBuf.clear();
                    for (size_t i = 0; i < particles_.size(); ) {
                        auto& p = particles_[i];
                        p.life -= dt;
                        if (p.life <= 0.0f) {
                            particles_[i] = particles_.back();
                            particles_.pop_back();
                            continue;
                        }
                        p.vy += p.grav * dt;
                        p.x += (p.vx + std::sin(tSec * 4.5f + p.phase) * 14.0f) * dt;
                        p.y += p.vy * dt;
                        float frac = p.life / p.maxLife;
                        float tw = 0.72f + 0.28f * std::sin(tSec * 12.0f + p.phase);
                        gpuBuf.push_back({ p.x, p.y, p.size * (0.4f + 0.6f * frac), frac * tw, p.r, p.g, p.b, p.kind });
                        ++i;
                    }
                    if (!gpuBuf.empty()) {
                        D3D11_MAPPED_SUBRESOURCE ms{};
                        if (SUCCEEDED(ctx_->Map(partCb_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
                            float cbData[4] = { static_cast<float>(curW), static_cast<float>(curH), 0, 0 };
                            memcpy(ms.pData, cbData, sizeof(cbData));
                            ctx_->Unmap(partCb_.Get(), 0);
                        }
                        if (SUCCEEDED(ctx_->Map(partVb_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
                            memcpy(ms.pData, gpuBuf.data(), gpuBuf.size() * sizeof(ParticleGPU));
                            ctx_->Unmap(partVb_.Get(), 0);
                        }
                        UINT stride = sizeof(ParticleGPU), offset = 0;
                        ctx_->IASetInputLayout(partLayout_.Get());
                        ctx_->IASetVertexBuffers(0, 1, partVb_.GetAddressOf(), &stride, &offset);
                        ctx_->VSSetShader(partVs_.Get(), nullptr, 0);
                        ctx_->VSSetConstantBuffers(0, 1, partCb_.GetAddressOf());
                        ctx_->PSSetShader(partPs_.Get(), nullptr, 0);
                        ctx_->DrawInstanced(6, static_cast<UINT>(gpuBuf.size()), 0, 0);
                    }
                }

                // Pass 3: Native GPU Mouse Cursor
                if (mVis) {
                    StepTail(mX, mY, mFac, tSec);
                    D3D11_MAPPED_SUBRESOURCE ms{};
                    if (SUCCEEDED(ctx_->Map(mouseCb_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
                        MouseCB cb{};
                        cb.pos[0] = mX; cb.pos[1] = mY;
                        cb.res[0] = static_cast<float>(curW); cb.res[1] = static_cast<float>(curH);
                        cb.facing = mFac; cb.boop = mBoop; cb.time = tSec; cb.hat = mHat ? 1.0f : 0.0f;
                        for (int k = 0; k < 6; ++k) { cb.tail[k * 2] = tailX_[k]; cb.tail[k * 2 + 1] = tailY_[k]; }
                        memcpy(ms.pData, &cb, sizeof(cb));
                        ctx_->Unmap(mouseCb_.Get(), 0);
                    }
                    ctx_->IASetInputLayout(nullptr);
                    ctx_->VSSetShader(mouseVs_.Get(), nullptr, 0);
                    ctx_->VSSetConstantBuffers(0, 1, mouseCb_.GetAddressOf());
                    ctx_->PSSetShader(mousePs_.Get(), nullptr, 0);
                    ctx_->PSSetConstantBuffers(0, 1, mouseCb_.GetAddressOf());
                    ctx_->Draw(6, 0);
                } else {
                    tailInit_ = false;
                }

                swapChain_->Present(0, 0);
                if (FAILED(DwmFlush())) Sleep(16);
            } else {
                Sleep(50);
            }
        }

        if (hOverlay_) { DestroyWindow(hOverlay_); hOverlay_ = nullptr; }
    }

    HINSTANCE hInst_ = nullptr;
    HWND hOverlay_ = nullptr;
    std::atomic<bool> running_{false};
    std::atomic<bool> snowEnabled_{false};
    std::thread worker_;

    std::mutex stateMtx_;
    bool mouseVisible_ = false;
    bool mouseHat_ = true;
    float mouseX_ = 0, mouseY_ = 0, mouseFacing_ = 1.0f, mouseBoop_ = 0.0f;
    std::vector<BurstReq> pendingBursts_;
    std::vector<ParticleSim> particles_;
    bool tailInit_ = false;
    float tailX_[6]{}, tailY_[6]{}, tailOX_[6]{}, tailOY_[6]{};

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> ctx_;
    ComPtr<IDXGISwapChain1> swapChain_;
    ComPtr<ID3D11RenderTargetView> rtv_;
    ComPtr<IDCompositionDevice> dcompDev_;
    ComPtr<IDCompositionTarget> dcompTarget_;
    ComPtr<IDCompositionVisual> dcompVisual_;
    ComPtr<ID3D11BlendState> blend_;
    ComPtr<ID3D11RasterizerState> raster_;

    ComPtr<ID3D11VertexShader> snowVs_;
    ComPtr<ID3D11PixelShader> snowPs_;
    ComPtr<ID3D11InputLayout> snowLayout_;
    ComPtr<ID3D11Buffer> snowVb_;
    ComPtr<ID3D11Buffer> snowCb_;

    ComPtr<ID3D11VertexShader> partVs_;
    ComPtr<ID3D11PixelShader> partPs_;
    ComPtr<ID3D11InputLayout> partLayout_;
    ComPtr<ID3D11Buffer> partVb_;
    ComPtr<ID3D11Buffer> partCb_;

    ComPtr<ID3D11VertexShader> mouseVs_;
    ComPtr<ID3D11PixelShader> mousePs_;
    ComPtr<ID3D11Buffer> mouseCb_;
};
