# 每天只运行一次抖音续火（开机触发时调用）
# 逻辑：检查状态文件记录的日期，若今天已跑过则直接退出

$ErrorActionPreference = 'Stop'

$ProjectDir = 'C:\Users\Administrator\Documents\douyin-auto-spark'
$StateFile  = Join-Path $ProjectDir '.last-run.json'
$LogFile    = Join-Path $ProjectDir 'logs\run.log'
$NotifyScript = Join-Path $ProjectDir 'notify.ps1'

# 确保日志目录存在
$LogDir = Split-Path $LogFile -Parent
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Output $line
}

# 发送桌面通知；失败不影响主流程
function Send-Notify {
    param(
        [string]$Title,
        [string]$Message,
        [string]$Level = 'error'
    )

    if (-not (Test-Path $NotifyScript)) {
        Write-Log "通知脚本不存在，跳过通知"
        return
    }

    try {
        # WinRT Toast 需要 Windows PowerShell 5.1，因此显式调用 powershell.exe
        $result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $NotifyScript `
            -Title $Title -Message $Message -Level $Level 2>&1 | Out-String
        Write-Log "通知发送结果: $($result.Trim())"
    } catch {
        Write-Log "通知发送异常: $($_.Exception.Message)"
    }
}

$Today = Get-Date -Format 'yyyy-MM-dd'

# 读取上次运行日期
$LastRun = $null
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $LastRun = $state.date
    } catch {
        Write-Log "状态文件损坏，忽略：$($_.Exception.Message)"
    }
}

if ($LastRun -eq $Today) {
    Write-Log "今天（$Today）已运行过，跳过"
    exit 0
}

Write-Log "开始运行续火（今天首次）"

# 等待网络就绪（开机后网络可能需要几秒）
$netReady = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Test-NetConnection -ComputerName 'www.douyin.com' -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($r) { $netReady = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}

if (-not $netReady) {
    Write-Log "网络未就绪（等待 60 秒后仍失败），放弃本次运行"
    Send-Notify -Title '抖音续火失败' `
        -Message "网络未就绪，本次续火未执行。下次开机会自动重试。" `
        -Level error
    exit 1
}

Write-Log "网络已就绪，启动续火"

Push-Location $ProjectDir
try {
    # cmd 子进程输出默认是 GBK（936），PowerShell 按 UTF-8 解码会乱码，
    # 因此先切到 UTF-8 代码页再调用。
    $prevCP = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        & cmd /c "chcp 65001 >nul && pnpm dev 2>&1" | Out-String | ForEach-Object {
            Add-Content -Path $LogFile -Value $_ -Encoding UTF8
        }
    } finally {
        [Console]::OutputEncoding = $prevCP
    }
    $exitCode = $LASTEXITCODE
    Write-Log "pnpm dev 退出码: $exitCode"

    if ($exitCode -eq 0) {
        # 只有成功才记录日期，失败则允许当天重试
        $newState = @{
            date      = $Today
            timestamp = (Get-Date -Format 'o')
        } | ConvertTo-Json
        Set-Content -Path $StateFile -Value $newState -Encoding UTF8
        Write-Log "运行成功，已记录日期 $Today"
    } else {
        Write-Log "运行失败（退出码 $exitCode），不记录日期，下次开机可重试"

        # 从日志中提取失败原因，让通知更有用
        $reason = '未知原因'
        try {
            $tail = Get-Content $LogFile -Encoding UTF8 -Tail 40
            $failLine = $tail | Where-Object { $_ -match '失败｜|Cookie 可能已经失效|登录超时|搜索框未出现|未全部成功' } | Select-Object -Last 1
            if ($failLine) {
                $reason = $failLine.Trim() -replace '^\[.*?\]\s*', ''
                if ($reason.Length -gt 80) { $reason = $reason.Substring(0, 80) + '...' }
            }
        } catch { }

        Send-Notify -Title '抖音续火失败' `
            -Message "退出码 $exitCode`n$reason`n详情见 logs\run.log，下次开机会重试。" `
            -Level error
    }
} catch {
    Write-Log "执行异常：$($_.Exception.Message)"
    Send-Notify -Title '抖音续火异常' `
        -Message "$($_.Exception.Message)`n详情见 logs\run.log" `
        -Level error
    exit 1
} finally {
    Pop-Location
}
