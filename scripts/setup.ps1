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

.EXAMPLE
  ./scripts/setup.ps1
  ./scripts/setup.ps1 -Up
  ./scripts/setup.ps1 -Yes -Up
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Up
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
if (Test-Path $EnvFile) {
  Write-Warn "An .env file already exists at: $EnvFile"
  if (-not (Confirm-Yes 'Overwrite it? A timestamped backup will be made first.')) {
    Write-Err 'Aborted. Existing .env left untouched.'
    exit 1
  }
  $backup = "$EnvFile.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item -Path $EnvFile -Destination $backup -Force
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
if (-not [string]::IsNullOrEmpty($Domain)) {
  if (Confirm-Yes 'Is this domain served over HTTPS (recommended for real deployments)?') {
    $UseHttps = 'true'
    $CookieSecure = 'true'
  }
  $CookieDomain = $Domain
}

Write-Title '2) Host ports'
Write-Info 'These are the ports published on the host machine.'
$AppPort       = Read-Default 'Web app port:'            '3001'
$ServerPort    = Read-Default 'API gateway port:'        '3000'
$FilesPort     = Read-Default 'Files service port:'      '3125'
# The realtime websocket gateway runs in-process on the API gateway port (no
# separate host port), so it is not prompted for here.

Write-Title '3) Database'
$MysqlDatabase = Read-Default 'Database name:' 'standard_notes_db'
$MysqlUser     = Read-Default 'Database user:' 'std_notes_user'

Write-Title '4) Admin'
Write-Info 'Comma-separated emails granted the in-app Admin panel (optional).'
$AdminEmails = Read-Default 'Admin email(s):' ''

# Derive URLs / origins
if (-not [string]::IsNullOrEmpty($Domain)) {
  $Scheme = if ($UseHttps -eq 'true') { 'https' } else { 'http' }
  $PublicFilesServerUrl = "${Scheme}://${Domain}:${FilesPort}"
  $U2fRpId = $Domain
  $U2fExpectedOrigin = "${Scheme}://${Domain}:${AppPort},${Scheme}://${Domain}"
} else {
  $PublicFilesServerUrl = "http://localhost:${FilesPort}"
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
$WebsocketGatewayInternalSecret = New-Hex32
$WebSocketConnectionTokenSecret = New-Hex32
$MysqlPassword                  = New-Hex32
$MysqlRootPassword              = New-Hex32
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
# Re-run scripts/setup.ps1 to regenerate. Changing the secrets below after users
# exist will lock people out, so keep this file safe and backed up.
# =============================================================================

# ----- Host ports (published on the host machine) ----------------------------
APP_PORT=$AppPort
SERVER_PORT=$ServerPort
FILES_PORT=$FilesPort

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

# ----- Realtime websocket gateway --------------------------------------------
# Shared secrets between the server and the websocket-gateway. Must match.
WEBSOCKET_GATEWAY_INTERNAL_SECRET=$WebsocketGatewayInternalSecret
WEB_SOCKET_CONNECTION_TOKEN_SECRET=$WebSocketConnectionTokenSecret

# ----- Domain / cookies / origins --------------------------------------------
# Empty COOKIE_DOMAIN => host-only cookie (works on localhost / any bare host/IP).
# For an HTTPS deployment behind a domain, COOKIE_DOMAIN is your domain and
# COOKIE_SECURE=true so the auth cookie is only sent over HTTPS.
COOKIE_DOMAIN=$CookieDomain
COOKIE_SECURE=$CookieSecure
PUBLIC_FILES_SERVER_URL=$PublicFilesServerUrl

# WebAuthn / hardware-key (U2F) relying party. Should match where the app is served.
AUTH_SERVER_U2F_RELYING_PARTY_ID=$U2fRpId
AUTH_SERVER_U2F_EXPECTED_ORIGIN=$U2fExpectedOrigin

# ----- Admin -----------------------------------------------------------------
# Comma-separated emails granted the in-app Admin panel and /admin endpoints.
ADMIN_EMAILS=$AdminEmails

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
# ASSISTANT_DAILY_REQUEST_LIMIT=0
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

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------
Write-Title 'Done!'
if (-not [string]::IsNullOrEmpty($Domain)) {
  $Scheme = if ($UseHttps -eq 'true') { 'https' } else { 'http' }
  $AppUrl = "${Scheme}://${Domain}:${AppPort}"
} else {
  $AppUrl = "http://localhost:${AppPort}"
}

$startNow = $Up -or (Confirm-Yes "Start the stack now with '$Compose up -d'?")
if ($startNow) {
  Write-Info 'Building and starting the stack (first run can take several minutes)...'
  Push-Location $RepoRoot
  try {
    if ($Compose -eq 'docker compose') { docker compose up -d --build }
    else { docker-compose up -d --build }
  } finally { Pop-Location }
  Write-Ok "Stack started. Open: $AppUrl"
  Write-Info "Watch logs:  $Compose logs -f"
  Write-Info "Stop:        $Compose down"
} else {
  Write-Info 'Next steps:'
  Write-Host "  1. cd `"$RepoRoot`""
  Write-Host "  2. $Compose up -d --build"
  Write-Host "  3. Open $AppUrl"
}
