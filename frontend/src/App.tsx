import { useEffect, useState, useCallback } from "react";

// --- Types ---
interface CodeQlAlert {
  type: "codeql";
  id: string;
  rule: string;
  description: string;
  severity: "error" | "warning" | "note" | "none";
  location: string;
  fullPath?: string;
  startLine?: number;
  endLine?: number;
  helpText?: string;
  snippet?: string;
}

interface DependabotAlert {
  type: "dependabot";
  id: string;
  package: string;
  action: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  versionRange: string;
  patchedVersion?: string;
  isDirect?: boolean;
  urls?: string[];
}

interface ScanStats {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  duration: number; // in seconds
  projectPath: string;
}

interface ToolStatus {
  npm: boolean;
  codeql: boolean;
  codeqlPath: string;
  npmVersion: string;
  codeqlVersion: string;
}

interface DetectedStack {
  languages: { name: string; code_lines: number; selected: boolean }[];
  ecosystems: { name: string; manifest: string; directory: string; selected: boolean }[];
}

type Page = "dashboard" | "settings";

export default function App() {
  const [bridge, setBridge] = useState("checking...");
  const [activePage, setActivePage] = useState<Page>("dashboard");
  const [activeTab, setActiveTab] = useState<"codeql" | "dependabot">("codeql");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanLogs, setScanLogs] = useState<string[]>([]);
  const [scanProgress, setScanProgress] = useState(0);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [isCheckingTools, setIsCheckingTools] = useState(false);
  const [codeqlPath, setCodeqlPath] = useState(() => localStorage.getItem("settings.codeqlPath") || "");
  const [dependabotCliPath, setDependabotCliPath] = useState(() => localStorage.getItem("settings.dependabotCliPath") || "");
  const [dotnetPath, setDotnetPath] = useState(() => localStorage.getItem("settings.dotnetPath") || "");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const [depSort, setDepSort] = useState<"name" | "action">("name");

  // State for project detection
  const [detectedStack, setDetectedStack] = useState<DetectedStack | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);

  // States for parsed data
  const [codeQlAlerts, setCodeQlAlerts] = useState<CodeQlAlert[]>([]);
  const [dependabotAlerts, setDependabotAlerts] = useState<DependabotAlert[]>([]);
  const [scanStats, setScanStats] = useState<ScanStats | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  
  // State for detail view
  const [selectedAlert, setSelectedAlert] = useState<CodeQlAlert | DependabotAlert | null>(null);
  const [isLoadingSnippet, setIsLoadingSnippet] = useState(false);
  const [snippetCache, setSnippetCache] = useState<Record<string, string>>({});
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (selectedAlert && selectedAlert.type === "codeql" && scanStats) {
      const alertId = selectedAlert.id;
      if (snippetCache[alertId]) return;

      const fetchSnippet = async () => {
        setIsLoadingSnippet(true);
        console.log("[JS] Fetching snippet for alert:", selectedAlert);
        try {
          const projectRoot = scanStats.projectPath;
          const fullPath = selectedAlert.fullPath?.startsWith("/") 
            ? selectedAlert.fullPath 
            : `${projectRoot}/${selectedAlert.location}`;
            
          const start = Math.max(1, (selectedAlert.startLine || 1) - 2);
          const end = (selectedAlert.endLine || 1) + 2;

          const payload = {
            path: fullPath,
            startLine: start,
            endLine: end
          };
          console.log("[JS] Calling codeql.readSnippet with payload:", payload);

          const rawSnippet = await (window as any).zero.invoke("codeql.readSnippet", payload);
          console.log("[JS] codeql.readSnippet returned type:", typeof rawSnippet);

          let snippetText = "";
          if (typeof rawSnippet === "string") {
            try {
              snippetText = JSON.parse(rawSnippet).content;
            } catch (e) {
              snippetText = rawSnippet;
            }
          } else if (rawSnippet && typeof rawSnippet === 'object' && 'content' in rawSnippet) {
            snippetText = rawSnippet.content;
          }

          if (snippetText) {
            console.log("[JS] Setting snippet text in cache, length:", snippetText.length);
            setSnippetCache(prev => ({ ...prev, [alertId]: snippetText }));
          }
        } catch (err) {
          console.error("[JS] Failed to fetch snippet", err);
        } finally {
          setIsLoadingSnippet(false);
        }
      };
      fetchSnippet();
    }
  }, [selectedAlert?.id, scanStats, snippetCache]);

  const checkTools = useCallback(async () => {
    setIsCheckingTools(true);
    // Mock tool check
    setTimeout(() => {
      setToolStatus({
        npm: true,
        codeql: true,
        codeqlPath: "/usr/local/bin/codeql",
        npmVersion: "10.2.4",
        codeqlVersion: "2.15.5"
      });
      setIsCheckingTools(false);
    }, 500);
  }, []);

  const sendPathsToBackend = useCallback(async () => {
    if (!(window as any).zero) return;
    try {
      await (window as any).zero.invoke("settings.updatePaths", {
        codeqlPath: localStorage.getItem("settings.codeqlPath") || "",
        dependabotCliPath: localStorage.getItem("settings.dependabotCliPath") || "",
        dotnetPath: localStorage.getItem("settings.dotnetPath") || ""
      });
    } catch (e) {
      console.debug("[JS] settings.updatePaths not available yet", e);
    }
  }, []);

  const handleBrowse = async (setter: (v: string) => void, key: string) => {
    try {
      const result = await (window as any).zero.invoke("zero-native.dialog.openFile", {
        title: "Select file",
      });
      if (result?.[0]) {
        let filePath: string = result[0];
        if (filePath.length >= 2 && filePath[1] === ':' && /^[a-zA-Z]$/.test(filePath[0])) {
          const driveLetter = filePath[0].toLowerCase();
          const rest = filePath.substring(2).replace(/\\/g, '/');
          filePath = `/mnt/${driveLetter}${rest}`;
        } else if (filePath.includes('\\')) {
          filePath = filePath.replace(/\\/g, '/');
        }
        setter(filePath);
        localStorage.setItem(key, filePath);
      }
    } catch (err) {
      console.error("[JS] Browse failed", err);
    }
  };

  const handleSaveSettings = async () => {
    localStorage.setItem("settings.codeqlPath", codeqlPath);
    localStorage.setItem("settings.dependabotCliPath", dependabotCliPath);
    localStorage.setItem("settings.dotnetPath", dotnetPath);
    await sendPathsToBackend();
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  };

  useEffect(() => { console.log("[JS] TRACE: useEffect triggered", selectedAlert?.id);
    const hasZero = !!(window as any).zero;
    setBridge(hasZero ? "available" : "not enabled");
    if (hasZero) {
      checkTools();
      sendPathsToBackend();
    }
  }, [checkTools, sendPathsToBackend]);

  const handleLocalScan = async () => {
    try {
      // 1. Select folder
      const result = await (window as any).zero.invoke("zero-native.dialog.openFile", {
        title: "Select Project Folder",
        allowDirectories: true,
      });

      if (!result || result.length === 0) return;
      let projectPath: string = result[0];
      
      // Normalize Windows paths to WSL-compatible paths
      // e.g. "C:\Users\foo" -> "/mnt/c/Users/foo"
      if (projectPath.length >= 2 && projectPath[1] === ':' && /^[a-zA-Z]$/.test(projectPath[0])) {
        const driveLetter = projectPath[0].toLowerCase();
        const rest = projectPath.substring(2).replace(/\\/g, '/');
        projectPath = `/mnt/${driveLetter}${rest}`;
        console.debug(`[JS] handleLocalScan: Converted Windows path to WSL: ${projectPath}`);
      } else if (projectPath.includes('\\')) {
        projectPath = projectPath.replace(/\\/g, '/');
        console.debug(`[JS] handleLocalScan: Replaced backslashes in path: ${projectPath}`);
      }
      
      setCurrentProjectPath(projectPath);

      // 2. Run detection
      console.debug(`[JS] handleLocalScan: Iniciando preescaneo del proyecto en: ${projectPath}`);
      setIsDetecting(true);
      setScanError(null);

      try {
        console.debug("[JS] handleLocalScan: Invocando project.detectStack...");
        const detectResult = await (window as any).zero.invoke("project.detectStack", { path: projectPath });
        console.debug("[JS] handleLocalScan: Resultado raw recibido:", detectResult);
        
        let detectData;
        if (typeof detectResult === "string") {
          detectData = JSON.parse(detectResult);
        } else if (detectResult instanceof Uint8Array || detectResult instanceof ArrayBuffer) {
          detectData = JSON.parse(new TextDecoder().decode(detectResult as any));
        } else if (detectResult && typeof detectResult === "object" && "buffer" in detectResult) {
          detectData = JSON.parse(new TextDecoder().decode(new Uint8Array(detectResult.buffer as ArrayBuffer)));
        } else {
          detectData = detectResult;
        }

        console.debug("[JS] handleLocalScan: Datos parseados de detección:", detectData);

        if (detectData.error) {
          console.debug("[JS] handleLocalScan: Error detectado en la respuesta:", detectData.error);
          setScanError(`Detection failed: ${detectData.error}`);
        } else {
          console.debug("[JS] handleLocalScan: Stack detectado, actualizando interfaz gráfica.");
          setDetectedStack(detectData);
        }
      } catch (err: any) {
        console.error("Detection error:", err);
        setScanError(`Detection failed: ${err.message || String(err)}`);
      } finally {
        setIsDetecting(false);
      }
    } catch (err: any) {
      console.error("Scan failed", err);
    }
  };

  const startAnalysis = async () => {
    if (!currentProjectPath || !detectedStack) return;

    console.debug(`[JS] startAnalysis: Comenzando escaneo para el proyecto en: ${currentProjectPath}`);
    console.debug(`[JS] startAnalysis: Opciones seleccionadas:`, detectedStack);

    setIsScanning(true);
    setScanLogs([`[Scan] Initializing multi-scan for: ${currentProjectPath}`]);
    setScanProgress(5);

    const removeListener = (window as any).zero.on("codeql-log", (detail: any) => {
      setScanLogs(prev => [...prev, detail.message]);
    });
    const removeDependabotListener = (window as any).zero.on("dependabot-log", (detail: any) => {
      setScanLogs(prev => [...prev, detail.message]);
    });

    try {
      setScanError(null);
      const startTime = Date.now();
      
      const promises: Promise<any>[] = [];
      const codeqlLangs = detectedStack.languages.filter(l => l.selected).map(l => l.name);
      const depEcos = detectedStack.ecosystems.filter(e => e.selected);

      codeqlLangs.forEach(lang => {
        console.debug(`[JS] startAnalysis: Preparando CodeQL para lenguaje: ${lang}`);
        promises.push((window as any).zero.invoke("codeql.runScan", { path: currentProjectPath, language: lang, codeqlPath, dotnetPath }).then((res: any) => ({ type: 'codeql', lang, result: res })));
      });
      depEcos.forEach(eco => {
        console.debug(`[JS] startAnalysis: Preparando Dependabot para ecosistema: ${eco.name} en ${eco.directory}`);
        promises.push((window as any).zero.invoke("dependabot.runScan", { path: currentProjectPath, ecosystem: eco.name, directory: eco.directory, dependabotCliPath }).then((res: any) => ({ type: 'dependabot', eco, result: res })));
      });

      console.debug(`[JS] startAnalysis: Lanzando ${promises.length} invocaciones en paralelo (CodeQL y Dependabot).`);
      const results = await Promise.allSettled(promises);
      const endTime = Date.now();
      
      let alerts: CodeQlAlert[] = [];
      let depAlerts: DependabotAlert[] = [];
      let errors: string[] = [];

      results.forEach((res, index) => {
        console.debug(`[JS] startAnalysis: Procesando resultado de la promesa ${index}`, res);
        
        if (res.status === "rejected") {
          console.debug(`[JS] startAnalysis: Tarea ${index} rechazada:`, res.reason);
          errors.push(`Task ${index} failed: ${res.reason}`);
          return;
        }

        const task = res.value;
        const rawValue = task.result;

        if (task.type === 'codeql') {
          let sarifRaw = "";
          if (typeof rawValue === "string") sarifRaw = rawValue;
          else if (rawValue instanceof Uint8Array || (rawValue && typeof rawValue === "object" && "buffer" in rawValue)) sarifRaw = new TextDecoder().decode(rawValue as any);
          else sarifRaw = JSON.stringify(rawValue);

          if (sarifRaw && sarifRaw.trim().length > 0) {
            try {
              const parsed = JSON.parse(sarifRaw);
              
              // Check if the bridge returned an error JSON instead of SARIF
              if (parsed.error) {
                console.debug(`[JS] CodeQL (${task.lang}) returned error:`, parsed.error);
                errors.push(`CodeQL (${task.lang}): ${parsed.error}`);
              } else if (parsed.runs) {
                // Valid SARIF response
                parsed.runs?.forEach((run: any) => {
                  run.results?.forEach((r: any, idx: number) => {
                    const loc = r.locations?.[0]?.physicalLocation;
                    const region = loc?.region;
                    const relativePath = loc?.artifactLocation?.uri || "unknown";
                    alerts.push({
                      type: "codeql",
                      id: `codeql-${task.lang}-${idx}`,
                      rule: r.ruleId,
                      description: `[${task.lang}] ${r.message.text}`,
                      severity: r.level === "error" ? "error" : "warning",
                      location: relativePath,
                      fullPath: currentProjectPath.endsWith('/') ? `${currentProjectPath}${relativePath}` : `${currentProjectPath}/${relativePath}`,
                      startLine: region?.startLine || 0,
                      endLine: region?.endLine || region?.startLine || 0,
                    });
                  });
                });
              } else {
                console.debug(`[JS] CodeQL (${task.lang}) returned unexpected JSON:`, parsed);
                errors.push(`CodeQL (${task.lang}): Unexpected response format`);
              }
            } catch (e: any) {
              errors.push(`Failed to parse CodeQL (${task.lang}): ${e.message}`);
            }
          }
        } else if (task.type === 'dependabot') {
          try {
            let depData: any;
            if (typeof rawValue === "string") depData = JSON.parse(rawValue);
            else if (rawValue instanceof Uint8Array || rawValue instanceof ArrayBuffer) depData = JSON.parse(new TextDecoder().decode(rawValue));
            else if (rawValue && typeof rawValue === "object") {
              if ('buffer' in rawValue && rawValue.buffer instanceof ArrayBuffer) {
                depData = JSON.parse(new TextDecoder().decode(new Uint8Array(rawValue.buffer, rawValue.byteOffset, rawValue.byteLength)));
              } else if ('0' in rawValue && typeof rawValue[0] === 'number') {
                const len = Object.keys(rawValue).filter(k => /^\d+$/.test(k)).length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) bytes[i] = rawValue[i];
                depData = JSON.parse(new TextDecoder().decode(bytes));
              } else depData = rawValue;
            }

            if (depData && depData.error) {
               errors.push(`Dependabot Error (${task.eco.name}): ${depData.error}`);
            } else if (Array.isArray(depData)) {
               depData.forEach((call: any, idx: number) => {
                  if (call.type === "create_pull_request" && call.expect && call.expect.data) {
                     const deps = call.expect.data.dependencies || [];
                     deps.forEach((d: any, dIdx: number) => {
                         depAlerts.push({
                           type: "dependabot",
                           id: `dep-${task.eco.name}-${idx}-${dIdx}`,
                           package: d.name,
                           action: call.type === "create_pull_request" ? "created" : "updated",
                           description: `Update ${d.name} from ${d['previous-version']} to ${d.version}`,
                           severity: "high",
                           versionRange: d['previous-version'] || "unknown",
                           patchedVersion: d.version || "unknown"
                        });
                     });
                  }
               });
            }
          } catch (e: any) {
             errors.push(`Failed to parse Dependabot (${task.eco.name}): ${e.message}`);
          }
        }
      });

      if (errors.length === promises.length && promises.length > 0) {
        throw new Error(`All scans failed:\n${errors.join('\n')}`);
      }

      if (errors.length > 0) {
        setScanLogs(prev => [...prev, `[Warning] Some scans had issues:`, ...errors]);
        setScanWarnings(errors);
      } else {
        setScanWarnings([]);
      }

      const stats: ScanStats = {
        total: alerts.length + depAlerts.length,
        critical: alerts.filter(a => a.severity === "error").length,
        high: alerts.filter(a => a.severity === "warning").length + depAlerts.length,
        medium: 0,
        low: 0,
        duration: Math.round((endTime - startTime) / 1000),
        projectPath: currentProjectPath
      };

      setDependabotAlerts(depAlerts);
      setScanStats(stats);
      setCodeQlAlerts(alerts);
      
      try {
        await (window as any).zero.invoke("scan.saveResults", {
          path: currentProjectPath,
          results: {
            codeql: alerts,
            dependabot: depAlerts,
            stats: stats,
            errors: errors
          }
        });
        setScanLogs(prev => [...prev, `[Scan] Results saved to ${currentProjectPath}/scan_results.json`]);
      } catch (e) {}

      setIsLoaded(true);
    } catch (err: any) {
      console.error("[JS] Error processing scan results:", err);
      const errMsg = err.message || String(err);
      setScanError(errMsg);
      setScanLogs(prev => [...prev, `[Error] ${errMsg}`]);
    } finally {
      removeListener();
      removeDependabotListener();
      setIsScanning(false);
      setScanProgress(0);
    }
  };


  const resetState = () => {
    setIsLoaded(false);
    setIsScanning(false);
    setIsDetecting(false);
    setScanError(null);
    setCodeQlAlerts([]);
    setDependabotAlerts([]);
    setScanStats(null);
    setSnippetCache({});
    setDetectedStack(null);
    setCurrentProjectPath(null);
    setScanWarnings([]);
  };

  const getSeverityBadgeClass = (severity: string) => {
    if (["error", "critical"].includes(severity)) return "critical";
    if (["warning", "high"].includes(severity)) return "high";
    if (["note", "medium"].includes(severity)) return "medium";
    return "low";
  };

  const getVersionUpdateType = (oldV: string, newV: string) => {
    if (!oldV || !newV || oldV === "unknown" || newV === "unknown") return "unknown";
    const cleanOld = oldV.replace(/[^0-9.]/g, '').split('.');
    const cleanNew = newV.replace(/[^0-9.]/g, '').split('.');
    
    if (cleanOld[0] !== cleanNew[0]) return "major";
    if (cleanOld[1] !== cleanNew[1]) return "minor";
    if (cleanOld[2] !== cleanNew[2]) return "patch";
    return "unknown";
  };

  const filteredDepAlerts = dependabotAlerts
    .filter(a => a.package.toLowerCase().includes(depSearch.toLowerCase()))
    .sort((a, b) => {
      if (depSort === "name") return a.package.localeCompare(b.package);
      if (depSort === "action") return a.action.localeCompare(b.action);
      return 0;
    });

  return (
    <div className="layout">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          </svg>
          <span>ReportBot</span>
        </div>
        
        <nav className="nav-menu">
          <button className={`nav-item ${activePage === "dashboard" ? "active" : ""}`} onClick={() => setActivePage("dashboard")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>
            Dashboard
          </button>
          <button className={`nav-item ${activePage === "settings" ? "active" : ""}`} onClick={() => setActivePage("settings")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            Settings
          </button>
        </nav>
        
        <div className="sidebar-footer">
          <div className="bridge-status">
            <span className={`status-dot ${bridge === "available" ? "active" : ""}`}></span>
            Bridge: {bridge}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
      {activePage === "settings" ? (
        <>
          <header className="page-header">
            <h1>Settings</h1>
            <p>Configure analysis tools and preferences.</p>
          </header>
          <div className="settings-grid">
            <div className="content-card settings-card">
              <div className="settings-card-header">
                <h2>Tool Availability</h2>
                <button className="settings-btn" onClick={checkTools} disabled={isCheckingTools}>
                  {isCheckingTools ? "Checking..." : "Re-check"}
                </button>
              </div>
              {toolStatus ? (
                <div className="tool-status-list">
                  <div className="tool-status-row">
                    <div className="tool-info">
                      <span className={`status-indicator ${toolStatus.npm ? "ok" : "missing"}`}></span>
                      <span className="tool-name">npm</span>
                    </div>
                    <span className="tool-detail">{toolStatus.npmVersion}</span>
                  </div>
                  <div className="tool-status-row">
                    <div className="tool-info">
                      <span className={`status-indicator ${toolStatus.codeql ? "ok" : "missing"}`}></span>
                      <span className="tool-name">CodeQL CLI</span>
                    </div>
                    <span className="tool-detail">{toolStatus.codeqlVersion}</span>
                  </div>
                </div>
              ) : (
                <p className="text-muted">Run a check to see tool availability.</p>
              )}
            </div>

            <div className="content-card settings-card">
              <div className="settings-card-header">
                <h2>Tool Paths</h2>
              </div>
              <div className="settings-path-group">
                <div className="settings-field">
                  <label htmlFor="codeql-path">CodeQL CLI Path</label>
                  <div className="settings-input-row">
                    <input
                      id="codeql-path"
                      type="text"
                      className="settings-input"
                      value={codeqlPath}
                      onChange={e => setCodeqlPath(e.target.value)}
                      placeholder="e.g. /usr/local/bin/codeql"
                    />
                    <button className="settings-browse-btn" onClick={() => handleBrowse(setCodeqlPath, "settings.codeqlPath")}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                      Browse
                    </button>
                  </div>
                  <p className="settings-help">Path to the CodeQL CLI binary.</p>
                </div>

                <div className="settings-field">
                  <label htmlFor="dependabot-path">Dependabot CLI Path</label>
                  <div className="settings-input-row">
                    <input
                      id="dependabot-path"
                      type="text"
                      className="settings-input"
                      value={dependabotCliPath}
                      onChange={e => setDependabotCliPath(e.target.value)}
                      placeholder="e.g. /usr/local/bin/dependabot"
                    />
                    <button className="settings-browse-btn" onClick={() => handleBrowse(setDependabotCliPath, "settings.dependabotCliPath")}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                      Browse
                    </button>
                  </div>
                  <p className="settings-help">Path to the Dependabot CLI binary. Falls back to system PATH if empty.</p>
                </div>

                <div className="settings-field">
                  <label htmlFor="dotnet-path">dotnet SDK PATH</label>
                  <div className="settings-input-row">
                    <input
                      id="dotnet-path"
                      type="text"
                      className="settings-input"
                      value={dotnetPath}
                      onChange={e => setDotnetPath(e.target.value)}
                      placeholder="e.g. /home/user/.dotnet"
                    />
                    <button className="settings-browse-btn" onClick={() => handleBrowse(setDotnetPath, "settings.dotnetPath")}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                      Browse
                    </button>
                  </div>
                  <p className="settings-help">Directory containing the dotnet SDK. Only required for C#/.NET projects.</p>
                </div>
              </div>

              <div className="settings-actions">
                <button className={`settings-save-btn ${settingsSaved ? 'saved' : ''}`} onClick={handleSaveSettings}>
                  {settingsSaved ? (
                    <><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Saved</>
                  ) : (
                    <><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> Save Settings</>
                  )}
                </button>
                {settingsSaved && <span className="settings-saved-msg">✓ Paths updated successfully</span>}
              </div>
            </div>

            <div className="content-card settings-card">
              <div className="settings-card-header">
                <h2>About</h2>
              </div>
              <div className="about-info">
                <p><strong>ReportBot</strong> v0.1.0</p>
                <p className="text-muted">Local security scanner for npm projects. UI-only mode enabled.</p>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
        <header className="page-header">
          <h1>ReportBot</h1>
          <p>Extract and visualize local CodeQL and Dependabot reports instantly.</p>
        </header>

        <div className="content-card">
          {!isLoaded ? (
            (isScanning || (scanError && !isDetecting && !detectedStack)) ? (
              <section className="scanning-section">
                <div className="scanning-header">
                  <h2>{scanError ? "Scan Failed" : "Active Security Scan"}</h2>
                  <p>{scanError ? "An error occurred during analysis" : "Running security analysis..."}</p>
                </div>
                
                {!scanError && (
                  <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${scanProgress}%` }}></div>
                  </div>
                )}
                
                <div className="terminal-mock">
                  <div className="terminal-header">
                    <span className="dot dot-red"></span>
                    <span className="dot dot-yellow"></span>
                    <span className="dot dot-green"></span>
                    <span className="title">scan-process — bash</span>
                  </div>
                  <div className="terminal-body">
                    {scanLogs.map((log, i) => (
                      <div key={i} className="terminal-line">{log}</div>
                    ))}
                    <div className="terminal-cursor">_</div>
                  </div>
                </div>

                {scanError && (
                  <div className="scan-error-banner" style={{ marginTop: '1rem', padding: '1rem', background: '#fee2e2', border: '1px solid #ef4444', borderRadius: '8px', color: '#b91c1c' }}>
                    <strong>Scan Error:</strong> {scanError}
                    <div style={{ marginTop: '0.5rem' }}>
                      <button className="btn-secondary" onClick={resetState} style={{ padding: '6px 12px', fontSize: '0.875rem' }}>
                        Dismiss & Try Again
                      </button>
                    </div>
                  </div>
                )}
              </section>
            ) : detectedStack ? (
              <section className="prescan-section" style={{ padding: '2rem' }}>
                <h2 style={{ marginBottom: '0.5rem' }}>Project Detected: {currentProjectPath?.split('/').pop()}</h2>
                <p className="text-muted">Select the languages and ecosystems to include in the analysis.</p>
                
                <div style={{ display: 'flex', gap: '2rem', marginTop: '2rem', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '300px', background: '#f8fafc', padding: '1.5rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                      Languages (CodeQL)
                    </h3>
                    {detectedStack.languages.map((l, i) => (
                      <div key={`l-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', padding: '0.5rem', background: '#fff', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                        <input type="checkbox" id={`lang-${i}`} checked={l.selected} onChange={() => {
                          const newStack = {...detectedStack};
                          newStack.languages[i].selected = !l.selected;
                          setDetectedStack(newStack);
                        }} style={{ width: '18px', height: '18px', accentColor: '#3b82f6' }} />
                        <label htmlFor={`lang-${i}`} style={{ flex: 1, cursor: 'pointer', fontWeight: 500 }}>{l.name}</label>
                        <span className="badge note">{l.code_lines.toLocaleString()} lines</span>
                      </div>
                    ))}
                    {detectedStack.languages.length === 0 && <p className="text-muted" style={{ fontStyle: 'italic' }}>No supported languages found.</p>}
                  </div>
                  
                  <div style={{ flex: 1, minWidth: '300px', background: '#f8fafc', padding: '1.5rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>
                      Dependencies (Dependabot)
                    </h3>
                    {detectedStack.ecosystems.map((e, i) => (
                      <div key={`e-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', padding: '0.5rem', background: '#fff', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                        <input type="checkbox" id={`eco-${i}`} checked={e.selected} onChange={() => {
                          const newStack = {...detectedStack};
                          newStack.ecosystems[i].selected = !e.selected;
                          setDetectedStack(newStack);
                        }} style={{ width: '18px', height: '18px', accentColor: '#3b82f6' }} />
                        <label htmlFor={`eco-${i}`} style={{ flex: 1, cursor: 'pointer', fontWeight: 500 }}>{e.name}</label>
                        <code style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#f1f5f9', borderRadius: '4px' }}>{e.directory}</code>
                      </div>
                    ))}
                    {detectedStack.ecosystems.length === 0 && <p className="text-muted" style={{ fontStyle: 'italic' }}>No supported manifests found.</p>}
                  </div>
                </div>
                
                {scanError && (
                  <div className="scan-error-banner" style={{ marginTop: '1.5rem', padding: '1rem', background: '#fee2e2', border: '1px solid #ef4444', borderRadius: '8px', color: '#b91c1c' }}>
                    <strong>Error:</strong> {scanError}
                  </div>
                )}

                <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', borderTop: '1px solid #e2e8f0', paddingTop: '1.5rem' }}>
                  <button className="btn-primary" onClick={startAnalysis} disabled={!detectedStack.languages.some(l => l.selected) && !detectedStack.ecosystems.some(e => e.selected)}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    Start Analysis
                  </button>
                  <button className="btn-secondary" onClick={() => { setDetectedStack(null); setScanError(null); }}>
                    Cancel
                  </button>
                </div>
              </section>
            ) : isDetecting ? (
              <section className="scanning-section">
                <div className="scanning-header">
                  <h2>Detecting Project Stack</h2>
                  <p>Analyzing project structure and languages...</p>
                </div>
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `100%`, animation: 'pulse 1.5s infinite' }}></div>
                </div>
              </section>
            ) : (
              <section className="upload-section">
                <button className="upload-area" onClick={handleLocalScan} style={{ width: '100%', border: 'none', fontFamily: 'inherit' }}>
                  <div className="upload-content">
                    <div className="icon-wrapper">
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                    </div>
                    <h3>Start Local Scan</h3>
                    <p>Select a project folder to run security analysis (dependency audit + static code analysis).</p>
                  </div>
                </button>
              </section>
            )
          ) : (
            <section className="reports-section">
              {scanStats && (
                <div className="analysis-summary-banner">
                  <div className="summary-header">
                    <div className="summary-title-group">
                      <h2>Analysis Summary</h2>
                      <div className="project-badge">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                        {scanStats.projectPath.split('/').pop()}
                      </div>
                    </div>
                    <div className="summary-meta">
                      <span className="meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        {scanStats.duration}s scan time
                      </span>
                    </div>
                  </div>
                  
                  <div className="summary-grid">
                    <div className="summary-card total">
                      <span className="value">{scanStats.total}</span>
                      <span className="label">Total Findings</span>
                    </div>
                    <div className="summary-card critical">
                      <span className="value">{scanStats.critical}</span>
                      <span className="label">Critical/Errors</span>
                    </div>
                    <div className="summary-card high">
                      <span className="value">{scanStats.high}</span>
                      <span className="label">High/Warnings</span>
                    </div>
                    <div className="summary-card medium">
                      <span className="value">{scanStats.medium}</span>
                      <span className="label">Medium</span>
                    </div>
                  </div>

                  {scanWarnings.length > 0 && (
                    <div style={{ marginTop: '1rem', padding: '1rem', background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontWeight: 600, color: '#92400e' }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        Some scans encountered errors
                      </div>
                      <ul style={{ margin: 0, padding: '0 0 0 1.25rem', color: '#78350f', fontSize: '0.875rem', lineHeight: '1.6' }}>
                        {scanWarnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="tabs">
                <button 
                  className={`tab-btn ${activeTab === "codeql" ? "active" : ""}`}
                  onClick={() => setActiveTab("codeql")}
                >
                  CodeQL (SARIF) <span className="tab-count">{codeQlAlerts.length}</span>
                </button>
                <button 
                  className={`tab-btn ${activeTab === "dependabot" ? "active" : ""}`}
                  onClick={() => setActiveTab("dependabot")}
                >
                  Dependencies <span className="tab-count">{dependabotAlerts.length}</span>
                </button>
                <button className="tab-btn reset-btn" onClick={resetState}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 1 0 2.81-6.5L3 8"></path></svg>
                  Load New Folder
                </button>
              </div>
              
              <div className="tab-content">
                {activeTab === "codeql" ? (
                  <div className="codeql-view">
                    {codeQlAlerts.length > 0 && (
                      <div className="codeql-action-bar" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
                        <button className="resolver-btn" onClick={() => {}}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                          </svg>
                          Resolver incidencias
                        </button>
                      </div>
                    )}
                    {codeQlAlerts.length > 0 ? (
                      <div className="alerts-list">
                        {codeQlAlerts.map(alert => (
                          <div key={alert.id} className="alert-item" onClick={() => setSelectedAlert(alert)}>
                            <div className="alert-main">
                              <span className={`severity-badge ${getSeverityBadgeClass(alert.severity)}`}>
                                {alert.severity}
                              </span>
                              <div className="alert-info">
                                <div className="alert-rule">{alert.rule}</div>
                                <div className="alert-desc">{alert.description}</div>
                                <div className="alert-loc">{alert.location}</div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state text-muted" style={{ padding: '60px' }}>
                        <p>No CodeQL findings in this project.</p>
                      </div>
                    )}
                  </div>
                ) : (
                  dependabotAlerts.length > 0 ? (
                    <div className="dep-view">
                      <div className="dep-summary-panel">
                        <div className="dep-stats-grid">
                          <div className="dep-stat-card">
                            <span className="value">{dependabotAlerts.length}</span>
                            <span className="label">Total Updates</span>
                          </div>
                          <div className="dep-stat-card">
                            <span className="value">
                              {dependabotAlerts.filter(a => getVersionUpdateType(a.versionRange, a.patchedVersion || "") === "major").length}
                            </span>
                            <span className="label">Major</span>
                          </div>
                          <div className="dep-stat-card">
                            <span className="value">
                              {dependabotAlerts.filter(a => getVersionUpdateType(a.versionRange, a.patchedVersion || "") === "minor").length}
                            </span>
                            <span className="label">Minor</span>
                          </div>
                          <div className="dep-stat-card">
                            <span className="value">
                              {dependabotAlerts.filter(a => getVersionUpdateType(a.versionRange, a.patchedVersion || "") === "patch").length}
                            </span>
                            <span className="label">Patch</span>
                          </div>
                        </div>
                      </div>

                      <div className="dep-search-container">
                        <input 
                          type="text" 
                          className="dep-search" 
                          placeholder="Search packages..." 
                          value={depSearch}
                          onChange={(e) => setDepSearch(e.target.value)}
                        />
                        <select 
                          className="dep-sort-select"
                          value={depSort}
                          onChange={(e) => setDepSort(e.target.value as "name" | "action")}
                        >
                          <option value="name">Sort by Name</option>
                          <option value="action">Sort by Action</option>
                        </select>
                        <button className="resolver-btn" onClick={() => {}} style={{ marginLeft: 'auto' }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                          </svg>
                          Resolver incidencias
                        </button>
                      </div>

                      <div className="dep-table-container">
                        <table className="dep-table">
                          <thead>
                            <tr>
                              <th>Action</th>
                              <th>Package</th>
                              <th>Update</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredDepAlerts.map(alert => (
                              <tr key={alert.id} onClick={() => setSelectedAlert(alert)}>
                                <td><span className={`badge ${alert.action === 'created' ? 'note' : 'medium'}`}>{alert.action}</span></td>
                                <td style={{ fontWeight: 600 }}>{alert.package}</td>
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center' }}>
                                    <span style={{ fontFamily: 'monospace', color: '#64748b' }}>{alert.versionRange}</span>
                                    <span className="version-arrow">→</span>
                                    <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{alert.patchedVersion}</span>
                                    <span style={{ marginLeft: '12px' }} className={`version-badge ${getVersionUpdateType(alert.versionRange, alert.patchedVersion || "")}`}>
                                      {getVersionUpdateType(alert.versionRange, alert.patchedVersion || "")}
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="empty-state text-muted" style={{ padding: '60px' }}>
                      <p>No dependency updates found.</p>
                    </div>
                  )
                )}
              </div>

            </section>
          )}
        </div>
      </>
      )}
      </main>

      {/* Drawer */}
      <div className={`drawer-backdrop ${selectedAlert ? 'open' : ''}`} onClick={() => setSelectedAlert(null)}></div>
      <div className={`drawer ${selectedAlert ? 'open' : ''}`}>
        {selectedAlert && (
          <>
            <div className="drawer-header">
               <h2>Detail View</h2>
               <button className="drawer-close" onClick={() => setSelectedAlert(null)}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
               </button>
            </div>
            <div className="drawer-body" style={{ padding: '20px' }}>
              <div style={{ marginBottom: '15px' }}>
                <span className={`severity-badge ${getSeverityBadgeClass(selectedAlert.severity)}`}>
                  {selectedAlert.severity}
                </span>
                <h3 style={{ marginTop: '10px' }}>{selectedAlert.type === 'codeql' ? selectedAlert.rule : 'Dependabot Alert'}</h3>
              </div>
              
              <p style={{ color: '#666', lineHeight: '1.5' }}>{selectedAlert.description}</p>
              
              <div style={{ marginTop: '20px' }}>
                <h4 style={{ marginBottom: '8px' }}>Location</h4>
                <code style={{ background: '#f0f0f0', padding: '4px 8px', borderRadius: '4px' }}>
                  {selectedAlert.type === 'codeql' ? `${selectedAlert.location}:${selectedAlert.startLine}` : 'package.json'}
                </code>
              </div>

              {selectedAlert.type === 'codeql' && (
                <div style={{ marginTop: '20px' }}>
                  <h4 style={{ marginBottom: '8px' }}>Code Context</h4>
                  {isLoadingSnippet ? (
                    <div style={{ color: '#888', fontStyle: 'italic' }}>Loading code context...</div>
                  ) : snippetCache[selectedAlert.id] ? (
                    <pre style={{ 
                      background: '#1e1e1e', 
                      color: '#d4d4d4', 
                      padding: '15px', 
                      borderRadius: '8px', 
                      overflowX: 'auto',
                      fontSize: '13px',
                      fontFamily: 'monospace'
                    }}>
                      <code>{snippetCache[selectedAlert.id]}</code>
                    </pre>
                  ) : (
                    <div style={{ color: '#888' }}>No snippet available.</div>
                  )}
                </div>
              )}

              {selectedAlert.type === 'dependabot' && (
                <div style={{ marginTop: '20px' }}>
                  <h4 style={{ marginBottom: '8px' }}>Version Changes</h4>
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'center', background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '4px', textTransform: 'uppercase', fontWeight: 600 }}>From</div>
                      <code style={{ fontSize: '1.1rem', background: 'transparent', padding: 0 }}>{selectedAlert.versionRange}</code>
                    </div>
                    <div style={{ color: '#cbd5e1' }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '4px', textTransform: 'uppercase', fontWeight: 600 }}>To</div>
                      <code style={{ fontSize: '1.1rem', background: 'transparent', padding: 0, fontWeight: 700 }}>{selectedAlert.patchedVersion}</code>
                    </div>
                    <div style={{ marginLeft: 'auto' }}>
                      <span className={`version-badge ${getVersionUpdateType(selectedAlert.versionRange, selectedAlert.patchedVersion || "")}`}>
                        {getVersionUpdateType(selectedAlert.versionRange, selectedAlert.patchedVersion || "")} update
                      </span>
                    </div>
                  </div>
                  <div style={{ marginTop: '16px' }}>
                    <a href={`https://www.npmjs.com/package/${selectedAlert.package}`} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#3b82f6', textDecoration: 'none', fontWeight: 500 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                      View on npm
                    </a>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
