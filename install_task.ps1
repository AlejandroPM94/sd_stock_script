<#
Crea una tarea programada en Windows que ejecute el watcher cada X minutos.
Uso:
  .\install_task.ps1 -IntervalMinutes 15
#>
param(
    [int]$IntervalMinutes = 15,
    [string]$TaskName = 'sd_stock_watcher'
)

$scriptPath = Join-Path $PSScriptRoot 'watch_stock.js'
$nodeExe = 'node' # asume node en PATH

Write-Host "Creando tarea '$TaskName' que ejecuta: $nodeExe $scriptPath cada $IntervalMinutes minutos"

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force
    Write-Host "Tarea registrada: $TaskName"
} catch {
    Write-Error "Error registrando la tarea: $_"
}

Write-Host "Puedes ver la tarea en el Programador de tareas (Task Scheduler) o ejecutarla con: Start-ScheduledTask -TaskName $TaskName"