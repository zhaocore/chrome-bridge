#Requires -Version 5.1
<#
.SYNOPSIS
  chrome-bridge bootstrap installer (Windows)

.DESCRIPTION
  Usage:
    irm https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.ps1 | iex
    irm https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.ps1 | iex -NoStart
    irm https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/bin/install.ps1 | iex -NoSkill

  What it does:
    1. Detect arch (Windows; arm64 / amd64)
    2. Download binary from GitHub to ~/.chrome-bridge/bin/chrome-bridge.exe
    3. Start the daemon (unless -NoStart)
    4. Install skills to detected AI agent runtimes (unless -NoSkill)
#>

# ---------- config ----------

$script:GitHubRepo = "zhaocore/chrome-bridge-api"
$script:GitHubRef  = "master"
$script:BaseUrl    = "https://github.com/$script:GitHubRepo/raw/refs/heads/$script:GitHubRef"
$script:InstallDir = Join-Path $HOME ".chrome-bridge"
$script:BinDir     = Join-Path $script:InstallDir "bin"
$script:BinPath    = Join-Path $script:BinDir "chrome-bridge.exe"

# ---------- output ----------

function Write-Info([string]$Msg) { Write-Host "==> $Msg" -ForegroundColor White }
function Write-Ok  ([string]$Msg) { Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn([string]$Msg) { Write-Host "[!] $Msg" -ForegroundColor Yellow }
function Write-Err ([string]$Msg) { Write-Host "[X] $Msg" -ForegroundColor Red }

function Show-Help {
  Write-Host @"
chrome-bridge bootstrap installer (Windows)

Usage:
  irm $script:BaseUrl/bin/install.ps1 | iex                              # latest (master)
  $env:NO_START=1; irm $script:BaseUrl/bin/install.ps1 | iex             # skip daemon start
  $env:NO_SKILL=1; irm $script:BaseUrl/bin/install.ps1 | iex             # skip skill install
  & ([scriptblock]::Create((irm $script:BaseUrl/bin/install.ps1))) -NoStart   # alt: pass params directly

Options (via [scriptblock]::Create or env vars):
  -Help / $env:HELP=1       Show this help.
  -NoStart / $env:NO_START=1    Install binary and skills, but don't start the daemon.
  -NoSkill / $env:NO_SKILL=1    Install binary and start the daemon, but skip skill installation.

What it does:
  1. Detect arch (Windows; arm64 / amd64)
  2. Download chrome-bridge binary from GitHub to $script:BinPath
  3. Start the daemon (unless -NoStart)
  4. Install skills to detected AI-agent runtimes (unless -NoSkill)
"@
}

# ---------- args ----------

# irm | iex 不支持直接传参，提供两种方式:
#   1. 环境变量: $env:NO_START=1; irm url | iex
#   2. scriptblock: & ([scriptblock]::Create((irm url))) -NoStart
$script:NoStart = $false
$script:NoSkill = $false

# 优先解析命令行参数 (scriptblock 方式)
$argList = @($args)

foreach ($a in $argList) {
  switch ($a) {
    "-Help"     { Show-Help; exit 0 }
    "-NoStart"  { $script:NoStart = $true }
    "-NoSkill"  { $script:NoSkill = $true }
    default     { Write-Err "unknown option: $a"; Write-Host ""; Show-Help; exit 2 }
  }
}

# 环境变量回退 (irm | iex 方式)
if ($env:NO_START -eq "1") { $script:NoStart = $true }
if ($env:NO_SKILL -eq "1") { $script:NoSkill = $true }
if ($env:HELP -eq "1")     { Show-Help; exit 0 }

# ---------- detect arch ----------

Write-Info "Detecting arch..."
$arch = $env:PROCESSOR_ARCHITECTURE
if (-not $arch) {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
}

switch ($arch) {
  { $_ -match "ARM64|arm64" } { $script:Arch = "arm64" }
  { $_ -match "AMD64|amd64|x64|X64" } { $script:Arch = "amd64" }
  default {
    Write-Err "unsupported arch: $arch. Supported: amd64, arm64."
    exit 1
  }
}

$platform = "windows-$script:Arch"
Write-Ok "Platform: $platform"

# ---------- download binary ----------

# 二进制文件直接提交在仓库 bin/ 目录下
# e.g. https://github.com/zhaocore/chrome-bridge-api/raw/refs/heads/master/bin/chrome-bridge-windows-amd64.exe
$binUrl = "$script:BaseUrl/bin/chrome-bridge-$platform.exe"
Write-Info "Downloading binary from $binUrl"

if (-not (Test-Path $script:BinDir)) {
  New-Item -ItemType Directory -Path $script:BinDir -Force | Out-Null
}

$tmpBin = Join-Path $env:TEMP "chrome-bridge-$([System.Guid]::NewGuid().ToString('N').Substring(0,8)).exe"

try {
  # PowerShell 5.1 用 Invoke-WebRequest，支持重试
  $maxRetries = 3
  $retryCount = 0
  $downloaded = $false
  while (-not $downloaded -and $retryCount -lt $maxRetries) {
    try {
      Invoke-WebRequest -Uri $binUrl -OutFile $tmpBin -UseBasicParsing -ErrorAction Stop
      $downloaded = $true
    } catch {
      $retryCount++
      if ($retryCount -lt $maxRetries) {
        Write-Warn "download attempt $retryCount failed, retrying..."
        Start-Sleep -Seconds 2
      } else {
        throw
      }
    }
  }
} catch {
  Write-Err "failed to download binary: $_"
  if (Test-Path $tmpBin) { Remove-Item $tmpBin -Force }
  exit 1
}

Move-Item -Path $tmpBin -Destination $script:BinPath -Force
Write-Ok "Installed to $script:BinPath"

# ---------- start daemon ----------

if (-not $script:NoStart) {
  Write-Info "Starting daemon..."
  try {
    & $script:BinPath start
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Daemon started"
    } else {
      $logPath = Join-Path $script:InstallDir "logs/daemon.log"
      Write-Warn "Daemon failed to start - check logs at $logPath"
    }
  } catch {
    $logPath = Join-Path $script:InstallDir "logs/daemon.log"
    Write-Warn "Daemon failed to start - check logs at $logPath"
  }
} else {
  Write-Info "Skipping daemon start (-NoStart)"
}

# ---------- install skill ----------

if (-not $script:NoSkill) {
  Write-Info "Installing skills..."
  try {
    & $script:BinPath install-skill -y
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Skills installed"
    } else {
      Write-Warn "Some skill installations failed"
    }
  } catch {
    Write-Warn "Some skill installations failed"
  }
} else {
  Write-Info "Skipping skill install (-NoSkill)"
}

Write-Host ""
Write-Host "[OK] Done. Check status anytime: chrome-bridge status" -ForegroundColor Green
Write-Host ""
