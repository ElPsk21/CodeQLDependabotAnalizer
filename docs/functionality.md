# Project Functionalities

## CodeQL Analysis
### 1. Database Creation
- **Trigger**: User selects a folder in the UI.
- **Process**: Runs `codeql database create` using the project path as source root.
- **Output**: Creates a `codeql_db/` folder in the target project.

### 2. Vulnerability Scan
- **Trigger**: Automatic after database creation.
- **Process**: Runs `codeql database analyze` with `sarif-latest` format.
- **Output**: Generates a `results.sarif` file in the project root.

### 3. Real-time Monitoring
- **Function**: Emits `codeql-log` events from Zig to React.
- **Display**: Shows console output and progress messages in the app UI.

### 4. Results Summary
- **Function**: Parses the SARIF file for `"ruleId"` patterns.
- **Display**: Informs the user of the total number of potential vulnerabilities detected.

## Documentation Management
### 5. Automatic Doc Tracking
- **Function**: Ensures every change is reflected in the `docs/` folder.
- **Constraint**: Mandated by project-level instructions in `.instructions.md`.
