# ============================================================
# 抖音自动续火 - Windows Server 部署收尾脚本（v2）
#
# 相比 v1 的改进：
#   - 不再全局开启 $ErrorActionPreference = 'Stop'
#     外部命令（npm / winget / msiexec）往 stderr 写提示会被误判成致命错误
#   - 每步显式检查 $LASTEXITCODE 并给出明确结果
#   - 已完成的步骤自动跳过，可重复运行（幂等）
#
# 用法（管理员 PowerShell）：
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   .\deploy-server.ps1 -ProjectZip "C:\Users\Administrator\Desktop\douyin-auto-spark-deploy.zip"
# ============================================================

param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectZip,

    [string]$InstallDir = 'C:\douyin-auto-spark'
)

# 注意：这里刻意不用 Stop，避免外部命令写 stderr 就中断整个脚本。
$ErrorActionPreference = 'Continue'

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==== $Message ====" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [警告] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  [失败] $Message" -ForegroundColor Red
}

# 执行外部命令，只按退出码判断成败，忽略 stderr 噪音。
function Invoke-External {
    param(
        [string]$Exe,
        [string[]]$Arguments,
        [string]$Label
    )

    Write-Host "  执行: $Exe $($Arguments -join ' ')"
    $output = & $Exe @Arguments 2>&1
    $code = $LASTEXITCODE

    if ($code -eq 0) {
        Write-Ok "$Label（退出码 0）"
        return $true
    }

    Write-Fail "$Label（退出码 $code）"
    $output | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    return $false
}

# ---------- 0. 前置检查 ----------
Write-Step '前置检查'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail '请以管理员身份运行 PowerShell 后再执行本脚本'
    exit 1
}
Write-Ok '管理员权限'

if (-not (Test-Path $ProjectZip)) {
    Write-Fail "找不到项目压缩包：$ProjectZip"
    exit 1
}
Write-Ok "项目包存在：$ProjectZip"

$os = Get-CimInstance Win32_OperatingSystem
$memGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
Write-Ok "系统：$($os.Caption)"
Write-Ok "内存：$memGb GB"
if ($memGb -lt 3) {
    Write-Warn '内存低于 3 GB，Chrome 运行可能不稳定'
}

# ---------- 1. Node.js ----------
Write-Step '检查 Node.js'

$nodeVersion = $null
try { $nodeVersion = (& node --version 2>$null) } catch { }

if ($nodeVersion -and $nodeVersion -match '^v(\d+)' -and [int]$Matches[1] -ge 20) {
    Write-Ok "已安装 Node.js $nodeVersion，跳过"
} else {
    Write-Host '  未检测到可用的 Node.js（需 20+），开始安装...'

    $installed = $false
    try {
        $installed = Invoke-External -Exe 'winget' -Label 'winget 安装 Node.js' -Arguments @(
            'install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent',
            '--accept-source-agreements', '--accept-package-agreements'
        )
    } catch {
        Write-Warn "winget 不可用：$($_.Exception.Message)"
    }

    if (-not $installed) {
        Write-Host '  改用官方 MSI 安装...'
        $msi = Join-Path $env:TEMP 'node-install.msi'
        Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.23.3/node-v22.23.3-x64.msi' `
            -OutFile $msi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    }

    # 刷新 PATH
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

# 复核
$nodeVersion = $null
try { $nodeVersion = (& node --version 2>$null) } catch { }
if (-not $nodeVersion) {
    Write-Fail 'Node.js 安装后仍不可用，请手动安装后重跑本脚本'
    exit 1
}
Write-Ok "Node.js：$nodeVersion"

# ---------- 2. pnpm ----------
Write-Step '检查 pnpm'

$pnpmVersion = $null
try { $pnpmVersion = (& pnpm --version 2>$null) } catch { }

if ($pnpmVersion) {
    Write-Ok "已安装 pnpm $pnpmVersion，跳过"
} else {
    Write-Host '  未检测到 pnpm，开始安装...'
    Invoke-External -Exe 'npm' -Label 'npm 安装 pnpm' -Arguments @('install', '-g', 'pnpm') | Out-Null

    $pnpmVersion = $null
    try { $pnpmVersion = (& pnpm --version 2>$null) } catch { }
    if (-not $pnpmVersion) {
        Write-Fail 'pnpm 安装失败'
        exit 1
    }
    Write-Ok "pnpm：$pnpmVersion"
}

# ---------- 3. Chrome ----------
Write-Step '检查 Google Chrome'

$chromeCandidates = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
$chromeExe = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chromeExe) {
    Write-Ok "已安装 Chrome：$chromeExe"
} else {
    Write-Host '  未检测到 Chrome，开始安装...'
    $installer = Join-Path $env:TEMP 'chrome-installer.exe'
    Invoke-WebRequest -Uri 'https://dl.google.com/chrome/install/latest/chrome_installer.exe' `
        -OutFile $installer -UseBasicParsing
    Start-Process $installer -ArgumentList '/silent', '/install' -Wait
    Start-Sleep -Seconds 5

    $chromeExe = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $chromeExe) {
        Write-Fail 'Chrome 安装后仍未找到 chrome.exe'
        exit 1
    }
    Write-Ok "Chrome：$chromeExe"
}

# ---------- 4. 解压项目 ----------
Write-Step '部署项目文件'

if (Test-Path $InstallDir) {
    $backup = "$InstallDir.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Write-Warn "目录已存在，备份到：$backup"
    Move-Item $InstallDir $backup -Force
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -Path $ProjectZip -DestinationPath $InstallDir -Force
Write-Ok "已解压到：$InstallDir"

# 若压缩包多套了一层目录，下探一次
if (-not (Test-Path (Join-Path $InstallDir 'package.json'))) {
    $dirs = Get-ChildItem $InstallDir -Directory
    if ($dirs.Count -eq 1 -and (Test-Path (Join-Path $dirs[0].FullName 'package.json'))) {
        Write-Warn '检测到嵌套目录，正在修正...'
        $inner = $dirs[0].FullName
        Get-ChildItem $inner -Force | Move-Item -Destination $InstallDir -Force
        Remove-Item $inner -Recurse -Force
    }
}

if (-not (Test-Path (Join-Path $InstallDir 'package.json'))) {
    Write-Fail "部署失败：$InstallDir 下找不到 package.json"
    exit 1
}
Write-Ok '项目结构正确'

# ---------- 5. 安装依赖 ----------
Write-Step '安装项目依赖'

Push-Location $InstallDir
$depsOk = Invoke-External -Exe 'cmd' -Label 'pnpm install' -Arguments @('/c', 'pnpm install --frozen-lockfile 2>&1')
Pop-Location

if (-not $depsOk) {
    Write-Fail '依赖安装失败，请手动在项目目录运行 pnpm install'
    exit 1
}

# ---------- 6. 校正浏览器路径 ----------
Write-Step '校正 .env 中的浏览器路径'

$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
    Write-Warn "未找到 .env，请手动从 .env.example 复制并填写账号配置"
} else {
    $chromeEnvPath = $chromeExe -replace '\\', '/'
    $content = Get-Content $envFile -Raw -Encoding UTF8

    if ($content -match '(?m)^PLAYWRIGHT_BROWSER_PATH=') {
        $content = $content -replace '(?m)^PLAYWRIGHT_BROWSER_PATH=.*$', "PLAYWRIGHT_BROWSER_PATH=$chromeEnvPath"
    } else {
        $content = "PLAYWRIGHT_BROWSER_PATH=$chromeEnvPath`r`n" + $content
    }

    [IO.File]::WriteAllText($envFile, $content, (New-Object Text.UTF8Encoding $false))
    Write-Ok "PLAYWRIGHT_BROWSER_PATH=$chromeEnvPath"
}

# ---------- 7. 计划任务 ----------
Write-Step '注册计划任务'

$runScript = Join-Path $InstallDir 'run-daily.ps1'
if (-not (Test-Path $runScript)) {
    Write-Warn "找不到 run-daily.ps1，跳过计划任务注册"
} else {
    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runScript`"" `
        -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    $taskPrincipal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

    Register-ScheduledTask `
        -TaskName 'DouyinAutoSpark-DailyOnFirstBoot' `
        -Description '每次登录后自动发送抖音续火消息（当天已发送则跳过）' `
        -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null

    Write-Ok '计划任务已注册：DouyinAutoSpark-DailyOnFirstBoot'
}

# ---------- 完成 ----------
Write-Step '部署完成'

Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host "  cd $InstallDir"
Write-Host '  pnpm dev'
Write-Host ''
Write-Host '首次运行会在弹出的 Chrome 窗口里等待扫码登录，登录后自动开始续火。'
Write-Host ''
