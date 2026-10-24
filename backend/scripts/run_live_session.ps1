<#
.SYNOPSIS
  Start the backend for the ONE human-approved (2026-10-25) paid live benchmark session.

.DESCRIPTION
  Sets process-only environment overrides, then starts uvicorn on 127.0.0.1:8000 in
  the foreground (one process, no reload). It contains no key: OPENROUTER_API_KEY
  comes from the ignored backend\.env or the caller's environment, and is never
  printed. Process variables override .env; .env itself is not edited.

  Starting the server makes no model call. The paid session starts only when the
  live action is confirmed (POST /api/v1/benchmark/sessions with
  {"source":"live","confirm_cost":true,"include_extension":false}).

  Values and their arithmetic are documented in backend\README.md
  ("Approved $2 live session (2026-10-25)"):
    MAX_SPEND_USD=2.00          human-approved raise for this session (hard maximum 2.00)
    CHAT_MAX_TOKENS=336         largest multiple of 16 whose required-session worst case
                                ($1.840903812) leaves >= $0.05 of the $1.944692352 remaining
    ALLOW_LIVE_RERUN=true       the saved seed-101 live warm-up is a G12 duplicate
    OPUS_TRUNCATION_GATE=report truncations are reported and counted, but do not stop
    EXPECTED_COST_WARMUP=0.22   1.5x = $0.33 >= worst-case warm-up $0.306817302
    EXPECTED_COST_PRIMARY=1.10  1.5x = $1.65 >= worst-case primary $1.534086510

  After the session, stop this server (Ctrl+C) and restart normally so
  ALLOW_LIVE_RERUN, the raised ceiling and report mode are no longer in effect.

.PARAMETER OpusTruncationGate
  'report' (default for this session) or 'stop' (the code default).

.PARAMETER CorsOrigins
  Optional comma-separated origins. When omitted, CORS_ORIGINS from .env applies.
#>
[CmdletBinding()]
param(
    [ValidateSet('stop', 'report')]
    [string]$OpusTruncationGate = 'report',
    [string]$CorsOrigins = ''
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    throw "Python virtual environment not found: $python"
}

# Exactly one ledger writer: refuse to start beside an existing backend.
if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8000 is already in use. Stop the existing backend first (one ledger writer only).'
}

$overrides = [ordered]@{
    MOCK_MODELS           = 'false'
    MAX_SPEND_USD         = '2.00'
    CHAT_MAX_TOKENS       = '336'
    ALLOW_LIVE_RERUN      = 'true'
    OPUS_TRUNCATION_GATE  = $OpusTruncationGate
    EXPECTED_COST_WARMUP  = '0.22'
    EXPECTED_COST_PRIMARY = '1.10'
}
if ($CorsOrigins) {
    $overrides['CORS_ORIGINS'] = $CorsOrigins
}

$previous = @{}
foreach ($name in $overrides.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $overrides[$name], 'Process')
    Write-Host "$name=$($overrides[$name])"
}

Push-Location $backend
try {
    & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
}
finally {
    Pop-Location
    foreach ($name in $overrides.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}
