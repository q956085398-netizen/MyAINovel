$ErrorActionPreference = 'Stop'
$env:GH_DEBUG = $null
$env:GIT_TRACE = $null
$env:GIT_CURL_VERBOSE = $null
$taskRepo = 'q956085398-netizen/MyAINovel'
$taskRoot = $PSScriptRoot
$manifestPath = Join-Path $taskRoot 'published.json'
$publishedRoot = Join-Path $taskRoot 'published'
[IO.Directory]::CreateDirectory($publishedRoot) | Out-Null
$taskTickets = @(
    @{ Key = '01'; File = '01-save-navigation.md'; Title = '修复保存与导航期间新增文字丢失' },
    @{ Key = '02'; File = '02-library-switch.md'; Title = '切库隔离：保存保护、旧对象退出与迟到响应处理' },
    @{ Key = '03'; File = '03-foreshadow-pending.md'; Title = '伏笔待打磨：原条目状态与完整便笺' },
    @{ Key = '04'; File = '04-expectation-pending.md'; Title = '期待感与目标待打磨：完整便笺与档位恢复' },
    @{ Key = '05'; File = '05-milestone-pending.md'; Title = '主线里程碑待打磨：完整便笺与同名定位保护' },
    @{ Key = '06'; File = '06-integration-build.md'; Title = '整合修复回归并生成当前 Windows 构建' },
    @{ Key = '07'; File = '07-windows-acceptance.md'; Title = 'Windows 实机终验：旧库副本、新库与应用重启' }
)
$taskPublished = @()
if (Test-Path -LiteralPath $manifestPath) {
    $taskPublished = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
}
foreach ($ticket in $taskTickets) {
    if ($taskPublished | Where-Object { $_.key -eq $ticket.Key }) { continue }
    $body = [IO.File]::ReadAllText((Join-Path (Join-Path $taskRoot 'issues') $ticket.File))
    if ($ticket.Key -eq '06') {
        $firstFive = @($taskPublished | Where-Object { [int]$_.key -le 5 } | ForEach-Object { '#' + $_.number })
        $body = $body.Replace('工单 01–05', ($firstFive -join '、'))
    }
    foreach ($prior in $taskPublished) {
        $body = $body.Replace(('工单 ' + $prior.key), ('工单 #' + $prior.number))
    }
    $bodyPath = Join-Path $publishedRoot $ticket.File
    [IO.File]::WriteAllText($bodyPath, $body, [Text.UTF8Encoding]::new($false))
    $createdUrl = gh issue create --repo $taskRepo --title $ticket.Title --body-file $bodyPath --label ready-for-agent --label wayfinder:task
    if ($LASTEXITCODE -ne 0) { throw ('Issue creation failed for ' + $ticket.Key) }
    $createdUrl = ($createdUrl | Select-Object -Last 1).Trim()
    if ($createdUrl -notmatch '/issues/(\d+)$') { throw ('Unexpected issue creation response: ' + $createdUrl) }
    $entry = [PSCustomObject]@{ key = $ticket.Key; number = [int]$Matches[1]; title = $ticket.Title; url = $createdUrl }
    $taskPublished += $entry
    [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject @($taskPublished) -Depth 5), [Text.UTF8Encoding]::new($false))
    $entry | ConvertTo-Json -Compress
}
