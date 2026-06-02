# Flujo de Aprobación de Correcciones vía Copilot

> **Fecha de implementación**: 31 de mayo de 2026  
> **Archivos principales**: `frontend/src/App.tsx`, `src/copilot_bridge.zig`, `src/main.zig`, `frontend/src/index.css`

## Resumen

Esta funcionalidad permite que, tras un escaneo de vulnerabilidades con CodeQL, el usuario pueda solicitar a GitHub Copilot CLI que analice y proponga correcciones automáticas. El sistema implementa un flujo de **3 fases**:

1. **Análisis**: Copilot recibe un prompt estructurado con las vulnerabilidades y genera propuestas de corrección.
2. **Aprobación**: El usuario revisa cada corrección propuesta en una interfaz modal interactiva, viendo la dificultad estimada y si requiere revisión humana.
3. **Aplicación**: Las correcciones aprobadas se aplican a los archivos del proyecto a través del backend Zig, creando copias de seguridad automáticas.

---

## Arquitectura

```
┌──────────────────────┐       IPC (zero.invoke)       ┌─────────────────────────┐
│  Frontend (React)    │ ──────────────────────────────>│  Backend (Zig)          │
│  App.tsx             │                                │  copilot_bridge.zig     │
│                      │                                │                         │
│  - Construye prompt  │       copilot.resolveIssues    │  - Ejecuta Copilot CLI  │
│  - Parsea respuesta  │ <──────────────────────────────│  - Captura stdout/stderr│
│  - UI de aprobación  │                                │  - Escapa JSON          │
│  - Selección usuario │       copilot.applyFixes       │                         │
│  - Envía aprobados   │ ──────────────────────────────>│  - Crea backups (.bak)  │
│                      │ <──────────────────────────────│  - Escribe archivos     │
└──────────────────────┘       {applied, errors}        └─────────────────────────┘
```

La comunicación entre frontend y backend se realiza mediante el sistema IPC de `zero-native`, usando `window.zero.invoke()` en React y handlers asíncronos registrados en `main.zig`.

---

## Fase 1: Análisis — Prompt Engineering

### Estructura del prompt

El prompt enviado a Copilot CLI se construye dinámicamente en `handleResolveIssues` ([App.tsx:590-617](file:///home/frano/my_app/frontend/src/App.tsx#L590-L617)). La estructura es:

```
# CodeQL Vulnerabilities to Analyze:
1. [rule-id] Description
   File: /absolute/path/to/file
   Lines: startLine-endLine
2. ...

---

You are a security expert. For each issue listed above:
1. Read the file at the specified location.
2. Analyze the difficulty of fixing the issue (e.g. Low, Medium, High).
3. If the issue is complex, requires architectural changes, or cannot be safely fixed, mark it as `requiresHumanRevision`.
4. If the issue is easy or safe to solve, generate the full content of the file with the fix applied.

CRITICAL REQUIREMENT:
...
```

### Formato de respuesta esperado

Se usa un **formato de etiquetas de texto plano** (estilo XML) en lugar de JSON. Esta decisión de diseño se tomó porque:

- Los LLMs tienden a "alucinar" nombres de propiedades JSON de forma inconsistente (`filePath` vs `filepath` vs `path`).
- Insertar el contenido completo de un archivo dentro de un string JSON provoca errores de escapado frecuentes.
- Las etiquetas XML son más robustas para extraer bloques de texto plano con regex.

Formato de cada bloque:

```
<<<<filePath: /absolute/path/to/file.ext>>>>
<difficulty>Low/Medium/High</difficulty>
<requiresHumanRevision>true or false</requiresHumanRevision>
<explanation>Brief explanation of the fix or why human revision is needed.</explanation>
<content>
FULL MODIFIED FILE CONTENT HERE (Leave empty if requiresHumanRevision is true)
</content>
```

### Parseo de la respuesta

El parseo se realiza en [App.tsx:634-653](file:///home/frano/my_app/frontend/src/App.tsx#L634-L653) mediante expresiones regulares:

```typescript
// Regex principal: captura cada bloque filePath + su contenido hasta el siguiente bloque o fin
const blockRegex = /<<<<filePath:\s*(.*?)\s*>>>>([\\s\\S]*?)(?=(?:<<<<filePath:|$))/g;

// Sub-regex para cada campo dentro del bloque:
/<difficulty>\s*(.*?)\s*<\/difficulty>/i
/<requiresHumanRevision>\s*(.*?)\s*<\/requiresHumanRevision>/i
/<explanation>\s*([\s\S]*?)\s*<\/explanation>/i
/<content>\n?([\s\S]*?)\n?<\/content>/i
```

### Cross-referencia con alertas originales

Dado que Copilot no siempre devuelve la regla o descripción exacta de la vulnerabilidad, el sistema **cruza las propuestas con las alertas originales de CodeQL** usando la ruta del archivo como clave de búsqueda ([App.tsx:660-664](file:///home/frano/my_app/frontend/src/App.tsx#L660-L664)):

```typescript
const matchedAlert = codeQlAlerts.find(a =>
  filePath.includes(a.location) ||
  (a.fullPath && filePath.includes(a.fullPath)) ||
  (a.fullPath && a.fullPath.includes(filePath)) ||
  filePath.endsWith(a.location.split('/').pop() || '')
);
```

---

## Fase 2: Aprobación — Interfaz de usuario

### Tipo de datos `ProposedFix`

Definido en [App.tsx:49-58](file:///home/frano/my_app/frontend/src/App.tsx#L49-L58):

```typescript
interface ProposedFix {
  filePath: string;        // Ruta absoluta del archivo
  content: string;         // Contenido completo del archivo corregido
  description: string;     // Explicación de Copilot o descripción de CodeQL
  approved: boolean;       // Si el usuario ha aprobado este cambio
  issueRule: string;       // Regla de CodeQL (ej: "cs/web/missing-token-validation")
  difficulty?: string;     // "Low", "Medium", "High"
  requiresHumanRevision?: boolean; // Si Copilot considera que es demasiado complejo
  explanation?: string;    // Explicación de por qué se necesita revisión humana
}
```

### Modal de aprobación

La interfaz modal ([App.tsx:1441-1509](file:///home/frano/my_app/frontend/src/App.tsx#L1441-L1509)) muestra:

- **Lista interactiva de archivos** con checkboxes para aprobar/rechazar individualmente.
- **Badges de dificultad** (verde/amarillo/rojo) junto al nombre de cada archivo.
- **Badge de "Revisión Humana Requerida"** (naranja) para archivos que Copilot no puede arreglar.
- **Botones globales**: "Aprobar Todos" / "Rechazar Todos".
- **Botón de aplicación**: "Aplicar seleccionados (N)" que muestra el conteo dinámico.

### Comportamiento de pre-aprobación

Los archivos se pre-aprueban automáticamente **excepto** los que requieren revisión humana:

```typescript
approved: !fix.requiresHumanRevision
```

Los archivos marcados como `requiresHumanRevision`:
- Su checkbox está **desactivado** (`disabled`).
- Su fila tiene estilo visual diferente (fondo ámbar, opacidad reducida, cursor `not-allowed`).
- Los clicks sobre la fila se ignoran.

### Estados del modal (`copilotModalMode`)

| Estado       | Descripción                                                  |
|:-------------|:-------------------------------------------------------------|
| `resolving`  | Copilot está trabajando. Se muestran logs en tiempo real.    |
| `approval`   | Copilot ha terminado. Se muestra la lista de aprobación.     |
| `applying`   | El backend está escribiendo los archivos aprobados.          |
| `done`       | Operación completada. Muestra resumen de archivos aplicados. |
| `error`      | Error durante el proceso.                                    |
| `login`      | Se requiere autenticación con GitHub.                        |

### Pantalla de "Revisión Humana Requerida"

Si Copilot no genera ningún bloque de corrección (todos los archivos requieren revisión humana o el formato no se reconoce), la pantalla `done` muestra un **aviso naranja** en lugar del mensaje de éxito verde ([App.tsx:1539-1565](file:///home/frano/my_app/frontend/src/App.tsx#L1539-L1565)).

---

## Fase 3: Aplicación — Backend Zig

### Registro del comando

El comando `copilot.applyFixes` está registrado en [main.zig:212-216](file:///home/frano/my_app/src/main.zig#L212-L216):

```zig
handlers[cq_disp.async_registry.handlers.len + 6] = .{
    .name = "copilot.applyFixes",
    .context = &app_instance.copilot_bridge,
    .invoke_fn = copilot_bridge.CopilotBridge.applyFixes,
};
```

### Función `applyFixes`

Implementada en [copilot_bridge.zig:283-321](file:///home/frano/my_app/src/copilot_bridge.zig#L283-L321). Recibe un payload JSON con la estructura:

```json
{
  "fixes": [
    { "filePath": "/path/to/file", "content": "full file content" }
  ]
}
```

El flujo de aplicación es:

1. Parsea el payload JSON con `std.json.parseFromSlice`.
2. Itera sobre cada fix y llama a `applyFixToFile`.
3. Acumula archivos aplicados exitosamente y errores en listas separadas.
4. Devuelve un JSON de respuesta con `applied` y `errors`.

### Función `applyFixToFile`

Implementada en [copilot_bridge.zig:323-345](file:///home/frano/my_app/src/copilot_bridge.zig#L323-L345). Para cada archivo:

1. **Crea un backup**: Lee el contenido original y lo escribe en `{archivo}.bak`.
2. **Escribe el contenido nuevo**: Sobrescribe el archivo original con el contenido corregido de Copilot.

```zig
fn applyFixToFile(self: *CopilotBridge, file_path: []const u8, content: []const u8) !void {
    // 1. Crear backup
    const backup_path = try std.fmt.allocPrint(self.allocator, "{s}.bak", .{file_path});
    defer self.allocator.free(backup_path);
    // ... lee original y escribe .bak ...

    // 2. Escribir contenido nuevo
    const new_file = try std.Io.Dir.createFileAbsolute(self.io, file_path, .{});
    defer new_file.close(self.io);
    try new_file.writePositionalAll(self.io, content, 0);
}
```

### Respuesta al frontend

Tras procesar todos los archivos, el backend responde con:

```json
{
  "applied": ["/path/to/file1.cs", "/path/to/file2.cs"],
  "errors": ["/path/to/file3.cs: FileNotFound"]
}
```

El frontend muestra esta información en la pantalla `done` con iconos ✅ y ❌.

---

## Estilos CSS

Los estilos de la interfaz de aprobación están definidos en [index.css](file:///home/frano/my_app/frontend/src/index.css):

| Clase CSS                    | Propósito                                              |
|:-----------------------------|:-------------------------------------------------------|
| `.fix-approval-list`         | Contenedor scrollable de la lista de archivos          |
| `.fix-approval-item`         | Fila individual de cada archivo                        |
| `.fix-approval-item.approved`| Estado visual cuando el archivo está aprobado (verde)  |
| `.fix-approval-item.needs-revision` | Estado visual de revisión humana (ámbar)        |
| `.fix-folder-badge`          | Badge gris con el nombre de la carpeta padre           |
| `.fix-difficulty-badge`      | Badge de dificultad (coloreado por nivel)               |
| `.difficulty-low`            | Verde — Dificultad baja                                |
| `.difficulty-medium`         | Amarillo — Dificultad media                            |
| `.difficulty-high`           | Rojo — Dificultad alta                                 |
| `.fix-revision-badge`        | Badge naranja de "Revisión Humana Requerida"           |
| `.fix-rule`                  | Estilo de la regla CodeQL (violeta)                    |

---

## Decisiones de diseño

### ¿Por qué no JSON para la respuesta de Copilot?

Inicialmente se usó un bloque ` ```json ... ``` ` para que Copilot devolviera las correcciones. Esto falló por múltiples razones:

1. **Escapado de comillas**: Al incluir el contenido completo de archivos C# o JavaScript dentro de un string JSON, las comillas dobles, barras invertidas y saltos de línea rompían constantemente el JSON.
2. **Inconsistencia de nombres**: Copilot alternaba entre `filePath`, `filepath`, `file`, `path` de forma impredecible.
3. **Omisión de campos**: Frecuentemente omitía `description` e `issueRule`, dejando la UI sin información útil.

La solución fue cambiar a etiquetas XML-like que son mucho más fáciles de parsear con regex y no sufren problemas de escapado.

### ¿Por qué contenido completo en lugar de diffs?

Se envía el **contenido completo del archivo** en lugar de un diff porque:

- Los diffs generados por LLMs son propensos a errores de contexto (líneas incorrectas, indentación rota).
- Aplicar un diff programáticamente requiere un motor de parches.
- El contenido completo garantiza que el archivo resultante es coherente.
- Se crean backups automáticos (`.bak`) para permitir la reversión manual.

### ¿Por qué cross-referencia con alertas de CodeQL?

Copilot no siempre devuelve la regla o la descripción original de la vulnerabilidad. Al cruzar el `filePath` de cada propuesta con las alertas de CodeQL almacenadas en estado, se garantiza que la UI siempre muestre información útil al usuario.

---

## Seguridad

- **Backups automáticos**: Antes de sobrescribir cualquier archivo, se crea una copia `.bak` del original.
- **Sin ejecución directa**: Copilot CLI se ejecuta en un sandbox y no tiene permisos para modificar archivos del proyecto directamente. Toda escritura pasa por el backend Zig controlado.
- **Aprobación explícita**: El usuario debe revisar y aprobar cada archivo antes de que se apliquen los cambios.
- **Archivos complejos protegidos**: Los archivos marcados como `requiresHumanRevision` no pueden ser aprobados accidentalmente (checkbox desactivado).
- **Escapado JSON**: Todas las respuestas del backend usan `escapeJsonString` para prevenir inyecciones vía caracteres especiales.

---

## Archivos modificados

| Archivo | Cambios |
|:--------|:--------|
| [App.tsx](file:///home/frano/my_app/frontend/src/App.tsx) | Tipo `ProposedFix`, prompt, parseo de respuesta, UI de aprobación, `handleApplyFixes` |
| [copilot_bridge.zig](file:///home/frano/my_app/src/copilot_bridge.zig) | Funciones `applyFixes`, `applyFixToFile`, structs `ProposedFix` y `ApplyFixesPayload` |
| [main.zig](file:///home/frano/my_app/src/main.zig) | Registro del comando `copilot.applyFixes` en el dispatcher |
| [index.css](file:///home/frano/my_app/frontend/src/index.css) | Estilos para la lista de aprobación, badges de dificultad y revisión humana |
