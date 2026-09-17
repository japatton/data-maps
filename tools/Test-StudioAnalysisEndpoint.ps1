<#
.SYNOPSIS
    Tells you why Studio's Analyze run was blocked: mixed content, CORS, or
    an endpoint that is simply not answering.

.DESCRIPTION
    Studio cannot tell these apart. A browser reports all three to
    JavaScript as one bare TypeError, which is why the Analyze error reads
    "blocked, offline, or no CORS headers" - the code at
    studio/lib/llm.js:546 has nothing else to go on.

    This asks the endpoint the same two questions the browser asks, from
    outside the browser, where the answers are visible:

      1. Is it reachable at all?
      2. Does it approve the CORS preflight for the origin Studio is
         served from?

    -StudioUrl is the address you load Studio at. -ApiUrl is the analysis
    endpoint from Settings (the base, ending in /v1 or similar) - the same
    value the site was built with.

.EXAMPLE
    .\Test-StudioAnalysisEndpoint.ps1 -StudioUrl https://pages.corp.example/data-maps/studio/ -ApiUrl https://llm.corp.example/v1

.NOTES
    Windows PowerShell 5.1, no modules. Read-only: it sends an OPTIONS
    preflight and a GET, never a completion.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $StudioUrl,
    [Parameter(Mandatory = $true)] [string] $ApiUrl,
    [switch] $SkipCertCheck
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

[Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11

if ($SkipCertCheck) {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    Write-Host "TLS certificate validation disabled for this run." -ForegroundColor Yellow
}

# Header lookup that works on both engines: Windows PowerShell 5.1 hands back
# a WebHeaderCollection (.AllKeys), PowerShell 7 an HttpResponseHeaders
# (enumerable of pairs), and a success object a plain dictionary.  The script
# targets 5.1, so this is what lets it be exercised on 7 as well.
function Get-HeaderValue {
    param($Headers, [string] $Name)

    if ($Headers -eq $null) { return $null }
    $wanted = $Name.ToLower()

    if ($Headers -is [System.Net.WebHeaderCollection]) {
        foreach ($k in $Headers.AllKeys) {
            if ($k -and $k.ToLower() -eq $wanted) { return $Headers[$k] }
        }
        return $null
    }
    if ($Headers -is [System.Collections.IDictionary]) {
        foreach ($k in $Headers.Keys) {
            if ($k -and $k.ToString().ToLower() -eq $wanted) {
                return ($Headers[$k] -join ", ")
            }
        }
        return $null
    }
    foreach ($pair in $Headers) {
        if ($pair -and $pair.Key -and $pair.Key.ToString().ToLower() -eq $wanted) {
            return ($pair.Value -join ", ")
        }
    }
    return $null
}

function Get-ErrorResponse {
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    if ($ex -eq $null) { return $null }
    if ($ex.PSObject.Properties.Name -notcontains "Response") { return $null }
    return $ex.Response
}

$studio = [Uri] $StudioUrl
$api = [Uri] $ApiUrl
$origin = $studio.Scheme + "://" + $studio.Authority
$completions = ($ApiUrl.TrimEnd("/")) + "/chat/completions"

Write-Host ""
Write-Host "Studio origin : $origin"
Write-Host "Analysis URL  : $completions"
Write-Host ""

$verdicts = @()

# --- 1. mixed content --------------------------------------------------
# Decided by the two schemes alone; no request can reveal it, because the
# browser refuses before anything leaves.
Write-Host "1. Mixed content" -ForegroundColor Cyan
if ($studio.Scheme -eq "https" -and $api.Scheme -eq "http") {
    Write-Host "   BLOCKED - an https page may not call an http endpoint." -ForegroundColor Red
    Write-Host "   The browser refuses this before any request is sent, and"
    Write-Host "   reports no CORS error, because there is no response to read."
    Write-Host "   Nothing about CORS below can fix it: the endpoint needs TLS."
    $verdicts += "mixed-content"
}
else {
    Write-Host "   OK - $($studio.Scheme) page calling $($api.Scheme) endpoint." -ForegroundColor Green
}

# --- 2. reachable ------------------------------------------------------
Write-Host ""
Write-Host "2. Reachable" -ForegroundColor Cyan
$reachable = $false
try {
    $models = ($ApiUrl.TrimEnd("/")) + "/models"
    $r = Invoke-WebRequest -Uri $models -Method Get -UseBasicParsing -TimeoutSec 15
    Write-Host "   OK - GET /models answered HTTP $([int] $r.StatusCode)." -ForegroundColor Green
    $reachable = $true
}
catch {
    $resp = Get-ErrorResponse $_
    if ($resp -ne $null) {
        # An HTTP error is still an answer: the host is up and routable.
        Write-Host ("   OK - answered HTTP " + [int] $resp.StatusCode +
                    " (an error, but it answered)." ) -ForegroundColor Green
        Write-Host "   An auth-required status here is normal; this test sends no key."
        $reachable = $true
    }
    else {
        Write-Host "   UNREACHABLE - no answer at all." -ForegroundColor Red
        Write-Host ("   " + $_.Exception.Message)
        Write-Host "   This is the 'offline' arm of the Studio message: DNS, routing,"
        Write-Host "   a firewall, or nothing listening on that port."
        $verdicts += "unreachable"
    }
}

# --- 3. the CORS preflight --------------------------------------------
# The Analyze call is always preflighted: Content-Type: application/json is
# not a CORS-safelisted value, and an API key adds Authorization on top.
Write-Host ""
Write-Host "3. CORS preflight (OPTIONS, as the browser sends it)" -ForegroundColor Cyan
if (-not $reachable) {
    Write-Host "   SKIPPED - nothing answered above." -ForegroundColor DarkGray
}
else {
    $allowOrigin = $null
    $status = $null
    $headers = $null
    try {
        $pre = Invoke-WebRequest -Uri $completions -Method Options -UseBasicParsing `
            -TimeoutSec 15 -Headers @{
                "Origin"                         = $origin
                "Access-Control-Request-Method"  = "POST"
                "Access-Control-Request-Headers" = "authorization,content-type"
            }
        $status = [int] $pre.StatusCode
        $headers = $pre.Headers
    }
    catch {
        $resp = Get-ErrorResponse $_
        if ($resp -ne $null) {
            $status = [int] $resp.StatusCode
            $headers = $resp.Headers
        }
        else {
            Write-Host "   No answer to the preflight." -ForegroundColor Red
            Write-Host ("   " + $_.Exception.Message)
            $verdicts += "preflight-unreachable"
        }
    }

    if ($status -ne $null) {
        $allowOrigin = Get-HeaderValue $headers "Access-Control-Allow-Origin"
        Write-Host "   HTTP $status"
        if ($allowOrigin) {
            Write-Host "   Access-Control-Allow-Origin: $allowOrigin" -ForegroundColor Green
            if ($allowOrigin -eq "*" -or $allowOrigin -eq $origin) {
                Write-Host "   OK - this origin is allowed." -ForegroundColor Green
            }
            else {
                Write-Host "   MISMATCH - allowed origin is not $origin." -ForegroundColor Red
                $verdicts += "cors-origin-mismatch"
            }
        }
        else {
            Write-Host "   NO Access-Control-Allow-Origin header." -ForegroundColor Red
            Write-Host "   The browser rejects the preflight and the POST is never sent."
            Write-Host "   This is what Studio reports as 'no CORS headers'."
            $verdicts += "no-cors-headers"
        }
    }
}

# --- verdict -----------------------------------------------------------
Write-Host ""
Write-Host "Verdict" -ForegroundColor Cyan
if ($verdicts.Count -eq 0) {
    Write-Host "   The transport looks fine from here." -ForegroundColor Green
    Write-Host "   If Analyze still fails, check the browser console for the exact"
    Write-Host "   refusal, and confirm Settings really holds this URL."
}
else {
    foreach ($v in $verdicts) {
        switch ($v) {
            "mixed-content" {
                Write-Host "   * Mixed content. Put the endpoint behind TLS." -ForegroundColor Yellow
            }
            "unreachable" {
                Write-Host "   * Not reachable from this machine." -ForegroundColor Yellow
            }
            "no-cors-headers" {
                Write-Host ("   * No CORS headers. The endpoint owner must return " +
                            "Access-Control-Allow-Origin: $origin,") -ForegroundColor Yellow
                Write-Host ("     allow the Authorization and Content-Type request " +
                            "headers, and answer OPTIONS.") -ForegroundColor Yellow
            }
            "cors-origin-mismatch" {
                Write-Host "   * CORS is on but does not cover $origin." -ForegroundColor Yellow
            }
            default {
                Write-Host "   * $v" -ForegroundColor Yellow
            }
        }
    }
}
Write-Host ""
