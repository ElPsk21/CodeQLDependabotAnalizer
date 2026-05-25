# Implementación de CodeQL: Guía Técnica Detallada

Este documento describe el flujo completo de implementación de CodeQL en la aplicación, desde la interfaz de usuario hasta la ejecución del binario y la generación de reportes.

## 1. Interfaz y Activación (Frontend)
El proceso comienza en el componente principal de React:
- **Archivo**: [frontend/src/App.tsx](frontend/src/App.tsx)
- **Función**: `handleScanProject`
- **Acción**: 
    1. Abre un diálogo nativo para seleccionar la carpeta del proyecto.
    2. Invoca el comando nativo `codeql.runScan` pasando la ruta seleccionada.
    3. Escucha el evento `codeql-log` para mostrar el progreso en tiempo real al usuario.

## 2. El Puente Nativo (Backend - Zig)
La lógica central que orquesta a CodeQL reside en la estructura `CodeQlBridge`:
- **Archivo**: [src/bridge.zig](src/bridge.zig)
- **Componentes Clave**:
    - **`CodeQlBridge`**: Estructura que almacena la ruta del ejecutable de CodeQL (por defecto en `/.../Programs/opt/codeql/codeql`).
    - **`runScan`**: Handler asíncrono que inicia un hilo separado para no bloquear la aplicación mientras se analiza el código.

## 3. Flujo de Ejecución Sequencial
Dentro de `runScanInternal` en [src/bridge.zig](src/bridge.zig), se ejecutan tres etapas críticas:

### A. Creación de la Base de Datos
- **Comando**: `codeql database create`
- **Ruta de salida**: `[proyecto_seleccionado]/codeql_db/`
- **Referencia**: [src/bridge.zig](src/bridge.zig#L64-L78)
- **Propósito**: Convierte el código fuente en una base de datos relacional que CodeQL puede consultar. Actualmente forzado a `--language=javascript`.

### B. Análisis de Vulnerabilidades
- **Comando**: `codeql database analyze`
- **Entrada**: La base de datos creada en el paso anterior.
- **Salida**: [results.sarif](results.sarif) (en la raíz del proyecto seleccionado).
- **Formato**: `sarif-latest` para una fácil lectura JSON.
- **Referencia**: [src/bridge.zig](src/bridge.zig#L94-L113)

### C. Procesamiento y Resumen de Resultados
- **Acción**: Zig abre el archivo SARIF generado usando `std.Io.Dir.openFileAbsolute`.
- **Análisis Rápido**: Se realiza un conteo de la cadena `"ruleId"` en el contenido del archivo para determinar el número total de fallos.
- **Referencia**: [src/bridge.zig](src/bridge.zig#L131-L144)

## 4. Sistema de Logging y Feedback
Para que el usuario sepa qué está ocurriendo, se implementó un sistema de emisión de eventos:
- **Función**: `emitLog` en [src/bridge.zig](src/bridge.zig#L151)
- **Flujo**: Envía un JSON con el mensaje al evento `codeql-log` del frontend.
- **Logs de Depuración**: Se añadieron `std.debug.print` para que los desarrolladores puedan ver errores de ruta o permisos directamente en la terminal de Zig.

## 5. Cierre y Respuesta
- Al finalizar, el puente envía el contenido completo del archivo SARIF al frontend mediante `responder.success`.
- El frontend parsea este JSON para mostrar las alertas detectadas en la tabla de resultados.

## 6. Veracidad y Limitaciones Actuales
Es importante destacar el estado actual de la fidelidad de los datos:

### Fidelidad de los Datos
- **Origen Real**: Los datos **no son falsos**. Provienen directamente del motor oficial de CodeQL. El archivo `results.sarif` es el informe estándar de la industria.
- **Conteo Directo**: El número de vulnerabilidades mostradas se basa en la búsqueda literal de la clave `"ruleId"` dentro del informe generado.

### Limitaciones Identificadas (Puntos de Mejora)
- **Análisis de Lenguaje Estático**: Actualmente, el sistema está forzado a `--language=javascript`. Si se analiza un proyecto de otro lenguaje (Python, C++, etc.), el resultado será 0 fallos debido a la incompatibilidad de configuración, no a la ausencia de riesgos.
- **Método de Conteo**: El conteo mediante búsqueda de strings es una aproximación rápida. Un parser de JSON real permitiría una precisión del 100% y evitaría contar metadatos.
- **Detección de Lenguaje**: Falta una fase de pre-escaneo para identificar automáticamente el stack tecnológico del proyecto seleccionado.
- **Detalle de Alertas**: Aunque CodeQL proporciona la ubicación exacta (archivo y línea), la implementación actual solo reporta el conteo total en el log de la interfaz.
