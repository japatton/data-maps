<#
.SYNOPSIS
    Applies the Studio "fit the field table to the window" layout change to an
    existing copy of this project.

.DESCRIPTION
    Two edits, and nothing else:

      studio.css  The editor route stops being capped at 1280px, and the
                  Fields table is laid out fixed and sized in fractions of
                  the pane instead of in pixel minimums.  Together those are
                  what stop the table scrolling sideways.
      studio.js   The shell writes the current route onto <body>, which is
                  how the stylesheet knows to widen the editor and only the
                  editor.

    Every copy of Studio under -Path is patched: the source tree
    (<Path>\studio) and a built or deployed site (<Path>\public\studio), plus
    <Path> itself if you point straight at a studio directory.

    The script refuses to write anything unless it finds the exact text it
    expects in both files, so a diverged copy fails loudly rather than
    quietly half-applying.  Re-running it is safe: an already-patched copy is
    reported and skipped.

.PARAMETER Path
    The project root, a deployed site root, or a studio directory itself.
    Defaults to the current directory.

.PARAMETER DryRun
    Report what would change and write nothing.

.PARAMETER Revert
    Restore the .pre-studio-fit.bak copies written by an earlier run.

.EXAMPLE
    .\Update-StudioLayout.ps1 -Path C:\src\data-maps -DryRun

.EXAMPLE
    .\Update-StudioLayout.ps1 -Path C:\src\data-maps

.NOTES
    Windows PowerShell 5.1, no modules, no network.  Files are read and
    written as UTF-8 with their original line endings and BOM preserved.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Path = ".",

    [switch] $DryRun,

    [switch] $Revert
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$BackupSuffix = ".pre-studio-fit.bak"
$script:Changed = 0

# --- the edits ---------------------------------------------------------
# Each is an exact find/replace against the LF-normalised file.  Find text
# that is absent is an error, not a no-op: it means this copy is not the
# version these edits were written against.

$CssAnchorApp = @'
#app { max-width: 1280px; margin: 0 auto; padding: 12px 24px 48px; }
'@

$CssReplaceApp = @'
#app { max-width: 1280px; margin: 0 auto; padding: 12px 24px 48px; }

/* The editor is the one route that is a workbench rather than a document:
   the field table wants every pixel the window has, and capping it at 1280
   meant a 4K display scrolled that table exactly as far as a laptop did.
   The cap is lifted for that route alone - a settings form 1800px wide
   would be worse, not better.  It hangs off a body attribute because the
   floor here is Chrome 64 (see studio/tests/es2018.test.js) and
   #app:has(.editor) is Chrome 105. */
body[data-route="editor"] .site-header,
body[data-route="editor"] #app { max-width: 1800px; }
'@

$CssAnchorTable = @'
/* the field table: one dense row per vendor field */
.field-table { max-height: 62vh; }
.field-table table { font-size: 12px; min-width: 1150px; }
.field-table td { padding: 4px 6px; }
.field-table .field { margin: 0; }
.field-table input[type="text"], .field-table textarea,
.field-table select { padding: 3px 6px; font-size: 12px; }
.field-table .help, .field-table .error { font-size: 11px; margin-top: 2px; }
.cell-num { color: var(--muted); width: 30px; }
.cell-vendor { min-width: 150px; }
.cell-type { min-width: 90px; }
.cell-prose { min-width: 200px; }
.cell-ecs { min-width: 190px; }
.cell-status { min-width: 105px; }
.cell-controls { width: 1%; white-space: nowrap; }
.row-controls { display: flex; gap: 3px; }
'@

$CssReplaceTable = @'
/* the field table: one dense row per vendor field.

   Laid out fixed and sized in fractions of whatever the pane is, rather
   than in pixels.  Every cell holds a width:100% input or textarea, and
   under the automatic layout it is their intrinsic widths that decide the
   column - a textarea is twenty columns wide before it is anything else -
   which added up to about 1370px and dragged the table sideways however
   wide the window was.  Fixed layout ignores content width altogether: the
   columns are whatever the header row says, so the table lands exactly on
   the pane and the inputs shrink with it.

   min-width is the floor at which the prose columns stop being worth
   typing into and .table-wrap goes back to scrolling; it sits below the
   876px a 1280 window leaves for the table, so on any window worth
   editing on it never binds, and under 900px the media query has stacked
   the rail and handed the table the full width anyway. */
.field-table { max-height: 62vh; }
.field-table table {
  font-size: 12px; table-layout: fixed; min-width: 820px;
}
/* Percentages, not calc().  Chrome drops a calc() width on a column in a
   fixed-layout table - it silently falls back to dividing the table into
   equal columns - so the shares below have to be plain percentages, and
   they have to add up to 100. */
.field-table th:nth-child(1) { width: 3%; }
.field-table th:nth-child(2) { width: 12.5%; }
.field-table th:nth-child(3) { width: 7.5%; }
.field-table th:nth-child(4) { width: 14.5%; }
.field-table th:nth-child(5) { width: 13.5%; }
.field-table th:nth-child(6) { width: 8.5%; }
.field-table th:nth-child(7) { width: 7.5%; }
.field-table th:nth-child(8) { width: 12%; }
.field-table th:nth-child(9) { width: 12%; }
.field-table th:nth-child(10) { width: 9%; }
.field-table td { padding: 4px 6px; }
.field-table .field { margin: 0; }
.field-table input[type="text"], .field-table textarea,
.field-table select { padding: 3px 6px; font-size: 12px; }
.field-table .help, .field-table .error { font-size: 11px; margin-top: 2px; }
/* A fixed column cannot grow to fit its content, so anything that is not an
   input - a help line, a long ECS name - has to be allowed to wrap. */
.field-table td { overflow-wrap: break-word; }
.cell-num { color: var(--muted); }
.cell-controls { white-space: nowrap; }
/* The four buttons are the one thing in the row that cannot be made
   narrower, so they are allowed a second line instead.  Without this they
   overflow their column at narrow widths and put the sideways scrollbar
   back, which is the whole point of the rules above. */
.row-controls { display: flex; gap: 3px; flex-wrap: wrap; }
'@

$JsAnchor = @'
    ctx.settings = readSettings();
    renderRoute(app, ctx, parseRoute(window.location.hash), {
'@

$JsReplace = @'
    ctx.settings = readSettings();
    const route = parseRoute(window.location.hash);
    // The stylesheet widens the editor and only the editor, so it has to be
    // told which route is on screen; this is the one place that knows.
    if (document.body) document.body.setAttribute("data-route", route.name);
    renderRoute(app, ctx, route, {
'@

# What proves a copy is already patched, per file.
$CssMarker = 'body[data-route="editor"] #app'
$JsMarker = 'document.body.setAttribute("data-route"'

# --- file helpers ------------------------------------------------------
# Read and write bytes rather than using Get-Content/Set-Content: 5.1 writes
# a BOM with -Encoding UTF8 and rewrites line endings, and this project's
# files are LF without a BOM.  Whatever a copy has, it keeps.

function Read-StudioFile {
    param([string] $File)

    $bytes = [System.IO.File]::ReadAllBytes($File)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
            $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $offset = 0
    if ($bom) { $offset = 3 }
    $text = [System.Text.Encoding]::UTF8.GetString(
        $bytes, $offset, $bytes.Length - $offset)
    $crlf = $text.Contains("`r`n")
    return [pscustomobject] @{
        Text = $text.Replace("`r`n", "`n")
        Crlf = $crlf
        Bom  = $bom
    }
}

function Write-StudioFile {
    param([string] $File, [string] $Text, [bool] $Crlf, [bool] $Bom)

    $out = $Text
    if ($Crlf) { $out = $out.Replace("`n", "`r`n") }
    $encoding = New-Object System.Text.UTF8Encoding($Bom)
    [System.IO.File]::WriteAllText($File, $out, $encoding)
}

function Normalize-Patch {
    param([string] $Text)
    # The .ps1 itself may have been saved CRLF; the here-strings above must
    # match files that are LF.
    return $Text.Replace("`r`n", "`n")
}

# --- one studio directory ----------------------------------------------

function Update-StudioDirectory {
    param([string] $Dir)

    $css = Join-Path $Dir "studio.css"
    $js = Join-Path $Dir "studio.js"

    Write-Host ""
    Write-Host ("  " + $Dir) -ForegroundColor Cyan

    $cssFile = Read-StudioFile $css
    $jsFile = Read-StudioFile $js

    $cssDone = $cssFile.Text.Contains($CssMarker)
    $jsDone = $jsFile.Text.Contains($JsMarker)

    if ($cssDone -and $jsDone) {
        Write-Host "    already up to date, nothing to do" -ForegroundColor DarkGray
        return $true
    }

    # Check every anchor before writing any file: a copy that is half a
    # version behind must fail with both files untouched.
    $problems = @()
    if (-not $cssDone) {
        if (-not $cssFile.Text.Contains((Normalize-Patch $CssAnchorApp))) {
            $problems += "studio.css: the '#app { max-width: 1280px' rule is not as expected"
        }
        if (-not $cssFile.Text.Contains((Normalize-Patch $CssAnchorTable))) {
            $problems += "studio.css: the field-table block is not as expected"
        }
    }
    if (-not $jsDone) {
        if (-not $jsFile.Text.Contains((Normalize-Patch $JsAnchor))) {
            $problems += "studio.js: the render() route call is not as expected"
        }
    }
    if ($problems.Count -gt 0) {
        foreach ($p in $problems) { Write-Host ("    SKIPPED - " + $p) -ForegroundColor Yellow }
        Write-Host "    this copy has diverged; nothing was written" -ForegroundColor Yellow
        return $false
    }

    if ($DryRun) {
        if (-not $cssDone) { Write-Host "    would patch studio.css (2 edits)" }
        if (-not $jsDone) { Write-Host "    would patch studio.js  (1 edit)" }
        return $true
    }

    if (-not $cssDone) {
        Copy-Item -LiteralPath $css -Destination ($css + $BackupSuffix) -Force
        $text = $cssFile.Text
        $text = $text.Replace((Normalize-Patch $CssAnchorApp),
                              (Normalize-Patch $CssReplaceApp))
        $text = $text.Replace((Normalize-Patch $CssAnchorTable),
                              (Normalize-Patch $CssReplaceTable))
        Write-StudioFile $css $text $cssFile.Crlf $cssFile.Bom
        $script:Changed++
        Write-Host "    patched studio.css (2 edits)" -ForegroundColor Green
    }
    else {
        Write-Host "    studio.css already current" -ForegroundColor DarkGray
    }

    if (-not $jsDone) {
        Copy-Item -LiteralPath $js -Destination ($js + $BackupSuffix) -Force
        $text = $jsFile.Text.Replace((Normalize-Patch $JsAnchor),
                                     (Normalize-Patch $JsReplace))
        Write-StudioFile $js $text $jsFile.Crlf $jsFile.Bom
        $script:Changed++
        Write-Host "    patched studio.js  (1 edit)" -ForegroundColor Green
    }
    else {
        Write-Host "    studio.js already current" -ForegroundColor DarkGray
    }

    return $true
}

function Restore-StudioDirectory {
    param([string] $Dir)

    Write-Host ""
    Write-Host ("  " + $Dir) -ForegroundColor Cyan
    $restored = 0
    foreach ($name in @("studio.css", "studio.js")) {
        $live = Join-Path $Dir $name
        $backup = $live + $BackupSuffix
        if (Test-Path -LiteralPath $backup) {
            if ($DryRun) {
                Write-Host ("    would restore " + $name)
            }
            else {
                Copy-Item -LiteralPath $backup -Destination $live -Force
                Remove-Item -LiteralPath $backup -Force
                Write-Host ("    restored " + $name) -ForegroundColor Green
            }
            $restored++
        }
    }
    if ($restored -eq 0) {
        Write-Host "    no backup from this script here" -ForegroundColor DarkGray
    }
    return $true
}

# --- find the copies ---------------------------------------------------

if (-not (Test-Path -LiteralPath $Path)) {
    throw "No such path: $Path"
}
$root = (Resolve-Path -LiteralPath $Path).Path

$candidates = @(
    $root,
    (Join-Path $root "studio"),
    (Join-Path $root (Join-Path "public" "studio"))
)

$found = @()
foreach ($dir in $candidates) {
    if ((Test-Path -LiteralPath (Join-Path $dir "studio.css")) -and
        (Test-Path -LiteralPath (Join-Path $dir "studio.js"))) {
        $found += $dir
    }
}

if ($found.Count -eq 0) {
    throw ("Found no Studio copy under $root. Expected studio.css and " +
           "studio.js in that directory, in .\studio, or in .\public\studio.")
}

$action = "Updating"
if ($Revert) { $action = "Reverting" }
$suffix = ""
if ($DryRun) { $suffix = "  (dry run - nothing will be written)" }
Write-Host ""
Write-Host ($action + " Studio layout in " + $found.Count.ToString() +
            " location(s) under " + $root + $suffix)

$ok = $true
foreach ($dir in $found) {
    if ($Revert) { $result = Restore-StudioDirectory $dir }
    else { $result = Update-StudioDirectory $dir }
    if (-not $result) { $ok = $false }
}

# --- what to do next ---------------------------------------------------

Write-Host ""
if (-not $ok) {
    Write-Host "Finished with skips - see the warnings above." -ForegroundColor Yellow
}
else {
    Write-Host "Done." -ForegroundColor Green
}

$patchedBuild = $found -contains (Join-Path $root (Join-Path "public" "studio"))
$patchedSource = $found -contains (Join-Path $root "studio")

if (-not $DryRun -and -not $Revert -and $script:Changed -gt 0) {
    Write-Host ""
    Write-Host "Next:"
    Write-Host "  - Hard-refresh Studio in the browser (Ctrl+F5). The stylesheet"
    Write-Host "    is served with normal caching and the old one will otherwise"
    Write-Host "    stay put."
    if ($patchedBuild -and -not $patchedSource) {
        Write-Host ""
        Write-Host ("  - You patched a built site only. The next pipeline will " +
                    "overwrite it,") -ForegroundColor Yellow
        Write-Host ("    because the build copies studio\ over public\studio\ " +
                    "wholesale.") -ForegroundColor Yellow
        Write-Host ("    Run this against the source checkout too, and commit " +
                    "it.") -ForegroundColor Yellow
    }
    if ($patchedSource) {
        Write-Host "  - Rebuild so the published copy matches:"
        Write-Host "        python -m datamaps.build"
        Write-Host "  - Then commit studio\studio.css and studio\studio.js."
    }
    Write-Host ""
    Write-Host ("  - To undo: .\Update-StudioLayout.ps1 -Path " + $root +
                " -Revert")
}
