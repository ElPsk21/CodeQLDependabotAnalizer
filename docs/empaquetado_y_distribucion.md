# Guía de Compilación, Empaquetado y Distribución

Esta guía documenta la arquitectura del proyecto, el flujo de ejecución en desarrollo y los pasos necesarios para generar y distribuir los paquetes autónomos para **Linux** y **Windows**. También incluye el diagnóstico y solución del error de compilación cruzada en el backend de Windows WebView2.

---

## 1. Arquitectura de Ejecución

El proyecto utiliza una arquitectura híbrida:
* **Backend Nativo (Zig):** Escrito en Zig, maneja la ventana principal, el ciclo de vida del sistema y la comunicación a bajo nivel a través de "puentes" (`bridges`) con herramientas como CodeQL, Dependabot y Copilot.
  * *Archivo de entrada:* [src/main.zig](file:///home/frano/my_app/src/main.zig) (Función `pub fn main`).
* **Frontend Interactivo (React + Vite + TypeScript):** Construye la interfaz gráfica que se renderiza dentro del WebView nativo provisto por `zero-native`.
  * *Archivo de entrada:* [frontend/src/main.tsx](file:///home/frano/my_app/frontend/src/main.tsx) (Monta el componente [App.tsx](file:///home/frano/my_app/frontend/src/App.tsx)).

---

## 2. Compilación y Empaquetado para Producción

Para que la aplicación sea totalmente autónoma (que no requiera el código fuente, Node.js ni Zig para funcionar), se debe generar un paquete de distribución con el comando `zig build package`.

### Linux (Nativo)
Para compilar y empaquetar para Linux en modo optimizado de producción:

```bash
zig build package -Dpackage-target=linux -Dplatform=linux -Doptimize=ReleaseFast
```

* **Ruta de salida:** `zig-out/package/my-app-0.1.0-linux-ReleaseFast/`
* **Ejecutable nativo:** `bin/my-app` (Binario ELF de Linux, ~5 MB).
* **Distribución:** Comprimir la carpeta en un `.tar.gz` o `.zip`.

### Windows (Compilación Cruzada desde Linux)
Zig permite compilar para Windows directamente desde Linux sin configuraciones adicionales de SDKs o compiladores de Windows:

```bash
zig build package -Dpackage-target=windows -Dtarget=x86_64-windows -Dplatform=windows -Doptimize=ReleaseFast
```

* **Ruta de salida:** `zig-out/package/my-app-0.1.0-windows-ReleaseFast/`
* **Ejecutable nativo:** `bin/my-app.exe` (Binario PE/COFF de Windows, ~1.3 MB).
* **Distribución:** Comprimir la carpeta en un archivo `.zip`. El usuario final en Windows solo necesita descomprimir y ejecutar `my-app.exe`.

---

## 3. Resolución de Problemas: Error de Compilación Cruzada para Windows

Durante el primer intento de generar el paquete para Windows, se detectó un fallo de compilación en el archivo host de C++ de `zero-native` para WebView2:

### Síntoma
```text
webview2_host.cpp:252:5: error: use of undeclared identifier 'zero_native_windows_load_window_webview'
webview2_host.cpp:278:5: error: use of undeclared identifier 'zero_native_windows_bridge_respond_window'
```

### Causa
En C++, las funciones deben ser declaradas antes de ser invocadas. En el archivo `webview2_host.cpp` de `zero-native`, las funciones `zero_native_windows_load_webview` y `zero_native_windows_bridge_respond` llamaban a `zero_native_windows_load_window_webview` y `zero_native_windows_bridge_respond_window` respectivamente, pero estas últimas estaban declaradas físicamente más abajo en el archivo y carecían de una declaración previa (*forward declaration*).

### Solución
Se modificó el archivo de la librería global:
`~/.nvm/versions/node/v24.14.0/lib/node_modules/zero-native/src/platform/windows/webview2_host.cpp`

Añadiendo las declaraciones previas correspondientes justo después del inicio del bloque `extern "C" {`:

```cpp
void zero_native_windows_load_window_webview(Host *host, uint64_t window_id, const char *source, size_t source_len, int source_kind, const char *asset_root, size_t asset_root_len, const char *asset_entry, size_t asset_entry_len, const char *asset_origin, size_t asset_origin_len, int spa_fallback);
void zero_native_windows_bridge_respond_window(Host *host, uint64_t window_id, const char *response, size_t response_len);
```

Tras esta corrección en la dependencia de `zero-native`, el comando de compilación cruzada funciona correctamente generando el ejecutable `.exe` y su paquete correspondiente de forma exitosa.
