param([switch]$AllUsers)
$ErrorActionPreference = 'SilentlyContinue'
if ($AllUsers) { $root = 'HKLM:'; $dest = Join-Path $env:ProgramFiles 'PDF Wizard' } else { $root = 'HKCU:'; $dest = Join-Path $env:LOCALAPPDATA 'PDF Wizard' }
foreach ($browser in @('Software\Google\Chrome', 'Software\Microsoft\Edge', 'Software\Chromium')) {
  Remove-Item -Force -Path "$root\$browser\NativeMessagingHosts\com.pdfwizard.cac"
}
Remove-Item -Force -Path (Join-Path $dest 'pdfwizard-cac-host.exe'), (Join-Path $dest 'com.pdfwizard.cac.json')
Write-Host 'PDF Wizard CAC helper removed.'
