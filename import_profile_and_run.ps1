<#
Importa tu perfil de Chrome/Chromium local al directorio `puppeter_profile` del proyecto
y ejecuta `sd_stock_script.js` usando ese perfil como `USER_DATA_DIR`.

Uso seguro:
- Cierra Chrome/Chromium antes de copiar el perfil (evita archivos en uso).
- Este script copia el contenido del perfil fuente al perfil dentro del repo.
- `cookies.json` y la carpeta `puppeter_profile` están en `.gitignore` por seguridad.

Ejemplo:
    .\import_profile_and_run.ps1 -SourceProfilePath 'C:\Users\Alejandro\puppeter_profile' -Headless $false
#>

param(
    [string]$SourceProfilePath = 'C:\Users\Alejandro\puppeter_profile',
    [bool]$Headless = $false,
    [switch]$WaitForLogin
)

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$WorkspaceProfile = Join-Path $ScriptRoot 'puppeter_profile'

Write-Host "Perfil origen: $SourceProfilePath"
Write-Host "Perfil destino (workspace): $WorkspaceProfile"

if (!(Test-Path $SourceProfilePath)) {
    Write-Error "La ruta de perfil origen no existe. Comprueba la ruta y vuelve a intentarlo."; exit 1
}

# Asegurarse de que la carpeta destino existe
if (!(Test-Path $WorkspaceProfile)) { New-Item -ItemType Directory -Path $WorkspaceProfile | Out-Null }

# Recomendar cerrar Chrome
Write-Host "Asegúrate de que Chrome/Chromium esté cerrado antes de continuar. Pulsa ENTER para continuar..."
[void][System.Console]::ReadLine()

# Copiar perfil (sobrescribe)
Write-Host "Copiando perfil... esto puede tardar varios segundos/minutos dependiendo del tamaño..."
try {
    Remove-Item -Recurse -Force (Join-Path $WorkspaceProfile '*') -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $SourceProfilePath '*') -Destination $WorkspaceProfile -Recurse -Force
    Write-Host "Copia completada."
} catch {
    Write-Error "Error al copiar el perfil: $_"; exit 1
}

# Preparar variables de entorno y ejecutar node
if ($Headless) { $env:HEADLESS = 'true' } else { $env:HEADLESS = 'false' }
$env:USER_DATA_DIR = $WorkspaceProfile
$env:SAVE_COOKIES = 'true'
if ($WaitForLogin) { $env:WAIT_FOR_LOGIN = 'true' }

Write-Host "Ejecutando: node sd_stock_script.js (HEADLESS=$env:HEADLESS)"
node sd_stock_script.js

# Nota: el proceso node heredará las variables de entorno para esta sesión de PowerShell
Write-Host "Proceso finalizado. Si quieres limpiar el perfil copiado, elimina la carpeta 'puppeter_profile' en el proyecto."