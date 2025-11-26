# Perfil de Puppeteer en el proyecto

Este proyecto puede usar un perfil de usuario de Chrome/Chromium (`USER_DATA_DIR`) para mantener la sesión iniciada en Steam.

Pasos recomendados:

1. Cierra todas las ventanas de Chrome/Chromium (evita archivos en uso).
2. Copia tu perfil local (por ejemplo `C:\Users\Alejandro\puppeter_profile`) al directorio del proyecto `puppeter_profile`.
   - Puedes usar el script provisto `import_profile_and_run.ps1` (recomendado) para copiar y ejecutar el script.

3. Ejecuta el script (ejemplo usando PowerShell):

```powershell
# Copia tu perfil y ejecuta (te pedirá que pulses ENTER antes de copiar)
.\import_profile_and_run.ps1 -SourceProfilePath 'C:\Users\Alejandro\puppeter_profile' -Headless $false -WaitForLogin
```

4. El script abrirá Chromium con el perfil copiado. Si necesitas iniciar sesión manualmente, usa `WAIT_FOR_LOGIN=true` o pulsa ENTER cuando termine la copia.

Notas de seguridad:
- `cookies.json` y `puppeter_profile` están ignorados en `.gitignore` del proyecto para evitar subir datos sensibles.
- Mantén la carpeta del proyecto privada si contiene datos del perfil.

Si prefieres no copiar el perfil, también puedes ejecutar directamente con `USER_DATA_DIR` apuntando a tu perfil original (pero no puedo acceder a rutas fuera del workspace desde este entorno).