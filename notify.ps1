# 发送 Windows 通知（Toast）或回退到消息框
# 由 run-daily.ps1 调用，也可单独测试：
#   powershell.exe -NoProfile -File notify.ps1 -Title "标题" -Message "内容" -Level error

param(
    [Parameter(Mandatory = $true)]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [string]$Message,

    [ValidateSet('info', 'error', 'warn')]
    [string]$Level = 'info',

    [int]$DisplaySeconds = 30
)

$ErrorActionPreference = 'Continue'

# 图标与声音随级别变化
$scenario = if ($Level -eq 'error') { 'urgent' } else { 'default' }
$iconText = switch ($Level) {
    'error' { '失败' }
    'warn'  { '警告' }
    default { '提示' }
}

function Send-Toast {
    param([string]$Title, [string]$Body, [string]$IconText)

    # WinRT 类型只在 Windows PowerShell 5.1 可用，PowerShell 7 需显式加载
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

    # 使用 PowerShell 自带 AppId，无需注册应用
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

    $escapedTitle = [System.Security.SecurityElement]::Escape($Title)
    $escapedBody = [System.Security.SecurityElement]::Escape($Body)
    $escapedIcon = [System.Security.SecurityElement]::Escape($IconText)

    $xmlString = @"
<toast scenario="$scenario">
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedBody</text>
      <text placement="attribution">$escapedIcon</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default" />
</toast>
"@

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlString)

    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
}

function Send-MessageBox {
    param([string]$Title, [string]$Body, [string]$IconText)

    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($Level -eq 'error') {
        [System.Windows.Forms.MessageBoxIcon]::Error
    } elseif ($Level -eq 'warn') {
        [System.Windows.Forms.MessageBoxIcon]::Warning
    } else {
        [System.Windows.Forms.MessageBoxIcon]::Information
    }

    [System.Windows.Forms.MessageBox]::Show(
        $Body,
        "[$IconText] $Title",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        $icon
    ) | Out-Null
}

# 优先 Toast；失败则回退到消息框
try {
    Send-Toast -Title $Title -Body $Message -IconText $iconText
    Write-Output 'TOAST_OK'
} catch {
    Write-Output "TOAST_FAIL: $($_.Exception.Message)"
    try {
        Send-MessageBox -Title $Title -Body $Message -IconText $iconText
        Write-Output 'MSGBOX_OK'
    } catch {
        Write-Output "MSGBOX_FAIL: $($_.Exception.Message)"
        exit 1
    }
}

exit 0
