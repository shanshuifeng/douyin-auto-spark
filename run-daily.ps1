# 每天只运行一次抖音续火（开机触发时调用）
# 逻辑：检查状态文件记录的日期，若今天已跑过则直接退出
#
# 可选参数：
#   -DryRun    演练模式：走完整流程但不真正发送消息（不按回车），
#              用于验证部署与配置，不会给好友发消息。

param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 项目目录 = 本脚本所在目录。
# 这样同一份脚本在本机、服务器、任意路径下都能正常工作，不需要改路径。
$ProjectDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$StateFile  = Join-Path $ProjectDir '.last-run.json'
$LogFile    = Join-Path $ProjectDir 'logs\run.log'
$NotifyScript = Join-Path $ProjectDir 'notify.ps1'

# 确保日志目录存在
$LogDir = Split-Path $LogFile -Parent
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# 兜底：任何未捕获的异常都写进日志，避免「任务跑了但什么都没留下」。
trap {
    $msg = "[{0}] 未捕获异常：{1}`r`n{2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message, $_.ScriptStackTrace
    try { Add-Content -Path $LogFile -Value $msg -Encoding UTF8 } catch { }
    exit 1
}

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

# 演练模式不做「今天是否已运行」判断，也不写状态文件，可随时重复执行。
if ($DryRun) {
    Write-Log '==== 演练模式（DRY_RUN）：不会真正发送消息 ===='
} else {
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
}

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
    # 优先找到 pnpm.cmd 的绝对路径：计划任务环境里 Get-Command 可能只解析到 .ps1 包装，
    # 直接调用 .cmd 更稳定。
    $pnpmCmd = $null
    foreach ($candidate in @(
            "$env:APPDATA\npm\pnpm.cmd",
            "$env:LOCALAPPDATA\pnpm\pnpm.exe",
            'C:\Program Files\nodejs\pnpm.cmd'
        )) {
        if (Test-Path $candidate) { $pnpmCmd = $candidate; break }
    }
    if (-not $pnpmCmd) {
        $found = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
        if ($found) { $pnpmCmd = $found.Source }
    }
    if (-not $pnpmCmd) {
        Write-Log '找不到 pnpm.cmd，无法继续'
        Send-Notify -Title '抖音续火失败' -Message '服务器上找不到 pnpm，请检查 Node.js 安装' -Level error
        exit 1
    }
    Write-Log "使用 pnpm：$pnpmCmd"

    # 关键：不用 cmd /c 包装。
    # cmd /c "A && B" 经过管道后 $LASTEXITCODE 会被管道中的 cmdlet 覆盖，
    # 导致已经成功发送也被判成失败。这里直接调用 pnpm.cmd 并立即取退出码。
    #
    # 另外：全局 $ErrorActionPreference = 'Stop' 时，`2>&1` 会把 pnpm 写到 stderr
    # 的提示行（例如 "$ tsx src/main.ts"）当成 NativeCommandError 直接抛出，
    # 表现为「只输出第一行就异常退出」。因此调用期间临时放宽到 'Continue'。
    $prevCP = [Console]::OutputEncoding
    $prevEAP = $ErrorActionPreference
    try {
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $ErrorActionPreference = 'Continue'
        if ($DryRun) {
            # 演练模式通过环境变量通知 Node 侧不要真的发送
            $env:DRY_RUN = 'true'
        } else {
            Remove-Item Env:\DRY_RUN -ErrorAction SilentlyContinue
        }
        $rawOutput = & $pnpmCmd dev 2>&1
        # 必须在任何其他语句之前取退出码
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEAP
        [Console]::OutputEncoding = $prevCP
        Remove-Item Env:\DRY_RUN -ErrorAction SilentlyContinue
    }

    if ($rawOutput) {
        Add-Content -Path $LogFile -Value ($rawOutput | Out-String) -Encoding UTF8
    }

    Write-Log "pnpm dev 退出码: $exitCode"

    if ($DryRun) {
        Write-Log '演练模式结束，未记录日期（不会影响今天的正式运行）'
        exit 0
    }

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
