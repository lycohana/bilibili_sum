param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [string]$Title = "",

    [string]$ServiceBaseUrl = "http://127.0.0.1:3838",

    [int]$PollSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$payload = @{
    input_type = "url"
    source = $Url
}

if ($Title) {
    $payload.title = $Title
}

$created = Invoke-RestMethod `
    -Method Post `
    -Uri "$ServiceBaseUrl/api/v1/tasks" `
    -ContentType "application/json" `
    -Body ($payload | ConvertTo-Json)

$taskId = $created.task_id
Write-Host "任务已创建: $taskId"

while ($true) {
    $result = Invoke-RestMethod -Uri "$ServiceBaseUrl/api/v1/tasks/$taskId/result"
    Write-Host ("当前状态: " + $result.status)

    if ($result.status -in @("completed", "failed", "cancelled")) {
        $result | ConvertTo-Json -Depth 10
        break
    }

    Start-Sleep -Seconds $PollSeconds
}
