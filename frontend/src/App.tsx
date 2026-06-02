import { useEffect, useState, useCallback, useRef } from "react";
import { initializeFirebasePush, listenToMessages } from "./firebase";

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

interface ProposedFix {
  filePath: string;
  content: string;
  description: string;
  approved: boolean;
  issueRule: string;
  difficulty?: string;
  requiresHumanRevision?: boolean;
  explanation?: string;
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
  const [copilotCliPath, setCopilotCliPath] = useState(() => localStorage.getItem("settings.copilotCliPath") || "");
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

  // Copilot integration states
  const [showCopilotModal, setShowCopilotModal] = useState(false);
  const [copilotModalMode, setCopilotModalMode] = useState<'login' | 'resolving' | 'approval' | 'applying' | 'done' | 'error'>('login');
  const [resolverLogs, setResolverLogs] = useState<string[]>([]);
  const [resolverResult, setResolverResult] = useState<string | null>(null);
  const [proposedFixes, setProposedFixes] = useState<ProposedFix[]>([]);
  const [resolveTarget, setResolveTarget] = useState<'codeql' | 'dependabot'>('codeql');
  const [loginCode, setLoginCode] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [copilotToken, setCopilotToken] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const copilotLogListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    initializeFirebasePush().then(token => {
      if (token && (window as any).zero) {
        (window as any).zero.invoke("firebase.saveToken", { token }).catch(console.error);
      }
    });
    listenToMessages();
  }, []);

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
        dotnetPath: localStorage.getItem("settings.dotnetPath") || "",
        copilotCliPath: localStorage.getItem("settings.copilotCliPath") || ""
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
    localStorage.setItem("settings.copilotCliPath", copilotCliPath);
    await sendPathsToBackend();
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  };

  useEffect(() => {
    console.log("[JS] TRACE: useEffect triggered", selectedAlert?.id);
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
      } catch (e) { }

      // --- FIREBASE DYNAMIC PUSH ---
      try {
        if ((window as any).zero) {
          const totalIssues = stats.critical + stats.high + stats.medium + stats.low;
          let bodyMsg = "¡El análisis ha finalizado perfectamente! 0 vulnerabilidades.";
          if (totalIssues > 0) {
            bodyMsg = `Análisis terminado con ${totalIssues} vulnerabilidades encontradas (Críticas: ${stats.critical}, Altas: ${stats.high}).`;
          }
          if (errors.length > 0) {
            bodyMsg += " Ojo: Hubo errores en algunos escáneres.";
          }
          await (window as any).zero.invoke("firebase.sendPush", {
            title: "ReportBot - Resultados listos",
            body: bodyMsg
          });
        }
      } catch (e) {
        console.error("Failed to send Firebase Push", e);
      }


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

  // --- Copilot resolve logic ---

  const closeCopilotModal = () => {
    if (pollIntervalRef.current) {
      clearTimeout(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (copilotLogListenerRef.current) {
      copilotLogListenerRef.current();
      copilotLogListenerRef.current = null;
    }
    setShowCopilotModal(false);
    setCopilotModalMode('login');
    setResolverLogs([]);
    setResolverResult(null);
    setLoginCode('');
    setLoginUrl('');
    setIsLoggingIn(false);
  };

  const parseResponse = (raw: any): any => {
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return { output: raw }; }
    }
    if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      try { return JSON.parse(new TextDecoder().decode(raw as any)); } catch { return {}; }
    }
    if (raw && typeof raw === "object" && "buffer" in raw) {
      try { return JSON.parse(new TextDecoder().decode(new Uint8Array(raw.buffer as ArrayBuffer))); } catch { return {}; }
    }
    if (raw && typeof raw === "object" && '0' in raw && typeof raw[0] === 'number') {
      const len = Object.keys(raw).filter(k => /^\d+$/.test(k)).length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = raw[i];
      try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
    }
    return raw || {};
  };

  const handleResolveIssues = async () => {
    if (!scanStats || codeQlAlerts.length === 0) return;

    setShowCopilotModal(true);
    setResolverResult(null);
    setProposedFixes([]);
    setResolveTarget('codeql');
    setCopilotModalMode('resolving');
    setResolverLogs(['[Copilot] Preparando prompt para análisis...']);

    // Register copilot-log event listener
    if (copilotLogListenerRef.current) copilotLogListenerRef.current();
    copilotLogListenerRef.current = (window as any).zero.on("copilot-log", (detail: any) => {
      setResolverLogs(prev => [...prev, detail.message]);
    });

    const prompt = [
      '# CodeQL Vulnerabilities to Analyze:',
      ...codeQlAlerts.map((a, i) =>
        `${i + 1}. [${a.rule}] ${a.description}\n   File: ${a.fullPath || a.location}\n   Lines: ${a.startLine}-${a.endLine}`
      ),
      '',
      '---',
      '',
      'You are a security expert. For each issue listed above:',
      '1. Read the file at the specified location.',
      '2. Analyze the difficulty of fixing the issue (e.g. Low, Medium, High).',
      '3. If the issue is complex, requires architectural changes, or cannot be safely fixed, mark it as `requiresHumanRevision`.',
      '4. If the issue is easy or safe to solve, generate the full content of the file with the fix applied.',
      '',
      'CRITICAL REQUIREMENT:',
      'Do NOT try to apply changes yourself using CLI commands. I will apply them manually.',
      'You MUST output an analysis block for EVERY file you analyzed using the following custom format at the very end of your response.',
      '',
      '<<<<filePath: /absolute/path/to/file.ext>>>>',
      '<difficulty>Low/Medium/High</difficulty>',
      '<requiresHumanRevision>true or false</requiresHumanRevision>',
      '<explanation>Brief explanation of the fix or why human revision is needed.</explanation>',
      '<content>',
      'FULL MODIFIED FILE CONTENT HERE (Leave empty if requiresHumanRevision is true)',
      '</content>',
      '',
      'Do NOT use JSON. Do NOT use markdown code blocks for the file content. Just use the exact tags shown above.'
    ].join('\n');

    try {
      const resolveRaw = await (window as any).zero.invoke("copilot.resolveIssues", {
        projectPath: scanStats!.projectPath,
        prompt
      });
      const resolveResult = parseResponse(resolveRaw);

      if (resolveResult.needsAuth) {
        handleCopilotLogin();
        return;
      }

      const outputText = resolveResult.output || '';
      setResolverResult(outputText);

      const blockRegex = /<<<<filePath:\s*(.*?)\s*>>>>([\s\S]*?)(?=(?:<<<<filePath:|$))/g;
      const parsedFixes: any[] = [];
      let blockMatch;
      while ((blockMatch = blockRegex.exec(outputText)) !== null) {
        const filePath = blockMatch[1].trim();
        const blockContent = blockMatch[2];
        
        const difficultyMatch = blockContent.match(/<difficulty>\s*(.*?)\s*<\/difficulty>/i);
        const requiresHumanMatch = blockContent.match(/<requiresHumanRevision>\s*(.*?)\s*<\/requiresHumanRevision>/i);
        const explanationMatch = blockContent.match(/<explanation>\s*([\s\S]*?)\s*<\/explanation>/i);
        const contentMatch = blockContent.match(/<content>\n?([\s\S]*?)\n?<\/content>/i);
        
        parsedFixes.push({
          filePath,
          difficulty: difficultyMatch ? difficultyMatch[1].trim() : "Unknown",
          requiresHumanRevision: requiresHumanMatch ? requiresHumanMatch[1].trim().toLowerCase() === 'true' : false,
          explanation: explanationMatch ? explanationMatch[1].trim() : "",
          content: contentMatch ? contentMatch[1] : "",
        });
      }

      if (parsedFixes.length > 0) {
        setProposedFixes(parsedFixes.map((fix: any) => {
          const filePath = fix.filePath;
          
          // Intentar buscar la alerta original usando la ruta del archivo
          const matchedAlert = codeQlAlerts.find(a => 
            filePath.includes(a.location) || 
            (a.fullPath && filePath.includes(a.fullPath)) || 
            (a.fullPath && a.fullPath.includes(filePath)) ||
            filePath.endsWith(a.location.split('/').pop() || '')
          );

          return {
            filePath,
            content: fix.content,
            description: fix.explanation || (matchedAlert ? matchedAlert.description : "Code fix proposed by Copilot"),
            issueRule: matchedAlert ? matchedAlert.rule : "security-fix",
            difficulty: fix.difficulty,
            requiresHumanRevision: fix.requiresHumanRevision,
            explanation: fix.explanation,
            approved: !fix.requiresHumanRevision // Don't pre-approve if it requires human revision
          };
        }));
        setCopilotModalMode('approval');
        return;
      }

      // Si llegamos aquí, no se encontraron arreglos (puede requerir revisión humana)
      setCopilotModalMode('done');
    } catch (err: any) {
      setCopilotModalMode('error');
      setResolverResult(`Error llamando a Copilot: ${err.message || String(err)}`);
    }
  };

  const handleCopilotLogin = async () => {
    setCopilotModalMode('login');
    setIsLoggingIn(true);
    setLoginCode('');
    setLoginUrl('');

    if (copilotLogListenerRef.current) copilotLogListenerRef.current();
    copilotLogListenerRef.current = (window as any).zero.on("copilot-log", (detail: any) => {
      const msg = detail.message;
      if (msg.includes("https://github.com/login/device") && msg.includes("code")) {
        const urlMatch = msg.match(/https:\/\/github\.com\/login\/device/);
        const codeMatch = msg.match(/code\s+([A-Z0-9-]+)/i);
        if (urlMatch) setLoginUrl(urlMatch[0]);
        if (codeMatch && codeMatch[1]) setLoginCode(codeMatch[1]);
      }
    });

    try {
      const loginRaw = await (window as any).zero.invoke("copilot.login", {});
      const loginResult = parseResponse(loginRaw);

      if (loginResult.success) {
        setCopilotModalMode('done');
        setResolverResult("Autenticación completada con éxito. Ya puedes resolver incidencias.");
      } else {
        setCopilotModalMode('error');
        setResolverResult("Error en la autenticación. Revisa tu conexión o intenta de nuevo.");
      }
    } catch (err: any) {
      setCopilotModalMode('error');
      setResolverResult(`Error llamando a login: ${err.message || String(err)}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleApplyFixes = async () => {
    const toApply = proposedFixes.filter(f => f.approved);
    if (toApply.length === 0) {
      setCopilotModalMode('done');
      return;
    }

    setCopilotModalMode('applying');
    setResolverLogs(['Aplicando cambios locales...']);

    try {
      const responseRaw = await (window as any).zero.invoke("copilot.applyFixes", {
        fixes: toApply
      });
      const res = parseResponse(responseRaw);
      
      let finalLog = `Cambios aplicados:\n`;
      if (res.applied) {
        res.applied.forEach((f: string) => finalLog += `✅ ${f}\n`);
      }
      if (res.errors && res.errors.length > 0) {
        finalLog += `\nErrores:\n`;
        res.errors.forEach((e: string) => finalLog += `❌ ${e}\n`);
      }
      
      setResolverResult(finalLog);
      setCopilotModalMode('done');
    } catch (err: any) {
      setCopilotModalMode('error');
      setResolverResult(`Error aplicando cambios: ${err.message || String(err)}`);
    }
  };

  // --- Dependabot resolve logic ---

  const handleResolveDependencies = () => {
    if (dependabotAlerts.length === 0) return;

    setShowCopilotModal(true);
    setResolverResult(null);
    setProposedFixes([]);
    setResolveTarget('dependabot');

    const fixes: ProposedFix[] = dependabotAlerts.map(alert => {
      const updateType = getVersionUpdateType(alert.versionRange, alert.patchedVersion || "");
      return {
        filePath: alert.package,
        content: alert.patchedVersion || "",
        description: `Update ${alert.package} from ${alert.versionRange} to ${alert.patchedVersion}`,
        issueRule: updateType,
        difficulty: updateType === "major" ? "High" : updateType === "minor" ? "Medium" : "Low",
        requiresHumanRevision: updateType === "major",
        explanation: updateType === "major" ? "Major version update — may contain breaking changes" : undefined,
        approved: updateType !== "major",
      };
    });

    setProposedFixes(fixes);
    setCopilotModalMode('approval');
  };

  const handleApplyDependencyUpdates = async () => {
    const toApply = proposedFixes.filter(f => f.approved);
    if (toApply.length === 0) {
      setCopilotModalMode('done');
      return;
    }

    setCopilotModalMode('applying');
    setResolverLogs(['Actualizando dependencias...']);

    try {
      const responseRaw = await (window as any).zero.invoke("dependabot.updateDeps", {
        projectPath: scanStats!.projectPath,
        updates: toApply.map(f => ({
          package: f.filePath,
          version: f.content,
        }))
      });
      const res = parseResponse(responseRaw);

      let finalLog = `Dependencias actualizadas:\n`;
      if (res.applied) {
        res.applied.forEach((f: string) => finalLog += `✅ ${f}\n`);
      }
      if (res.errors && res.errors.length > 0) {
        finalLog += `\nErrores:\n`;
        res.errors.forEach((e: string) => finalLog += `❌ ${e}\n`);
      }

      setResolverResult(finalLog);
      setCopilotModalMode('done');
    } catch (err: any) {
      setCopilotModalMode('error');
      setResolverResult(`Error actualizando dependencias: ${err.message || String(err)}`);
    }
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

                  <div className="settings-field">
                    <label htmlFor="copilot-path">Copilot CLI Path</label>
                    <div className="settings-input-row">
                      <input
                        id="copilot-path"
                        type="text"
                        className="settings-input"
                        value={copilotCliPath}
                        onChange={e => setCopilotCliPath(e.target.value)}
                        placeholder="e.g. /usr/local/bin/copilot (defaults to PATH)"
                      />
                      <button className="settings-browse-btn" onClick={() => handleBrowse(setCopilotCliPath, "settings.copilotCliPath")}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                        Browse
                      </button>
                    </div>
                    <p className="settings-help">Path to the GitHub Copilot CLI binary. Falls back to system PATH if empty.</p>
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
                              const newStack = { ...detectedStack };
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
                              const newStack = { ...detectedStack };
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
                            <button className="resolver-btn" onClick={handleResolveIssues} disabled={showCopilotModal}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                              </svg>
                              {showCopilotModal ? 'Resolviendo...' : 'Resolver incidencias'}
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
                            <button className="resolver-btn" onClick={handleResolveDependencies} disabled={showCopilotModal}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                              </svg>
                              {showCopilotModal ? 'Actualizando...' : 'Actualizar dependencias'}
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
      {/* Copilot Modal */}
      {showCopilotModal && (
        <div className="copilot-modal-overlay" onClick={() => { if (copilotModalMode === 'done' || copilotModalMode === 'error') closeCopilotModal(); }}>
          <div className="copilot-modal" onClick={e => e.stopPropagation()}>
            {copilotModalMode === 'login' && (
              <div className="copilot-login-section">
                <div className="copilot-modal-icon">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path>
                    <path d="M9 18c-4.51 2-5-2-7-2"></path>
                  </svg>
                </div>
                <h2>Autenticación con GitHub</h2>
                <p className="copilot-modal-subtitle">Para usar Copilot, autentícate con tu cuenta de GitHub</p>

                {loginCode ? (
                  <>
                    <p className="copilot-modal-label">Tu código de dispositivo:</p>
                    <div className="copilot-device-code" onClick={() => { navigator.clipboard.writeText(loginCode); }}>
                      {loginCode}
                      <span className="copilot-copy-hint">Click para copiar</span>
                    </div>
                    <button
                      className="copilot-github-link"
                      onClick={async () => {
                        try {
                          await (window as any).zero.invoke("copilot.openUrl", { url: loginUrl });
                        } catch (e) {
                          console.warn('[JS] Failed to open URL via backend', e);
                        }
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <line x1="10" y1="14" x2="21" y2="3"></line>
                      </svg>
                      Abrir github.com/login/device
                    </button>
                    <div className="copilot-waiting">
                      <div className="copilot-spinner"></div>
                      <span>Esperando autenticación...</span>
                    </div>
                  </>
                ) : (
                  <div className="copilot-waiting">
                    <div className="copilot-spinner"></div>
                    <span>Conectando con GitHub...</span>
                  </div>
                )}

                <button className="copilot-cancel-btn" onClick={closeCopilotModal}>Cancelar</button>
              </div>
            )}

            {copilotModalMode === 'resolving' && (
              <div className="copilot-resolver-section">
                <div className="copilot-modal-icon resolving">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                  </svg>
                </div>
                <h2>Copilot está trabajando</h2>
                <p className="copilot-modal-subtitle">Resolviendo {codeQlAlerts.length} incidencia{codeQlAlerts.length !== 1 ? 's' : ''} de CodeQL...</p>

                <div className="terminal-mock" style={{ marginTop: '1.5rem' }}>
                  <div className="terminal-header">
                    <span className="dot dot-red"></span>
                    <span className="dot dot-yellow"></span>
                    <span className="dot dot-green"></span>
                    <span className="title">copilot — resolving</span>
                  </div>
                  <div className="terminal-body">
                    {resolverLogs.map((log, i) => (
                      <div key={i} className="terminal-line">{log}</div>
                    ))}
                    <div className="terminal-cursor">_</div>
                  </div>
                </div>

                <p className="copilot-modal-hint">Esto puede tardar varios minutos dependiendo del número de incidencias.</p>
                <button className="copilot-cancel-btn" onClick={closeCopilotModal}>Cancelar</button>
              </div>
            )}

            {copilotModalMode === 'approval' && (
              <div className="copilot-resolver-section" style={{ width: '100%', maxWidth: '800px' }}>
                <div className="copilot-modal-icon" style={{ background: '#e0e7ff', color: '#4f46e5' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                    <polyline points="10 9 9 9 8 9"></polyline>
                  </svg>
                </div>
                <h2>{resolveTarget === 'dependabot' ? 'Revisar y Aprobar Actualizaciones' : 'Revisar y Aprobar Cambios'}</h2>
                <p className="copilot-modal-subtitle">
                  {resolveTarget === 'dependabot' 
                    ? 'Dependabot sugiere las siguientes actualizaciones. Selecciona cuáles aplicar:'
                    : 'Copilot sugiere los siguientes cambios. Selecciona cuáles aplicar:'}
                </p>

                <div className="fix-approval-actions">
                  <button className="btn-secondary" onClick={() => setProposedFixes(proposedFixes.map(f => ({ ...f, approved: f.requiresHumanRevision ? f.approved : true })))}>
                    Aprobar Todos
                  </button>
                  <button className="btn-secondary" onClick={() => setProposedFixes(proposedFixes.map(f => ({ ...f, approved: false })))}>
                    Rechazar Todos
                  </button>
                </div>

                <div className="fix-approval-list">
                  {proposedFixes.map((fix, idx) => {
                    let badgeName: string;
                    let fileName: string;
                    let versionInfo: string | null = null;

                    if (resolveTarget === 'dependabot') {
                      badgeName = fix.issueRule; // "major", "minor", "patch"
                      fileName = fix.filePath;   // package name
                      // Extract version transition from description
                      const fromMatch = fix.description.match(/from\s+(\S+)\s+to\s+(\S+)/);
                      if (fromMatch) versionInfo = `${fromMatch[1]} → ${fromMatch[2]}`;
                    } else {
                      const parts = fix.filePath.split('/');
                      badgeName = parts.length > 1 ? parts[parts.length - 2] : 'root';
                      fileName = parts[parts.length - 1];
                    }

                    return (
                      <div key={idx} className={`fix-approval-item ${fix.approved ? 'approved' : ''} ${fix.requiresHumanRevision ? 'needs-revision' : ''}`} onClick={() => {
                        const newFixes = [...proposedFixes];
                        newFixes[idx].approved = !newFixes[idx].approved;
                        setProposedFixes(newFixes);
                      }}>
                        <div className="fix-checkbox">
                          <input type="checkbox" checked={fix.approved} readOnly />
                        </div>
                        <div className="fix-details">
                          <div className="fix-path">
                            <span className={`fix-folder-badge ${resolveTarget === 'dependabot' ? `version-badge ${badgeName}` : ''}`}>{badgeName}</span>
                            {fileName}
                            {fix.difficulty && (
                              <span className={`fix-difficulty-badge difficulty-${fix.difficulty.toLowerCase()}`}>
                                {fix.difficulty}
                              </span>
                            )}
                            {versionInfo && (
                              <span className="fix-version-transition">{versionInfo}</span>
                            )}
                            {fix.requiresHumanRevision && (
                              <span className="fix-revision-badge">Revisión Humana Requerida</span>
                            )}
                          </div>
                          <div className="fix-desc">
                            <span className="fix-rule">[{fix.issueRule}]</span> {fix.description}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '2rem' }}>
                  <button className="copilot-done-btn" onClick={resolveTarget === 'dependabot' ? handleApplyDependencyUpdates : handleApplyFixes} disabled={!proposedFixes.some(f => f.approved)}>
                    Aplicar seleccionados ({proposedFixes.filter(f => f.approved).length})
                  </button>
                  <button className="copilot-cancel-btn" onClick={closeCopilotModal}>Cancelar</button>
                </div>
              </div>
            )}

            {copilotModalMode === 'applying' && (
              <div className="copilot-resolver-section">
                <div className="copilot-modal-icon resolving">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                  </svg>
                </div>
                <h2>Aplicando Cambios Locales</h2>
                <p className="copilot-modal-subtitle">Modificando los archivos y creando backups...</p>

                <div className="terminal-mock" style={{ marginTop: '1.5rem' }}>
                  <div className="terminal-header">
                    <span className="dot dot-red"></span>
                    <span className="dot dot-yellow"></span>
                    <span className="dot dot-green"></span>
                    <span className="title">copilot — applying</span>
                  </div>
                  <div className="terminal-body">
                    {resolverLogs.map((log, i) => (
                      <div key={i} className="terminal-line">{log}</div>
                    ))}
                    <div className="terminal-cursor">_</div>
                  </div>
                </div>
              </div>
            )}

            {copilotModalMode === 'done' && (
              <div className="copilot-resolver-section">
                {proposedFixes.length > 0 ? (
                  <>
                    <div className="copilot-modal-icon success">
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5"></path>
                      </svg>
                    </div>
                    <h2>Resolución completada</h2>
                    <p>Copilot ha analizado y modificado los archivos del proyecto.</p>
                  </>
                ) : (
                  <>
                    <div className="copilot-modal-icon resolving" style={{ background: '#fef3c7', color: '#d97706' }}>
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                      </svg>
                    </div>
                    <h2>Revisión Humana Requerida</h2>
                    <p>Copilot ha analizado el proyecto pero no ha podido generar correcciones automáticas. Es probable que las vulnerabilidades sean complejas y requieran revisión humana.</p>
                  </>
                )}
                
                <div className="terminal-mock" style={{ marginTop: '1.5rem' }}>
                  <div className="terminal-header">
                    <span className="dot dot-red"></span>
                    <span className="dot dot-yellow"></span>
                    <span className="dot dot-green"></span>
                    <span className="title">copilot — output</span>
                  </div>
                  <div className="terminal-body" style={{ maxHeight: '300px' }}>
                    {(resolverResult ?? '').split('\n').map((line, i) => (
                      <div key={i} className="terminal-line">{line}</div>
                    ))}
                  </div>
                </div>
                
                {proposedFixes.length > 0 && (
                  <p className="copilot-instruction-text">
                    Revisa los cambios con git diff. Se recomienda volver a escanear el proyecto para verificar las correcciones.
                  </p>
                )}
                
                <button className="copilot-done-btn" onClick={closeCopilotModal}>
                  Cerrar
                </button>
              </div>
            )}

            {copilotModalMode === 'error' && (
              <div className="copilot-resolver-section">
                <div className="copilot-modal-icon error">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                  </svg>
                </div>
                <h2>Error</h2>
                <p className="copilot-modal-subtitle">Se produjo un error durante la resolución.</p>

                {resolverResult && (
                  <div className="terminal-mock" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                    <div className="terminal-header">
                      <span className="dot dot-red"></span>
                      <span className="dot dot-yellow"></span>
                      <span className="dot dot-green"></span>
                      <span className="title">error</span>
                    </div>
                    <div className="terminal-body">
                      <div className="terminal-line" style={{ color: '#ef4444', whiteSpace: 'pre-wrap' }}>{resolverResult}</div>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                  {resolverResult?.includes('no está autenticado') && (
                    <button className="copilot-done-btn" onClick={handleCopilotLogin}>Iniciar sesión en Copilot</button>
                  )}
                  <button className="copilot-cancel-btn" onClick={closeCopilotModal}>Cerrar</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
