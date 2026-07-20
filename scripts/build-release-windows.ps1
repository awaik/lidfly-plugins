param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$ArtifactsDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw 'Version must be X.Y.Z'
}
if ((node -p "process.versions.node.split('.')[0]") -ne '22') {
  throw 'Windows release requires Node 22'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installerRoot = Join-Path $repositoryRoot 'installer'
$artifactsDir = [System.IO.Path]::GetFullPath($ArtifactsDir)
New-Item -ItemType Directory -Force -Path $artifactsDir | Out-Null

if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = Join-Path $env:USERPROFILE '.tauri\lidfly-codex-installer-updater.key'
}
if ([string]::IsNullOrWhiteSpace($env:TAURI_UPDATER_PUBLIC_KEY_PATH)) {
  $env:TAURI_UPDATER_PUBLIC_KEY_PATH = "$($env:TAURI_SIGNING_PRIVATE_KEY_PATH).pub"
}
foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_UPDATER_PUBLIC_KEY_PATH')) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Missing local release setting: $name"
  }
}

$env:TAURI_UPDATER_PUBLIC_KEY = (Get-Content -Raw $env:TAURI_UPDATER_PUBLIC_KEY_PATH).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $env:TAURI_SIGNING_PRIVATE_KEY_PATH).Trim()
$releaseConfig = Join-Path $env:TEMP "lidfly-tauri-release-$PID.json"
$source = Join-Path $installerRoot "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\LidFly Codex Plugin Installer_${Version}_x64-setup.exe"
$application = Join-Path $installerRoot 'src-tauri\target\x86_64-pc-windows-msvc\release\lidfly-codex-plugin-installer.exe'
$installerName = "LidFly Codex Plugin Installer_${Version}_x64-setup.exe"
$installer = Join-Path $artifactsDir $installerName
$signature = "$installer.sig"

foreach ($output in @($installer, $signature, (Join-Path $artifactsDir 'windows-evidence.json'), (Join-Path $artifactsDir 'plugin-bundle-files.json'), (Join-Path $artifactsDir 'plugin-bundle'))) {
  if (Test-Path $output) {
    throw "Refusing to overwrite existing release output: $output"
  }
}

Push-Location $installerRoot
try {
  npm ci
  npm run bundle:plugin
  npm run bundle:plugin:verify
  npm run version:check
  if ((node -p "require('./package.json').version") -ne $Version) {
    throw 'package.json version does not match the requested release'
  }
  node ..\scripts\write-release-tauri-config.mjs $releaseConfig
  npx tauri build --bundles nsis --target x86_64-pc-windows-msvc --config $releaseConfig

  Copy-Item $source $installer
  Copy-Item "$source.sig" $signature
  node ..\scripts\verify-pe-machine.mjs $application

  $authenticode = Get-AuthenticodeSignature $installer
  if ($authenticode.Status -ne 'NotSigned') {
    throw "Glas-style Windows release must not contain Authenticode: $($authenticode.Status)"
  }

  cargo run --quiet --manifest-path src-tauri\Cargo.toml --example verify-updater-signature -- $installer $signature
  $evidence = @{
    schema_version = 1
    release_version = $Version
    windows = @{
      authenticode_status = 'NotSigned'
      release_policy = 'tauri_updater_signature_only'
      architecture = 'x86_64'
      installer_sha256 = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
      updater_signature_verified = $true
    }
  }
  $evidenceJson = ($evidence | ConvertTo-Json -Depth 5) + [Environment]::NewLine
  [System.IO.File]::WriteAllText(
    (Join-Path $artifactsDir 'windows-evidence.json'),
    $evidenceJson,
    [System.Text.UTF8Encoding]::new($false)
  )
  Copy-Item 'src-tauri\resources\plugin-bundle-files.json' (Join-Path $artifactsDir 'plugin-bundle-files.json')
  Copy-Item -Recurse 'src-tauri\resources\plugin-bundle' (Join-Path $artifactsDir 'plugin-bundle')
} finally {
  Pop-Location
}

Write-Host "Local Windows release is ready: $artifactsDir"
