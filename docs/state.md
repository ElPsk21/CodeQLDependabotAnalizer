# Project State - May 17, 2026

## Overview
This project is a Zig-based application with a React (Vite/TypeScript) frontend, designed to integrate CodeQL analysis directly into a desktop-like interface using the `zero-native` framework.

## Current Architecture
- **Backend (Zig)**: Uses `src/bridge.zig` to interface with the CodeQL CLI. It manages database creation and analysis.
- **Frontend (React)**: Located in `frontend/`, it triggers scans via IPC and displays real-time logs and results.
- **Integration**: Communication happens through a custom `Bridge` system that emits events like `codeql-log`.

## Recent Changes
- Implemented `CodeQlBridge` in Zig.
- Added debug logging to troubleshoot CodeQL process execution.
- Added a SARIF summary analyzer to count vulnerabilities found.
- Fixed compilation errors related to `std.Io` vs `std.fs` usage.
- Established mandatory documentation tracking via `.instructions.md`.
- Created detailed documentation of the CodeQL implementation in [docs/implementation_codeql.md](docs/implementation_codeql.md).
- Updated documentation with current technical limitations and data truthfulness analysis.
