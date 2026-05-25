# Implementación Definitiva: Análisis Multi-Proyecto

Este documento describe la implementación completa del sistema de análisis multi-proyecto de **ReportBot**, que permite detectar y analizar automáticamente proyectos de diversos tipos de lenguaje y ecosistemas de dependencias.

---

## Arquitectura General

El flujo de análisis se divide en dos fases principales:

1. **Fase de Detección** — Identifica automáticamente los lenguajes y ecosistemas del proyecto.
2. **Fase de Análisis** — Ejecuta CodeQL y Dependabot en paralelo sobre los lenguajes/ecosistemas seleccionados.

```
┌─────────────┐     ┌────────────────────────────┐     ┌──────────────────────┐
│  Frontend    │────▶│  Backend (Zig Bridges)     │────▶│  Scripts Python /    │
│  (App.tsx)   │◀────│  + IPC zero-native         │◀────│  Herramientas CLI    │
└─────────────┘     └────────────────────────────┘     └──────────────────────┘
```

---

## Archivos Involucrados

| Archivo | Rol |
|---------|-----|
| [`frontend/src/App.tsx`](file:///home/frano/my_app/frontend/src/App.tsx) | Interfaz de usuario React. Orquesta las dos fases, presenta los resultados. |
| [`src/main.zig`](file:///home/frano/my_app/src/main.zig) | Punto de entrada. Registra todos los handlers IPC del bridge. |
| [`src/project_detector_bridge.zig`](file:///home/frano/my_app/src/project_detector_bridge.zig) | Bridge Zig que conecta el frontend con `project_detector.py`. |
| [`src/bridge.zig`](file:///home/frano/my_app/src/bridge.zig) | Bridge Zig para CodeQL (`codeql.runScan`, `codeql.readSnippet`). |
| [`src/dependabot_bridge.zig`](file:///home/frano/my_app/src/dependabot_bridge.zig) | Bridge Zig para Dependabot (`dependabot.runScan`). |
| [`scripts/project_detector.py`](file:///home/frano/my_app/scripts/project_detector.py) | Script Python que usa Tokei para detectar lenguajes y busca manifiestos de dependencias. |
| [`scripts/dependabot_runner.py`](file:///home/frano/my_app/scripts/dependabot_runner.py) | Script Python que ejecuta el CLI de Dependabot y parsea los resultados. |
| [`scripts/tokei`](file:///home/frano/my_app/scripts/tokei) | Binario de Tokei (contador de líneas de código por lenguaje). |

---

## Fase 1: Detección del Stack del Proyecto

### Paso 1 — El usuario selecciona una carpeta

En [`App.tsx` → `handleLocalScan()`](file:///home/frano/my_app/frontend/src/App.tsx#L160-L224):

1. Se abre un diálogo nativo de selección de directorio mediante `zero-native.dialog.openFile`.
2. Se normaliza la ruta (conversión de rutas Windows `C:\...` a WSL `/mnt/c/...` si es necesario).
3. Se almacena la ruta en `currentProjectPath`.

### Paso 2 — Invocación del bridge de detección

Desde el frontend se invoca el comando IPC:
```typescript
const detectResult = await window.zero.invoke("project.detectStack", { path: projectPath });
```

Este comando es gestionado por [`project_detector_bridge.zig`](file:///home/frano/my_app/src/project_detector_bridge.zig#L19-L37):

1. Se extrae el campo `path` del payload JSON.
2. Se lanza un hilo separado (`std.Thread.spawn`) para no bloquear el bridge IPC.
3. Dentro del hilo ([`detectStackInternal`](file:///home/frano/my_app/src/project_detector_bridge.zig#L39-L84)), se resuelve la ruta del script relativamente al ejecutable y se ejecuta:
   ```
   <exe_dir>/../scripts/project_detector.py <ruta_del_proyecto>
   ```
4. El `stdout` del script (JSON) se devuelve al frontend vía `responder.success()`.

### Paso 3 — El script `project_detector.py` analiza el proyecto

[`project_detector.py`](file:///home/frano/my_app/scripts/project_detector.py) realiza dos tareas principales:

#### 3a. Detección de lenguajes con Tokei

- Ejecuta `tokei -o json <ruta_del_proyecto>` ([línea 153](file:///home/frano/my_app/scripts/project_detector.py#L151-L157)).
- Tokei devuelve un JSON con todos los lenguajes detectados y las líneas de código de cada uno.
- El script mapea los lenguajes de Tokei a lenguajes compatibles con CodeQL usando el diccionario [`CODEQL_LANGUAGE_MAP`](file:///home/frano/my_app/scripts/project_detector.py#L8-L24):

| Lenguaje Tokei | Lenguaje CodeQL |
|----------------|-----------------|
| JavaScript, TypeScript, TSX, JSX | `javascript` |
| Python | `python` |
| Java, Kotlin | `java` |
| C, C++, CHeader, CppHeader | `cpp` |
| Go | `go` |
| Ruby | `ruby` |
| C# | `csharp` |
| Swift | `swift` |

#### 3b. Detección de ecosistemas de dependencias

- Recorre el árbol de directorios (hasta profundidad 2) buscando archivos manifiesto ([`get_ecosystems()`](file:///home/frano/my_app/scripts/project_detector.py#L68-L109)).
- Usa el diccionario [`ECOSYSTEM_MANIFEST_MAP`](file:///home/frano/my_app/scripts/project_detector.py#L26-L39):

| Archivo Manifiesto | Ecosistema Dependabot |
|---------------------|-----------------------|
| `package.json` | `npm_and_yarn` |
| `requirements.txt`, `setup.py`, `Pipfile`, `pyproject.toml` | `pip` |
| `pom.xml` | `maven` |
| `build.gradle`, `build.gradle.kts` | `gradle` |
| `Cargo.toml` | `cargo` |
| `go.mod` | `gomod` |
| `composer.json` | `composer` |
| `Gemfile` | `bundler` |
| `*.csproj`, `packages.config` | `nuget` |

#### 3c. Salida JSON

El script devuelve un JSON con la estructura:
```json
{
  "languages": [
    { "name": "javascript", "code_lines": 5423, "selected": true },
    { "name": "python", "code_lines": 1200, "selected": true }
  ],
  "ecosystems": [
    { "name": "npm_and_yarn", "manifest": "package.json", "directory": "/", "selected": true },
    { "name": "pip", "manifest": "requirements.txt", "directory": "/", "selected": true }
  ]
}
```

### Paso 4 — Presentación al usuario

El frontend recibe el JSON y muestra una interfaz donde el usuario puede:
- Ver los lenguajes detectados con sus líneas de código.
- Ver los ecosistemas de dependencias encontrados.
- Seleccionar/deseleccionar qué lenguajes y ecosistemas analizar.
- Iniciar el análisis pulsando "Start Analysis".

---

## Fase 2: Análisis (CodeQL + Dependabot)

### Paso 5 — Lanzamiento del análisis en paralelo

En [`App.tsx` → `startAnalysis()`](file:///home/frano/my_app/frontend/src/App.tsx#L226-L415):

1. Se filtran los lenguajes y ecosistemas **seleccionados** por el usuario.
2. Se crean promesas paralelas (`Promise.allSettled`):
   - Una invocación `codeql.runScan` por cada lenguaje seleccionado.
   - Una invocación `dependabot.runScan` por cada ecosistema seleccionado.

### Paso 6 — Análisis CodeQL

[`bridge.zig` → `runScanInternal()`](file:///home/frano/my_app/src/bridge.zig#L53-L244):

1. **Database Create**: Ejecuta en bash:
   ```bash
   export PATH=<dotnet_path>:$PATH && \
   "<codeql_path>" database create "<db_path>" \
     --source-root "<project_path>" --language=<lang> --overwrite
   ```
   (Las rutas `codeql_path` y `dotnet_path` se configuran desde **Settings → Tool Paths**.)
2. **Database Analyze**: Ejecuta:
   ```bash
   export PATH=<dotnet_path>:$PATH && \
   "<codeql_path>" database analyze "<db_path>" \
     --format=sarif-latest --output "<sarif_path>"
   ```
3. **Lee el archivo SARIF** generado y lo envía al frontend vía `responder.success()`.
4. Si ocurre un error, se construye un JSON de error con el stderr **correctamente escapado** usando [`escapeJsonString()`](file:///home/frano/my_app/src/bridge.zig#L306-L319), evitando JSON malformado.

### Paso 7 — Análisis Dependabot

[`dependabot_bridge.zig` → `runScanInternal()`](file:///home/frano/my_app/src/dependabot_bridge.zig#L61-L110):

1. Resuelve la ruta del script relativamente al ejecutable y lo ejecuta:
   ```
   <exe_dir>/../scripts/dependabot_runner.py <ruta> <ecosistema> <directorio> [<dependabot_cli_path>]
   ```
2. [`dependabot_runner.py`](file:///home/frano/my_app/scripts/dependabot_runner.py) ejecuta el CLI de Dependabot:
   ```
   dependabot update <ecosistema> ElPsk21/repoDummy --local <ruta> -d <dir> -o <output.yml>
   ```
3. Parsea la salida (tabla resumen de stdout + archivo YAML de resultados) y devuelve un JSON con los pull requests simulados.

### Paso 8 — Procesamiento y presentación de resultados

En [`App.tsx` → `startAnalysis()` (continuación)](file:///home/frano/my_app/frontend/src/App.tsx#L268-L414):

1. Se itera sobre los resultados (`Promise.allSettled`).
2. **Resultados CodeQL**: Se parsea el SARIF, extrayendo regla, descripción, severidad, ubicación del archivo y rango de líneas.
3. **Resultados Dependabot**: Se parsean los pull requests, extrayendo paquete, versión anterior, nueva versión.
4. **Errores parciales**: Si algún análisis falla pero otros tienen éxito, los errores se muestran como advertencias (banner amarillo) sin abortar el análisis completo.
5. Se calculan las estadísticas (`ScanStats`) y se guardan los resultados en `scan_results.json` dentro del proyecto analizado.

---

## Funcionalidad de Lectura de Snippets

[`bridge.zig` → `readSnippet()`](file:///home/frano/my_app/src/bridge.zig#L256-L382):

Cuando el usuario selecciona una alerta de CodeQL, el frontend solicita el fragmento de código fuente afectado:
1. Se envía `codeql.readSnippet` con `path`, `startLine` y `endLine`.
2. El bridge abre el archivo, extrae las líneas solicitadas.
3. El contenido se escapa con `escapeJsonString()` y se devuelve envuelto en `{"content": "..."}`.

---

## Registro de Handlers IPC

En [`main.zig`](file:///home/frano/my_app/src/main.zig#L72-L136):

Se registran los siguientes comandos bridge:

| Comando IPC | Handler | Bridge |
|-------------|---------|--------|
| `codeql.runScan` | `CodeQlBridge.runScan` | `bridge.zig` |
| `codeql.readSnippet` | `CodeQlBridge.readSnippet` | `bridge.zig` |
| `dependabot.runScan` | `DependabotBridge.runScan` | `dependabot_bridge.zig` |
| `project.detectStack` | `ProjectDetectorBridge.detectStack` | `project_detector_bridge.zig` |
| `scan.saveResults` | `SystemBridge.saveResults` | `main.zig` |
| `settings.updatePaths` | `SettingsBridge.updatePaths` | `main.zig` |
| `zero-native.dialog.openFile` | (Builtin) | zero-native |

---

## Correcciones Importantes Realizadas

### Error "Bridge command returned invalid JSON"

Se detectó que cuando CodeQL fallaba (p.ej., por falta de un SDK), el backend insertaba el contenido crudo de `stderr` (que incluye saltos de línea, comillas, etc.) directamente en una cadena JSON, produciendo un JSON malformado.

**Solución**: Se implementó la función [`escapeJsonString()`](file:///home/frano/my_app/src/bridge.zig#L306-L319) que escapa correctamente todos los caracteres especiales (`"`, `\`, `\n`, `\r`, `\t`) antes de incluirlos en la respuesta JSON. Se aplica tanto en errores de `database create` como de `database analyze`.

### PATH de .NET para proyectos C#

Los comandos de CodeQL se ejecutan con `export PATH=<dotnet_path>:$PATH` antepuesto, donde `<dotnet_path>` se configura desde **Settings → Tool Paths → dotnet SDK PATH**. Esto permite que el auto-builder de CodeQL encuentre el SDK de .NET necesario para compilar proyectos C#.
