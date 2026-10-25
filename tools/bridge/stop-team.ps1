# Stops every bot loop, bot process and the team proxy started by start-team.ps1. Leaves cloudflared running.
$procs = Get-CimInstance Win32_Process
$procs | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'A37_TEAM_LOOP' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped loop $($_.ProcessId)" }
$procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'run-agent37-bridge\.mjs|share-viewer\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped node $($_.ProcessId)" }
