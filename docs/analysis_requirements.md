# Requisitos del Sistema para el Análisis por Tipo de Proyecto

Este documento detalla los **requisitos previos** que el entorno del sistema debe cumplir para que ReportBot pueda analizar correctamente cada tipo de proyecto soportado.

---

## Requisitos Generales (Todos los tipos)

Estos componentes son necesarios independientemente del tipo de proyecto:

| Componente | Propósito | Verificación |
|------------|-----------|-------------|
| **CodeQL CLI** | Motor de análisis estático | `codeql version` |
| **Tokei** | Detección automática de lenguajes | Incluido en `scripts/tokei` |
| **Python 3** | Ejecutar scripts de detección y Dependabot | `python3 --version` |
| **Dependabot CLI** | Análisis de dependencias vulnerables | Ruta configurada en `dependabot_runner.py` |
| **Docker** | Requerido por Dependabot CLI para ejecutar actualizadores | `docker --version` |

### Rutas configurables (Settings)

Todas las rutas de herramientas externas son configurables desde la sección **Settings → Tool Paths** de la interfaz gráfica. Los valores se persisten en `localStorage` y se envían al backend vía el handler IPC `settings.updatePaths`.

| Herramienta | Configuración |
|-------------|---------------|
| CodeQL CLI | Campo "CodeQL CLI Path" en Settings. Si está vacío, se asume que `codeql` está en el PATH del sistema. |
| Dependabot CLI | Campo "Dependabot CLI Path" en Settings. Si está vacío, se asume que `dependabot` está en el PATH del sistema. |
| dotnet SDK | Campo "dotnet SDK PATH" en Settings. Solo necesario para proyectos C#/.NET. |
| Tokei | `scripts/tokei` (resuelto automáticamente por `project_detector.py` relativo al script). |
| Script detector | Resuelto automáticamente relativo al ejecutable (`../scripts/project_detector.py`). |
| Script Dependabot | Resuelto automáticamente relativo al ejecutable (`../scripts/dependabot_runner.py`). |

---

## Requisitos Específicos por Lenguaje CodeQL

### JavaScript / TypeScript

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `javascript` |
| **Archivos detectados por Tokei** | `.js`, `.ts`, `.tsx`, `.jsx` |
| **Compilación previa** | ❌ No necesaria (lenguaje interpretado). CodeQL extrae el código directamente. |
| **SDK/Runtime necesario** | Ninguno adicional. |
| **Ecosistema Dependabot** | `npm_and_yarn` (detectado por `package.json`) |
| **Notas** | Es el tipo de proyecto más simple de analizar. No requiere ninguna herramienta de compilación. |

### Python

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `python` |
| **Archivos detectados por Tokei** | `.py` |
| **Compilación previa** | ❌ No necesaria (lenguaje interpretado). |
| **SDK/Runtime necesario** | Ninguno adicional. |
| **Ecosistema Dependabot** | `pip` (detectado por `requirements.txt`, `setup.py`, `Pipfile`, `pyproject.toml`) |
| **Notas** | Análisis directo sin necesidad de build. |

### Java / Kotlin

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `java` |
| **Archivos detectados por Tokei** | `.java`, `.kt` |
| **Compilación previa** | ✅ **Sí, obligatoria**. CodeQL necesita compilar el proyecto para crear la base de datos. |
| **SDK/Runtime necesario** | **JDK** (Java Development Kit). La versión debe coincidir con la requerida por el proyecto (p.ej., JDK 11, 17, 21). |
| **Herramienta de build** | Se necesita **Maven** (`mvn`) o **Gradle** (`gradle`) según el proyecto. El auto-builder de CodeQL los invoca automáticamente. |
| **Ecosistema Dependabot** | `maven` (detectado por `pom.xml`) o `gradle` (detectado por `build.gradle`/`build.gradle.kts`) |
| **Verificación** | `java -version` y `mvn --version` (o `gradle --version`) |
| **Problemas comunes** | <ul><li>Versión de JDK incompatible con el `pom.xml`/`build.gradle` del proyecto.</li><li>Dependencias no disponibles en repositorios Maven locales (requiere acceso a internet para la primera compilación).</li><li>Maven settings.xml con repositorios privados que requieren autenticación.</li></ul> |

### C / C++

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `cpp` |
| **Archivos detectados por Tokei** | `.c`, `.cpp`, `.h`, `.hpp` |
| **Compilación previa** | ✅ **Sí, obligatoria**. CodeQL traza el proceso de compilación. |
| **SDK/Runtime necesario** | **GCC** o **Clang** (compilador de C/C++). |
| **Herramienta de build** | `make`, `cmake`, `autotools` u otra según el proyecto. El auto-builder de CodeQL intentará detectar y usar la adecuada. |
| **Ecosistema Dependabot** | No hay ecosistema estándar de Dependabot para C/C++. |
| **Verificación** | `gcc --version` o `clang --version`, y `make --version` o `cmake --version` |
| **Problemas comunes** | <ul><li>Falta de dependencias de sistema (librerías `-dev` necesarias para la compilación).</li><li>Makefile o CMakeLists.txt con rutas hardcodeadas.</li><li>Proyectos que requieren configuración previa (`./configure`).</li></ul> |

### C# (.NET)

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `csharp` |
| **Archivos detectados por Tokei** | `.cs` |
| **Compilación previa** | ✅ **Sí, obligatoria**. CodeQL usa `dotnet build` o `msbuild` internamente. |
| **SDK/Runtime necesario** | **.NET SDK**. La versión **debe coincidir** con el `TargetFramework` del `.csproj` del proyecto. |
| **Instalación del SDK** | `sudo apt install dotnet-sdk-<version>` (Ubuntu) |
| **Ecosistema Dependabot** | `nuget` (detectado por `*.csproj` o `packages.config`) |
| **Configuración especial en ReportBot** | La ruta de .NET se configura desde **Settings → Tool Paths → dotnet SDK PATH**. Se añade al PATH al ejecutar los comandos de CodeQL. |
| **Verificación** | `dotnet --version` y `dotnet --list-sdks` |
| **Problemas comunes** | <ul><li>**Versión del SDK no coincide con el TargetFramework**: Si el proyecto apunta a `.NET 9.0` pero solo tienes instalado el SDK `8.0`, la compilación fallará. Debes instalar el SDK correcto.</li><li>`.NET SDK` no está en el `PATH` del usuario que ejecuta CodeQL (solucionado con el `export PATH` en el bridge).</li><li>Proyectos con paquetes NuGet que requieren restauración previa (`dotnet restore`).</li></ul> |

> **⚠️ Nota importante**: En Ubuntu 24.04, el paquete `dotnet-sdk-9.0` puede no estar disponible en los repositorios por defecto. Puede ser necesario instalar la versión desde los repositorios de Microsoft o usar el script de instalación oficial:
> ```bash
> # Instalar desde repositorios de Microsoft
> wget https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb -O packages-microsoft-prod.deb
> sudo dpkg -i packages-microsoft-prod.deb
> sudo apt update && sudo apt install -y dotnet-sdk-9.0
> ```

### Go

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `go` |
| **Archivos detectados por Tokei** | `.go` |
| **Compilación previa** | ✅ Sí, pero el auto-builder de CodeQL gestiona la compilación con `go build`. |
| **SDK/Runtime necesario** | **Go SDK** (`go`). La versión debe ser compatible con la declarada en `go.mod`. |
| **Ecosistema Dependabot** | `gomod` (detectado por `go.mod`) |
| **Verificación** | `go version` |
| **Problemas comunes** | <ul><li>Versión de Go incompatible con la requerida en `go.mod`.</li><li>Módulos privados que requieren configuración de `GOPRIVATE`.</li></ul> |

### Ruby

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `ruby` |
| **Archivos detectados por Tokei** | `.rb` |
| **Compilación previa** | ❌ No necesaria (lenguaje interpretado). |
| **SDK/Runtime necesario** | Ninguno adicional para CodeQL. |
| **Ecosistema Dependabot** | `bundler` (detectado por `Gemfile`) |
| **Verificación** | `ruby --version` (solo si se usa Dependabot con bundler) |
| **Notas** | El análisis CodeQL funciona directamente sin compilación. |

### Swift

| Requisito | Detalle |
|-----------|---------|
| **Lenguaje CodeQL** | `swift` |
| **Archivos detectados por Tokei** | `.swift` |
| **Compilación previa** | ✅ Sí, requiere compilación. |
| **SDK/Runtime necesario** | **Swift toolchain** y **Xcode** (o sus command line tools en macOS). |
| **Ecosistema Dependabot** | No hay ecosistema estándar de Dependabot para Swift Package Manager en esta configuración. |
| **Verificación** | `swift --version` y `xcodebuild -version` |
| **Problemas comunes** | <ul><li>En Linux, Swift está soportado pero con limitaciones.</li><li>El soporte de CodeQL para Swift puede requerir versiones específicas del CLI.</li></ul> |

---

## Requisitos para Ecosistemas Dependabot

Para que el análisis de dependencias con Dependabot funcione correctamente:

| Ecosistema | Requisito del Sistema | Requisito del Proyecto |
|------------|----------------------|----------------------|
| `npm_and_yarn` | Node.js + npm | `package.json` en el directorio raíz o subdirectorio |
| `pip` | Python 3 + pip | `requirements.txt`, `setup.py`, `Pipfile` o `pyproject.toml` |
| `maven` | JDK + Maven | `pom.xml` |
| `gradle` | JDK + Gradle | `build.gradle` o `build.gradle.kts` |
| `cargo` | Rust + Cargo | `Cargo.toml` |
| `gomod` | Go SDK | `go.mod` |
| `composer` | PHP + Composer | `composer.json` |
| `bundler` | Ruby + Bundler | `Gemfile` |
| `nuget` | .NET SDK | `*.csproj` o `packages.config` |

> **Nota**: Dependabot CLI ejecuta sus actualizadores dentro de contenedores Docker. Por lo tanto, **Docker debe estar instalado y en ejecución** en el sistema para que cualquier ecosistema de Dependabot funcione. Además, se requiere acceso a internet para que Dependabot consulte los registros de paquetes (npm, PyPI, Maven Central, etc.).

---

## Resumen de Comandos de Verificación

Para verificar que el sistema cumple todos los requisitos, ejecutar los siguientes comandos:

```bash
# Requisitos generales
codeql version                   # CodeQL CLI instalado
python3 --version                # Python 3
docker --version                 # Docker (para Dependabot)

# Para proyectos JavaScript/TypeScript
node --version                   # Node.js
npm --version                    # npm

# Para proyectos Python
pip3 --version                   # pip

# Para proyectos Java/Kotlin
java -version                    # JDK
mvn --version                    # Maven (si el proyecto usa Maven)
gradle --version                 # Gradle (si el proyecto usa Gradle)

# Para proyectos C/C++
gcc --version                    # GCC
make --version                   # Make
cmake --version                  # CMake (si aplica)

# Para proyectos C# (.NET)
dotnet --version                 # .NET SDK
dotnet --list-sdks               # Listar versiones de SDK instaladas

# Para proyectos Go
go version                       # Go SDK

# Para proyectos Ruby
ruby --version                   # Ruby
bundler --version                # Bundler

# Para proyectos Swift
swift --version                  # Swift toolchain
```

---

## Tabla Resumen Rápida

| Tipo de Proyecto | ¿Requiere compilar? | SDK/Herramienta necesaria | Ecosistema Dependabot |
|------------------|:-------------------:|---------------------------|:---------------------:|
| JavaScript/TS    | ❌ | — | npm_and_yarn |
| Python           | ❌ | — | pip |
| Java/Kotlin      | ✅ | JDK + Maven/Gradle | maven / gradle |
| C/C++            | ✅ | GCC/Clang + Make/CMake | — |
| C# (.NET)        | ✅ | .NET SDK (versión correcta) | nuget |
| Go               | ✅ | Go SDK | gomod |
| Ruby             | ❌ | — | bundler |
| Swift            | ✅ | Swift toolchain | — |
