# Implementación de GitHub Copilot SDK (Vía CLI)

Esta documentación describe cómo se ha implementado el soporte de GitHub Copilot en el entorno de Zero-Native (Frontend React + Backend Zig), interactuando de manera invisible con el CLI oficial de `@github/copilot-cli`.

## Arquitectura

La implementación utiliza el patrón IPC (Inter-Process Communication) ofrecido por `zero-native`. Se han creado los siguientes componentes clave:

1. **Frontend (React)**: Interfaz de usuario donde los usuarios pueden resolver incidencias o iniciar sesión si no están autenticados.
2. **Backend (Zig)**: Un puente (bridge) que se encarga de lanzar comandos de consola interactuando con el CLI de `copilot`, monitorizar los flujos estándar (`stdout`/`stderr`), y emitir los resultados o eventos asíncronos (`copilot-log`) hacia el frontend de vuelta.

## Autenticación (Login)

Si el entorno no está autenticado con Copilot, el backend devolverá `needsAuth: true` cuando se intente escanear y el usuario verá automáticamente el modal de login.

### Flujo de Login
- El usuario hace clic (automático si detecta error) en "Iniciar sesión".
- React llama al IPC: `zero.invoke("copilot.login")`.
- **Backend (Zig)** arranca el proceso `copilot login`.
  - **Importante**: Se envuelve la ejecución con el comando `script -e -q -c "exec copilot login" /dev/null` para engañar a Copilot CLI y hacerle creer que se encuentra en un entorno de Terminal Interactivo (PTY). De este modo se previenen *crasheos* provocados por falta de TTY en librerías de consola.
- Zig captura la salida línea por línea y lanza eventos `copilot-log` a React.
- React, a través de Regex, captura la URL (`https://github.com/login/device`) y el código de dispositivo (`code XXXX-XXXX`).
- El usuario lo ingresa en su navegador y finaliza la autenticación web.
- **Backend (Zig)** detecta cuando la terminal pregunta de guardar el token en texto plano: `(y/N)`.
  - Utiliza un chequeo robusto con `std.mem.indexOf` tolerando espacios o códigos de color ANSI.
  - Al detectar la confirmación, envía automáticamente una letra `"y\n"` al `stdin` de la terminal falsa, guardando el token exitosamente y cerrando el flujo.

## Ejecución de Prompts

El escaneo de incidencias se hace enviando prompts concretos por CLI:
- Se ejecuta la orden: `bash -c "exec copilot -p '<prompt>'"` utilizando `std.process.spawn` en Zig (versión 0.16.0).
- La salida de la ejecución captura tanto `stdout` como `stderr`.
- Si el mensaje de respuesta contiene errores específicos ("No authentication information found"), se aborta y se notifica al Frontend que requiere login, lo que cambia instantáneamente a la pantalla de dispositivo.

## Archivos Relevantes
- `src/copilot_bridge.zig`: Archivo principal donde ocurre toda la invocación asíncrona (Spawn processes, IPC logs, PTY trick, StdIn pipe responses).
- `frontend/src/App.tsx`: UI Modal que procesa las incidencias, parsea los logs (`parseResponse`), extrae los códigos de autenticación mediante Regex y abre las ventanas correspondientes del navegador (`zero.invoke("copilot.openUrl")`).

## Consideraciones de Seguridad
Dado que las respuestas se imprimen con formato y pueden contener datos de usuario o sugerencias en raw, las salidas de JSON están escapadas de manera manual (`escapeJsonString`) en Zig para prevenir que saltos de línea (`\n`, `\r`, `\t`, `\x1B` ansi) o comillas dobles rompan la estructura JSON enviada por el IPC.
