<#
  Build the PDF Wizard CAC helper with the C# compiler that ships with Windows and register it with
  Chrome and Edge.

    powershell -ExecutionPolicy Bypass -File native\windows\install.ps1            # current user
    powershell -ExecutionPolicy Bypass -File native\windows\install.ps1 -AllUsers  # every user (run as administrator)

  -ExtensionId overrides the extension ID pinned in extension/manifest.json.
  Uninstall: native\windows\uninstall.ps1 [-AllUsers]
#>
param(
  [switch]$AllUsers,
  [string]$ExtensionId = 'pcalefniaiaclbiffigjgdlcjigencoa'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'The .NET Framework 4 C# compiler (csc.exe) was not found.' }

if ($AllUsers) { $dest = Join-Path $env:ProgramFiles 'PDF Wizard' } else { $dest = Join-Path $env:LOCALAPPDATA 'PDF Wizard' }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$exe = Join-Path $dest 'pdfwizard-cac-host.exe'

& $csc /nologo /optimize+ /target:exe "/out:$exe" /r:System.Core.dll /r:System.Security.dll /r:System.Web.Extensions.dll (Join-Path $here 'PdfWizardCacHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compiling the helper failed.' }

$manifestPath = Join-Path $dest 'com.pdfwizard.cac.json'
@{
  name = 'com.pdfwizard.cac'
  description = 'PDF Wizard CAC signing helper'
  path = $exe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json | Set-Content -Encoding UTF8 -Path $manifestPath

if ($AllUsers) { $root = 'HKLM:' } else { $root = 'HKCU:' }
foreach ($browser in @('Software\Google\Chrome', 'Software\Microsoft\Edge', 'Software\Chromium')) {
  $key = "$root\$browser\NativeMessagingHosts\com.pdfwizard.cac"
  New-Item -Force -Path $key | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "registered: $key"
}
Write-Host "helper: $exe"
Write-Host 'certificates on the card now:'
& $exe --list
