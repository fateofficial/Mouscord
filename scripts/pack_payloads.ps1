$ErrorActionPreference = "Stop"

function Pack-TextToRawChunks {
    param(
        [string]$Content,
        [string]$VarName,
        [string]$Delimiter,
        [string]$SourceComment
    )

    $maxChunkBytes = 10000
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("// AUTO-GENERATED from $SourceComment by scripts/pack_payloads.ps1 - do not edit directly.")
    [void]$sb.AppendLine("#pragma once")
    [void]$sb.AppendLine("")
    [void]$sb.Append("static const char* $VarName = ")

    $lines = $Content.Split("`n")
    $chunk = New-Object System.Text.StringBuilder
    $first = $true

    foreach ($line in $lines) {
        $lineWithNl = $line + "`n"
        $pos = 0
        while ($pos -lt $lineWithNl.Length) {
            $take = [Math]::Min(6000, $lineWithNl.Length - $pos)
            $part = $lineWithNl.Substring($pos, $take)
            $pos += $take
            $candidateLen = [System.Text.Encoding]::UTF8.GetByteCount($chunk.ToString() + $part)
            if ($chunk.Length -gt 0 -and $candidateLen -gt $maxChunkBytes) {
                if (-not $first) { [void]$sb.AppendLine("") }
                [void]$sb.Append("R`"$Delimiter(")
                [void]$sb.Append($chunk.ToString())
                [void]$sb.Append(")$Delimiter`"")
                $first = $false
                [void]$chunk.Clear()
            }
            [void]$chunk.Append($part)
        }
    }

    if ($chunk.Length -gt 0) {
        if (-not $first) { [void]$sb.AppendLine("") }
        [void]$sb.Append("R`"$Delimiter(")
        [void]$sb.Append($chunk.ToString())
        [void]$sb.Append(")$Delimiter`"")
    }

    [void]$sb.AppendLine(";")
    return $sb.ToString()
}

function Pack-JsToHeader {
    param(
        [string]$JsPath,
        [string]$HeaderPath,
        [string]$VarName,
        [string]$Delimiter
    )

    $content = [System.IO.File]::ReadAllText($JsPath, [System.Text.Encoding]::UTF8).Replace("`r`n", "`n")
    $srcName = $JsPath.Replace("\", "/")
    $content = $content + "`n//# sourceURL=dc-cleaner/$srcName`n"
    $out = Pack-TextToRawChunks -Content $content -VarName $VarName -Delimiter $Delimiter -SourceComment $JsPath
    [System.IO.File]::WriteAllText($HeaderPath, $out, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Packed $JsPath -> $HeaderPath ($($content.Length) chars)"
}

function Pack-CssToJsGlobalHeader {
    param(
        [string]$CssPath,
        [string]$HeaderPath,
        [string]$VarName,
        [string]$JsGlobalName,
        [string]$Delimiter
    )

    $rawCss = [System.IO.File]::ReadAllText($CssPath, [System.Text.Encoding]::UTF8).Replace("`r`n", "`n")
    $jsonCss = $rawCss | ConvertTo-Json -Compress
    $jsExpr = "window.$JsGlobalName = $jsonCss;`n//# sourceURL=dc-cleaner/$($CssPath.Replace('\','/'))`n"
    $out = Pack-TextToRawChunks -Content $jsExpr -VarName $VarName -Delimiter $Delimiter -SourceComment $CssPath
    [System.IO.File]::WriteAllText($HeaderPath, $out, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Packed $CssPath -> $HeaderPath ($($jsExpr.Length) chars)"
}

Pack-CssToJsGlobalHeader -CssPath "src\css\sidebar.css"        -HeaderPath "src\sidebar_css_payload.h"    -VarName "kSidebarCssPayloadJs"    -JsGlobalName "__dcSidebarCss" -Delimiter "SBCSS"
Pack-JsToHeader          -JsPath "src\js\core_runtime.js"      -HeaderPath "src\core_runtime_payload.h"   -VarName "kCoreRuntimePayloadJs"   -Delimiter "CORE"
Pack-JsToHeader          -JsPath "src\js\discord_bridge.js"    -HeaderPath "src\discord_bridge_payload.h" -VarName "kDiscordBridgePayloadJs" -Delimiter "BRIDGE"
Pack-JsToHeader          -JsPath "src\js\vfx_shaders.js"       -HeaderPath "src\vfx_shaders_payload.h"    -VarName "kVfxShadersPayloadJs"    -Delimiter "SHADERS"
Pack-JsToHeader          -JsPath "src\js\vfx.js"               -HeaderPath "src\vfx_payload.h"            -VarName "kVfxPayloadJs"           -Delimiter "VFX"
Pack-JsToHeader          -JsPath "src\js\mouse_cursor.js"      -HeaderPath "src\mouse_cursor_payload.h"   -VarName "kMouseCursorPayloadJs"   -Delimiter "MOUSE"
Pack-JsToHeader          -JsPath "src\js\popout_chat.js"       -HeaderPath "src\popout_chat_payload.h"    -VarName "kPopoutChatPayloadJs"    -Delimiter "POPOUT"
Pack-JsToHeader          -JsPath "src\js\snow_shader.js"       -HeaderPath "src\snow_shader_payload.h"    -VarName "kSnowShaderPayloadJs"    -Delimiter "SNOW"
Pack-JsToHeader          -JsPath "src\js\filter.js"            -HeaderPath "src\filter_payload.h"         -VarName "kFilterPayloadJs"        -Delimiter "FILTER"
Pack-JsToHeader          -JsPath "src\js\delete_engine.js"     -HeaderPath "src\delete_engine_payload.h"  -VarName "kDeleteEnginePayloadJs"  -Delimiter "ENGINE"
Pack-JsToHeader          -JsPath "src\js\sidebar.js"           -HeaderPath "src\sidebar_payload.h"        -VarName "kSidebarPayloadJs"       -Delimiter "PAYLOAD"
