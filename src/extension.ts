// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

const impor = require("impor")(__dirname);

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as constants from "./common/constants";
const arduinoContentProviderModule =
    impor("./arduino/arduinoContentProvider") as typeof import ("./arduino/arduinoContentProvider");
import { IBoard } from "./arduino/package";
import { VscodeSettings } from "./arduino/vscodeSettings";
const arduinoActivatorModule = impor("./arduinoActivator") as typeof import ("./arduinoActivator");
const arduinoContextModule = impor("./arduinoContext") as typeof import ("./arduinoContext");
const quickAccessProviderModule = impor("./arduino/projectLauncherProvider") as typeof import ("./arduino/projectLauncherProvider");
const arduinoHomePanelModule = impor("./arduino/arduinoHomePanel") as typeof import ("./arduino/arduinoHomePanel");
import {
    ARDUINO_CONFIG_FILE, ARDUINO_MANAGER_PROTOCOL, ARDUINO_MODE, BOARD_CONFIG_URI, BOARD_MANAGER_URI, EXAMPLES_URI,
    LIBRARY_MANAGER_URI,
} from "./common/constants";
import { validateArduinoPath } from "./common/platform";
import * as util from "./common/util";
import { ArduinoWorkspace } from "./common/workspace";
const arduinoDebugConfigurationProviderModule = impor("./debug/configurationProvider") as typeof import ("./debug/configurationProvider");
import { DeviceContext } from "./deviceContext";
const completionProviderModule = impor("./langService/completionProvider") as typeof import ("./langService/completionProvider");
import { BuildMode } from "./arduino/arduino";
import { checkForCliUpdate } from "./arduino/cliDownloader";
import { getEnvironmentStatus, promptSetupEnvironment, setupEnvironment } from "./arduino/environmentSetup";
import { recommendCppTools, recommendKablix } from "./arduino/extensionRecommendation";
import { getUserPortNames, resolvePortName, setUserPortName } from "./arduino/portIdentification";
import { applyArduinoTheme } from "./arduino/themeManager";
import { listSerialPorts } from "./common/portList";
import * as Logger from "./logger/logger";
const usbDetectorModule = impor("./serialmonitor/usbDetector") as typeof import ("./serialmonitor/usbDetector");

type ArduinoContentProviderInstance = InstanceType<typeof arduinoContentProviderModule.ArduinoContentProvider>;

// Conserve hors de activate() pour que deactivate() puisse fermer le serveur
// HTTP local : tant qu'il ecoute, l'hote d'extensions ne se termine jamais et
// VS Code finit par l'abattre (abort(), code 134).
let activeArduinoManagerProvider: ArduinoContentProviderInstance | undefined;

// Minuteurs de demarrage differe, annulables a la desactivation.
const pendingTimers = new Set<NodeJS.Timeout>();

const TELEPLOT_EXTENSION_ID = "alexnesnes.teleplot";
const TELEPLOT_START_COMMAND = "teleplot.start";

export async function activate(context: vscode.ExtensionContext) {
    Logger.configure(context);
    const pendingBoardSelectionKey = "arduino.pendingBoardSelectionPath";
    const showHomeOnActivateKey = "arduino.showHomeOnActivate";
    const vscodeSettings = VscodeSettings.getInstance();
    const shouldShowHomeOnActivate = !!context.globalState.get<boolean>(showHomeOnActivateKey);

    const getErrorMessage = (error: any): string => {
        if (error instanceof Error && error.message) {
            return error.message;
        }

        return `${error}`;
    };
    const isTeleplotReady = async (): Promise<boolean> => {
        const teleplotExtension = vscode.extensions.getExtension(TELEPLOT_EXTENSION_ID);
        if (!teleplotExtension) {
            return false;
        }
        if (!teleplotExtension.isActive) {
            try {
                await teleplotExtension.activate();
            } catch {
            }
        }
        const commands = await vscode.commands.getCommands(true);
        return commands.includes(TELEPLOT_START_COMMAND);
    };
    const ensureTeleplotReady = async (): Promise<boolean> => {
        if (await isTeleplotReady()) {
            return true;
        }

        const installButton = vscode.l10n.t("Install Teleplot");
        const installChoice = await vscode.window.showInformationMessage(
            vscode.l10n.t("Teleplot is required to use the serial tracer. Do you want to install it now?"),
            { modal: true },
            installButton,
        );
        if (installChoice !== installButton) {
            return false;
        }

        try {
            await vscode.commands.executeCommand("workbench.extensions.installExtension", TELEPLOT_EXTENSION_ID);
        } catch (error) {
            vscode.window.showErrorMessage(vscode.l10n.t("Teleplot installation failed: {0}", getErrorMessage(error)));
            return false;
        }

        if (await isTeleplotReady()) {
            return true;
        }

        const reloadButton = vscode.l10n.t("Reload Window");
        const reloadChoice = await vscode.window.showInformationMessage(
            vscode.l10n.t("Teleplot was installed. Reload VS Code to finish activating it."),
            reloadButton,
        );
        if (reloadChoice === reloadButton) {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }

        return false;
    };
    const openSerialTracer = async () => {
        if (!await ensureTeleplotReady()) {
            return;
        }
        try {
            const mode = vscodeSettings.teleplotOpenMode;
            await vscode.commands.executeCommand(TELEPLOT_START_COMMAND);
            if (mode === "splitRight") {
                await vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
            } else if (mode === "newPanel") {
                await vscode.commands.executeCommand("workbench.action.moveEditorToBelowGroup");
            }
            // "newTab" = comportement par défaut de Teleplot, pas de repositionnement
        } catch (error) {
            vscode.window.showErrorMessage(vscode.l10n.t("Unable to open Teleplot: {0}", getErrorMessage(error)));
        }
    };
    const applyConfiguredArduinoTheme = async () => {
        await applyArduinoTheme(context, vscodeSettings.arduinoTheme);
    };

    // Show a warning message if the working file is not under the workspace folder.
    // People should know the extension might not work appropriately, they should look for the doc to get started.
    const openEditor = vscode.window.activeTextEditor;
    if (openEditor && openEditor.document.fileName.endsWith(".ino")) {
        const workingFile = path.normalize(openEditor.document.fileName);
        const workspaceFolder = (vscode.workspace && ArduinoWorkspace.rootPath) || "";
        if (!workspaceFolder || workingFile.indexOf(path.normalize(workspaceFolder)) < 0) {
            vscode.window.showWarningMessage(vscode.l10n.t("The open file \"{0}\" is not inside the workspace folder, the arduino extension might not work properly.", workingFile));
        }
        await applyConfiguredArduinoTheme();
    }
    const deviceContext = DeviceContext.getInstance();
    deviceContext.extensionPath = context.extensionPath;
    context.subscriptions.push(deviceContext);

    // Pass extension path to the activator for CLI auto-download
    arduinoActivatorModule.default.setExtensionPath(context.extensionPath);

    const quickAccessTreeView = vscode.window.createTreeView(
        "arduinoProjectWelcome",
        { treeDataProvider: new quickAccessProviderModule.QuickAccessProvider() },
    );
    context.subscriptions.push(quickAccessTreeView);

    let arduinoManagerProvider: ArduinoContentProviderInstance | undefined;
    let arduinoManagerProviderPromise: Promise<ArduinoContentProviderInstance> | undefined;

    const ensureArduinoManagerProvider = async (): Promise<ArduinoContentProviderInstance> => {
        if (arduinoManagerProvider) {
            return arduinoManagerProvider;
        }

        if (!arduinoManagerProviderPromise) {
            arduinoManagerProviderPromise = (async () => {
                const provider = new arduinoContentProviderModule.ArduinoContentProvider(context.extensionPath);
                await provider.initialize();
                context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ARDUINO_MANAGER_PROTOCOL, provider));
                arduinoManagerProvider = provider;
                activeArduinoManagerProvider = provider;
                return provider;
            })().catch((error) => {
                arduinoManagerProviderPromise = undefined;
                Logger.traceError("initializeHomePanelError", error);
                throw error;
            });
        }

        return arduinoManagerProviderPromise;
    };

    const safeOpenHomePanel = async (view?: string) => {
        try {
            const provider = await ensureArduinoManagerProvider();
            arduinoHomePanelModule.ArduinoHomePanel.createOrShow(
                context.extensionUri,
                provider.serverUrl,
                provider.authToken,
                view,
            );
        } catch (error) {
            vscode.window.showErrorMessage(vscode.l10n.t("Unable to open Arduino home: {0}", getErrorMessage(error)));
        }
    };

    const updateHomePanelView = async (uri: vscode.Uri) => {
        try {
            const provider = await ensureArduinoManagerProvider();
            provider.update(uri);
        } catch {
        }
    };

    const revealHomeFromActivityBar = async () => {
        await vscode.commands.executeCommand("workbench.view.explorer");
        await safeOpenHomePanel();
    };

    const openPrimarySketch = async (): Promise<boolean> => {
        const inoFiles = await vscode.workspace.findFiles("**/*.ino", undefined, 1);
        if (!inoFiles.length) {
            return false;
        }

        await vscode.commands.executeCommand("setContext", "arduino.hasProject", true);
        await vscode.commands.executeCommand("vscode.open", inoFiles[0], vscode.ViewColumn.Two);
        return true;
    };

    const showStartupHomeLayout = async () => {
        await vscode.commands.executeCommand("workbench.view.explorer");
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("vscode.setEditorLayout", {
            orientation: 0,
            groups: [{ size: 0.38 }, { size: 0.62 }],
        });
        await safeOpenHomePanel();
        await openPrimarySketch();
    };

    const runPendingBoardSelection = async () => {
        const pendingBoardSelectionPath = context.globalState.get<string>(pendingBoardSelectionKey);
        if (!pendingBoardSelectionPath || !ArduinoWorkspace.rootPath) {
            return;
        }
        if (path.resolve(pendingBoardSelectionPath) !== path.resolve(ArduinoWorkspace.rootPath)) {
            return;
        }
        if (!arduinoContextModule.default.initialized) {
            await arduinoActivatorModule.default.activate();
        }
        if (!deviceContext.board) {
            await arduinoContextModule.default.boardManager.changeBoardType();
        }
        await context.globalState.update(pendingBoardSelectionKey, undefined);
    };

    const commandExecution = async (command: string, commandBody: (...args: any[]) => any, args: any, getUserData?: () => any) => {
        try {
            let result = commandBody(...args);
            if (result) {
                result = await Promise.resolve(result);
            }
        } catch (error) {
            // Notifier l'utilisateur : une commande qui échoue en silence semble "ne rien faire"
            Logger.notifyUserError("executeCommandError", error, `${command}: ${error.message || error}`);
        }
    };
    const registerArduinoCommand = (command: string, commandBody: (...args: any[]) => any, getUserData?: () => any): number => {
        return context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
            if (!arduinoContextModule.default.initialized) {
                await arduinoActivatorModule.default.activate();
            }

            const arduinoPath = arduinoContextModule.default.arduinoApp.settings.arduinoPath;
            const commandPath = arduinoContextModule.default.arduinoApp.settings.commandPath;
            // Pop up vscode User Settings page when cannot resolve arduino path.
            if (!arduinoPath || !validateArduinoPath(arduinoPath)) {
                Logger.notifyUserError("InvalidArduinoPath", new Error(constants.messages.INVALID_ARDUINO_PATH));
                vscode.commands.executeCommand("workbench.action.openGlobalSettings");
            } else if (!commandPath || !util.fileExistsSync(commandPath)) {
                Logger.notifyUserError("InvalidCommandPath", new Error(constants.messages.INVALID_COMMAND_PATH + commandPath));
            } else {
                await commandExecution(command, commandBody, args, getUserData);
            }
        }));
    };

    const registerNonArduinoCommand = (command: string, commandBody: (...args: any[]) => any, getUserData?: () => any): number => {
        return context.subscriptions.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
            await commandExecution(command, commandBody, args, getUserData);
        }));
    };

    context.subscriptions.push(vscode.commands.registerCommand("arduino.initialize", async () => {
        const projectFolder = await deviceContext.initialize();
        if (!projectFolder) {
            return;
        }
        // Open the project folder in the current window (this reloads the window)
        await context.globalState.update(showHomeOnActivateKey, true);
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(projectFolder), false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("arduino.openProjectFolder", async () => {
        await applyConfiguredArduinoTheme();
        const folderPath = await deviceContext.openProjectFolder();
        if (!folderPath) {
            return;
        }
        // Open the project folder in the current window
        await context.globalState.update(showHomeOnActivateKey, true);
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folderPath), false);
    }));

    registerArduinoCommand("arduino.verify", async () => {
        if (!arduinoContextModule.default.arduinoApp.building) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Arduino: Verifying..."),
            }, async () => {
                await arduinoContextModule.default.arduinoApp.build(BuildMode.Verify);
            });
        }
    }, () => {
        return {
            board: (arduinoContextModule.default.boardManager.currentBoard === null) ? null :
                arduinoContextModule.default.boardManager.currentBoard.name,
        };
    });

    registerArduinoCommand("arduino.upload", async () => {
        if (!arduinoContextModule.default.arduinoApp.building) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Arduino: Uploading..."),
            }, async () => {
                await arduinoContextModule.default.arduinoApp.build(BuildMode.Upload);
            });
        }
    }, () => {
        return { board: arduinoContextModule.default.boardManager.currentBoard.name };
    });

    registerArduinoCommand("arduino.cliUpload", async () => {
        if (!arduinoContextModule.default.arduinoApp.building) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Arduino: Using CLI to upload..."),
            }, async () => {
                await arduinoContextModule.default.arduinoApp.build(BuildMode.CliUpload);
            });
        }
    }, () => {
        return { board: arduinoContextModule.default.boardManager.currentBoard.name };
    });

    registerArduinoCommand("arduino.selectSketch", async () => {
        const sketchFileName = deviceContext.sketch;

        // Include any ino, cpp, or c files under the workspace folder
        const includePattern = "**/*.{ino,cpp,c}";

        // The sketchbook folder may contain hardware & library folders, any sketches under these paths
        // should be excluded
        const sketchbookPath = arduinoContextModule.default.arduinoApp.settings.sketchbookPath;
        const excludePatterns = [
            path.relative(ArduinoWorkspace.rootPath, sketchbookPath + "/hardware/**"),
            path.relative(ArduinoWorkspace.rootPath, sketchbookPath + "/libraries/**")];

        // If an output path is specified, it should be excluded as well
        if (deviceContext.output) {
            const outputPath = path.relative(ArduinoWorkspace.rootPath,
                path.resolve(ArduinoWorkspace.rootPath, deviceContext.output));
            excludePatterns.push(`${outputPath}/**`);
        }
        const excludePattern = `{${excludePatterns.map((p) => p.replace(/\\/g, "/")).join(",")}}`;

        const fileUris = await vscode.workspace.findFiles(includePattern, excludePattern);
        const newSketchFileName = await vscode.window.showQuickPick(fileUris.map((fileUri) =>
            ({
                label: path.relative(ArduinoWorkspace.rootPath, fileUri.fsPath),
                description: fileUri.fsPath,
            })),
            { placeHolder: sketchFileName, matchOnDescription: true });

        if (!newSketchFileName) {
            return;
        }

        deviceContext.sketch = newSketchFileName.label;
        deviceContext.showStatusBar();
    });

    registerArduinoCommand("arduino.uploadUsingProgrammer", async () => {
        if (!arduinoContextModule.default.arduinoApp.building) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Arduino: Uploading (programmer)..."),
            }, async () => {
                await arduinoContextModule.default.arduinoApp.build(BuildMode.UploadProgrammer);
            });
        }
    }, () => {
        return { board: arduinoContextModule.default.boardManager.currentBoard.name };
    });

    registerArduinoCommand("arduino.cliUploadUsingProgrammer", async () => {
        if (!arduinoContextModule.default.arduinoApp.building) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Arduino: Using CLI to upload (programmer)..."),
            }, async () => {
                await arduinoContextModule.default.arduinoApp.build(BuildMode.CliUploadProgrammer);
            });
        }
    }, () => {
        return { board: arduinoContextModule.default.boardManager.currentBoard.name };
    });

    registerArduinoCommand("arduino.rebuildIntelliSenseConfig", async () => {
        if (!arduinoContextModule.default.arduinoApp.building) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: vscode.l10n.t("Arduino: Rebuilding IS Configuration..."),
            }, async () => {
                await arduinoContextModule.default.arduinoApp.build(BuildMode.Analyze);
            });
        }
    }, () => {
        return { board: arduinoContextModule.default.boardManager.currentBoard.name };
    });

    registerArduinoCommand("arduino.selectProgrammer", async () => {
        // Note: this guard does not prevent building while setting the
        // programmer. But when looking at the code of selectProgrammer
        // it seems not to be possible to trigger building while setting
        // the programmer. If the timed IntelliSense analysis is triggered
        // this is not a problem, since it doesn't use the programmer.
        if (!arduinoContextModule.default.arduinoApp.building) {
            try {
                await arduinoContextModule.default.arduinoApp.programmerManager.selectProgrammer();
            } catch (ex) {
            }
        }
    }, () => {
        return {
            board: (arduinoContextModule.default.boardManager.currentBoard === null) ? null :
                arduinoContextModule.default.boardManager.currentBoard.name,
        };
    });

    registerArduinoCommand("arduino.openExample", (path) => arduinoContextModule.default.arduinoApp.openExample(path));
    registerArduinoCommand("arduino.loadPackages", async () => await arduinoContextModule.default.boardManager.loadPackages(true));
    registerArduinoCommand("arduino.installBoard", async (packageName, arch, version: string = "") => {
        let installed = false;
        const installedBoards = arduinoContextModule.default.boardManager.installedBoards;
        installedBoards.forEach((board: IBoard, key: string) => {
            let _packageName: string;
            if (board.platform.package && board.platform.package.name) {
                _packageName = board.platform.package.name;
            } else {
                _packageName = board.platform.packageName;
            }

            if (packageName === _packageName &&
                arch === board.platform.architecture &&
                (!version || version === board.platform.installedVersion)) {
                installed = true;
            }
        });

        if (!installed) {
            await arduinoContextModule.default.boardManager.loadPackages(true);
            await arduinoContextModule.default.arduinoApp.installBoard(packageName, arch, version);
        }
        return;
    });

    // Installe tout ce qu'il faut pour programmer une carte AVR : arduino-cli, index des
    // paquets, cœur arduino:avr (avr-gcc + avrdude), extension C/C++ pour l'IntelliSense.
    // Volontairement hors de registerArduinoCommand : celui-ci exige un CLI valide, ce que
    // cette commande a précisément pour rôle de fournir.
    const runEnvironmentSetup = async (): Promise<void> => {
        if (!arduinoContextModule.default.initialized) {
            try {
                await arduinoActivatorModule.default.activate();
            } catch {
                // Activation partielle possible sans CLI : le parcours reste utile
            }
        }
        const settings = arduinoContextModule.default.initialized
            ? arduinoContextModule.default.arduinoApp.settings
            : undefined;
        const result = await setupEnvironment(
            context.extensionPath,
            () => (settings ? settings.commandPath : ""),
            () => (arduinoContextModule.default.initialized
                ? arduinoContextModule.default.arduinoApp.getAdditionalUrlsArgs()
                : []),
        );
        if (result.cliInstalled || result.coreInstalled) {
            await arduinoActivatorModule.default.reloadAfterEnvironmentChange();
        }
        // Régénérer la configuration IntelliSense : sans cœur installé, les chemins d'en-têtes
        // étaient introuvables, donc le c_cpp_properties.json généré (s'il l'était) était vide.
        if (result.coreInstalled) {
            try {
                await vscode.commands.executeCommand("arduino.rebuildIntelliSenseConfig");
            } catch {
                // Pas de croquis ouvert ou IntelliSense désactivé : sans conséquence
            }
        }
    };
    registerNonArduinoCommand("arduino.setupEnvironment", runEnvironmentSetup);

    context.subscriptions.push(vscode.commands.registerCommand("arduino.openSerialTracer", openSerialTracer));
    context.subscriptions.push(vscode.commands.registerCommand("arduino.openSerialMonitor", async () => {
        try {
            await vscode.commands.executeCommand("vscode-serial-monitor.monitor0.focus");
        } catch {
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    "The built-in VS Code serial monitor is not available. Install the \"Serial Monitor\" extension or use the built-in terminal.",
                ),
            );
        }
    }));
    registerNonArduinoCommand("arduino.selectSerialPort", async () => {
        const ports = await listSerialPorts();
        if (!ports.length) {
            vscode.window.showInformationMessage(vscode.l10n.t("No serial port is available."));
            return;
        }
        const chosen = await vscode.window.showQuickPick(
            ports.map((p) => ({ label: p.port, description: p.desc }))
                 .sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
            { placeHolder: vscode.l10n.t("Select a serial port") },
        );
        if (chosen) {
            DeviceContext.getInstance().port = chosen.label;
        }
    });

    // Renommage d'un port : les cartes a pont serie generique (CH340, CP2102...)
    // ne portent aucun identifiant propre, aucun outil ne peut donc deviner leur
    // modele. Le nom saisi ici est memorise par port dans les reglages globaux.
    registerNonArduinoCommand("arduino.renamePort", async () => {
        const ports = await listSerialPorts();
        if (!ports.length) {
            vscode.window.showInformationMessage(vscode.l10n.t("No serial port is available."));
            return;
        }
        const userNames = getUserPortNames();
        const chosen = await vscode.window.showQuickPick(
            ports.map((p) => {
                const resolved = resolvePortName(p.port, {
                    manufacturer: p.desc,
                    pid: p.productId,
                    vid: p.vendorId,
                }, "", userNames);
                return { label: p.port, description: resolved.label };
            }).sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
            { placeHolder: vscode.l10n.t("Select the port to rename") },
        );
        if (!chosen) {
            return;
        }
        const newName = await vscode.window.showInputBox({
            placeHolder: vscode.l10n.t("For example: Joy-IT ARD-One-C"),
            prompt: vscode.l10n.t("Name to display for {0} (leave empty to restore automatic detection)", chosen.label),
            value: userNames[chosen.label] || "",
        });
        // showInputBox renvoie undefined si l'utilisateur annule : ne rien faire.
        // Une chaine vide, elle, demande explicitement le retour a la detection.
        if (newName === undefined) {
            return;
        }
        await setUserPortName(chosen.label, newName);
        arduinoHomePanelModule.ArduinoHomePanel.refreshConnectedBoards();
    });

    registerArduinoCommand("arduino.changeBoardType", async () => {
        try {
            await arduinoContextModule.default.boardManager.changeBoardType();
        } catch (exception) {
            Logger.error(exception.message);
        }
        await updateHomePanelView(LIBRARY_MANAGER_URI);
        await updateHomePanelView(EXAMPLES_URI);
    }, () => {
        return { board: arduinoContextModule.default.boardManager.currentBoard.name };
    });
    registerArduinoCommand("arduino.reloadExample", async () => {
        await updateHomePanelView(EXAMPLES_URI);
    }, () => {
        return {
            board: (arduinoContextModule.default.boardManager.currentBoard === null) ? null :
                arduinoContextModule.default.boardManager.currentBoard.name,
        };
    });

    const completionProvider = new completionProviderModule.CompletionProvider();
    // Le disposable d'enregistrement ne libère pas l'instance : son watcher doit l'être explicitement
    context.subscriptions.push(completionProvider);
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(ARDUINO_MODE, completionProvider, "<", '"', "."));
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("arduino", new
        arduinoDebugConfigurationProviderModule.ArduinoDebugConfigurationProvider()));

    if (ArduinoWorkspace.rootPath && (
        util.fileExistsSync(path.join(ArduinoWorkspace.rootPath, ARDUINO_CONFIG_FILE))
        || (openEditor && openEditor.document.fileName.endsWith(".ino")))) {
        (async () => {
            await applyConfiguredArduinoTheme();
            if (!arduinoContextModule.default.initialized) {
                await arduinoActivatorModule.default.activate();
            }

            vscode.commands.executeCommand("setContext", "vscode-arduino:showExampleExplorer", true);
            await runPendingBoardSelection();
        })().catch((error) => {
            Logger.notifyUserError("activationError", error);
        });
    }
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && ((path.basename(activeEditor.document.fileName) === path.basename(ARDUINO_CONFIG_FILE)
            && path.basename(path.dirname(activeEditor.document.fileName)) === ".vscode")
            || activeEditor.document.fileName.endsWith(".ino")
        )) {
            await applyConfiguredArduinoTheme();
            if (!arduinoContextModule.default.initialized) {
                await arduinoActivatorModule.default.activate();
            }
            vscode.commands.executeCommand("setContext", "vscode-arduino:showExampleExplorer", true);
        }
    }));

    const allowPDEFiletype = vscodeSettings.allowPDEFiletype;

    if (allowPDEFiletype) {
        // Renommage .pde -> .ino : les deux listeners ci-dessous peuvent se déclencher pour le
        // même fichier ; le Set évite un double renameSync (ENOENT) et une double fermeture d'éditeur.
        const pdeRenamesInProgress = new Set<string>();
        const renamePdeToIno = async (document: vscode.TextDocument) => {
            const fsPath = document.uri.fsPath;
            if (!/\.pde$/.test(fsPath) || pdeRenamesInProgress.has(fsPath) || !fs.existsSync(fsPath)) {
                return;
            }
            pdeRenamesInProgress.add(fsPath);
            try {
                const newFsName = fsPath.replace(/\.pde$/, ".ino");
                await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                fs.renameSync(fsPath, newFsName);
                await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(newFsName));
            } catch (error) {
                Logger.traceError("renamePdeToIno", error);
            } finally {
                pdeRenamesInProgress.delete(fsPath);
            }
        };

        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (document) => {
            await renamePdeToIno(document);
        }));

        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (!editor) {
                return;
            }
            await renamePdeToIno(editor.document);
        }));
    }
    Logger.traceUserData("end-activate-extension");

    context.subscriptions.push(vscode.commands.registerCommand("arduino.showBoardManager", async () => {
        if (!arduinoContextModule.default.initialized) {
            await arduinoActivatorModule.default.activate();
        }
        await safeOpenHomePanel("boardmanager");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("arduino.showLibraryManager", async () => {
        if (!arduinoContextModule.default.initialized) {
            await arduinoActivatorModule.default.activate();
        }
        await safeOpenHomePanel("librarymanager");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("arduino.showBoardConfig", async () => {
        if (!arduinoContextModule.default.initialized) {
            await arduinoActivatorModule.default.activate();
        }
        await safeOpenHomePanel("boardConfig");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("arduino.showExamples", async (forceRefresh: boolean = false) => {
        vscode.commands.executeCommand("setContext", "vscode-arduino:showExampleExplorer", true);
        if (!arduinoContextModule.default.initialized) {
            await arduinoActivatorModule.default.activate();
        }
        if (forceRefresh) {
            await vscode.commands.executeCommand("arduino.reloadExample");
        }
        await safeOpenHomePanel("examples");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("arduino.showHome", async () => {
        await safeOpenHomePanel();
    }));

    context.subscriptions.push(quickAccessTreeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            void revealHomeFromActivityBar();
        }
    }));

    if (shouldShowHomeOnActivate) {
        await context.globalState.update(showHomeOnActivateKey, undefined);
        await showStartupHomeLayout();
    } else if (quickAccessTreeView.visible) {
        await revealHomeFromActivityBar();
    }

    // Les demarrages differes sont enregistres pour etre annules a la
    // desactivation : un minuteur encore arme empeche l'hote d'extensions de se
    // terminer et VS Code l'abat (abort(), code 134).
    const deferred = (delay: number, action: () => void) => {
        const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            action();
        }, delay);
        pendingTimers.add(timer);
        context.subscriptions.push({
            dispose: () => {
                clearTimeout(timer);
                pendingTimers.delete(timer);
            },
        });
    };

    deferred(200, () => {
        // delay to detect usb
        usbDetectorModule.UsbDetector.getInstance().initialize(context.extensionPath);
        usbDetectorModule.UsbDetector.getInstance().startListening()
            .catch((error) => Logger.traceError("startUsbDetectorError", error));
    });

    // Silently check for Arduino CLI updates (downloaded CLIs only)
    deferred(5000, () => {
        checkForCliUpdate(context.extensionPath).catch(() => { /* ignore */ });
    });

    // Recommend Kablix on first launch and after each update (non blocking)
    deferred(8000, () => {
        recommendKablix(context).catch((error) => Logger.traceError("recommendKablixError", error));
    });

    // Environnement incomplet (machine sans Arduino IDE ni arduino-cli, ou CLI sans cœur
    // installé) : une seule notification propose le parcours complet. Hors du chemin critique
    // d'activation — attendre un clic pendant activate() ferait annuler l'activation.
    deferred(12000, () => {
        (async () => {
            const settings = arduinoContextModule.default.initialized
                ? arduinoContextModule.default.arduinoApp.settings
                : undefined;
            const status = await getEnvironmentStatus(
                settings ? settings.commandPath : "",
                settings ? settings.packagePath : "",
            );
            if (await promptSetupEnvironment(context, status)) {
                await runEnvironmentSetup();
                return;
            }
            // Environnement complet : reste seulement à proposer C/C++ pour l'IntelliSense.
            if (status.hasCli && status.hasCore) {
                await recommendCppTools(context);
            }
        })().catch((error) => Logger.traceError("setupEnvironmentError", error));
    });
}

export async function deactivate() {
    // Chaque etape est isolee : une exception ici laisserait des ressources
    // vivantes et l'hote d'extensions serait tue au lieu de se terminer.
    for (const timer of pendingTimers) {
        clearTimeout(timer);
    }
    pendingTimers.clear();

    try {
        usbDetectorModule.UsbDetector.getInstance().stopListening();
    } catch (error) {
        Logger.traceError("deactivateStopUsbDetector", error);
    }

    try {
        arduinoHomePanelModule.ArduinoHomePanel.disposeCurrent();
    } catch (error) {
        Logger.traceError("deactivateDisposeHomePanel", error);
    }

    // Le serveur HTTP local doit etre ferme explicitement, sinon son `listen`
    // maintient l'hote en vie au-dela du delai d'arret accorde par VS Code.
    try {
        if (activeArduinoManagerProvider) {
            await activeArduinoManagerProvider.dispose();
            activeArduinoManagerProvider = undefined;
        }
    } catch (error) {
        Logger.traceError("deactivateDisposeContentProvider", error);
    }

    Logger.traceUserData("deactivate-extension");
}
