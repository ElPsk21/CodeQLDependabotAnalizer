# Documentación: Solución al Error de Comunicación de Snippets (JSON IPC)

## Descripción del Problema
Durante la visualización de detalles de vulnerabilidades, el backend (escrito en Zig) leía correctamente el código fuente para extraer fragmentos (snippets), pero la interfaz (React) fallaba al recibirlos. A pesar de que los logs del backend indicaban un envío exitoso, los snippets no se mostraban.

La causa raíz fue identificada en la forma en que el framework `zero-native` estructura sus mensajes IPC. Las respuestas enviadas a través de `responder.success(id, data)` insertan `data` de forma literal dentro de un sobre JSON.
* **El caso exitoso (`runScan`)**: Enviaba directamente el contenido de `results.sarif`, que de por sí es un JSON válido.
* **El caso fallido (`readSnippet`)**: Enviaba texto plano con código fuente crudo. Al incrustarse sin un formato de cadena JSON válido (con comillas y caracteres escapados), el sobre IPC entero resultaba en un JSON malformado. Esto causaba un error silencioso de parseo en el frontend, resultando en el rechazo de la promesa de `zero.invoke`.

## Implementación de la Solución

Para solucionar esto, se estableció que **toda la comunicación asíncrona hacia el frontend debe consistir en JSON válido**. Se decidió envolver el texto del snippet en un objeto JSON: `{"content": "..."}`.

### 1. Backend: Custom JSON Escaper (`src/bridge.zig`)
Debido a cambios drásticos en la API de `std.json` y `std.ArrayList` en la versión actual (Zig 0.16.0 - master), el uso de `std.json.stringifyAlloc` u otros métodos nativos generaban errores de compilación o requerían dependencias frágiles de la biblioteca estándar en desarrollo. 

Se optó por implementar un emisor JSON personalizado simple, robusto e independiente de las versiones de `std.json`:

* Se creó la función auxiliar `escapeJsonString` para recorrer el texto fuente y escapar manualmente caracteres conflictivos (`\`, `"`, `\n`, `\r`, `\t`).
* Dentro de `readSnippetInternal`, se reserva un bloque dinámico `std.ArrayListUnmanaged(u8)` donde se inyecta el prefijo `{"content":`, seguido de la llamada a `escapeJsonString`, y se cierra con `}`.

### 2. Frontend: Deserialización (`frontend/src/App.tsx`)
En el manejador del frontend `fetchSnippet`, se actualizó la lógica de decodificación:
* Dado que `zero.invoke` parsea los sobres JSON por defecto, la variable `rawSnippet` se evalúa primero.
* Si por compatibilidad hacia atrás el mensaje es recibido como `string`, se realiza un `JSON.parse` manual y se extrae la propiedad `content`.
* Si se recibe correctamente como `object`, simplemente se lee `rawSnippet.content`.

## Archivos Modificados
* `src/bridge.zig`: Implementación de `escapeJsonString` y refactorización asíncrona de `readSnippet`.
* `frontend/src/App.tsx`: Refactorización de la llamada `codeql.readSnippet` para decodificar la estructura envuelta en lugar de un string crudo o buffer de array.
