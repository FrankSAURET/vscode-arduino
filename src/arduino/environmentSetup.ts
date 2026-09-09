// Copyright (c) electropol-fr. All rights reserved.
// Licensed under the MIT license.

import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { arduinoChannel } from "../common/outputChannel";
import { getExecutableFileName } from "../common/platform";
import { downloadArduinoCli, getDownloadedCliExecutable } from "./cliDownloader";
import { CPPTOOLS_EXTENSION_ID } from "./extensionRecommendation";

const execFileAsync = promisify(child_process.execFile);

// Cœur installé d'office : c'est le seul qui apporte avr-gcc et avrdude,
// donc la seule chose qui rend une Uno/Nano/Mega compilable et téléversable.
const DEFAULT_CORE = "arduino:avr";

const SETUP_PROMPT_STATE_KEY = "arduino.environmentSetupPrompt";

export interface IEnvironmentStatus {
    /** Un arduino-cli réellement invocable a été trouvé. */
    hasCli: boolean;
    /** Au moins un cœur (plateforme) est installé : sans cela, aucune compilation possible. */
    hasCore: boolean;
    /** L'extension C/C++ est installée (IntelliSense). */
    hasCppTools: boolean;
}

/**
 * Le CLI répond-il ? On ne se contente pas de l'existence du fichier :
 * un binaire tronqué ou d'une architecture étrangère existe sans fonctionner.
 */
async function cliResponds(commandPath: string): Promise<boolean> {
    try {
        await execFileAsync(commandPath, ["version"], { timeout: 8000, windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * Liste les cœurs installés via le CLI. Retourne null si le CLI n'a pas répondu
 * (indéterminé), un tableau éventuellement vide sinon.
 */
async function listInstalledCores(commandPath: string): Promise<string[] | null> {
    const parse = (stdout: string): string[] => {
        const parsed = JSON.parse(stdout);
        // Selon la version du CLI : { platforms: [...] } ou directement un tableau
        const platforms = Array.isArray(parsed) ? parsed : (parsed.platforms || []);
        return platforms
            // `installed_version` distingue une plateforme réellement installée d'une simple
            // entrée d'index : selon la version, le CLI peut lister les deux.
            .filter((p: any) => !!(p.installed_version || p.installedVersion
                || (p.metadata && p.metadata.installed_version)))
            .map((p: any) => p.id || (p.metadata && p.metadata.id) || "")
            .filter((id: string) => !!id);
    };
    try {
        const { stdout } = await execFileAsync(commandPath, ["core", "list", "--json"],
            { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        return parse(stdout);
    } catch {
        // Anciennes versions du CLI (< 1.0) : --json s'écrivait --format json
        try {
            const { stdout } = await execFileAsync(commandPath, ["core", "list", "--format", "json"],
                { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
            return parse(stdout);
        } catch {
            return null;
        }
    }
}

/**
 * Repli hors CLI : un cœur installé se voit au dossier `packages/<éditeur>/hardware`
 * du dossier de données du CLI. Sert quand le CLI ne répond pas.
 */
function hasCoreOnDisk(packagePath: string): boolean {
    if (!packagePath) {
        return false;
    }
    const packagesDir = path.join(packagePath, "packages");
    try {
        for (const vendor of fs.readdirSync(packagesDir)) {
            const hardwareDir = path.join(packagesDir, vendor, "hardware");
            if (!fs.existsSync(hardwareDir)) {
                continue;
            }
            for (const arch of fs.readdirSync(hardwareDir)) {
                // Un cœur réellement installé contient au moins une version avec boards.txt
                const archDir = path.join(hardwareDir, arch);
                for (const version of fs.readdirSync(archDir)) {
                    if (fs.existsSync(path.join(archDir, version, "boards.txt"))) {
                        return true;
                    }
                }
            }
        }
    } catch {
        // Dossier absent ou illisible : pas de cœur détectable
    }
    return false;
}

/**
 * État de l'environnement de programmation Arduino.
 * @param commandPath chemin de l'exécutable arduino-cli résolu par les réglages
 * @param packagePath dossier de données du CLI (pour le repli hors CLI)
 */
export async function getEnvironmentStatus(commandPath: string, packagePath: string): Promise<IEnvironmentStatus> {
    const hasCli = !!commandPath && await cliResponds(commandPath);
    let hasCore = false;
    if (hasCli) {
        const cores = await listInstalledCores(commandPath);
        hasCore = cores === null ? hasCoreOnDisk(packagePath) : cores.length > 0;
    } else {
        hasCore = hasCoreOnDisk(packagePath);
    }
    return {
        hasCli,
        hasCore,
        hasCppTools: !!vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID),
    };
}

/**
 * Lance une commande du CLI en renvoyant sa sortie dans le canal Arduino.
 */
function runCli(commandPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = child_process.spawn(commandPath, args, { windowsHide: true });
        const relay = (data: Buffer) => {
            const text = data.toString().replace(/\r?\n$/, "");
            if (text) {
                arduinoChannel.channel.appendLine(text);
            }
        };
        child.stdout.on("data", relay);
        child.stderr.on("data", relay);
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(vscode.l10n.t("Exit with code={0}", code)));
            }
        });
    });
}

export interface ISetupResult {
    /** Le CLI vient d'être téléchargé : les réglages doivent être réinitialisés. */
    cliInstalled: boolean;
    /** Le cœur arduino:avr a été installé pendant ce parcours. */
    coreInstalled: boolean;
    /** Toutes les étapes indispensables sont satisfaites. */
    ready: boolean;
}

/**
 * Parcours complet d'installation : arduino-cli, index des paquets, cœur arduino:avr,
 * puis extension C/C++ pour l'IntelliSense. Chaque étape est sautée si déjà satisfaite.
 *
 * @param extensionPath dossier de l'extension (destination du CLI téléchargé)
 * @param resolveCommandPath fournit le chemin courant du CLI ; rappelé après téléchargement
 * @param additionalUrlsArgs flags `--additional-urls` à transmettre au CLI
 */
export async function setupEnvironment(
    extensionPath: string,
    resolveCommandPath: () => string,
    additionalUrlsArgs: () => string[],
): Promise<ISetupResult> {
    const result: ISetupResult = { cliInstalled: false, coreInstalled: false, ready: false };
    arduinoChannel.show();
    arduinoChannel.start(vscode.l10n.t("Set up the Arduino environment..."));

    // Étape 1 : arduino-cli
    let commandPath = resolveCommandPath();
    if (!commandPath || !await cliResponds(commandPath)) {
        const downloaded = getDownloadedCliExecutable(extensionPath);
        if (downloaded && await cliResponds(downloaded)) {
            commandPath = downloaded;
        } else {
            arduinoChannel.info(vscode.l10n.t("Arduino CLI not found: downloading it."));
            await downloadArduinoCli(extensionPath);
            commandPath = getDownloadedCliExecutable(extensionPath)
                || path.join(extensionPath, "arduino-cli", getExecutableFileName("arduino-cli"));
            result.cliInstalled = true;
        }
    } else {
        arduinoChannel.info(vscode.l10n.t("Arduino CLI found: {0}", commandPath));
    }

    if (!await cliResponds(commandPath)) {
        arduinoChannel.error(vscode.l10n.t("Arduino CLI is still unusable: {0}", commandPath));
        throw new Error(vscode.l10n.t("Arduino CLI is still unusable: {0}", commandPath));
    }

    // Étape 2 : index des paquets, sans quoi `core install` ne trouve rien
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Arduino environment"),
        cancellable: false,
    }, async (progress) => {
        progress.report({ message: vscode.l10n.t("Updating package index...") });
        try {
            await runCli(commandPath, ["core", "update-index", ...additionalUrlsArgs()]);
        } catch (error) {
            // Index déjà présent ou réseau capricieux : l'installation du cœur tranchera
            arduinoChannel.warning(vscode.l10n.t("Package index update failed: {0}", error.message));
        }

        // Étape 3 : cœur arduino:avr (avr-gcc + avrdude)
        const cores = await listInstalledCores(commandPath);
        const hasAvr = cores !== null && cores.some((id) => id.toLowerCase() === DEFAULT_CORE);
        if (!hasAvr) {
            progress.report({ message: vscode.l10n.t("Installing the {0} core...", DEFAULT_CORE) });
            arduinoChannel.info(vscode.l10n.t("Installing the {0} core...", DEFAULT_CORE));
            await runCli(commandPath, ["core", "install", DEFAULT_CORE, ...additionalUrlsArgs()]);
            result.coreInstalled = true;
        } else {
            arduinoChannel.info(vscode.l10n.t("The {0} core is already installed.", DEFAULT_CORE));
        }

        // Étape 4 : index des bibliothèques, pour que le gestionnaire soit utilisable d'emblée
        progress.report({ message: vscode.l10n.t("Updating library index...") });
        try {
            await runCli(commandPath, ["lib", "update-index"]);
        } catch (error) {
            arduinoChannel.warning(vscode.l10n.t("Library index update failed: {0}", error.message));
        }
    });

    // Étape 5 : extension C/C++ pour l'IntelliSense (facultative, jamais bloquante)
    if (!vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID)) {
        await installCppTools();
    }

    result.ready = true;
    arduinoChannel.end(vscode.l10n.t("Arduino environment ready."));
    return result;
}

/**
 * Installe l'extension C/C++, avec repli sur la recherche du Marketplace
 * (elle est absente d'Open VSX : licence Microsoft non redistribuable).
 */
async function installCppTools(): Promise<void> {
    const install = vscode.l10n.t("Install C/C++");
    const skip = vscode.l10n.t("Skip");
    const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t("Install the \"C/C++\" extension to get IntelliSense (completion, navigation, error checking) in your sketches."),
        install,
        skip,
    );
    if (choice !== install) {
        return;
    }
    try {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", CPPTOOLS_EXTENSION_ID);
        arduinoChannel.info(vscode.l10n.t("C/C++ extension installed."));
    } catch (error) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Unable to install the \"C/C++\" extension automatically."));
        await vscode.commands.executeCommand("workbench.extensions.search", `@id:${CPPTOOLS_EXTENSION_ID}`);
    }
}

/**
 * Notification unique proposant le parcours d'installation quand l'environnement
 * est incomplet. Remplace l'ancien prompt qui ne parlait que du CLI : un CLI seul
 * ne compile rien, faute de cœur.
 *
 * Non bloquante par construction : appelée hors du chemin critique d'activation.
 */
export async function promptSetupEnvironment(
    context: vscode.ExtensionContext,
    status: IEnvironmentStatus,
): Promise<boolean> {
    if (status.hasCli && status.hasCore) {
        return false;
    }

    const state = context.globalState.get<{ dismissedForever?: boolean }>(SETUP_PROMPT_STATE_KEY);
    if (state && state.dismissedForever) {
        return false;
    }

    const message = !status.hasCli
        ? vscode.l10n.t("The Arduino environment is missing: Arduino CLI and a board core are needed to compile and upload. Install everything now?")
        : vscode.l10n.t("No board core is installed: nothing can be compiled or uploaded. Install the {0} core now?", DEFAULT_CORE);

    const installAction = vscode.l10n.t("Install");
    const neverAction = vscode.l10n.t("Don't show again");
    const choice = await vscode.window.showWarningMessage(
        message,
        installAction,
        vscode.l10n.t("Later"),
        neverAction,
    );

    if (choice === neverAction) {
        await context.globalState.update(SETUP_PROMPT_STATE_KEY, { dismissedForever: true });
        return false;
    }
    return choice === installAction;
}
