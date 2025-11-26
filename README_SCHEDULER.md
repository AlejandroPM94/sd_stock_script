# Ejecutar periódicamente y notificaciones

Opciones para ejecutar el watcher automáticamente y recibir notificaciones cuando haya stock o errores.

Requisitos
- Node.js instalado (>=14)
- Desde el proyecto, instala dependencias:

```powershell
npm install
```

Ejecutar en bucle (proceso persistente)

```powershell
# Ejecuta el watcher en primer plano
node watch_stock.js
# o usar npm
npm start
```

Crear una tarea programada en Windows (Task Scheduler)

1. Desde PowerShell (ejemplo interval 15 minutos):

```powershell
.\install_task.ps1 -IntervalMinutes 15
```

2. La tarea ejecutará `node watch_stock.js` periódicamente con el usuario actual (LogonType Interactive). Ajusta `$nodeExe` en `install_task.ps1` si necesitas el path absoluto.

Variables de entorno útiles
- `INTERVAL_MINUTES` — intervalo en minutos (si ejecutas `watch_stock.js` manualmente en un servicio/terminal). Default 15.
- `ALERT_THROTTLE_MIN` — número de minutos para suprimir notificaciones repetidas (default 30).
- `HEADLESS` — `true|false` para pasar al script (si corresponde).
- `FAIL_IF_NOT_LOGGED` — `true` hace que `fetchStock` salga con código 4 si no detecta sesión.

Logs
- El watcher escribe en `watch_log.txt` en el directorio del proyecto.

Notificaciones
- Usa `node-notifier` para notificaciones nativas en Windows.

Opciones adicionales
- Puedo añadir notificaciones por correo usando `nodemailer` si me das los parámetros SMTP.
- Puedo añadir un script para ejecutar el watcher como servicio usando `nssm` o `pm2` si quieres mayor robustez.
