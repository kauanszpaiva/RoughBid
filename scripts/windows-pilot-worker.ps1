[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('Install','Start','Run','Stop','Restart','Status','Uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$stateDirectory = [IO.Path]::GetFullPath($config.stateDirectory)
$enabledPath = Join-Path $stateDirectory 'enabled'
$stopPath = Join-Path $stateDirectory 'stop-request'
$statusPath = Join-Path $stateDirectory 'status.json'
$taskName = 'RoughBid Pilot Worker'
$runName = 'RoughBidPilotWorker'
$controller = $PSCommandPath
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launchArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Run -ConfigPath "{1}"' -f $controller, $ConfigPath
function Get-PilotStatus {
    if (!(Test-Path -LiteralPath $statusPath)) { return [pscustomobject]@{ state = 'not_started'; enabled = (Test-Path -LiteralPath $enabledPath) } }
    $current = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $running = $false
    if ($current.supervisorPid) { $running = $null -ne (Get-Process -Id $current.supervisorPid -ErrorAction SilentlyContinue) }
    $current | Add-Member -NotePropertyName supervisorRunning -NotePropertyValue $running -Force
    $current | Add-Member -NotePropertyName enabled -NotePropertyValue (Test-Path -LiteralPath $enabledPath) -Force
    return $current
}
function Start-Pilot {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
    Set-Content -LiteralPath $enabledPath -Value ([DateTime]::UtcNow.ToString('o'))
    Start-Process -FilePath $powershell -ArgumentList $launchArguments -WindowStyle Hidden | Out-Null
}
function Stop-Pilot {
    if (Test-Path -LiteralPath $enabledPath) { Remove-Item -LiteralPath $enabledPath }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    Set-Content -LiteralPath $stopPath -Value ([DateTime]::UtcNow.ToString('o'))
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $current = Get-PilotStatus
        if (!$current.supervisorRunning -or $current.state -eq 'stopped') { return }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The worker is still draining. Automatic restart is disabled; inspect status before restarting. No process was force-killed.'
}
switch ($Action) {
    'Install' {
        New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        try {
            $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $launchArguments -WorkingDirectory $config.repository
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
            $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval ([TimeSpan]::FromMinutes(1)) -MultipleInstances IgnoreNew
            Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'RoughBid worker. Requires this PC awake, network, and this Windows user signed in. No paid validation tests.' -Force | Out-Null
            Write-Output 'Installed logon task. Start is a separate explicit action.'
        } catch {
            $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
            New-Item -Path $runPath -Force | Out-Null
            New-ItemProperty -Path $runPath -Name $runName -Value ('"{0}" {1}' -f $powershell, $launchArguments) -PropertyType String -Force | Out-Null
            Write-Output 'Scheduled task unavailable; installed current-user logon entry. Supervisor still restarts failed worker processes.'
        }
    }
    'Run' { & $config.nodePath (Join-Path $config.repository 'scripts\windows-pilot-supervisor.mjs') $ConfigPath; exit $LASTEXITCODE }
    'Start' { Start-Pilot; Get-PilotStatus | ConvertTo-Json -Depth 4 }
    'Stop' { Stop-Pilot; Get-PilotStatus | ConvertTo-Json -Depth 4 }
    'Restart' { Stop-Pilot; Start-Pilot; Get-PilotStatus | ConvertTo-Json -Depth 4 }
    'Status' { Get-PilotStatus | ConvertTo-Json -Depth 4 }
    'Uninstall' {
        Stop-Pilot
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runName -ErrorAction SilentlyContinue
        Write-Output 'Removed worker autostart. Configuration, logs and checkpoints were preserved.'
    }
}
