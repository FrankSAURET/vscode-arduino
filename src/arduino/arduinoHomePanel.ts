// Arduino Home Panel — unified webview with navigation rail and content iframe
import * as child_process from "child_process";
import * as vscode from "vscode";
import ArduinoContext from "../arduinoContext";
import { DeviceContext } from "../deviceContext";
import { getExtensionPackageJSON, isProductionMode } from "../extensionInfo";
import { getDownloadedCliExecutable } from "./cliDownloader";
import { getUserPortNames, resolvePortName } from "./portIdentification";
import { canStoreArduinoThemeLocally } from "./themeManager";

/**
 * Manages a single "VsCode Arduino" editor panel with a left icon rail
 * and an iframe on the right that loads existing React-based views
 * (Board Manager, Library Manager, Examples, Board Config) from the local web server.
 */
export class ArduinoHomePanel {
    public static currentPanel: ArduinoHomePanel | undefined;
    private static readonly viewType = "arduinoHome";

    private static getPreferredViewColumn(): vscode.ViewColumn {
        return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    }

    /**
     * Elimine le panneau encore ouvert a la desactivation de l'extension.
     * Son minuteur de scrutation (setInterval) maintiendrait sinon la boucle
     * d'evenements de l'hote active apres l'arret demande par VS Code.
     */
    public static disposeCurrent() {
        if (ArduinoHomePanel.currentPanel) {
            ArduinoHomePanel.currentPanel.dispose();
        }
    }

    /**
     * Redemande la liste des ports au panneau ouvert, s'il y en a un.
     * Appele apres un renommage de port pour que le nouveau libelle apparaisse
     * sans attendre la prochaine scrutation.
     */
    public static refreshConnectedBoards() {
        if (ArduinoHomePanel.currentPanel) {
            ArduinoHomePanel.currentPanel._sendConnectedBoards();
        }
    }

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _serverBaseUrl: string;
    private _authToken: string;
    private _disposables: vscode.Disposable[] = [];
    private _boardPollTimer: NodeJS.Timer | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri,
        serverBaseUrl: string,
        authToken: string,
        initialView?: string,
    ) {
        const viewColumn = ArduinoHomePanel.getPreferredViewColumn();

        if (ArduinoHomePanel.currentPanel) {
            ArduinoHomePanel.currentPanel._panel.reveal(viewColumn, false);
            if (initialView) {
                ArduinoHomePanel.currentPanel.navigateTo(initialView);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ArduinoHomePanel.viewType,
            "VsCode Arduino",
            { viewColumn, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "images")],
            },
        );

        ArduinoHomePanel.currentPanel = new ArduinoHomePanel(panel, extensionUri, serverBaseUrl, authToken, initialView);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        serverBaseUrl: string,
        authToken: string,
        initialView?: string,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._serverBaseUrl = serverBaseUrl;
        this._authToken = authToken;

        this._panel.webview.html = this._getHtml(initialView);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === "executeCommand" && message.id) {
                    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
                    if (message.id === "workbench.action.openSettings" && message.args) {
                        await vscode.commands.executeCommand(message.id, message.args);
                    } else {
                        await vscode.commands.executeCommand(message.id);
                    }
                } else if (message.command === "getSettings") {
                    this._sendSettings();
                } else if (message.command === "updateSetting") {
                    await this._updateSetting(message.scope, message.key, message.value);
                } else if (message.command === "getConnectedBoards") {
                    await this._sendConnectedBoards();
                } else if (message.command === "selectBoard") {
                    this._selectBoard(message.port, message.fqbn);
                }
            },
            undefined,
            this._disposables,
        );

        // Sync settings when changed externally
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration("arduino")) {
                    this._sendSettings();
                }
            }),
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Auto-refresh board list every 5 seconds for USB plug/unplug detection
        this._boardPollTimer = setInterval(() => {
            this._sendConnectedBoards();
        }, 5000);
    }

    public navigateTo(view: string) {
        this._panel.webview.postMessage({ command: "navigate", view });
    }

    public dispose() {
        ArduinoHomePanel.currentPanel = undefined;
        if (this._boardPollTimer) {
            clearInterval(this._boardPollTimer);
            this._boardPollTimer = undefined;
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private _iconUri(name: string): vscode.Uri {
        return this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "images", name),
        );
    }

    private _sendSettings() {
        const config = vscode.workspace.getConfiguration("arduino");
        const vscodeSettings: Record<string, any> = {};
        const vscodeKeys = [
            "path", "commandPath", "arduinoCliConfigFile", "customLibraryPath",
            "clearOutputOnBuild", "logLevel", "additionalUrls",
            "disableIntelliSenseAutoGen", "analyzeOnOpen", "analyzeOnSettingChange",
            "theme", "enableUSBDetection", "teleplotOpenMode",
            "openPDEFiletype", "skipHeaderProvider", "ignoreBoards",
        ];
        for (const key of vscodeKeys) {
            vscodeSettings[key] = config.get(key);
        }

        const projectSettings: Record<string, any> = {};
        try {
            const dc = DeviceContext.getInstance();
            projectSettings.sketch = dc.sketch || "";
            projectSettings.board = dc.board || "";
            projectSettings.port = dc.port || "";
            projectSettings.configuration = dc.configuration || "";
            projectSettings.output = dc.output || "";
            projectSettings.intelliSenseGen = dc.intelliSenseGen || "global";
            projectSettings.programmer = dc.programmer || "";
            projectSettings.prebuild = dc.prebuild || "";
            projectSettings.postbuild = dc.postbuild || "";
        } catch {
            // DeviceContext may not be initialized yet
        }

        this._panel.webview.postMessage({
            command: "loadSettings",
            vscode: vscodeSettings,
            project: projectSettings,
        });
    }

    private async _updateSetting(scope: string, key: string, value: any) {
        if (scope === "vscode") {
            const config = vscode.workspace.getConfiguration("arduino");
            if (key === "theme") {
                if (!canStoreArduinoThemeLocally(!!vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders?.length || 0)) {
                    void vscode.window.showWarningMessage(
                        vscode.l10n.t("Open a workspace folder to store the Arduino theme locally."),
                    );
                    return;
                }

                await config.update(key, value, vscode.ConfigurationTarget.Workspace);
                return;
            }

            await config.update(key, value, vscode.ConfigurationTarget.Global);
        } else if (scope === "project") {
            try {
                const dc = DeviceContext.getInstance();
                if (key in dc && typeof (dc as any)[key] !== "function") {
                    (dc as any)[key] = value;
                }
            } catch {
                // DeviceContext may not be available
            }
        }
    }

    private async _sendConnectedBoards() {
        const boards: Array<{name: string; nameSource: string; port: string; fqbn: string}> = [];
        let selectedPort = "";
        try {
            const dc = DeviceContext.getInstance();
            selectedPort = dc.port || "";
        } catch {
            // DeviceContext may not be initialized
        }

        try {
            // Resolve CLI path: 1) ArduinoApp settings, 2) downloaded CLI, 3) PATH fallback
            let commandPath = "";
            try {
                commandPath = ArduinoContext.arduinoApp.settings.commandPath;
            } catch {
                // ArduinoApp may not be initialized yet
            }
            if (!commandPath) {
                const extPath = this._extensionUri.fsPath;
                commandPath = getDownloadedCliExecutable(extPath) || "";
            }
            if (!commandPath) {
                commandPath = process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli";
            }

            const result = await new Promise<string>((resolve, reject) => {
                child_process.execFile(commandPath, ["board", "list", "--format", "json"], {
                    timeout: 10000,
                }, (err, stdout) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(stdout);
                    }
                });
            });

            const parsed = JSON.parse(result);
            // arduino-cli board list --format json returns an array of detected_ports
            const ports = Array.isArray(parsed) ? parsed : (parsed.detected_ports || []);
            // Noms attribues manuellement : lus une fois pour toute la liste.
            const userNames = getUserPortNames();
            for (const entry of ports) {
                const port = entry.port || {};
                const portAddress = port.address || port.label || "";
                const portProtocol = port.protocol || "";
                // Only show serial ports
                if (portProtocol && portProtocol !== "serial") {
                    continue;
                }
                const properties = port.properties || {};
                const matchingBoards = entry.matching_boards || [];
                if (matchingBoards.length > 0) {
                    for (const mb of matchingBoards) {
                        const resolved = resolvePortName(portAddress, properties, mb.name, userNames);
                        boards.push({
                            name: resolved.label,
                            nameSource: resolved.source,
                            port: portAddress,
                            fqbn: mb.fqbn || "",
                        });
                    }
                } else {
                    // Aucune carte reconnue : on descend l'echelle des replis
                    // (product, manufacturer, table VID/PID, port sans USB).
                    const resolved = resolvePortName(portAddress, properties, "", userNames);
                    boards.push({
                        name: resolved.label,
                        nameSource: resolved.source,
                        port: portAddress,
                        fqbn: "",
                    });
                }
            }
        } catch (e) {
            // tslint:disable-next-line:no-console
            console.error("[ArduinoHomePanel] board list error:", e);
        }

        this._panel.webview.postMessage({
            command: "loadBoards",
            boards,
            selectedPort,
        });
    }

    private _selectBoard(port: string, fqbn: string) {
        try {
            const dc = DeviceContext.getInstance();
            if (port) {
                dc.port = port;
            }
            if (fqbn) {
                dc.board = fqbn;
            }
        } catch {
            // DeviceContext may not be available
        }
    }

    /**
     * Numero de version a afficher : la version publique du manifeste,
     * completee du numero interne (buildNumber) quand l'extension ne tourne
     * pas en production (developpement ou tests).
     */
    private static _getDisplayedVersion(): string {
        const packageJSON = getExtensionPackageJSON();
        const version = <string>packageJSON.version || "";
        const buildNumber = <string>packageJSON.buildNumber || "";
        if (!isProductionMode() && buildNumber) {
            return buildNumber;
        }
        return version;
    }

    private _getHtml(initialView?: string): string {
        const webview = this._panel.webview;
        const csp = webview.cspSource;

        // Icon URIs
        const logoUri = this._iconUri("LogoVsCodeArduinoIDE.svg");
        const boardManagerIcon = this._iconUri("boardManager.svg");
        const libManagerIcon = this._iconUri("libManager.svg");
        const examplesIcon = this._iconUri("examples.svg");
        const openIcon = this._iconUri("open.svg");
        const selectBoardIcon = this._iconUri("selectBoard.svg");
        const newProjectIcon = this._iconUri("newProject.svg");
        const parametersIcon = this._iconUri("parameters.svg");

        const defaultView = initialView || "";

        // Numero affiche en bas de la page d'accueil.
        // Hors production, on montre le numero interne a 4 segments (buildNumber).
        const displayedVersion = ArduinoHomePanel._getDisplayedVersion();

        // Localized strings (English defaults, translated via vscode.l10n.t)
        const t = {
            newProject: vscode.l10n.t("New Project"),
            boardConfig: vscode.l10n.t("Board Configuration"),
            verify: vscode.l10n.t("Verify"),
            upload: vscode.l10n.t("Upload"),
            boardManager: vscode.l10n.t("Board Manager"),
            libraryManager: vscode.l10n.t("Library Manager"),
            examples: vscode.l10n.t("Examples"),
            settings: vscode.l10n.t("Settings"),
            board: vscode.l10n.t("Board"),
            selectBoardPlaceholder: vscode.l10n.t("Select a board and port…"),
            noBoardDetected: vscode.l10n.t("No board detected"),
            refresh: vscode.l10n.t("Refresh"),
            welcomeTitle: vscode.l10n.t("VsCode Arduino"),
            welcomeText: vscode.l10n.t("Welcome! To get started, create a new project or open a folder containing an Arduino sketch (.ino)."),
            openExistingProject: vscode.l10n.t("Open Existing Project"),
            version: vscode.l10n.t("Version {0}", displayedVersion),
            welcomeHint: vscode.l10n.t("Use the toolbar on the left to navigate between views, or {0} → \"Arduino\" to access all commands.", "Ctrl+Shift+P"),
            settingsTitle: vscode.l10n.t("Settings"),
            openInVsCodeSettings: vscode.l10n.t("Open in VS Code Settings"),
            // Settings groups
            groupGeneralPaths: vscode.l10n.t("General / Paths"),
            groupBuildUpload: vscode.l10n.t("Build & Upload"),
            groupIntelliSense: vscode.l10n.t("IntelliSense"),
            groupInterface: vscode.l10n.t("Interface"),
            groupAdvanced: vscode.l10n.t("Advanced"),
            groupProject: vscode.l10n.t("Project (.vscode/arduino.yaml)"),
            // Settings labels
            sArduinoCliPath: vscode.l10n.t("Arduino CLI Path"),
            sArduinoCliPathDesc: vscode.l10n.t("Directory containing the Arduino CLI executable"),
            sAutoDetected: vscode.l10n.t("(auto-detected)"),
            sCliExecutableName: vscode.l10n.t("CLI Executable Name"),
            sCliExecutableNameDesc: vscode.l10n.t("Name or relative path of the arduino-cli binary"),
            sCliConfigFile: vscode.l10n.t("CLI Config File"),
            sCliConfigFileDesc: vscode.l10n.t("Path to a custom arduino-cli.yaml file"),
            sCustomLibraryPath: vscode.l10n.t("Custom Library Path"),
            sCustomLibraryPathDesc: vscode.l10n.t("Additional directory for Arduino libraries"),
            sClearOutputOnBuild: vscode.l10n.t("Clear Output Before Build"),
            sClearOutputOnBuildDesc: vscode.l10n.t("Clears output logs before each verify/upload"),
            sLogLevel: vscode.l10n.t("Log Level"),
            sLogLevelDesc: vscode.l10n.t("Arduino output verbosity"),
            sAdditionalUrls: vscode.l10n.t("Additional Package URLs"),
            sAdditionalUrlsDesc: vscode.l10n.t("URLs for third-party boards (one per line)"),
            sDisableAutoConfig: vscode.l10n.t("Disable Automatic Configuration"),
            sDisableAutoConfigDesc: vscode.l10n.t("Do not automatically generate c_cpp_properties.json"),
            sAnalyzeOnOpen: vscode.l10n.t("Analyze on Open"),
            sAnalyzeOnOpenDesc: vscode.l10n.t("Run IntelliSense analysis when the project is opened"),
            sAnalyzeOnSettingChange: vscode.l10n.t("Analyze on Setting Change"),
            sAnalyzeOnSettingChangeDesc: vscode.l10n.t("Re-run analysis when project settings change"),
            sArduinoTheme: vscode.l10n.t("Arduino Theme"),
            sArduinoThemeDesc: vscode.l10n.t("Theme to apply for Arduino views"),
            sUsbDetection: vscode.l10n.t("USB Detection"),
            sUsbDetectionDesc: vscode.l10n.t("Automatically detect boards plugged via USB"),
            sTeleplotOpenMode: vscode.l10n.t("Teleplot Open Mode"),
            sTeleplotOpenModeDesc: vscode.l10n.t("Choose how Teleplot opens from the serial tracer action"),
            sTeleplotNewTab: vscode.l10n.t("New tab"),
            sTeleplotNewPanel: vscode.l10n.t("New panel"),
            sTeleplotSplitRight: vscode.l10n.t("Split right"),
            sOpenPde: vscode.l10n.t("Open PDE Files"),
            sOpenPdeDesc: vscode.l10n.t("Allow opening legacy .pde sketches"),
            sDisableHeaderProvider: vscode.l10n.t("Disable Header Provider"),
            sDisableHeaderProviderDesc: vscode.l10n.t("Do not offer #include auto-completion"),
            sIgnoreBoards: vscode.l10n.t("Ignored Boards"),
            sIgnoreBoardsDesc: vscode.l10n.t("List of hidden boards (one per line)"),
            // Project settings
            sSketch: vscode.l10n.t("Sketch"),
            sSketchDesc: vscode.l10n.t("Main sketch file"),
            sBoardLabel: vscode.l10n.t("Board"),
            sBoardDesc: vscode.l10n.t("Arduino board type (e.g. arduino:avr:uno)"),
            sPort: vscode.l10n.t("Port"),
            sPortDesc: vscode.l10n.t("Serial port (e.g. COM3, /dev/ttyUSB0)"),
            sConfiguration: vscode.l10n.t("Configuration"),
            sConfigurationDesc: vscode.l10n.t("Board options (e.g. cpu=atmega328p)"),
            sOutputFolder: vscode.l10n.t("Output Folder"),
            sOutputFolderDesc: vscode.l10n.t("Directory for intermediate build files"),
            sIntelliSenseProject: vscode.l10n.t("IntelliSense (project)"),
            sIntelliSenseProjectDesc: vscode.l10n.t("Local override for IntelliSense generation"),
            sProgrammer: vscode.l10n.t("Programmer"),
            sProgrammerDesc: vscode.l10n.t("Selected programmer for upload"),
            sPreBuild: vscode.l10n.t("Pre-build Command"),
            sPreBuildDesc: vscode.l10n.t("Command executed before each build"),
            sPostBuild: vscode.l10n.t("Post-build Command"),
            sPostBuildDesc: vscode.l10n.t("Command executed after each build"),
            serialMonitor: vscode.l10n.t("Serial Monitor"),
            serialTracer: vscode.l10n.t("Serial Tracer"),
        };

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${csp} data:;
                   style-src ${csp} 'unsafe-inline';
                   script-src 'unsafe-inline';
                   frame-src http://localhost:*;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root { color-scheme: light dark; }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        html, body { height: 100%; overflow: hidden; }

        body {
            display: flex;
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
        }

        /* ───── Navigation Rail ───── */
        .rail {
            width: 52px;
            min-width: 52px;
            display: flex;
            flex-direction: column;
            align-items: center;
            background: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-panel-border);
            padding-top: 6px;
            gap: 2px;
            overflow-y: auto;
        }

        .rail-logo {
            width: 36px;
            height: 36px;
            margin-bottom: 6px;
            opacity: 0.85;
        }

        .rail-sep {
            width: 40px;
            height: 2px;
            background: var(--vscode-panel-border);
            margin: 4px 0;
        }

        .rail-btn {
            position: relative;
            width: 44px;
            height: 44px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            border-radius: 8px;
            background: transparent;
            cursor: pointer;
            transition: background 120ms ease;
        }
        .rail-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .rail-btn.active {
            background: color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
        }
        .rail-btn.active::before {
            content: '';
            position: absolute;
            left: 0;
            top: 6px;
            bottom: 6px;
            width: 3px;
            border-radius: 0 3px 3px 0;
            background: var(--vscode-button-background);
        }
        .rail-btn img {
            width: 32px;
            height: 32px;
            opacity: 0.8;
        }
        .rail-btn:hover img,
        .rail-btn.active img {
            opacity: 1;
        }

        /* ───── Content Area ───── */
        .content-view iframe {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            border: none;
        }

        /* ───── Welcome Screen ───── */
        .welcome {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            height: 100%;
            padding: 40px 32px;
            text-align: center;
            gap: 20px;
            overflow-y: auto;
        }
        .welcome-logo {
            width: 300px;
            opacity: 0.7;
            margin-bottom: 4px;
            margin-top: 10px;
        }
        .welcome h2 {
            font-size: 20px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin: 0;
        }
        .welcome p {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            max-width: 360px;
            line-height: 1.6;
            margin: 0;
        }
        .welcome-actions {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 8px;
            width: 100%;
            max-width: 260px;
        }
        .welcome-btn {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 16px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #cccccc);
            font-size: 13px;
            font-family: var(--vscode-font-family);
            cursor: pointer;
            transition: background 120ms ease;
            text-align: left;
        }
        .welcome-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .welcome-btn.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .welcome-btn.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .welcome-btn img {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
        }
        .welcome-hint {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
            max-width: 320px;
            line-height: 1.5;
            margin-top: 8px;
        }
        .welcome-version {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.55;
            margin-top: 24px;
        }
        .welcome-kbd {
            display: inline-block;
            padding: 1px 5px;
            border-radius: 3px;
            background: var(--vscode-keybindingLabel-background, #333);
            border: 1px solid var(--vscode-keybindingLabel-border, #555);
            color: var(--vscode-keybindingLabel-foreground, #ccc);
            font-size: 11px;
            font-family: var(--vscode-editor-font-family, monospace);
        }

        /* ───── Settings Panel ───── */
        .settings-panel {
            height: 100%;
            overflow-y: auto;
            padding: 24px 32px 40px;
        }
        .settings-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .settings-header h2 {
            font-size: 18px;
            font-weight: 600;
            margin: 0;
        }
        .settings-header-btn {
            padding: 4px 12px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
            font-size: 12px;
            font-family: var(--vscode-font-family);
            cursor: pointer;
        }
        .settings-header-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .settings-group {
            margin-bottom: 24px;
        }
        .settings-group h3 {
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .settings-item {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 8px 0;
            min-height: 32px;
        }
        .settings-item-info {
            flex: 1;
            min-width: 0;
        }
        .settings-item-label {
            font-size: 13px;
            font-weight: 500;
            color: var(--vscode-foreground);
            margin-bottom: 2px;
        }
        .settings-item-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.4;
        }
        .settings-item-key {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .settings-item-control {
            flex-shrink: 0;
            display: flex;
            align-items: center;
        }
        .settings-input {
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #ccc);
            font-size: 13px;
            font-family: var(--vscode-font-family);
            width: 260px;
            outline: none;
        }
        .settings-input:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .settings-input.narrow {
            width: 120px;
        }
        .settings-select {
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-dropdown-background, #3c3c3c);
            color: var(--vscode-dropdown-foreground, #ccc);
            font-size: 13px;
            font-family: var(--vscode-font-family);
            outline: none;
            min-width: 160px;
        }
        .settings-select:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .settings-checkbox {
            width: 18px;
            height: 18px;
            accent-color: var(--vscode-button-background, #007acc);
            cursor: pointer;
            margin-top: 2px;
        }
        .settings-textarea {
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #ccc);
            font-size: 12px;
            font-family: var(--vscode-editor-font-family, monospace);
            width: 320px;
            min-height: 60px;
            resize: vertical;
            outline: none;
        }
        .settings-textarea:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .settings-saved {
            font-size: 11px;
            color: var(--vscode-testing-iconPassed, #73c991);
            opacity: 0;
            transition: opacity 200ms;
            margin-left: 8px;
        }
        .settings-saved.show {
            opacity: 1;
        }

        /* ───── Board Selector Zone ───── */
        .board-selector {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding: 8px 12px;
            background: var(--vscode-sideBar-background);
            display: flex;
            align-items: center;
            gap: 10px;
            min-height: 40px;
            flex-shrink: 0;
        }
        .board-selector-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .board-selector select {
            flex: 1;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-dropdown-background, #3c3c3c);
            color: var(--vscode-dropdown-foreground, #ccc);
            font-size: 13px;
            font-family: var(--vscode-font-family);
            outline: none;
            min-width: 200px;
        }
        .board-selector select:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .board-selector-refresh {
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 16px;
            flex-shrink: 0;
            transition: background 120ms;
        }
        .board-selector-refresh:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .board-selector-refresh.spinning {
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        /* Content must be column to stack board-selector + views */
        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            position: relative;
        }
        .content-view {
            flex: 1;
            position: relative;
        }

        /* ───── Rail spacer ───── */
        .rail-spacer {
            flex: 1;
        }
    </style>
</head>
<body>
    <nav class="rail">
        <img class="rail-logo" src="${logoUri}" alt="Arduino" />

        <div class="rail-sep"></div>

        <button class="rail-btn" data-cmd="arduino.initialize" title="${t.newProject}">
            <img src="${newProjectIcon}" alt="" />
        </button>
        <button class="rail-btn" data-cmd="arduino.openProjectFolder" title="${t.openExistingProject}">
            <img src="${openIcon}" alt="" />
        </button>

        <div class="rail-sep"></div>

        <button class="rail-btn" data-view="boardConfig" title="${t.boardConfig}">
            <img src="${selectBoardIcon}" alt="" />
        </button>

        <div class="rail-sep"></div>

        <button class="rail-btn" data-view="boardmanager" title="${t.boardManager}">
            <img src="${boardManagerIcon}" alt="" />
        </button>
        <button class="rail-btn" data-view="librarymanager" title="${t.libraryManager}">
            <img src="${libManagerIcon}" alt="" />
        </button>
        <button class="rail-btn" data-view="examples" title="${t.examples}">
            <img src="${examplesIcon}" alt="" />
        </button>

        <div class="rail-spacer"></div>

        <div class="rail-sep"></div>
        <button class="rail-btn" id="settingsBtn" title="${t.settings}">
            <img src="${parametersIcon}" alt="" />
        </button>
        <div style="height:6px;"></div>
    </nav>

    <main class="content">
        <div class="board-selector" id="boardSelector">
            <select id="boardSelect">
                <option value="" disabled selected>${t.selectBoardPlaceholder}</option>
            </select>
            <button class="board-selector-refresh" id="boardRefresh" title="${t.refresh}">⟳</button>
        </div>
        <div class="content-view">
        <div class="welcome" id="welcome">
            <img class="welcome-logo" src="${logoUri}" alt="Arduino" />
            <h2>${t.welcomeTitle}</h2>
            <p>${t.welcomeText}</p>
            <div class="welcome-actions">
                <button class="welcome-btn primary" data-wcmd="arduino.initialize">
                    <img src="${newProjectIcon}" alt="" /> ${t.newProject}
                </button>
                <button class="welcome-btn" data-wcmd="arduino.openProjectFolder">
                    <img src="${openIcon}" alt="" /> ${t.openExistingProject}
                </button>
            </div>
            <p class="welcome-hint">${t.welcomeHint}</p>
            <p class="welcome-version">${t.version}</p>
        </div>
        <iframe id="frame" style="display:none;"></iframe>

        </div>
        <div class="settings-panel" id="settings" style="display:none;">
            <div class="settings-header">
                <h2>${t.settingsTitle}</h2>
                <button class="settings-header-btn" id="openNativeSettings">${t.openInVsCodeSettings}</button>
            </div>

            <!-- General / Paths -->
            <div class="settings-group">
                <h3>${t.groupGeneralPaths}</h3>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sArduinoCliPath}</div>
                        <div class="settings-item-desc">${t.sArduinoCliPathDesc}</div>
                        <div class="settings-item-key">arduino.path</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="vscode" data-key="path" placeholder="${t.sAutoDetected}" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sCliExecutableName}</div>
                        <div class="settings-item-desc">${t.sCliExecutableNameDesc}</div>
                        <div class="settings-item-key">arduino.commandPath</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="vscode" data-key="commandPath" placeholder="arduino-cli" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sCliConfigFile}</div>
                        <div class="settings-item-desc">${t.sCliConfigFileDesc}</div>
                        <div class="settings-item-key">arduino.arduinoCliConfigFile</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="vscode" data-key="arduinoCliConfigFile" placeholder="" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sCustomLibraryPath}</div>
                        <div class="settings-item-desc">${t.sCustomLibraryPathDesc}</div>
                        <div class="settings-item-key">arduino.customLibraryPath</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="vscode" data-key="customLibraryPath" placeholder="" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
            </div>

            <!-- Build & Upload -->
            <div class="settings-group">
                <h3>${t.groupBuildUpload}</h3>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sClearOutputOnBuild}</div>
                        <div class="settings-item-desc">${t.sClearOutputOnBuildDesc}</div>
                        <div class="settings-item-key">arduino.clearOutputOnBuild</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="clearOutputOnBuild" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sLogLevel}</div>
                        <div class="settings-item-desc">${t.sLogLevelDesc}</div>
                        <div class="settings-item-key">arduino.logLevel</div>
                    </div>
                    <div class="settings-item-control">
                        <select class="settings-select" data-scope="vscode" data-key="logLevel">
                            <option value="info">info</option>
                            <option value="verbose">verbose</option>
                        </select>
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sAdditionalUrls}</div>
                        <div class="settings-item-desc">${t.sAdditionalUrlsDesc}</div>
                        <div class="settings-item-key">arduino.additionalUrls</div>
                    </div>
                    <div class="settings-item-control">
                        <textarea class="settings-textarea" data-scope="vscode" data-key="additionalUrls" data-type="stringArray" placeholder="https://example.com/package_index.json"></textarea>
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
            </div>

            <!-- IntelliSense -->
            <div class="settings-group">
                <h3>${t.groupIntelliSense}</h3>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sDisableAutoConfig}</div>
                        <div class="settings-item-desc">${t.sDisableAutoConfigDesc}</div>
                        <div class="settings-item-key">arduino.disableIntelliSenseAutoGen</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="disableIntelliSenseAutoGen" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sAnalyzeOnOpen}</div>
                        <div class="settings-item-desc">${t.sAnalyzeOnOpenDesc}</div>
                        <div class="settings-item-key">arduino.analyzeOnOpen</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="analyzeOnOpen" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sAnalyzeOnSettingChange}</div>
                        <div class="settings-item-desc">${t.sAnalyzeOnSettingChangeDesc}</div>
                        <div class="settings-item-key">arduino.analyzeOnSettingChange</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="analyzeOnSettingChange" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
            </div>

            <!-- Interface -->
            <div class="settings-group">
                <h3>${t.groupInterface}</h3>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sArduinoTheme}</div>
                        <div class="settings-item-desc">${t.sArduinoThemeDesc}</div>
                        <div class="settings-item-key">arduino.theme</div>
                    </div>
                    <div class="settings-item-control">
                        <select class="settings-select" data-scope="vscode" data-key="theme">
                            <option value="Arduino light">Arduino light</option>
                            <option value="Arduino dark">Arduino dark</option>
                        </select>
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sUsbDetection}</div>
                        <div class="settings-item-desc">${t.sUsbDetectionDesc}</div>
                        <div class="settings-item-key">arduino.enableUSBDetection</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="enableUSBDetection" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sTeleplotOpenMode}</div>
                        <div class="settings-item-desc">${t.sTeleplotOpenModeDesc}</div>
                        <div class="settings-item-key">arduino.teleplotOpenMode</div>
                    </div>
                    <div class="settings-item-control">
                        <select class="settings-select" data-scope="vscode" data-key="teleplotOpenMode">
                            <option value="newTab">${t.sTeleplotNewTab}</option>
                            <option value="newPanel">${t.sTeleplotNewPanel}</option>
                            <option value="splitRight">${t.sTeleplotSplitRight}</option>
                        </select>
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
            </div>

            <!-- Advanced -->
            <div class="settings-group">
                <h3>${t.groupAdvanced}</h3>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sOpenPde}</div>
                        <div class="settings-item-desc">${t.sOpenPdeDesc}</div>
                        <div class="settings-item-key">arduino.openPDEFiletype</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="openPDEFiletype" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sDisableHeaderProvider}</div>
                        <div class="settings-item-desc">${t.sDisableHeaderProviderDesc}</div>
                        <div class="settings-item-key">arduino.skipHeaderProvider</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-checkbox" type="checkbox" data-scope="vscode" data-key="skipHeaderProvider" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sIgnoreBoards}</div>
                        <div class="settings-item-desc">${t.sIgnoreBoardsDesc}</div>
                        <div class="settings-item-key">arduino.ignoreBoards</div>
                    </div>
                    <div class="settings-item-control">
                        <textarea class="settings-textarea" data-scope="vscode" data-key="ignoreBoards" data-type="stringArray" placeholder=""></textarea>
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
            </div>

            <!-- Project Settings -->
            <div class="settings-group">
                <h3>${t.groupProject}</h3>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sSketch}</div>
                        <div class="settings-item-desc">${t.sSketchDesc}</div>
                        <div class="settings-item-key">sketch</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="sketch" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sBoardLabel}</div>
                        <div class="settings-item-desc">${t.sBoardDesc}</div>
                        <div class="settings-item-key">board</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="board" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sPort}</div>
                        <div class="settings-item-desc">${t.sPortDesc}</div>
                        <div class="settings-item-key">port</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input narrow" type="text" data-scope="project" data-key="port" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sConfiguration}</div>
                        <div class="settings-item-desc">${t.sConfigurationDesc}</div>
                        <div class="settings-item-key">configuration</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="configuration" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sOutputFolder}</div>
                        <div class="settings-item-desc">${t.sOutputFolderDesc}</div>
                        <div class="settings-item-key">output</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="output" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sIntelliSenseProject}</div>
                        <div class="settings-item-desc">${t.sIntelliSenseProjectDesc}</div>
                        <div class="settings-item-key">intelliSenseGen</div>
                    </div>
                    <div class="settings-item-control">
                        <select class="settings-select" data-scope="project" data-key="intelliSenseGen">
                            <option value="global">global</option>
                            <option value="disable">disable</option>
                            <option value="enable">enable</option>
                        </select>
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sProgrammer}</div>
                        <div class="settings-item-desc">${t.sProgrammerDesc}</div>
                        <div class="settings-item-key">programmer</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="programmer" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sPreBuild}</div>
                        <div class="settings-item-desc">${t.sPreBuildDesc}</div>
                        <div class="settings-item-key">prebuild</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="prebuild" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
                <div class="settings-item">
                    <div class="settings-item-info">
                        <div class="settings-item-label">${t.sPostBuild}</div>
                        <div class="settings-item-desc">${t.sPostBuildDesc}</div>
                        <div class="settings-item-key">postbuild</div>
                    </div>
                    <div class="settings-item-control">
                        <input class="settings-input" type="text" data-scope="project" data-key="postbuild" />
                        <span class="settings-saved">✓</span>
                    </div>
                </div>
            </div>
        </div>
        </div>
    </main>

    <script>
        (function() {
            var vscode = acquireVsCodeApi();
            var baseUrl = "${this._serverBaseUrl}";
            var authToken = "${this._authToken}";
            var frame = document.getElementById('frame');
            var welcome = document.getElementById('welcome');
            var settingsPanel = document.getElementById('settings');
            var boardSelectEl = document.getElementById('boardSelect');
            var boardRefreshBtn = document.getElementById('boardRefresh');
            var buttons = document.querySelectorAll('.rail-btn[data-view]');
            var cmdButtons = document.querySelectorAll('.rail-btn[data-cmd]');
            var settingsBtn = document.getElementById('settingsBtn');
            var currentView = '';
            var connectedBoards = [];

            function getThemeParams() {
                var doc = document.documentElement;
                var styles = window.getComputedStyle(doc);
                var bg = styles.getPropertyValue('--vscode-editor-background') || '#1e1e1e';
                var fg = styles.getPropertyValue('--vscode-foreground') || '#d4d4d4';
                var theme = document.body.className || 'vscode-dark';
                return 'theme=' + encodeURIComponent(theme.trim()) +
                       '&backgroundcolor=' + encodeURIComponent(bg.trim()) +
                       '&color=' + encodeURIComponent(fg.trim()) +
                       '&token=' + encodeURIComponent(authToken);
            }

            function hideAll() {
                frame.style.display = 'none';
                welcome.style.display = 'none';
                settingsPanel.style.display = 'none';
                buttons.forEach(function(b) { b.classList.remove('active'); });
                settingsBtn.classList.remove('active');
            }

            // ── Board selector ──
            // JSON.stringify côté extension : évite de casser le script si une traduction contient une apostrophe
            var placeholderText = ${JSON.stringify(t.selectBoardPlaceholder)};
            var noBoardText = ${JSON.stringify(t.noBoardDetected)};
            function renderBoards(boards, selectedPort) {
                connectedBoards = boards || [];
                // Keep only the placeholder option
                boardSelectEl.innerHTML = '<option value="" disabled></option>';
                boardSelectEl.options[0].textContent = placeholderText;
                if (connectedBoards.length === 0) {
                    boardSelectEl.options[0].textContent = noBoardText;
                    boardSelectEl.selectedIndex = 0;
                    return;
                }
                var hasSelection = false;
                connectedBoards.forEach(function(b, i) {
                    var opt = document.createElement('option');
                    opt.value = String(i);
                    opt.textContent = b.name + ' - ' + b.port;
                    if (b.port === selectedPort) {
                        opt.selected = true;
                        hasSelection = true;
                    }
                    boardSelectEl.appendChild(opt);
                });
                if (!hasSelection) {
                    boardSelectEl.selectedIndex = 0;
                }
            }

            boardSelectEl.addEventListener('change', function() {
                var idx = parseInt(boardSelectEl.value, 10);
                if (!isNaN(idx) && connectedBoards[idx]) {
                    var b = connectedBoards[idx];
                    vscode.postMessage({ command: 'selectBoard', port: b.port, fqbn: b.fqbn || '', name: b.name });
                }
            });

            function refreshBoards() {
                boardRefreshBtn.classList.add('spinning');
                vscode.postMessage({ command: 'getConnectedBoards' });
            }

            boardRefreshBtn.addEventListener('click', refreshBoards);

            function showWelcome() {
                currentView = '';
                hideAll();
                welcome.style.display = 'flex';
            }

            function navigateTo(view) {
                if (view === currentView) return;
                currentView = view;
                hideAll();
                buttons.forEach(function(b) {
                    b.classList.toggle('active', b.getAttribute('data-view') === view);
                });
                frame.style.display = 'block';
                frame.src = baseUrl + '/' + view + '?' + getThemeParams();
            }

            function showSettings() {
                currentView = 'settings';
                hideAll();
                settingsBtn.classList.add('active');
                settingsPanel.style.display = 'block';
                vscode.postMessage({ command: 'getSettings' });
            }

            function flashSaved(control) {
                var indicator = control.nextElementSibling;
                if (!indicator || !indicator.classList.contains('settings-saved')) {
                    indicator = control.parentElement.querySelector('.settings-saved');
                }
                if (indicator) {
                    indicator.classList.add('show');
                    setTimeout(function() { indicator.classList.remove('show'); }, 1500);
                }
            }

            function getControlValue(el) {
                var dataType = el.getAttribute('data-type');
                if (el.type === 'checkbox') {
                    return el.checked;
                } else if (dataType === 'number') {
                    return parseInt(el.value, 10);
                } else if (dataType === 'stringArray') {
                    return el.value.split('\\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
                }
                return el.value;
            }

            function setControlValue(el, value) {
                var dataType = el.getAttribute('data-type');
                if (el.type === 'checkbox') {
                    el.checked = !!value;
                } else if (dataType === 'stringArray') {
                    el.value = Array.isArray(value) ? value.join('\\n') : (value || '');
                } else {
                    el.value = (value != null) ? String(value) : '';
                }
            }

            function loadSettingsData(data) {
                var controls = settingsPanel.querySelectorAll('[data-scope][data-key]');
                controls.forEach(function(el) {
                    var scope = el.getAttribute('data-scope');
                    var key = el.getAttribute('data-key');
                    var obj = (scope === 'project') ? data.project : data.vscode;
                    if (obj && key in obj) {
                        setControlValue(el, obj[key]);
                    }
                });
            }

            // Debounce helper for text inputs
            var debounceTimers = {};
            function debounceUpdate(el, delay) {
                var id = el.getAttribute('data-scope') + '.' + el.getAttribute('data-key');
                clearTimeout(debounceTimers[id]);
                debounceTimers[id] = setTimeout(function() {
                    vscode.postMessage({
                        command: 'updateSetting',
                        scope: el.getAttribute('data-scope'),
                        key: el.getAttribute('data-key'),
                        value: getControlValue(el)
                    });
                    flashSaved(el);
                }, 600);
            }

            // Attach change/input handlers to all setting controls
            settingsPanel.querySelectorAll('[data-scope][data-key]').forEach(function(el) {
                if (el.type === 'checkbox') {
                    el.addEventListener('change', function() {
                        vscode.postMessage({
                            command: 'updateSetting',
                            scope: el.getAttribute('data-scope'),
                            key: el.getAttribute('data-key'),
                            value: getControlValue(el)
                        });
                        flashSaved(el);
                    });
                } else if (el.tagName === 'SELECT') {
                    el.addEventListener('change', function() {
                        vscode.postMessage({
                            command: 'updateSetting',
                            scope: el.getAttribute('data-scope'),
                            key: el.getAttribute('data-key'),
                            value: getControlValue(el)
                        });
                        flashSaved(el);
                    });
                } else {
                    // text / textarea: debounce
                    el.addEventListener('input', function() {
                        debounceUpdate(el, 600);
                    });
                }
            });

            // Settings button
            settingsBtn.addEventListener('click', function() {
                showSettings();
            });

            // Open native settings
            document.getElementById('openNativeSettings').addEventListener('click', function() {
                vscode.postMessage({ command: 'executeCommand', id: 'workbench.action.openSettings', args: 'arduino' });
            });

            // Rail view buttons
            buttons.forEach(function(btn) {
                btn.addEventListener('click', function() {
                    navigateTo(btn.getAttribute('data-view'));
                });
            });

            // Rail command buttons
            cmdButtons.forEach(function(btn) {
                btn.addEventListener('click', function() {
                    vscode.postMessage({ command: 'executeCommand', id: btn.getAttribute('data-cmd') });
                });
            });

            // Welcome screen buttons
            document.querySelectorAll('.welcome-btn[data-wcmd]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    vscode.postMessage({ command: 'executeCommand', id: btn.getAttribute('data-wcmd') });
                });
            });
            document.querySelectorAll('.welcome-btn[data-wview]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    navigateTo(btn.getAttribute('data-wview'));
                });
            });

            // Logo in rail = back to welcome
            document.querySelector('.rail-logo').addEventListener('click', function() {
                showWelcome();
            });
            document.querySelector('.rail-logo').style.cursor = 'pointer';

            // Listen for messages from the extension
            window.addEventListener('message', function(event) {
                var msg = event.data;
                if (msg && msg.command === 'navigate' && msg.view) {
                    navigateTo(msg.view);
                } else if (msg && msg.command === 'loadSettings') {
                    loadSettingsData(msg);
                } else if (msg && msg.command === 'loadBoards') {
                    boardRefreshBtn.classList.remove('spinning');
                    renderBoards(msg.boards, msg.selectedPort);
                }
            });

            // Start on welcome screen, unless a specific view was requested
            var initial = "${defaultView}";
            if (initial) {
                navigateTo(initial);
            }

            // Initial board list fetch
            refreshBoards();
        })();
    </script>
</body>
</html>`;
    }
}
