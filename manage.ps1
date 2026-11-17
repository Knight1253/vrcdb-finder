$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Say($m, $c = 'Cyan') { Write-Host $m -ForegroundColor $c }
$utf8 = New-Object System.Text.UTF8Encoding $false

function Add-ToList($file, $prop, $value) {
    $obj = Get-Content $file -Raw | ConvertFrom-Json
    $cur = @($obj.$prop | Where-Object { $_ })
    if ($cur -contains $value) { Say "Already in $file" 'Yellow'; return }
    $obj.$prop = @($cur + $value)
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $file), ($obj | ConvertTo-Json -Depth 5), $utf8)
    Say "Added '$value' to $file ($prop). Commit and push to apply." 'Green'
}
function Set-Secret($name) {
    if (-not (Has gh)) { Say "GitHub CLI (gh) is required." 'Red'; return }
    $sec = Read-Host "Value for $name (input hidden)" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if ([string]::IsNullOrWhiteSpace($plain)) { Say "Empty, skipped." 'Yellow'; return }
    $plain | gh secret set $name
    Say "$name saved." 'Green'
}
function Repo-Slug { if (Has gh) { (gh repo view --json nameWithOwner --jq .nameWithOwner 2>$null) } }

while ($true) {
    Write-Host ""
    Say "=== VRC Avatar DB Finder ===" 'Green'
    Write-Host " 1) Run scan locally (incremental)"
    Write-Host " 2) Run scan locally (full)"
    Write-Host " 3) Run scan on GitHub (full)"
    Write-Host " 4) Block a repo / owner / keyword"
    Write-Host " 5) Allow a repo (override a safety flag)"
    Write-Host " 6) Queue a repo (submission)"
    Write-Host " 7) Set Discord webhook secret"
    Write-Host " 8) Set GH_PAT secret (higher rate limits)"
    Write-Host " 9) Commit and push my changes"
    Write-Host "10) Pull latest results"
    Write-Host "11) Open site / repo / actions"
    Write-Host "12) Run offline smoke test"
    Write-Host " Q) Quit"
    $c = (Read-Host "Choose").Trim().ToLower()
    try {
        switch ($c) {
            '1' { if (-not (Has node)) { Say "Node.js 20+ required." 'Red' } else { if (Has gh) { $env:GH_TOKEN = (gh auth token) }; node scan.js } }
            '2' { if (-not (Has node)) { Say "Node.js 20+ required." 'Red' } else { if (Has gh) { $env:GH_TOKEN = (gh auth token) }; node scan.js --full } }
            '3' { gh workflow run scan.yml -f full=true; Say "Triggered. Watch the Actions tab." 'Green' }
            '4' {
                $t = Read-Host "Type: repo / owner / keyword"
                $v = Read-Host "Value (repo: owner/name, owner: name, keyword: regex)"
                $prop = switch ($t) { 'repo' { 'repos' } 'owner' { 'owners' } 'keyword' { 'keywords' } default { $null } }
                if ($prop -and $v) { Add-ToList 'data\blocklist.json' $prop $v } else { Say "Invalid input." 'Red' }
            }
            '5' { $v = Read-Host "Repo (owner/name)"; if ($v) { Add-ToList 'data\allowlist.json' 'repos' $v } }
            '6' { $v = Read-Host "Repo (owner/name)"; if ($v) { Add-ToList 'data\submissions.json' 'repos' $v } }
            '7' { Set-Secret 'DISCORD_WEBHOOK_URL' }
            '8' { Set-Secret 'GH_PAT' }
            '9' { git add -A; git commit -m "Update lists/config"; git push }
            '10' { git pull --rebase }
            '11' {
                $slug = Repo-Slug
                if (-not $slug) { Say "Could not detect the repo (is gh installed and logged in?)" 'Red' }
                else {
                    $o, $n = $slug -split '/'
                    Start-Process "https://$($o.ToLower()).github.io/$n/"
                    Start-Process "https://github.com/$slug/actions"
                }
            }
            '12' { if (-not (Has node)) { Say "Node.js 20+ required." 'Red' } else { node test/mock-run.js } }
            'q' { return }
            default { Say "Unknown option." 'Yellow' }
        }
    } catch { Say "Error: $($_.Exception.Message)" 'Red' }
}
