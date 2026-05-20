#!/usr/bin/env python3
import os
import sys
import subprocess
import yaml
import json

def run_dependabot(project_path):
    # Determine the directory flag for dependabot
    sub_dir = "/"
    if os.path.exists(os.path.join(project_path, "frontend", "package.json")):
        sub_dir = "/frontend"
    elif not os.path.exists(os.path.join(project_path, "package.json")):
        print(json.dumps({"error": "No package.json found in root or frontend/"}))
        sys.exit(1)

    output_yml = os.path.join(project_path, "dependabot_output.yml")
    if os.path.exists(output_yml):
        os.remove(output_yml)
    
    # Run dependabot
    cmd = [
        "/home/frano/Programs/dependabotCli/dependabot-cli/dependabot",
        "update",
        "npm_and_yarn",
        "ElPsk21/repoDummy",
        "--local", project_path,
        "-d", sub_dir,
        "-o", output_yml
    ]
    
    env = os.environ.copy()
    env["FAKE_API_HOST"] = "127.0.0.1"
    
    log_file = os.path.join(project_path, "dependabot_scan.log")
    
    try:
        import datetime
        import re
        
        # Run command without check=True to prevent failing on non-zero exit codes if table is there
        result = subprocess.run(cmd, env=env, capture_output=True, text=True)
        
        # Combine both stdout and stderr to ensure we capture the summary table wherever it is printed
        full_output = (result.stdout or "") + "\n" + (result.stderr or "")
            
        # Parse the output to extract the summary table
        lines = full_output.split('\n')
        table_lines = []
        in_table = False
        package_count = 0
        parsed_updates = []
        
        # Regex to parse package changes from table lines:
        # e.g., "| created  | @ai-sdk/google ( from 3.0.31 to 3.0.75 )                    |"
        row_regex = re.compile(r'^\s*\|\s*([^\s\|]+)\s*\|\s*([^\s\|(]+)\s*\(\s*from\s+([^\s]+)\s+to\s+([^\s\)]+)\s*\)\s*\|\s*$')
        
        # Parse every line for update entries using the regex directly
        for line in lines:
            clean_line = line.replace('updater | ', '').strip()
            
            # Capture table formatting lines for the log file
            if clean_line.startswith('+--') or (clean_line.startswith('|') and 'created' not in clean_line and 'updated' not in clean_line):
                table_lines.append(clean_line)
            
            m = row_regex.match(clean_line)
            if m:
                action = m.group(1).strip()
                package = m.group(2).strip()
                prev_ver = m.group(3).strip()
                new_ver = m.group(4).strip()
                parsed_updates.append({
                    "package": package,
                    "action": action,
                    "previous-version": prev_ver,
                    "version": new_ver
                })
                package_count += 1
                table_lines.append(clean_line)
                
        # If we successfully parsed any packages, we consider the table extraction successful!
        in_table = (package_count > 0)
                    
        # Write only the summary, discard the full log
        now = datetime.datetime.now().isoformat()
        with open(log_file, "w") as f_log:
            if in_table and len(table_lines) >= 3:
                f_log.write("=== Dependabot Scan Results ===\n")
                f_log.write(f"Timestamp: {now}\n")
                f_log.write(f"Project: {project_path}\n\n")
                f_log.write('\n'.join(table_lines) + '\n\n')
                f_log.write(f"Summary: {package_count} packages updated\n")
            else:
                f_log.write("=== Dependabot Scan Results ===\n")
                f_log.write(f"Timestamp: {now}\n")
                f_log.write(f"Project: {project_path}\n\n")
                f_log.write("No 'Changes to Dependabot Pull Requests' table found in the output.\n")
                if result.returncode != 0:
                    f_log.write(f"CLI exited with return code: {result.returncode}\n")
                    if result.stderr:
                        f_log.write("\n--- Last 50 lines of STDERR ---\n")
                        f_log.write('\n'.join(result.stderr.split('\n')[-50:]))
                    if result.stdout:
                        f_log.write("\n--- Last 50 lines of STDOUT ---\n")
                        f_log.write('\n'.join(result.stdout.split('\n')[-50:]))
                        
        # Load and parse output file safely by stripping massive file contents first
        documents = []
        if os.path.exists(output_yml) and os.path.getsize(output_yml) > 0:
            try:
                # Strip out massive file contents (e.g. package-lock.json dumps) before parsing
                # to prevent PyYAML from hanging or consuming gigabytes of RAM.
                stripped_yaml_lines = []
                skip_indent = None
                with open(output_yml, 'r') as f:
                    for line in f:
                        stripped = line.lstrip()
                        if not stripped:
                            continue
                        indent = len(line) - len(stripped)
                        
                        if skip_indent is not None:
                            if indent > skip_indent:
                                continue
                            else:
                                skip_indent = None
                        
                        # Strip heavy keys and their children
                        if (stripped.startswith("updated_dependency_files:") or 
                            stripped.startswith("updated-dependency-files:") or 
                            stripped.startswith("dependency_files:")):
                            skip_indent = indent
                            continue
                            
                        stripped_yaml_lines.append(line)
                
                compact_yaml = "".join(stripped_yaml_lines)
                documents = list(yaml.safe_load_all(compact_yaml))
                documents = [doc for doc in documents if doc is not None]
            except Exception as e:
                # If parsing fails but we have parsed updates, we will use parsed updates
                pass
                
        # Check if we have pull requests in the loaded YAML documents
        has_pr = any(doc.get('type') == 'create_pull_request' for doc in documents if isinstance(doc, dict))
        
        # If we don't have pull request events in the YAML, but we parsed updates from the stdout table,
        # we construct the pull request events manually so the frontend displays them perfectly!
        if not has_pr and parsed_updates:
            for up in parsed_updates:
                documents.append({
                    "type": "create_pull_request",
                    "expect": {
                        "data": {
                            "dependencies": [
                                {
                                    "name": up["package"],
                                    "previous-version": up["previous-version"],
                                    "version": up["version"]
                                }
                            ]
                        }
                    }
                })
                
        # If we successfully parsed any updates or have documents, print JSON and exit 0
        # If we have absolutely no updates and the CLI returned an error, then it actually failed
        if not documents and result.returncode != 0:
            print(json.dumps({
                "error": f"Dependabot CLI failed with exit code {result.returncode}",
                "details": f"Check {log_file} for details"
            }))
            sys.exit(1)
            
        print(json.dumps(documents))
        
    except Exception as e:
        print(json.dumps({"error": "Failed during Dependabot runner execution", "details": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Project path required"}))
        sys.exit(1)
    
    run_dependabot(sys.argv[1])
