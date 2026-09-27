$ErrorActionPreference = 'Stop'
$env:GH_DEBUG = $null
$env:GIT_TRACE = $null
$env:GIT_CURL_VERBOSE = $null
$taskRepo = 'q956085398-netizen/MyAINovel'
$taskPublished = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'published.json') -Raw | ConvertFrom-Json)
if ($taskPublished.Count -ne 7) { throw 'All seven approved issues must exist before linking.' }
$taskLiveJson = gh api ('repos/' + $taskRepo + '/issues?state=open&per_page=100')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read issue identities.' }
$taskLive = @(($taskLiveJson -join "`n") | ConvertFrom-Json)
$taskIds = @{}
foreach ($ticket in $taskPublished) {
    $live = $taskLive | Where-Object { $_.number -eq $ticket.number }
    if (!$live -or $live.title -ne $ticket.title) { throw ('Issue mismatch: ' + $ticket.number) }
    $taskIds[$ticket.key] = $live.id
}
$taskGroups = @(
    @{ Child = '02'; Blockers = @('01') },
    @{ Child = '06'; Blockers = @('02', '03', '04', '05') },
    @{ Child = '07'; Blockers = @('06') }
)
foreach ($group in $taskGroups) {
    $child = $taskPublished | Where-Object { $_.key -eq $group.Child }
    $endpoint = 'repos/' + $taskRepo + '/issues/' + $child.number + '/dependencies/blocked_by'
    $existingJson = gh api $endpoint
    if ($LASTEXITCODE -ne 0) { throw ('Cannot inspect blockers for #' + $child.number) }
    $existing = @(($existingJson -join "`n") | ConvertFrom-Json)
    foreach ($blockerKey in $group.Blockers) {
        $blocker = $taskPublished | Where-Object { $_.key -eq $blockerKey }
        if (!($existing | Where-Object { $_.id -eq $taskIds[$blockerKey] })) {
            gh api --method POST $endpoint -F ('issue_id=' + $taskIds[$blockerKey]) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw ('Cannot link #' + $child.number + ' to #' + $blocker.number) }
        }
        [PSCustomObject]@{ child = $child.number; blockedBy = $blocker.number } | ConvertTo-Json -Compress
    }
}
