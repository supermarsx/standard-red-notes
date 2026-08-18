#Requires -Version 5.1
<#
.SYNOPSIS
  Standard Red Notes - self-hosting setup script (Windows PowerShell).

.DESCRIPTION
  Generates a complete .env file with securely-generated secrets, lets you
  customize the install (domain, ports, database name/user), and optionally
  brings the Docker Compose stack up. Produces a .env identical in keys and
  format to scripts/setup.sh.

.PARAMETER Yes
  Non-interactive: accept all defaults without prompting.

.PARAMETER Up
  After writing .env, run `docker compose up -d --build`.

.PARAMETER ForceOverwrite
  Explicitly replace an existing .env after making a timestamped backup.

.PARAMETER GenerateAssistantSubscriptionKey
  Safely add a persistent pairing-encryption key to an existing keyless .env.

.EXAMPLE
  ./scripts/setup.ps1
  ./scripts/setup.ps1 -Up
  ./scripts/setup.ps1 -Yes -Up
  ./scripts/setup.ps1 -Yes -ForceOverwrite
  ./scripts/setup.ps1 -GenerateAssistantSubscriptionKey
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Up,
  [switch]$ForceOverwrite,
  [switch]$GenerateAssistantSubscriptionKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths (run from anywhere; .env always lands in the repo root)
# ---------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$EnvFile   = Join-Path $RepoRoot '.env'

# ---------------------------------------------------------------------------
# Pretty output helpers
# ---------------------------------------------------------------------------
function Write-Info  { param([string]$m) Write-Host $m -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host $m -ForegroundColor Green }
function Write-Warn  { param([string]$m) Write-Host $m -ForegroundColor Yellow }
function Write-Err   { param([string]$m) Write-Host $m -ForegroundColor Red }
function Write-Title { param([string]$m) Write-Host ''; Write-Host $m -ForegroundColor White }

# ---------------------------------------------------------------------------
# Prompt helpers (honor -Yes)
# ---------------------------------------------------------------------------
function Read-Default {
  param([string]$Question, [string]$Default)
  if ($Yes) { return $Default }
  $suffix = if ([string]::IsNullOrEmpty($Default)) { '' } else { " [$Default]" }
  $answer = Read-Host "$Question$suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer
}

function Confirm-Yes {
  param([string]$Question)
  if ($Yes) { return $true }
  $answer = Read-Host "$Question [y/N]"
  return ($answer -match '^(y|yes)$')
}

# ---------------------------------------------------------------------------
# Secret generation: 32 cryptographically-random bytes -> 64-char hex.
# Uses RandomNumberGenerator (NOT Get-Random, which is not cryptographic).
# ---------------------------------------------------------------------------
function New-Hex32 {
  $bytes = New-Object 'System.Byte[]' 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-AssistantSubscriptionKeyState {
  param([string]$Path)

  $assignments = @(Get-Content -LiteralPath $Path | Where-Object {
    $_ -match '^\s*ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY\s*='
  })
  if ($assignments.Count -gt 1) {
    throw 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is assigned more than once in .env. Refusing ambiguous configuration.'
  }
  if ($assignments.Count -eq 0) {
    return [pscustomobject]@{ State = 'missing'; Value = '' }
  }

  $value = ($assignments[0] -replace '^[^=]*=', '').Trim()
  if ([string]::IsNullOrEmpty($value)) {
    return [pscustomobject]@{ State = 'missing'; Value = '' }
  }
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  if ($value -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).'
  }

  return [pscustomobject]@{ State = 'valid'; Value = $value }
}

function Get-SyncingServerInternalGrpcAuthSecretState {
  param([string]$Path)

  $assignments = @(Get-Content -LiteralPath $Path | Where-Object {
    $_ -match '^\s*SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET\s*='
  })
  if ($assignments.Count -gt 1) {
    throw 'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET is assigned more than once in .env. Refusing ambiguous configuration.'
  }
  if ($assignments.Count -eq 0) {
    return [pscustomobject]@{ State = 'missing'; Value = '' }
  }

  $value = ($assignments[0] -replace '^[^=]*=', '').Trim()
  if ([string]::IsNullOrEmpty($value)) {
    return [pscustomobject]@{ State = 'missing'; Value = '' }
  }
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  if ($value -notmatch '^[0-9a-fA-F]{64}$') {
    throw 'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET must be exactly 64 hexadecimal characters (32 bytes).'
  }

  return [pscustomobject]@{ State = 'valid'; Value = $value }
}

function Invoke-ComposeCommand {
  param([string[]]$Arguments)
  if ($Compose -eq 'docker compose') {
    & docker compose @Arguments
  } else {
    & docker-compose @Arguments
  }
}

function Set-CleanDeploymentRevision {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required to identify the source being deployed.'
  }
  $revision = (& git -C $RepoRoot rev-parse --verify 'HEAD^{commit}' 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $revision -cnotmatch '^[0-9a-f]{40}$') {
    throw 'Repository HEAD did not resolve to a lowercase full Git commit.'
  }
  $dirty = (& git -C $RepoRoot status --porcelain=v1 --untracked-files=all 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect repository cleanliness.' }
  if (-not [string]::IsNullOrEmpty($dirty)) {
    throw 'Refusing to build a deployment identity from a dirty checkout. Commit or remove source changes first.'
  }
  $env:SRN_DEPLOY_REVISION = $revision
  $env:SRN_DEPLOY_VERSION = "setup-$($revision.Substring(0, 12))"
  Write-Ok "Deploying exact clean commit: $revision"
  return $revision
}

$DeploymentIdentityProbeScript = @'
const expected={revision:process.env.EXPECTED_REVISION,version:process.env.EXPECTED_VERSION||null};
const normalize=(value)=>({revision:value?.revision,version:value?.version===""?null:value?.version});
Promise.all([fetch("http://app:8080/healthcheck/readiness",{cache:"no-store"}),fetch("http://app:8080/.well-known/srn-deployment.json",{cache:"no-store"})])
  .then(async ([readyResponse,markerResponse])=>{
    if(!readyResponse.ok||!markerResponse.ok)throw new Error("identity endpoint unavailable");
    const readiness=await readyResponse.json();const marker=normalize(await markerResponse.json());const server=normalize(readiness.deployment);
    if(readiness.status!=="ready"||server.revision!==expected.revision||server.version!==expected.version||marker.revision!==expected.revision||marker.version!==expected.version)throw new Error("deployment identity mismatch");
  }).catch((error)=>{console.error(error.message);process.exit(1)})
'@

function Assert-StartedDeploymentIdentity {
  param([string]$Revision)
  $version = [Environment]::GetEnvironmentVariable('SRN_DEPLOY_VERSION')
  for ($attempt = 1; $attempt -le 120; $attempt++) {
    Push-Location $RepoRoot
    try {
      Invoke-ComposeCommand -Arguments @(
        'exec', '-T', '-e', "EXPECTED_REVISION=$Revision", '-e', "EXPECTED_VERSION=$version",
        'server', 'node', '-e', $DeploymentIdentityProbeScript
      )
      $probeStatus = $LASTEXITCODE
    } finally { Pop-Location }
    if ($probeStatus -eq 0) {
      Write-Ok 'App and server deployment identity verified.'
      return
    }
    Start-Sleep -Seconds 2
  }
  throw 'The stack started but did not prove the expected app/server deployment identity.'
}

$AssistantPairingProbeScript = @'
path="${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-/opt/server/packages/api-gateway/data/assistant-subscription.json}"
case "$path" in
  /opt/server/packages/api-gateway/data/*) ;;
  *) exit 42 ;;
esac
[ ! -e "$path" ] || exit 43
'@

function Assert-NoExistingAssistantPairingData {
  Push-Location $RepoRoot
  try {
    $containerIds = @(Invoke-ComposeCommand -Arguments @('ps', '--all', '-q', 'server') |
      ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
  } finally {
    Pop-Location
  }
  if ($containerIds.Count -gt 1) {
    throw 'Multiple Compose server containers were found. Refusing to guess which pairing store is authoritative.'
  }

  if ($containerIds.Count -eq 1) {
    $running = (& docker inspect --format '{{.State.Running}}' $containerIds[0] 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      throw 'The existing server container cannot be inspected. Refusing automatic key generation.'
    }
    if ($running -eq 'true') {
      & docker exec $containerIds[0] /bin/sh -ec $AssistantPairingProbeScript
      $probeStatus = $LASTEXITCODE
    } else {
      $mountDestinations = @(& docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' $containerIds[0] 2>$null |
        ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
      if ($LASTEXITCODE -ne 0 -or $mountDestinations -notcontains '/opt/server/packages/api-gateway/data') {
        throw 'The stopped server container has no inspectable persistent gateway-data mount. It may contain legacy pairing data; start/recover it before setup generates a key.'
      }
      Push-Location $RepoRoot
      try {
        Invoke-ComposeCommand -Arguments @(
          'run', '--rm', '--no-deps', '--entrypoint', '/bin/sh', 'server', '-ec', $AssistantPairingProbeScript
        )
        $probeStatus = $LASTEXITCODE
      } finally {
        Pop-Location
      }
    }
  } else {
    Push-Location $RepoRoot
    try {
      Invoke-ComposeCommand -Arguments @(
        'run', '--rm', '--no-deps', '--entrypoint', '/bin/sh', 'server', '-ec', $AssistantPairingProbeScript
      )
      $probeStatus = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  switch ($probeStatus) {
    0 { return }
    42 { throw 'ASSISTANT_SUBSCRIPTION_TOKEN_PATH is outside the persistent gateway data directory. Refusing automatic key generation.' }
    43 { throw 'An assistant subscription pairing file already exists. Restore its original encryption key or unpair it before generating a replacement.' }
    default { throw 'Could not prove that the persistent assistant pairing store is empty. Refusing automatic key generation.' }
  }
}

function Add-MissingEnvironmentSecrets {
  param(
    [string]$Path,
    [string]$AssistantKey,
    [string]$DurableGrpcAuthSecret
  )

  $addAssistant = -not [string]::IsNullOrEmpty($AssistantKey)
  $addGrpcAuth = -not [string]::IsNullOrEmpty($DurableGrpcAuthSecret)
  if (-not $addAssistant -and -not $addGrpcAuth) {
    return
  }

  $backup = "$Path.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
  $temporary = "$Path.secret-migration.tmp.$PID"
  if ((Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $temporary)) {
    throw 'Refusing to overwrite an existing environment backup or migration temporary file.'
  }

  $assistantReplaced = $false
  $grpcAuthReplaced = $false
  $updated = foreach ($line in Get-Content -LiteralPath $Path) {
    if ($addAssistant -and $line -match '^\s*ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY\s*=') {
      $assistantReplaced = $true
      "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=$AssistantKey"
    } elseif ($addGrpcAuth -and $line -match '^\s*SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET\s*=') {
      $grpcAuthReplaced = $true
      "SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET=$DurableGrpcAuthSecret"
    } else {
      $line
    }
  }
  if ($addAssistant -and -not $assistantReplaced) {
    $updated = @($updated) + @(
      '',
      '# Guided ChatGPT/Codex pairing credential encryption (32 random bytes).',
      "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=$AssistantKey"
    )
  }
  if ($addGrpcAuth -and -not $grpcAuthReplaced) {
    $updated = @($updated) + @(
      '',
      '# Dedicated durable API-gateway -> syncing-server gRPC authentication (32 random bytes).',
      "SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET=$DurableGrpcAuthSecret"
    )
  }
  try {
    $attributes = [System.IO.File]::GetAttributes($Path)
    [System.IO.File]::WriteAllText($temporary, (($updated -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::SetAttributes($temporary, $attributes)
    # ReplaceFile preserves the destination file's ACL while atomically moving
    # its previous contents to the requested backup path.
    [System.IO.File]::Replace($temporary, $Path, $backup)
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
  if ($addAssistant) {
    Write-Ok 'Added a persistent assistant subscription encryption key.'
  }
  if ($addGrpcAuth) {
    Write-Ok 'Added a dedicated durable gRPC authentication key.'
  }
  Write-Ok "Backed up the previous .env to: $backup"
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
Write-Title 'Standard Red Notes - self-hosting setup'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Err 'Docker is not installed or not on PATH.'
  Write-Err 'Install Docker Desktop for Windows: https://docs.docker.com/desktop/install/windows-install/'
  exit 1
}

$Compose = $null
try {
  docker compose version *> $null
  if ($LASTEXITCODE -eq 0) { $Compose = 'docker compose' }
} catch { }
if (-not $Compose) {
  if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $Compose = 'docker-compose'
  } else {
    Write-Err 'Docker Compose v2 is not available. Update Docker Desktop, or install the compose plugin.'
    exit 1
  }
}
Write-Ok "Found Docker and Compose ($Compose)."

# ---------------------------------------------------------------------------
# Existing .env handling
# ---------------------------------------------------------------------------
$backup = $null
if (Test-Path $EnvFile) {
  Write-Warn "An .env file already exists at: $EnvFile"
  try {
    $assistantKey = Get-AssistantSubscriptionKeyState -Path $EnvFile
    $syncingGrpcAuthSecret = Get-SyncingServerInternalGrpcAuthSecretState -Path $EnvFile
  } catch {
    Write-Err $_.Exception.Message
    exit 1
  }
  if ($GenerateAssistantSubscriptionKey) {
    if ($ForceOverwrite) {
      Write-Err 'Use -GenerateAssistantSubscriptionKey separately before -ForceOverwrite.'
      exit 2
    }
    $migrationNeeded = $false
    if ($assistantKey.State -eq 'valid') {
      Write-Ok 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is already configured; leaving .env unchanged.'
    } else {
      $migrationNeeded = $true
    }
    if ($syncingGrpcAuthSecret.State -eq 'missing') {
      $migrationNeeded = $true
    }
    if ($migrationNeeded) {
      Push-Location $RepoRoot
      try {
        Invoke-ComposeCommand -Arguments @('config', '--quiet')
        if ($LASTEXITCODE -ne 0) { Write-Err 'Existing .env validation failed.'; exit 1 }
      } finally { Pop-Location }
      try {
        $assistantKeyToAdd = ''
        $grpcAuthSecretToAdd = ''
        if ($assistantKey.State -eq 'missing') {
          Assert-NoExistingAssistantPairingData
          $AssistantSubscriptionEncryptionKey = New-Hex32
          $assistantKeyToAdd = $AssistantSubscriptionEncryptionKey
        }
        if ($syncingGrpcAuthSecret.State -eq 'missing') {
          $SyncingServerInternalGrpcAuthSecret = New-Hex32
          $grpcAuthSecretToAdd = $SyncingServerInternalGrpcAuthSecret
        }
        Add-MissingEnvironmentSecrets -Path $EnvFile -AssistantKey $assistantKeyToAdd -DurableGrpcAuthSecret $grpcAuthSecretToAdd
        $assistantKey = Get-AssistantSubscriptionKeyState -Path $EnvFile
        $syncingGrpcAuthSecret = Get-SyncingServerInternalGrpcAuthSecretState -Path $EnvFile
      } catch {
        Write-Err $_.Exception.Message
        exit 1
      }
      Push-Location $RepoRoot
      try {
        Invoke-ComposeCommand -Arguments @('config', '--quiet')
        if ($LASTEXITCODE -ne 0) { Write-Err 'Migrated .env validation failed.'; exit 1 }
      } finally { Pop-Location }
    }
    if ($Up) {
      try { $deploymentRevision = Set-CleanDeploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }
      Push-Location $RepoRoot
      try {
        Invoke-ComposeCommand -Arguments @('up', '-d', '--build')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      } finally { Pop-Location }
      try { Assert-StartedDeploymentIdentity -Revision $deploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }
      Write-Ok 'Stack started.'
    }
    exit 0
  }
  if (-not $ForceOverwrite) {
    if ($assistantKey.State -eq 'missing' -or $syncingGrpcAuthSecret.State -eq 'missing') {
      Write-Info 'Required per-install secrets are missing; preparing one atomic, non-rotating .env migration.'
      Push-Location $RepoRoot
      try {
        Invoke-ComposeCommand -Arguments @('config', '--quiet')
        if ($LASTEXITCODE -ne 0) { Write-Err 'Existing .env validation failed.'; exit 1 }
      } finally { Pop-Location }
      try {
        $assistantKeyToAdd = ''
        $grpcAuthSecretToAdd = ''
        if ($assistantKey.State -eq 'missing') {
          Write-Info 'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is missing; checking the persistent pairing store before generating it.'
          Assert-NoExistingAssistantPairingData
          $AssistantSubscriptionEncryptionKey = New-Hex32
          $assistantKeyToAdd = $AssistantSubscriptionEncryptionKey
        }
        if ($syncingGrpcAuthSecret.State -eq 'missing') {
          $SyncingServerInternalGrpcAuthSecret = New-Hex32
          $grpcAuthSecretToAdd = $SyncingServerInternalGrpcAuthSecret
        }
        Add-MissingEnvironmentSecrets -Path $EnvFile -AssistantKey $assistantKeyToAdd -DurableGrpcAuthSecret $grpcAuthSecretToAdd
        $assistantKey = Get-AssistantSubscriptionKeyState -Path $EnvFile
        $syncingGrpcAuthSecret = Get-SyncingServerInternalGrpcAuthSecretState -Path $EnvFile
      } catch {
        Write-Err $_.Exception.Message
        exit 1
      }
      Push-Location $RepoRoot
      try {
        Invoke-ComposeCommand -Arguments @('config', '--quiet')
        if ($LASTEXITCODE -ne 0) { Write-Err 'Migrated .env validation failed.'; exit 1 }
      } finally { Pop-Location }
    }
    Write-Info 'Reusing the existing configuration; normal setup reruns never rotate existing secrets.'
    Push-Location $RepoRoot
    try {
      if ($Compose -eq 'docker compose') { docker compose config --quiet }
      else { docker-compose config --quiet }
      if ($LASTEXITCODE -ne 0) { Write-Err 'Existing .env validation failed.'; exit 1 }
      Write-Ok 'Existing .env validated.'
      if ($Up) {
        Write-Info 'Building and starting the existing stack...'
        try { $deploymentRevision = Set-CleanDeploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }
        if ($Compose -eq 'docker compose') { docker compose up -d --build }
        else { docker-compose up -d --build }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        try { Assert-StartedDeploymentIdentity -Revision $deploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }
        Write-Ok 'Stack started.'
      } else {
        Write-Info 'Start it with: .\scripts\setup.ps1 -Up'
      }
    } finally { Pop-Location }
    Write-Info 'Intentional rotation requires -ForceOverwrite. If an accidental overwrite already happened, run: npm run recover:database'
    exit 0
  }
  if ($assistantKey.State -eq 'missing') {
    Write-Err 'The existing .env has no assistant subscription encryption key. Run normal setup once to add it safely before a full overwrite.'
    exit 1
  }
  $AssistantSubscriptionEncryptionKey = $assistantKey.Value
  # Keep the purpose-specific command key stable across an intentional full
  # rewrite. A missing value is generated below; a valid value is not rotated.
  $SyncingServerInternalGrpcAuthSecret = $syncingGrpcAuthSecret.Value
  $backup = "$EnvFile.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
  if (Test-Path -LiteralPath $backup) {
    Write-Err "Refusing to overwrite existing environment backup: $backup"
    exit 1
  }
  Copy-Item -LiteralPath $EnvFile -Destination $backup
  Write-Ok "Backed up existing .env to: $backup"
}

# ---------------------------------------------------------------------------
# Gather user choices
# ---------------------------------------------------------------------------
Write-Title '1) Where will this server be reached?'
Write-Info 'For a plain localhost install just press Enter through these.'
Write-Info 'For an HTTPS deployment behind a domain, enter your domain (e.g. notes.example.com).'

$Domain = Read-Default 'Public domain or hostname (blank = localhost):' ''

$UseHttps    = 'false'
$CookieSecure = 'false'
$CookieDomain = ''
$AppBindAddress = '0.0.0.0'
if (-not [string]::IsNullOrEmpty($Domain)) {
  if (Confirm-Yes 'Is this domain served over HTTPS (recommended for real deployments)?') {
    $UseHttps = 'true'
    $CookieSecure = 'true'
    $AppBindAddress = '127.0.0.1'
  }
  $CookieDomain = $Domain
}

Write-Title '2) Host port'
Write-Info 'The public app port. The app''s nginx front door'
Write-Info 'proxies the API (/v1), files (/files/) and realtime websocket (/sockets)'
Write-Info 'same-origin, so the API gateway and files service publish no host ports.'
Write-Info 'Optional profiles may bind separate development ports to host loopback.'
$AppPort       = Read-Default 'Web app port:'            '3001'

Write-Title '3) Database'
$MysqlDatabase = Read-Default 'Database name:' 'standard_notes_db'
$MysqlUser     = Read-Default 'Database user:' 'std_notes_user'

Write-Title '4) Admin'
Write-Info 'Admin access is a persisted role. Register the account after startup, then run:'
Write-Info "$Compose exec server srn-admin roles grant <user> ADMIN_USER"

Write-Title '5) Safety posture'
$PublicDefault = if ([string]::IsNullOrEmpty($Domain)) { 'no' } else { 'yes' }
Write-Info 'Public instances get explicit rate limits, signup caps, and bounded infrastructure defaults.'
Write-Info 'Invite-only / approval-gated registration is safer after the first admin account exists.'
$PublicSafetyAnswer = Read-Default 'Apply public-instance registration safety defaults? (yes/no):' $PublicDefault
$UsePublicSafety = $PublicSafetyAnswer -match '^(1|true|y|yes)$'
$RegistrationSignupsPerIpMax = if ($UsePublicSafety) { '5' } else { '0' }
$RegistrationMaxTotalAccounts = if ($UsePublicSafety) { Read-Default 'Maximum total accounts (0 = no cap):' '0' } else { '0' }
$GateRegistrationAnswer = if ($UsePublicSafety) {
  Read-Default 'Require invite links and admin approval immediately? This can block first-account setup. (yes/no):' 'no'
} else {
  'no'
}
$GateRegistration = $GateRegistrationAnswer -match '^(1|true|y|yes)$'
$RegistrationInviteOnly = if ($GateRegistration) { 'true' } else { 'false' }
$RegistrationApprovalRequired = if ($GateRegistration) { 'true' } else { 'false' }

# Derive URLs / origins. Files are served through the app front door's /files/
# proxy, so the files URL is the app origin + /files.
if (-not [string]::IsNullOrEmpty($Domain)) {
  $Scheme = if ($UseHttps -eq 'true') { 'https' } else { 'http' }
  $PublicFilesServerUrl = if ($UseHttps -eq 'true') { "${Scheme}://${Domain}/files" } else { "${Scheme}://${Domain}:${AppPort}/files" }
  $PublicUrl = if ($UseHttps -eq 'true') { "${Scheme}://${Domain}" } else { "${Scheme}://${Domain}:${AppPort}" }
  $U2fRpId = $Domain
  $U2fExpectedOrigin = "${Scheme}://${Domain}:${AppPort},${Scheme}://${Domain}"
} else {
  $PublicFilesServerUrl = "http://localhost:${AppPort}/files"
  $PublicUrl = "http://localhost:${AppPort}"
  $U2fRpId = 'localhost'
  $U2fExpectedOrigin = "http://localhost:${AppPort},http://localhost"
}

# ---------------------------------------------------------------------------
# Generate secrets
# ---------------------------------------------------------------------------
Write-Title 'Generating secrets (32 random bytes each)...'
$AuthJwtSecret                  = New-Hex32
$AuthServerEncryptionServerKey  = New-Hex32
$ValetTokenSecret               = New-Hex32
$AuthServerPseudoKeyParamsKey   = New-Hex32
if (-not (Get-Variable -Name SyncingServerInternalGrpcAuthSecret -ErrorAction SilentlyContinue) -or
    [string]::IsNullOrEmpty($SyncingServerInternalGrpcAuthSecret)) {
  $SyncingServerInternalGrpcAuthSecret = New-Hex32
}
$WebsocketGatewayInternalSecret = New-Hex32
$WebSocketConnectionTokenSecret = New-Hex32
$MysqlPassword                  = New-Hex32
$MysqlRootPassword              = New-Hex32
if (-not (Get-Variable -Name AssistantSubscriptionEncryptionKey -ErrorAction SilentlyContinue)) {
  $AssistantSubscriptionEncryptionKey = New-Hex32
}
Write-Ok 'Secrets generated.'

# ---------------------------------------------------------------------------
# Write .env  (KEEP IN SYNC WITH scripts/setup.sh)
# ---------------------------------------------------------------------------
$generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$content = @"
# =============================================================================
# Standard Red Notes - environment configuration
# Generated by scripts/setup.ps1 on $generatedAt
#
# DO NOT COMMIT THIS FILE. It contains secrets. (.gitignore already excludes it.)
# Keep this file safe and backed up. Normal setup reruns preserve existing
# secrets; intentional rotation can lock users out or disconnect persisted data.
# =============================================================================

# ----- Public app port --------------------------------------------------------
# The app's nginx front door proxies the API, files and websocket same-origin;
# the API gateway and files service are internal-only (no host ports). Optional
# profiles may bind development-only ports to host loopback.
APP_PORT=$AppPort
# Keep the inner HTTP front door reachable only by a same-host reverse proxy.
# Direct LAN users may deliberately change this only while proxy HTTPS trust is off.
APP_BIND_ADDRESS=$AppBindAddress

# ----- Database (MariaDB) ----------------------------------------------------
MYSQL_DATABASE=$MysqlDatabase
MYSQL_USER=$MysqlUser
MYSQL_PASSWORD=$MysqlPassword
MYSQL_ROOT_PASSWORD=$MysqlRootPassword

# ----- Required server secrets (the stack will not start without these) ------
# 64-char hex (32 bytes). The encryption key MUST be exactly 32 bytes of hex.
AUTH_JWT_SECRET=$AuthJwtSecret
AUTH_SERVER_ENCRYPTION_SERVER_KEY=$AuthServerEncryptionServerKey
VALET_TOKEN_SECRET=$ValetTokenSecret

# Pseudo key-params seed. Auto-generated by the container if unset, but then it
# changes on every restart; pin it here so login key-params stay stable.
AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY=$AuthServerPseudoKeyParamsKey

# Dedicated HMAC key for durable API-gateway -> syncing-server gRPC commands.
SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET=$SyncingServerInternalGrpcAuthSecret

# ----- Security step-up client compatibility ---------------------------------
APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2=0.0.0
APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3=0.0.0

# ----- Realtime websocket gateway --------------------------------------------
# Shared secrets between the server and the websocket-gateway. Must match.
WEBSOCKET_GATEWAY_INTERNAL_SECRET=$WebsocketGatewayInternalSecret
WEB_SOCKET_CONNECTION_TOKEN_SECRET=$WebSocketConnectionTokenSecret

# Worker WebSocket is the primary durable sync transport. Empty allowed origins
# derive the exact browser origin from PUBLIC_URL below; HTTP remains fallback.
WEBSOCKET_SYNC_ENABLED=true
WEBSOCKET_SYNC_ALLOWED_ORIGINS=
WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER=4
WEBSOCKET_SYNC_REDIS_KEY_PREFIX=srn:ws-sync:v1
WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS=1500
WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS=30000
WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS=75000

# ----- Domain / cookies / origins --------------------------------------------
# Empty COOKIE_DOMAIN => host-only cookie (works on localhost / any bare host/IP).
# For an HTTPS deployment behind a domain, COOKIE_DOMAIN is your domain and
# COOKIE_SECURE=true so the auth cookie is only sent over HTTPS.
COOKIE_DOMAIN=$CookieDomain
COOKIE_SECURE=$CookieSecure
PUBLIC_FILES_SERVER_URL=$PublicFilesServerUrl
PUBLIC_URL=$PublicUrl
# Trust X-Forwarded-Proto only for the HTTPS reverse-proxy mode explicitly
# selected above. Local/direct HTTP installs keep this disabled.
ENFORCE_HTTPS_FROM_PROXY=$UseHttps

# WebAuthn / hardware-key (U2F) relying party. Should match where the app is served.
AUTH_SERVER_U2F_RELYING_PARTY_ID=$U2fRpId
AUTH_SERVER_U2F_EXPECTED_ORIGIN=$U2fExpectedOrigin

# ----- Analytics reports -----------------------------------------------------
# Optional analytics report recipients. This does not grant administrator access.
ADMIN_EMAILS=

# ----- Operational safety defaults ------------------------------------------
# These values make the generated install match the documented production
# posture. Tune them for larger instances, but do not remove them accidentally.
DB_CONNECTION_LIMIT=20
DB_MAX_CONNECTIONS=150
DB_MAX_QUERY_EXECUTION_TIME=45000
DB_INNODB_BUFFER_POOL_SIZE=512M
DB_MAX_ALLOWED_PACKET=128M
DB_INNODB_FLUSH_LOG_AT_TRX_COMMIT=1

CACHE_MEM_LIMIT=256m
CACHE_MAXMEMORY=192mb
CACHE_MAXMEMORY_POLICY=noeviction

HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES=50
MAX_CHUNK_BYTES=100000000
MAX_ATTACHMENT_BYTE_SIZE=5368709120

TRUST_PROXY=loopback,linklocal,uniquelocal
CORS_ORIGIN_STRICT_MODE_ENABLED=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_LOGIN_MAX=10
RATE_LIMIT_REGISTRATION_MAX=5
RATE_LIMIT_USER_WINDOW_SECONDS=60
RATE_LIMIT_USER_MAX=0
RATE_LIMIT_ADAPTIVE_ESCALATION=false

REGISTRATION_SIGNUPS_PER_IP_MAX=$RegistrationSignupsPerIpMax
REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS=24
REGISTRATION_SIGNUPS_PER_WEEK_MAX=0
REGISTRATION_SIGNUPS_PER_DEVICE_MAX=0
REGISTRATION_SIGNUPS_PER_DEVICE_WINDOW_HOURS=24
REGISTRATION_MAX_TOTAL_ACCOUNTS=$RegistrationMaxTotalAccounts
REGISTRATION_INVITE_ONLY=$RegistrationInviteOnly
REGISTRATION_APPROVAL_REQUIRED=$RegistrationApprovalRequired

# =============================================================================
# Optional settings (uncomment and edit as needed). Defaults are applied by
# docker-compose.yml when these are left unset.
# =============================================================================
# LOG_LEVEL=info
# COOKIE_SAME_SITE=Lax
# COOKIE_PARTITIONED=false
#
# # Feature / entitlement mode (this fork defaults to fully-included).
# STANDARD_RED_FEATURES_MODE=included
# STANDARD_RED_ENTITLEMENT_MODE=included
# STANDARD_RED_FULL_FEATURE_FILE_UPLOAD_BYTES_LIMIT=-1
#
# # Revision history retention (0 = keep everything).
# REVISIONS_RETENTION_DAYS=0
# REVISIONS_MAX_COUNT_PER_ITEM=0
#
# # WebAuthn relying party display name.
# AUTH_SERVER_U2F_RELYING_PARTY_NAME=Standard Red Notes
#
# # Assistant / LLM proxy (optional). The "openai" provider is OpenAI-compatible
# # and also serves LM Studio, Ollama (OpenAI mode), OpenRouter, etc.
# ASSISTANT_ANTHROPIC_API_KEY=
# ASSISTANT_OPENAI_API_KEY=
# ASSISTANT_OPENAI_BASE_URL=
# ASSISTANT_OPENAI_MODEL=
# ASSISTANT_OLLAMA_URL=
# ASSISTANT_DEFAULT_PROVIDER=
# ASSISTANT_DEFAULT_MODEL=
# # Guided ChatGPT/Codex pairing. PUBLIC_URL above must stay the exact public
# # origin. This dedicated key is generated once and must never be rotated while
# # an encrypted pairing file exists.
ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=$AssistantSubscriptionEncryptionKey
# ASSISTANT_SUBSCRIPTION_TOKEN_PATH=/opt/server/packages/api-gateway/data/assistant-subscription.json
# ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL=
# ASSISTANT_CHATGPT_OAUTH_TOKEN_URL=
# ASSISTANT_CHATGPT_OAUTH_CLIENT_ID=
# ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI=
# ASSISTANT_CHATGPT_OAUTH_SCOPES=
# ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM=
# # Compatibility-only direct bearer mode for the default slot. Prefer pairing.
# ASSISTANT_OPENAI_AUTH_MODE=
# ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN=
# ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL=
# ASSISTANT_OPENAI_ACCOUNT_ID=
# ASSISTANT_OPENAI_BETA=
# ASSISTANT_OPENAI_EXTRA_HEADERS=
# ASSISTANT_DAILY_REQUEST_LIMIT=0
#
# # Outbound email. Configure here or later in Preferences -> Admin -> Server ->
# # Email delivery. SMTP_SECURE=true selects implicit TLS (usually port 465);
# # otherwise STARTTLS is required. Insecure mode is accepted only for an
# # explicitly trusted loopback/private relay.
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM=
# SMTP_SECURE=false
# SMTP_ALLOW_INSECURE=false
#
# # MCP bridge (only used with: docker compose --profile mcp run --rm mcp)
# STANDARD_RED_NOTES_EMAIL=
# STANDARD_RED_NOTES_PASSWORD=
# STANDARD_RED_NOTES_ALLOW_WRITES=0
"@

# Write UTF-8 without BOM and with LF line endings (Compose/Docker friendly).
$content = $content -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($EnvFile, $content, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "Wrote $EnvFile"
if ($backup) {
  Write-Warn 'The complete environment was rotated. If that was accidental or startup now fails, run: npm run recover:database'
}

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------
Write-Title 'Done!'
$AppUrl = $PublicUrl

$startNow = $Up -or (Confirm-Yes "Start the stack now with '$Compose up -d'?")
if ($startNow) {
  Write-Info 'Building and starting the stack (first run can take several minutes)...'
  try { $deploymentRevision = Set-CleanDeploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }
  Push-Location $RepoRoot
  try {
    if ($Compose -eq 'docker compose') { docker compose up -d --build }
    else { docker-compose up -d --build }
  } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    if ($backup) { Write-Err 'Startup failed after credential rotation. Recover the prior full environment with: npm run recover:database' }
    exit $LASTEXITCODE
  }
  try { Assert-StartedDeploymentIdentity -Revision $deploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }
  Write-Ok "Stack started. Open: $AppUrl"
  Write-Info "Watch logs:  $Compose logs -f"
  Write-Info "Stop:        $Compose down"
} else {
  Write-Info 'Next steps:'
  Write-Host "  1. cd `"$RepoRoot`""
  Write-Host '  2. .\scripts\setup.ps1 -Up'
  Write-Host "  3. Open $AppUrl"
}
Write-Info "After registering an administrator: $Compose exec server srn-admin roles grant <user> ADMIN_USER"
