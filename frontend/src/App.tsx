import { useEffect, useState, useCallback } from "react";

// --- Types ---
interface CodeQlAlert {
  type: "codeql";
  id: string;
  rule: string;
  description: string;
  severity: "error" | "warning" | "note" | "none";
  location: string;
  helpText?: string;
  snippet?: string;
}

interface DependabotAlert {
  type: "dependabot";
  id: string;
  package: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  versionRange: string;
  patchedVersion?: string;
  isDirect?: boolean;
  urls?: string[];
}

interface ToolStatus {
  npm: boolean;
  codeql: boolean;
  codeqlPath: string;
  npmVersion: string;
  codeqlVersion: string;
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
  const [codeqlPathInput, setCodeqlPathInput] = useState("");

  // States for parsed data
  const [codeQlAlerts, setCodeQlAlerts] = useState<CodeQlAlert[]>([]);
  const [dependabotAlerts, setDependabotAlerts] = useState<DependabotAlert[]>([]);
  
  // State for detail view
  const [selectedAlert, setSelectedAlert] = useState<CodeQlAlert | DependabotAlert | null>(null);

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

  useEffect(() => {
    const hasZero = !!(window as any).zero;
    setBridge(hasZero ? "available" : "not enabled");
    if (hasZero) checkTools();
  }, [checkTools]);

  const handleLocalScan = async () => {
    try {
      // 1. Select folder
      const result = await (window as any).zero.invoke("zero-native.dialog.openFile", {
        title: "Select Project Folder",
        allowDirectories: true,
      });

      if (!result || result.length === 0) return;
      const projectPath = result[0];

      // 2. Start scan
      setIsScanning(true);
      setScanLogs([`[Scan] Initializing scan for: ${projectPath}`]);
      setScanProgress(5);

      // Listen for progress logs
      const removeListener = (window as any).zero.on("codeql-log", (detail: any) => {
        setScanLogs(prev => [...prev, detail.message]);
      });

      try {
        const sarifRaw = await (window as any).zero.invoke("codeql.runScan", { path: projectPath });

        const sarif = JSON.parse(sarifRaw);
        
        // Parse SARIF alerts
        const alerts: CodeQlAlert[] = [];
        sarif.runs?.forEach((run: any) => {
          run.results?.forEach((res: any, idx: number) => {
            alerts.push({
              type: "codeql",
              id: `codeql-${idx}`,
              rule: res.ruleId,
              description: res.message.text,
              severity: res.level === "error" ? "error" : "warning",
              location: res.locations?.[0]?.physicalLocation?.artifactLocation?.uri || "unknown",
            });
          });
        });

        setCodeQlAlerts(alerts);
        setIsLoaded(true);
      } catch (err: any) {
        setScanLogs(prev => [...prev, `[Error] ${err.message || err}`]);
      } finally {
        removeListener();
        setIsScanning(false);
        setScanProgress(0);
      }
    } catch (err: any) {
      console.error("Scan failed", err);
    }
  };


  const resetState = () => {
    setIsLoaded(false);
    setCodeQlAlerts([]);
    setDependabotAlerts([]);
  };

  const getSeverityBadgeClass = (severity: string) => {
    if (["error", "critical"].includes(severity)) return "critical";
    if (["warning", "high"].includes(severity)) return "high";
    if (["note", "medium"].includes(severity)) return "medium";
    return "low";
  };

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
                <h2>CodeQL Configuration</h2>
              </div>
              <div className="settings-field">
                <label htmlFor="codeql-path">CodeQL CLI Path</label>
                <div className="settings-input-row">
                  <input
                    id="codeql-path"
                    type="text"
                    className="settings-input"
                    value={codeqlPathInput}
                    onChange={e => setCodeqlPathInput(e.target.value)}
                    placeholder="e.g. /home/user/.local/share/codeql/codeql"
                  />
                </div>
                <p className="settings-help">Custom paths are currently disabled in this demo.</p>
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
            isScanning ? (
              <section className="scanning-section">
                <div className="scanning-header">
                  <h2>Active Security Scan</h2>
                  <p>Running security analysis...</p>
                </div>
                
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `${scanProgress}%` }}></div>
                </div>
                
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
                  codeQlAlerts.length > 0 ? (
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
                  )
                ) : (
                  <div className="empty-state text-muted" style={{ padding: '60px' }}>
                    <p>Dependency analysis not implemented yet.</p>
                  </div>
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
          <div className="drawer-header">
             <h2>Detail View</h2>
             <button className="drawer-close" onClick={() => setSelectedAlert(null)}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
             </button>
          </div>
        )}
      </div>
    </div>
  );
}
