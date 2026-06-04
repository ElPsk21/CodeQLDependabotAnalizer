#!/bin/bash
set -e

# Verificar si makeself está instalado en el sistema
if ! command -v makeself &> /dev/null; then
  echo "Error: 'makeself' no está instalado en el sistema." >&2
  echo "Instálalo usando el gestor de paquetes de tu sistema operativo:" >&2
  echo "  - Ubuntu/Debian:  sudo apt install makeself" >&2
  echo "  - Fedora:         sudo dnf install makeself" >&2
  echo "  - macOS (Brew):   brew install makeself" >&2
  exit 1
fi

MAKESELF_BIN="makeself"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${PROJECT_ROOT}/zig-out/package"

mkdir -p "$PACKAGE_DIR"

echo "=== Generando paquete auto-extraíble para Linux ==="
LINUX_DIR=$(find "$PACKAGE_DIR" -maxdepth 1 -type d -name "my-app-0.1.0-linux-*" | head -n 1)
if [ -d "$LINUX_DIR" ]; then
  echo "Encontrado directorio de Linux: $LINUX_DIR"
  
  # Crear script de inicio wrapper para resolver la ruta de assets de zero-native en Linux
  cat << 'EOF' > "${LINUX_DIR}/run.sh"
#!/bin/sh
# Crear enlace simbólico temporal para enlazar el path de frontend con resources
ln -sf resources/frontend frontend
# Ejecutar la aplicación redireccionando argumentos
exec ./bin/my-app "$@"
EOF
  chmod +x "${LINUX_DIR}/run.sh"

  # Copiar scripts y binarios requeridos para el análisis de seguridad
  mkdir -p "${LINUX_DIR}/scripts"
  cp "${PROJECT_ROOT}/scripts/project_detector.py" "${LINUX_DIR}/scripts/"
  cp "${PROJECT_ROOT}/scripts/dependabot_runner.py" "${LINUX_DIR}/scripts/"

  "$MAKESELF_BIN" "$LINUX_DIR" "${PACKAGE_DIR}/ReportBot-linux.run" "ReportBot para Linux" ./run.sh
  chmod +x "${PACKAGE_DIR}/ReportBot-linux.run"
  echo "¡Éxito! Paquete creado en: ${PACKAGE_DIR}/ReportBot-linux.run"
else
  echo "Advertencia: No se encontró la carpeta de distribución de Linux en $PACKAGE_DIR"
fi

echo ""
echo "=== Generando paquete auto-extraíble para macOS ==="
MACOS_DIR=$(find "$PACKAGE_DIR" -maxdepth 1 -type d -name "my-app-0.1.0-macos-*" | head -n 1)
if [ -d "$MACOS_DIR" ]; then
  echo "Encontrado directorio de macOS: $MACOS_DIR"

  # Copiar scripts y binarios requeridos para el análisis de seguridad
  mkdir -p "${MACOS_DIR}/scripts"
  cp "${PROJECT_ROOT}/scripts/project_detector.py" "${MACOS_DIR}/scripts/"
  cp "${PROJECT_ROOT}/scripts/dependabot_runner.py" "${MACOS_DIR}/scripts/"

  "$MAKESELF_BIN" "$MACOS_DIR" "${PACKAGE_DIR}/ReportBot-macos.run" "ReportBot para macOS" ./Contents/MacOS/my-app
  chmod +x "${PACKAGE_DIR}/ReportBot-macos.run"
  echo "¡Éxito! Paquete creado en: ${PACKAGE_DIR}/ReportBot-macos.run"
else
  echo "Advertencia: No se encontró la carpeta de distribución de macOS en $PACKAGE_DIR"
fi
