#!/usr/bin/env python3
import os
import sys
import subprocess
import json
import fnmatch

CODEQL_LANGUAGE_MAP = {
    "JavaScript": "javascript",
    "TypeScript": "javascript",
    "TSX": "javascript",
    "JSX": "javascript",
    "Python": "python",
    "Java": "java",
    "Kotlin": "java",
    "C": "cpp",
    "C++": "cpp",
    "CHeader": "cpp",
    "CppHeader": "cpp",
    "Go": "go",
    "Ruby": "ruby",
    "C#": "csharp",
    "Swift": "swift"
}

ECOSYSTEM_MANIFEST_MAP = {
    "package.json": "npm_and_yarn",
    "requirements.txt": "pip",
    "setup.py": "pip",
    "Pipfile": "pip",
    "pyproject.toml": "pip",
    "pom.xml": "maven",
    "build.gradle": "gradle",
    "build.gradle.kts": "gradle",
    "Cargo.toml": "cargo",
    "go.mod": "gomod",
    "composer.json": "composer",
    "Gemfile": "bundler"
}

def debug(msg):
    """Print debug messages to stderr so they don't pollute the JSON stdout."""
    print(f"[project_detector] {msg}", file=sys.stderr, flush=True)

def normalize_path(raw_path):
    """
    Normalize paths that might come from Windows environments.
    Handles: C:\\Users\\... -> /mnt/c/Users/...  (WSL-style)
    Also handles already-valid Linux paths.
    """
    path = raw_path.strip()
    
    # Check if it's a Windows-style path (e.g. C:\foo or C:/foo)
    if len(path) >= 2 and path[1] == ':' and path[0].isalpha():
        drive_letter = path[0].lower()
        rest = path[2:].replace('\\', '/')
        converted = f"/mnt/{drive_letter}{rest}"
        debug(f"Detected Windows path. Converting: '{path}' -> '{converted}'")
        path = converted
    
    # Also handle any remaining backslashes (shouldn't happen on Linux paths but just in case)
    if '\\' in path:
        path = path.replace('\\', '/')
        debug(f"Replaced backslashes in path -> '{path}'")
    
    return path

def get_ecosystems(project_path):
    debug(f"Searching for dependency manifests in: {project_path}")
    ecosystems = []
    seen = set()
    
    # Fast shallow walk to find manifests
    for root, dirs, files in os.walk(project_path):
        # Ignore common heavy directories
        dirs[:] = [d for d in dirs if d not in {'.git', 'node_modules', 'venv', '__pycache__', 'build', 'dist', 'target', '.next', '.nuxt', 'vendor'}]
        
        rel_dir = os.path.relpath(root, project_path)
        if rel_dir == ".":
            rel_dir = "/"
        else:
            rel_dir = "/" + rel_dir
            
        # Don't go deeper than 2 levels to avoid performance issues
        if rel_dir.count('/') > 2:
            dirs.clear()
            continue
            
        for file in files:
            eco_name = None
            if file in ECOSYSTEM_MANIFEST_MAP:
                eco_name = ECOSYSTEM_MANIFEST_MAP[file]
            elif fnmatch.fnmatch(file, "*.csproj") or file == "packages.config":
                eco_name = "nuget"
                
            if eco_name:
                key = f"{eco_name}:{rel_dir}"
                if key not in seen:
                    seen.add(key)
                    debug(f"  Found manifest: {file} ({eco_name}) in {rel_dir}")
                    ecosystems.append({
                        "name": eco_name,
                        "manifest": file,
                        "directory": rel_dir,
                        "selected": True
                    })
    
    debug(f"Total ecosystems found: {len(ecosystems)}")
    return ecosystems

def run_detection(project_path, tokei_path=None):
    debug(f"=== Project Detection Start ===")
    debug(f"Raw input path: '{project_path}'")
    
    # Normalize path (handle Windows paths)
    project_path = normalize_path(project_path)
    debug(f"Normalized path: '{project_path}'")
    
    # Validate path exists
    if not os.path.exists(project_path):
        error_msg = f"Path does not exist: {project_path}"
        debug(f"ERROR: {error_msg}")
        print(json.dumps({"error": error_msg}))
        sys.exit(1)
        
    if not os.path.isdir(project_path):
        error_msg = f"Path is not a directory: {project_path}"
        debug(f"ERROR: {error_msg}")
        print(json.dumps({"error": error_msg}))
        sys.exit(1)
    
    debug(f"Path exists and is a directory. Contents (top-level):")
    try:
        for item in sorted(os.listdir(project_path))[:30]:
            item_type = "DIR" if os.path.isdir(os.path.join(project_path, item)) else "FILE"
            debug(f"  [{item_type}] {item}")
    except PermissionError as e:
        debug(f"  WARNING: Cannot list directory contents: {e}")
    
    # Locate tokei binary: use explicit path from settings, or fall back to system PATH
    if tokei_path and os.path.exists(tokei_path):
        tokei_bin = tokei_path
        debug(f"Using tokei binary from settings: {tokei_bin}")
    else:
        if tokei_path:
            debug(f"Configured tokei path not found at {tokei_path}, falling back to system PATH")
        else:
            debug(f"No tokei path configured, using system PATH")
        tokei_bin = "tokei"
        
    try:
        debug(f"Running: {tokei_bin} -o json {project_path}")
        result = subprocess.run([tokei_bin, "-o", "json", project_path], capture_output=True, text=True, check=True)
        debug(f"Tokei stdout length: {len(result.stdout)} bytes")
        if result.stderr:
            debug(f"Tokei stderr: {result.stderr[:500]}")
        tokei_data = json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        error_msg = f"Tokei exited with code {e.returncode}. stderr: {e.stderr[:300] if e.stderr else '(empty)'}"
        debug(f"ERROR: {error_msg}")
        print(json.dumps({"error": error_msg}))
        sys.exit(1)
    except json.JSONDecodeError as e:
        error_msg = f"Failed to parse tokei JSON output: {str(e)}"
        debug(f"ERROR: {error_msg}")
        print(json.dumps({"error": error_msg}))
        sys.exit(1)
    except Exception as e:
        error_msg = f"Failed to run tokei: {type(e).__name__}: {str(e)}"
        debug(f"ERROR: {error_msg}")
        print(json.dumps({"error": error_msg}))
        sys.exit(1)
        
    # Log all languages found by tokei
    debug(f"Tokei detected {len(tokei_data)} language entries:")
    for lang_name, lang_stats in sorted(tokei_data.items()):
        code_lines = lang_stats.get("code", 0)
        mapped = CODEQL_LANGUAGE_MAP.get(lang_name, "(not mapped to CodeQL)")
        debug(f"  {lang_name}: {code_lines} lines of code -> {mapped}")
    
    codeql_langs = {}
    
    # Process tokei output
    for tokei_lang, stats in tokei_data.items():
        if tokei_lang == "Total":
            continue
            
        if tokei_lang in CODEQL_LANGUAGE_MAP:
            cql_lang = CODEQL_LANGUAGE_MAP[tokei_lang]
            code_lines = stats.get("code", 0)
            if code_lines > 0:
                if cql_lang not in codeql_langs:
                    codeql_langs[cql_lang] = {"name": cql_lang, "code_lines": 0, "selected": True}
                codeql_langs[cql_lang]["code_lines"] += code_lines
                
    languages = list(codeql_langs.values())
    debug(f"CodeQL-compatible languages: {[l['name'] for l in languages]}")
    
    # Process ecosystems
    ecosystems = get_ecosystems(project_path)
    
    output = {
        "languages": sorted(languages, key=lambda x: x["code_lines"], reverse=True),
        "ecosystems": ecosystems
    }
    
    debug(f"Final output: {len(languages)} languages, {len(ecosystems)} ecosystems")
    debug(f"=== Project Detection Complete ===")
    
    print(json.dumps(output))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Project path required"}))
        sys.exit(1)
    
    project_path_arg = sys.argv[1]
    tokei_path_arg = None
    
    # Parse optional --tokei-path argument
    if "--tokei-path" in sys.argv:
        idx = sys.argv.index("--tokei-path")
        if idx + 1 < len(sys.argv):
            tokei_path_arg = sys.argv[idx + 1]
            debug(f"Received --tokei-path: {tokei_path_arg}")
    
    run_detection(project_path_arg, tokei_path=tokei_path_arg)
