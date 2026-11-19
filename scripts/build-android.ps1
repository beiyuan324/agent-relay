param(
    [ValidateSet("aarch64", "x86_64")][string]$Target = "aarch64",
    [switch]$Debug,
    [string]$GradleInitScript = ""
)
$ErrorActionPreference = "Stop"
$relayRoot = Split-Path -Parent $PSScriptRoot
$relayAndroid = Join-Path $relayRoot "src-tauri/gen/android"
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android/Sdk" }
if (-not $env:NDK_HOME) { $env:NDK_HOME = Join-Path $env:ANDROID_HOME "ndk/28.2.13676358" }
if (-not (Test-Path -LiteralPath (Join-Path $env:NDK_HOME "source.properties"))) { throw "请先安装 Android SDK 36、Build Tools 36.0.0 和 NDK 28.2.13676358。" }
$relayLocalCredential = Join-Path $env:USERPROFILE ".tauri/agent-relay-android-signing.clixml"
$relayLoadedCredential = $false
if (-not $Debug) {
    if (-not $env:RELAY_ANDROID_KEYSTORE) { $env:RELAY_ANDROID_KEYSTORE = Join-Path $env:USERPROFILE ".tauri/agent-relay-android-release.jks" }
    if (-not $env:RELAY_ANDROID_STORE_PASSWORD -and (Test-Path -LiteralPath $relayLocalCredential)) {
        $relayCredential = Import-Clixml -LiteralPath $relayLocalCredential
        $env:RELAY_ANDROID_STORE_PASSWORD = $relayCredential.GetNetworkCredential().Password
        $env:RELAY_ANDROID_KEY_ALIAS = $relayCredential.UserName
        $relayLoadedCredential = $true
    }
    if (-not (Test-Path -LiteralPath $env:RELAY_ANDROID_KEYSTORE) -or -not $env:RELAY_ANDROID_STORE_PASSWORD) { throw "请提供安卓发布签名密钥和 RELAY_ANDROID_STORE_PASSWORD。" }
}
$relayPreviousFlags = $env:CARGO_ENCODED_RUSTFLAGS
$relayBuildFlags = @("--remap-path-prefix=$env:USERPROFILE=/build/user", "--remap-path-prefix=$relayRoot=/build/agent-relay")
$env:CARGO_ENCODED_RUSTFLAGS = (@($relayPreviousFlags) + $relayBuildFlags | Where-Object { $_ }) -join [char]0x1f
$relayLog = [System.IO.Path]::GetTempFileName()
Push-Location -LiteralPath $relayRoot
try {
    $relayArgs = @("run", "tauri", "--", "android", "build", "--target", $Target, "--apk", "--ci")
    if ($Debug) { $relayArgs += "--debug" }
    & npm @relayArgs 2>&1 | Tee-Object -FilePath $relayLog
    if ($LASTEXITCODE -ne 0) {
        $relayOutput = Get-Content -LiteralPath $relayLog -Raw
        if ($relayOutput -notmatch "Failed to create a symbolic link") { throw "Tauri 安卓构建失败，请查看以上输出。" }
        $relayProfile = if ($Debug) { "debug" } else { "release" }
        $relayAbi = if ($Target -eq "aarch64") { "arm64-v8a" } else { "x86_64" }
        $relayFlavor = if ($Target -eq "aarch64") { "Arm64" } else { "X86_64" }
        $relayVariant = if ($Debug) { "Debug" } else { "Release" }
        $relayLibrary = Join-Path $relayRoot "target/$Target-linux-android/$relayProfile/libagent_relay_lib.so"
        $relayJni = Join-Path $relayAndroid "app/src/main/jniLibs/$relayAbi"
        New-Item -ItemType Directory -Path $relayJni -Force | Out-Null
        Copy-Item -LiteralPath $relayLibrary -Destination (Join-Path $relayJni "libagent_relay_lib.so") -Force
        Push-Location -LiteralPath $relayAndroid
        try {
            $relayGradle = Join-Path $relayAndroid "gradlew.bat"
            $relayCachedGradle = Get-ChildItem -Path (Join-Path $env:USERPROFILE ".gradle/wrapper/dists/gradle-9.3.1-bin/*/gradle-9.3.1/bin/gradle.bat") -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($relayCachedGradle) { $relayGradle = $relayCachedGradle.FullName }
            $relayGradleArgs = @("assemble$relayFlavor$relayVariant", "-x", "rustBuild$relayFlavor$relayVariant", "--console=plain")
            if ($GradleInitScript) { $relayGradleArgs += @("--init-script", $GradleInitScript) }
            & $relayGradle @relayGradleArgs
            if ($LASTEXITCODE -ne 0) { throw "Gradle 安卓打包失败。" }
        } finally { Pop-Location }
    }
} finally {
    Pop-Location
    Remove-Item -LiteralPath $relayLog -ErrorAction SilentlyContinue
    if ($relayLoadedCredential) { Remove-Item Env:RELAY_ANDROID_STORE_PASSWORD }
    $env:CARGO_ENCODED_RUSTFLAGS = $relayPreviousFlags
}
