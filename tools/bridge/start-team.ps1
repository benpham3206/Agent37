# Starts one Agent-37 bridge per bot in team.json (each in its own restart loop) plus the team proxy.
# Any tunnel (e.g. cloudflared pointed at 127.0.0.1:8800) is not touched.
$dir = $PSScriptRoot; New-Item -ItemType Directory -Force "$dir\logs" | Out-Null
# Settings such as A37_BRIDGE_SERVER come from bridge.env (copy bridge.env.example). Child processes inherit them. bridge.env is optional.
if (Test-Path "$dir\bridge.env") { Get-Content "$dir\bridge.env" | Where-Object { $_ -match '^\s*[A-Z0-9_]+=' } | ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$($k.Trim())" $v.Trim() } }
# Unset A37_BRIDGE_SERVER means the launcher uses the in-repo bridge (..\..\bridge\server.js).
$team = Get-Content "$dir\team.json" -Raw | ConvertFrom-Json
foreach ($t in $team) {
  $loop = "Set-Location '$dir'; `$env:A37_BOT='$($t.bot)'; `$env:A37_WEB_PORT='$($t.control)'; `$env:A37_VIEWER_PORT='$($t.viewer)'; `$env:A37_STATUS_PORT='$($t.status)'; " +
          "while (`$true) { node run-agent37-bridge.mjs --a37-team $($t.bot) *>> 'logs\$($t.bot).log'; Start-Sleep 10 }"
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', "# A37_TEAM_LOOP $($t.bot)`n$loop"
  Write-Output "started $($t.bot): /$($t.path)/ (control $($t.control), viewer $($t.viewer), status $($t.status))"
}
Start-Process node -WindowStyle Hidden -WorkingDirectory $dir -ArgumentList 'share-viewer.mjs' -RedirectStandardOutput "$dir\logs\proxy.log" -RedirectStandardError "$dir\logs\proxy-err.log"
Write-Output 'started proxy on 127.0.0.1:8800'
