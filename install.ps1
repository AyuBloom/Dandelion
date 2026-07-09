param(
  [string]$InstallDir = $(if ($env:DANDELION_INSTALL_DIR) { $env:DANDELION_INSTALL_DIR } else { Join-Path (Get-Location).Path "Dandelion" }),
  [switch]$SkipBunInstall,
  [switch]$NoFrozenLockfile,
  [switch]$Verify,
  [Alias("Verbose")]
  [switch]$VerboseOutput,
  [Alias("h")]
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

$Script:InstallBun = -not [bool]$SkipBunInstall
$Script:FrozenLockfile = -not [bool]$NoFrozenLockfile
$Script:RunVerify = [bool]$Verify
$Script:VerboseInstaller = [bool]$VerboseOutput
$Script:RepoUrl = if ($env:DANDELION_REPO_URL) { $env:DANDELION_REPO_URL } else { "https://github.com/AyuBloom/Dandelion.git" }
$Script:Branch = if ($env:DANDELION_BRANCH) { $env:DANDELION_BRANCH } else { "main" }
$Script:InstallDir = $InstallDir
$Script:TempDir = $null

$Esc = [char]27
$Script:Reset = "$Esc[0m"
$Script:ColorDebug = "$Esc[38;2;255;154;170m"
$Script:ColorError = "$Esc[38;2;159;0;31m"
$Script:ColorInfo = "$Esc[38;2;255;107;128m"
$Script:ColorLog = "$Esc[38;2;255;23;68m"
$Script:ColorWarn = "$Esc[38;2;216;23;61m"

function Write-InstallMessage {
  param(
    [string]$Color,
    [string]$Level,
    [string]$Message,
    [switch]$ErrorStream
  )

  $line = "$Color[$Level]$Script:Reset $Message"
  if ($ErrorStream) {
    [Console]::Error.WriteLine($line)
    return
  }

  [Console]::Out.WriteLine($line)
}

function Write-DebugLog {
  param([string]$Message)

  if ($Script:VerboseInstaller) {
    Write-InstallMessage $Script:ColorDebug "debug" $Message
  }
}

function Write-InfoLog {
  param([string]$Message)

  Write-InstallMessage $Script:ColorInfo "info" $Message
}

function Write-Log {
  param([string]$Message)

  Write-InstallMessage $Script:ColorLog "log" $Message
}

function Write-WarnLog {
  param([string]$Message)

  Write-InstallMessage $Script:ColorWarn "warn" $Message -ErrorStream
}

function Write-ErrorLog {
  param([string]$Message)

  Write-InstallMessage $Script:ColorError "error" $Message -ErrorStream
}

function Write-Plain {
  param([string]$Message = "")

  [Console]::Out.WriteLine($Message)
}

function Stop-Install {
  param([string]$Message)

  Write-ErrorLog $Message
  exit 1
}

function Show-Usage {
  $usage = @"
Usage: .\install.ps1 [options]
       powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/AyuBloom/Dandelion/main/install.ps1 | iex"

Options:
  -InstallDir <path>    Directory to clone into when running from the one-liner
  -SkipBunInstall       Do not install Bun automatically if it is missing
  -NoFrozenLockfile     Run bun install without --frozen-lockfile
  -Verify               Run TypeScript checking and tests after install
  -Verbose              Print extra diagnostic output
  -Help                 Show this help message
"@

  Write-Plain $usage
}

function Test-CommandExists {
  param([string]$Name)

  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-Windows {
  if ($env:OS -eq "Windows_NT") {
    return $true
  }

  $isWindowsVariable = Get-Variable -Name IsWindows -ErrorAction SilentlyContinue
  if ($null -ne $isWindowsVariable) {
    return [bool]$isWindowsVariable.Value
  }

  return $false
}

function Resolve-InstallPath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    Stop-Install "Install directory cannot be empty."
  }

  if ([IO.Path]::IsPathRooted($Path)) {
    return [IO.Path]::GetFullPath($Path)
  }

  return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

function Quote-PowerShellArgument {
  param([string]$Value)

  return "'" + ($Value -replace "'", "''") + "'"
}

function Test-SourceLooksLikeProject {
  param([string]$Dir)

  return (Test-Path -LiteralPath (Join-Path $Dir "package.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Dir "bun.lock") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Dir "src/shared/logger.ts") -PathType Leaf)
}

function Invoke-NativeQuiet {
  param(
    [string]$FailureMessage,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory = (Get-Location).Path
  )

  if ($Script:VerboseInstaller) {
    Push-Location -LiteralPath $WorkingDirectory
    try {
      & $FilePath @Arguments
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }

    if ($exitCode -ne 0) {
      Stop-Install $FailureMessage
    }

    return
  }

  $outputFile = [IO.Path]::GetTempFileName()
  try {
    Push-Location -LiteralPath $WorkingDirectory
    try {
      & $FilePath @Arguments *> $outputFile
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }

    if ($exitCode -ne 0) {
      Write-ErrorLog $FailureMessage
      Get-Content -LiteralPath $outputFile | ForEach-Object { [Console]::Error.WriteLine($_) }
      exit 1
    }
  } finally {
    Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NativeVisible {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-Install $FailureMessage
  }
}

function Find-LocalProjectRoot {
  $scriptPathVariable = Get-Variable -Name PSCommandPath -ErrorAction SilentlyContinue
  if ($null -eq $scriptPathVariable -or [string]::IsNullOrWhiteSpace([string]$scriptPathVariable.Value)) {
    return $null
  }

  $root = Split-Path -Parent $scriptPathVariable.Value
  if ([string]::IsNullOrWhiteSpace($root)) {
    return $null
  }

  try {
    $root = (Resolve-Path -LiteralPath $root).Path
  } catch {
    return $null
  }

  if (Test-SourceLooksLikeProject $root) {
    return $root
  }

  return $null
}

function Get-ArchiveUrl {
  return "https://github.com/AyuBloom/Dandelion/archive/refs/heads/$Script:Branch.zip"
}

function Download-SourceArchive {
  param([string]$Target)

  $Script:TempDir = Join-Path ([IO.Path]::GetTempPath()) ("dandelion-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $Script:TempDir "dandelion.zip"
  $extractPath = Join-Path $Script:TempDir "source"

  New-Item -ItemType Directory -Path $Script:TempDir -Force | Out-Null
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
  New-Item -ItemType Directory -Path $Target -Force | Out-Null

  Write-Log "Downloading Dandelion"
  Invoke-WebRequest -Uri (Get-ArchiveUrl) -OutFile $zipPath -UseBasicParsing
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force

  $sourceRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
  if ($null -eq $sourceRoot) {
    Stop-Install "Dandelion archive did not contain a source directory."
  }

  Get-ChildItem -LiteralPath $sourceRoot.FullName -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
  }
}

function Ensure-Source {
  param([string]$Target)

  if (Test-SourceLooksLikeProject $Target) {
    Write-InfoLog "Using existing Dandelion checkout at $Target"
    return
  }

  if ((Test-Path -LiteralPath $Target) -and -not (Test-Path -LiteralPath $Target -PathType Container)) {
    Stop-Install "$Target already exists and is not a directory."
  }

  if ((Test-Path -LiteralPath $Target) -and (Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1)) {
    Stop-Install "$Target already exists and does not look like a Dandelion checkout."
  }

  $parent = Split-Path -Parent $Target
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  if (Test-CommandExists "git") {
    Write-Log "Cloning Dandelion"
    Invoke-NativeQuiet "Failed to clone Dandelion." "git" @("clone", "--depth", "1", "--branch", $Script:Branch, $Script:RepoUrl, $Target)
  } else {
    Download-SourceArchive $Target
  }

  if (-not (Test-SourceLooksLikeProject $Target)) {
    Stop-Install "Dandelion source was downloaded, but required project files are missing."
  }
}

function Ensure-SupportedOS {
  if (-not (Test-Windows)) {
    Stop-Install "Unsupported OS. Use install.sh on Linux or macOS."
  }

  $version = [Environment]::OSVersion.Version
  if ($version.Major -lt 10 -or ($version.Major -eq 10 -and $version.Build -lt 17763)) {
    Stop-Install "Bun requires Windows 10 version 1809 or later."
  }

  Write-DebugLog "Detected supported OS: Windows $version"
}

function Add-BunToPath {
  $bunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
  $bunBin = Join-Path $bunHome "bin"
  $bunExe = Join-Path $bunBin "bun.exe"

  if (Test-Path -LiteralPath $bunExe -PathType Leaf) {
    $env:PATH = "$bunBin;$env:PATH"
    Write-DebugLog "Added $bunBin to PATH"
  }
}

function Get-BunVersion {
  $version = & bun --version 2>$null | Select-Object -First 1
  if ($LASTEXITCODE -ne 0) {
    return $null
  }

  return $version
}

function Ensure-Bun {
  Add-BunToPath

  if (Test-CommandExists "bun") {
    Write-InfoLog "Using Bun $(Get-BunVersion)"
    return
  }

  if (-not $Script:InstallBun) {
    Stop-Install "Bun is required but was not found on PATH."
  }

  Write-Log "Bun was not found. Installing Bun with the official installer..."
  try {
    Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")
  } catch {
    Stop-Install "Failed to install Bun automatically. $($_.Exception.Message)"
  }

  Add-BunToPath
  if (-not (Test-CommandExists "bun")) {
    Stop-Install "Bun installed, but bun is still not available on PATH. Open a new shell or add $env:USERPROFILE\.bun\bin to PATH."
  }

  Write-InfoLog "Installed Bun $(Get-BunVersion)"
}

function Install-Dependencies {
  $installArgs = @("install")
  if ($Script:FrozenLockfile) {
    $installArgs += "--frozen-lockfile"
  }

  Write-Log "Installing dependencies"
  Write-DebugLog "Running: bun $($installArgs -join ' ')"
  Invoke-NativeQuiet "Failed to install dependencies." "bun" $installArgs
}

function Run-Verification {
  Write-Log "Running TypeScript type checking"
  Invoke-NativeVisible "bunx" @("tsc", "--noEmit") "TypeScript type checking failed."

  Write-Log "Running tests"
  Invoke-NativeVisible "bun" @("test", "tests/") "Tests failed."
}

function Print-NextSteps {
  param([string]$Root)

  $quotedRoot = Quote-PowerShellArgument $Root

  Write-Plain
  Write-InfoLog "Installation complete"
  Write-Plain
  Write-Plain "Dandelion was installed at:"
  Write-Plain "  $Root"
  Write-Plain
  Write-Plain "Next steps:"
  Write-Plain "  cd $quotedRoot"
  Write-Plain "  bun run src/index.ts"
  Write-Plain
  Write-Plain "The API listens on port 50000 by default. To use another port:"
  Write-Plain '  $env:API_PORT = "8080"; bun run src/index.ts'
  Write-Plain
  Write-Plain "To verify the code:"
  Write-Plain "  bunx tsc --noEmit"
  Write-Plain "  bun test tests/"
}

function Clear-TempDir {
  if ($Script:TempDir -and (Test-Path -LiteralPath $Script:TempDir -PathType Container)) {
    Remove-Item -LiteralPath $Script:TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Main {
  if ($Help) {
    Show-Usage
    return
  }

  Ensure-SupportedOS
  $Script:InstallDir = Resolve-InstallPath $Script:InstallDir

  $root = Find-LocalProjectRoot
  if (-not $root) {
    $root = $Script:InstallDir
    Ensure-Source $root
  }

  Set-Location -LiteralPath $root
  $root = (Resolve-Path -LiteralPath ".").Path

  Write-InfoLog "Installing Dandelion from $root"
  Ensure-Bun
  Install-Dependencies

  if ($Script:RunVerify) {
    Run-Verification
  } else {
    Write-InfoLog "Skipping verification. Run .\install.ps1 -Verify to typecheck and test."
  }

  Print-NextSteps $root
}

try {
  Main
} finally {
  Clear-TempDir
}
