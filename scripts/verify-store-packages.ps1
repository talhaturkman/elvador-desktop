param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [switch]$IncludeX86,
  [switch]$RunSmoke
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageConfig = Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$expectedIdentity = $packageConfig.build.appx
$expectedVersion = "$Version.0"
$architectures = @('x64')
if ($IncludeX86) {
  $architectures += 'x86'
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$packageFiles = [System.Collections.Generic.List[string]]::new()
foreach ($architecture in $architectures) {
  $packageDirectory = Join-Path $projectRoot "release/store/$architecture"
  # 2026-09-30: Older local 1.0.0 packages must not block verification of the new 1.0.1 release.
  $packageName = "$($packageConfig.build.productName) $Version"
  if ($architecture -eq 'x86') {
    $packageName += ' ia32'
  }
  $packagePath = Join-Path $packageDirectory "$packageName.appx"
  if (!(Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "release/store/$architecture içinde $Version paketi bulunamadı: $packagePath."
  }

  $package = Get-Item -LiteralPath $packagePath
  $archive = [System.IO.Compression.ZipFile]::OpenRead($package.FullName)
  try {
    $manifestEntry = $archive.GetEntry('AppxManifest.xml')
    if ($null -eq $manifestEntry) {
      throw "$($package.Name) içinde AppxManifest.xml bulunamadı."
    }

    $reader = [System.IO.StreamReader]::new($manifestEntry.Open())
    try {
      [xml]$manifest = $reader.ReadToEnd()
    }
    finally {
      $reader.Dispose()
    }

    $identity = $manifest.SelectSingleNode("//*[local-name()='Identity']")
    if ($null -eq $identity) {
      throw "$($package.Name) manifestinde Identity bulunamadı."
    }

    $actual = [ordered]@{
      Name = $identity.GetAttribute('Name')
      Publisher = $identity.GetAttribute('Publisher')
      Architecture = $identity.GetAttribute('ProcessorArchitecture').ToLowerInvariant()
      Version = $identity.GetAttribute('Version')
    }

    if ($actual.Name -ne $expectedIdentity.identityName) {
      throw "$($package.Name) kimliği farklı: $($actual.Name)."
    }
    if ($actual.Publisher -ne $expectedIdentity.publisher) {
      throw "$($package.Name) Publisher farklı: $($actual.Publisher)."
    }
    if ($actual.Architecture -ne $architecture) {
      throw "$($package.Name) mimarisi $($actual.Architecture); $architecture bekleniyordu."
    }
    if ($actual.Version -ne $expectedVersion) {
      throw "$($package.Name) sürümü $($actual.Version); $expectedVersion bekleniyordu."
    }

    Write-Host ("Doğrulandı: {0} | {1} | {2} | {3}" -f $actual.Name, $actual.Publisher, $actual.Architecture, $actual.Version)
    $packageFiles.Add($package.FullName)
  }
  finally {
    $archive.Dispose()
  }
}

$uploadDirectory = Join-Path $projectRoot 'release/store'
$uploadPath = Join-Path $uploadDirectory "Elvador-Store-$Version.msixupload"
if (Test-Path -LiteralPath $uploadPath) {
  Remove-Item -LiteralPath $uploadPath -Force
}

$uploadArchive = [System.IO.Compression.ZipFile]::Open($uploadPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($packageFile in $packageFiles) {
    $entryName = [System.IO.Path]::GetFileName($packageFile)
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $uploadArchive,
      $packageFile,
      $entryName,
      [System.IO.Compression.CompressionLevel]::NoCompression
    )
  }
}
finally {
  $uploadArchive.Dispose()
}

Write-Host "Store upload paketi hazır: $uploadPath"
if ($env:GITHUB_OUTPUT) {
  "upload_path=$uploadPath" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}

if ($RunSmoke) {
foreach ($packageFile in $packageFiles) {
  $architecture = if ($packageFile -match '[\\/]x86[\\/]') { 'x86' } else { 'x64' }
  $temporaryRoot = $env:RUNNER_TEMP
  if ([string]::IsNullOrWhiteSpace($temporaryRoot)) {
    $temporaryRoot = $env:TEMP
  }
  $smokeRoot = Join-Path $temporaryRoot "elvador-store-smoke-$architecture"
  $appDataPath = Join-Path $smokeRoot 'appdata'
  $reportPath = Join-Path $smokeRoot 'store-smoke.json'
  if (Test-Path -LiteralPath $smokeRoot) {
    Remove-Item -LiteralPath $smokeRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Path $appDataPath -Force | Out-Null
  $unpackedDirectory = Join-Path $projectRoot "release/store/$architecture/win-unpacked"
  if ($architecture -eq 'x86') {
    $unpackedDirectory = Join-Path $projectRoot 'release/store/x86/win-ia32-unpacked'
  }
  $executablePath = Join-Path $unpackedDirectory 'Elvador.exe'
  if (!(Test-Path -LiteralPath $executablePath)) {
    throw "$architecture Store smoke: electron-builder win-unpacked uygulama çıktısı bulunamadı ($executablePath)."
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $executablePath
  $startInfo.WorkingDirectory = $unpackedDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  [void]$startInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $startInfo.EnvironmentVariables['APPDATA'] = $appDataPath
  $startInfo.EnvironmentVariables['ELVADOR_DISTRIBUTION_CHANNEL'] = 'microsoft-store'
  $startInfo.EnvironmentVariables['ELVADOR_STORE_SMOKE_REPORT'] = $reportPath
  $startInfo.EnvironmentVariables['ELVADOR_STORE_UPDATER_SMOKE_TEST'] = 'true'
  $process = [System.Diagnostics.Process]::Start($startInfo)
  if (!$process.WaitForExit(60000)) {
    $process.Kill()
    throw "$architecture Store smoke 60 saniyede tamamlanmadı."
  }
  $smokeOutput = $process.StandardOutput.ReadToEnd()
  $smokeError = $process.StandardError.ReadToEnd()
  if ($process.ExitCode -ne 0) {
    throw "$architecture Store smoke başarısız oldu; uygulama çıkış kodu $($process.ExitCode). $smokeOutput $smokeError"
  }

  if (!(Test-Path -LiteralPath $reportPath)) {
    throw "$architecture Store smoke sonucu oluşturulmadı: $reportPath"
  }
  $smokeResult = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if (!$smokeResult.storeBuildDetected -or $smokeResult.electronUpdaterLoaded) {
    throw "$architecture Store smoke beklenen sonucu vermedi: $($smokeResult | ConvertTo-Json -Compress)"
  }

  Write-Host ("Runtime smoke başarılı: {0}; Store kanalı={1}; process.windowsStore={2}; electron-updater yüklü={3}" -f `
    $architecture, $smokeResult.storeBuildDetected, $smokeResult.windowsStore, $smokeResult.electronUpdaterLoaded)
}
}
