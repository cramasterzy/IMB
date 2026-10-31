param(
  [Parameter(Mandatory = $true)]
  [string]$LatestExe,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [switch]$WaitForExit
)

$ErrorActionPreference = 'Stop'
$resolvedExe = (Resolve-Path -LiteralPath $LatestExe -ErrorAction Stop).Path
$latestDirectory = Split-Path -Parent $resolvedExe
$projectDirectory = Split-Path -Parent $PSScriptRoot
$currentDirectory = Join-Path $projectDirectory 'current\win-unpacked'
$currentExe = Join-Path $currentDirectory 'Infinite Media Board.exe'

function Get-RunningCurrentProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'Infinite Media Board.exe' -and $_.ExecutablePath -eq $currentExe
  }
}

$runningCurrentProcesses = @(Get-RunningCurrentProcesses)
if ($runningCurrentProcesses.Count -gt 0 -and -not $WaitForExit) {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $PSCommandPath + '"'),
    '-LatestExe', ('"' + $resolvedExe + '"'),
    '-Version', ('"' + $Version + '"'),
    '-WaitForExit'
  )
  $deferred = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
  [pscustomobject]@{
    PublishedVersion = $Version
    Status = 'DeferredUntilExit'
    UpdaterPid = $deferred.Id
    StableExecutable = $currentExe
  }
  return
}

while (@(Get-RunningCurrentProcesses).Count -gt 0) {
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Path $currentDirectory -Force | Out-Null
Copy-Item -Path (Join-Path $latestDirectory '*') -Destination $currentDirectory -Recurse -Force

$startMenuDirectory = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs'
$startMenuShortcut = Join-Path $startMenuDirectory 'Infinite Media Board.lnk'

$shell = New-Object -ComObject WScript.Shell
$existingTarget = if (Test-Path -LiteralPath $startMenuShortcut) {
  $shell.CreateShortcut($startMenuShortcut).TargetPath
} else { '' }

if ($existingTarget -ne $currentExe) {
  $shortcut = $shell.CreateShortcut($startMenuShortcut)
  $shortcut.TargetPath = $currentExe
  $shortcut.WorkingDirectory = $currentDirectory
  $shortcut.IconLocation = "$currentExe,0"
  $shortcut.Description = 'Infinite Media Board'
  try {
    $shortcut.Save()
  } catch {
    if (-not (Test-Path -LiteralPath $startMenuShortcut)) { throw }
    $shortcutAcl = Get-Acl -LiteralPath $startMenuShortcut
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $writeRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $currentUser,
      [System.Security.AccessControl.FileSystemRights]::Modify,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $shortcutAcl.SetAccessRule($writeRule)
    Set-Acl -LiteralPath $startMenuShortcut -AclObject $shortcutAcl
    $shortcut.Save()
  }
}

$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$desktopShortcut = Join-Path $desktopDirectory 'Infinite Media Board.lnk'
$desktopLink = $shell.CreateShortcut($desktopShortcut)
$desktopLink.TargetPath = $currentExe
$desktopLink.WorkingDirectory = $currentDirectory
$desktopLink.IconLocation = "$currentExe,0"
$desktopLink.Description = 'Infinite Media Board'
$desktopLink.Save()

$saved = $shell.CreateShortcut($startMenuShortcut)
[pscustomobject]@{
  StartMenuShortcut = $startMenuShortcut
  TargetPath = $saved.TargetPath
  Description = $saved.Description
  DesktopShortcut = $desktopShortcut
  PublishedVersion = $Version
}
