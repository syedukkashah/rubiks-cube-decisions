<#
.SYNOPSIS
  Start the backend for the SECOND attempt at the ONE human-approved (2026-10-25) paid
  live benchmark session.

.DESCRIPTION
  Sets process-only environment overrides, then starts uvicorn on 127.0.0.1:8000 in
  the foreground (one process, no reload). It contains no key: OPENROUTER_API_KEY
  comes from the ignored backend\.env or the caller's environment, and is never
  printed. Process variables override .env; .env itself is not edited.

  Starting the server makes no model call. The paid session starts only when the
  live action is confirmed (POST /api/v1/benchmark/sessions with
  {"source":"live","confirm_cost":true,"include_extension":false}).

  The first attempt (cap 336, sess_e92516433a334c6db0adbacfec3fc4e2) failed after
  $0.067 because the OpenRouter account had no credit. Top the account up first.

  Values and their arithmetic are documented in backend\README.md
  ("Second attempt: cap 512 with rolling admission"):
    MAX_SPEND_USD=2.00          human-approved session ceiling (hard maximum 2.00)
    CHAT_MAX_TOKENS=512         the code's hard maximum: the truncation fix
    ALLOW_LIVE_RERUN=true       completed seed-101 live warm-ups exist in the history
    OPUS_TRUNCATION_GATE=report truncations are reported and counted, but do not stop
    LIVE_ADMISSION=rolling      admit if one puzzle's worst case ($0.423) + $0.05 fits;
                                re-check before every puzzle and step (human-approved)
    EXPECTED_COST_WARMUP=0.29   1.5x = $0.435 >= worst-case warm-up $0.422996442
    EXPECTED_COST_PRIMARY=1.41  1.5x = $2.115 >= worst-case primary $2.114982210
    BENCHMARK_TIMEOUT_S=20      the API maximum; same per-call timeout for all models

  After the session, stop this server (Ctrl+C) and restart normally so the
  overrides are no longer in effect.

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
    CHAT_MAX_TOKENS       = '512'
    ALLOW_LIVE_RERUN      = 'true'
    OPUS_TRUNCATION_GATE  = $OpusTruncationGate
    LIVE_ADMISSION        = 'rolling'
    EXPECTED_COST_WARMUP  = '0.29'
    EXPECTED_COST_PRIMARY = '1.41'
    BENCHMARK_TIMEOUT_S   = '20'
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
