param(
    [ValidateSet('none', 'local', 'real')]
    [string]$ModelInterruption = 'none'
)
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$temporaryParent = Join-Path $desktopRoot 'testplace\tmp'
$evidenceParent = Join-Path $desktopRoot 'testplace\readings\installer-windows'
$runId = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N')
$evidenceRoot = Join-Path $evidenceParent $runId
$version = (Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $desktopRoot "release\ligule Setup $version.exe"
# The workspace path is deep; keep the leaf short so the installed resource tree stays under MAX_PATH.
$installRoot = Join-Path $temporaryParent ('i-' + [Guid]::NewGuid().ToString('N'))
$resolvedInstallRoot = [IO.Path]::GetFullPath($installRoot)
$expectedPrefix = [IO.Path]::GetFullPath($temporaryParent).TrimEnd('\') + '\'
if (-not $resolvedInstallRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer test destination is outside desktop/testplace/tmp.'
}
if (Test-Path -LiteralPath $resolvedInstallRoot) { throw 'Installer test destination already exists.' }
if ($ModelInterruption -eq 'real' -and [string]::IsNullOrWhiteSpace($env:LIGULE_PLAN2_OTHERS_API_KEY)) {
    throw 'The isolated real-provider interruption test requires its dedicated environment variable.'
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'NSIS installer is missing.' }

New-Item -ItemType Directory -Path $temporaryParent, $evidenceParent -Force | Out-Null
New-Item -ItemType Directory -Path $evidenceRoot -ErrorAction Stop | Out-Null
$report = [ordered]@{ version = $version; installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash; evidenceRoot = $evidenceRoot; installRoot = $resolvedInstallRoot; installed = $false; runtime = $null; window = $null; uninstalled = $false }
$exitCode = 1

$uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$registered = @(Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'ligule' } |
    Select-Object DisplayName, InstallLocation, UninstallString, PSPath)
$shortcutRoots = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Desktop'),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartMenu),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$shortcuts = @($shortcutRoots | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Filter 'ligule.lnk' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName
} | Sort-Object -Unique)
$shortcutShell = if ($shortcuts.Count -gt 0) { New-Object -ComObject WScript.Shell }
$shortcutDetails = @($shortcuts | ForEach-Object {
    $shortcut = $shortcutShell.CreateShortcut($_)
    [pscustomobject]@{ Path = $_; TargetPath = $shortcut.TargetPath; Arguments = $shortcut.Arguments }
})
if ($registered.Count -gt 0 -or $shortcuts.Count -gt 0) {
    $report.preflightUninstallEntries = $registered
    $report.preflightShortcuts = $shortcutDetails
    $report.error = 'A Ligule uninstall registration or same-name shortcut exists; the isolated installer test will not replace it.'
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'report.json') -Encoding utf8
    Get-Content -LiteralPath (Join-Path $evidenceRoot 'report.json')
    exit 1
}

try {
    $installation = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $installRoot)) -WindowStyle Hidden -PassThru -Wait
    $report.installExit = $installation.ExitCode
    if ($installation.ExitCode -ne 0) { throw 'NSIS installation failed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'ligule.exe'))) { throw 'Installed executable is missing.' }
    $report.installed = $true
    $node = Join-Path $installRoot 'resources\node\node.exe'
    & $node (Join-Path $desktopRoot 'check-runtime.mjs') --resources (Join-Path $installRoot 'resources') *> (Join-Path $evidenceRoot 'runtime.txt')
    $report.runtime = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime self-check failed.' }
    $smokeArguments = @((Join-Path $PSScriptRoot 'run-packaged-smoke.mjs'), '--app-dir', $installRoot)
    if ($ModelInterruption -eq 'local') { $smokeArguments += '--local-request-interruption' }
    if ($ModelInterruption -eq 'real') { $smokeArguments += '--real-request-interruption' }
    & $node @smokeArguments *> (Join-Path $evidenceRoot 'window.txt')
    $report.window = $LASTEXITCODE
    if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke check failed.' }
    $exitCode = 0
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($report.installed) {
        $uninstaller = Join-Path $installRoot 'Uninstall ligule.exe'
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            $removal = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
            $report.uninstallExit = $removal.ExitCode
            for ($attempt = 0; $attempt -lt 50 -and (Test-Path -LiteralPath (Join-Path $installRoot 'ligule.exe')); $attempt++) {
                Start-Sleep -Milliseconds 200
            }
            $report.uninstalled = -not (Test-Path -LiteralPath (Join-Path $installRoot 'ligule.exe'))
            if (-not $report.uninstalled -or $removal.ExitCode -ne 0) { $exitCode = 1 }
            if ($report.uninstalled -and (Test-Path -LiteralPath $installRoot -PathType Container)) {
                try {
                    $remaining = @(Get-ChildItem -LiteralPath $installRoot -Force -Recurse -ErrorAction Stop)
                    $report.remainingInstallEntries = $remaining.Count
                    if ($remaining.Count -eq 0) {
                        Remove-Item -LiteralPath $installRoot -Force -ErrorAction Stop
                    } else {
                        $exitCode = 1
                    }
                } catch {
                    $report.cleanupError = $_.Exception.Message
                    $exitCode = 1
                }
            } else {
                $report.remainingInstallEntries = 0
            }
        } else {
            $report.uninstallError = 'The installed uninstaller is missing.'
            $exitCode = 1
        }
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceRoot 'report.json') -Encoding utf8
}
Get-Content -LiteralPath (Join-Path $evidenceRoot 'report.json')
exit $exitCode
