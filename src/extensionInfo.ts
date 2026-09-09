// Acces centralise aux informations du manifeste de l'extension et a son mode
// d'execution. Le contexte est memorise a l'activation (voir extension.ts).
import * as vscode from "vscode";

export const EXTENSION_ID = "electropol-fr.arduino-vscode-ide";

let extensionMode: vscode.ExtensionMode | undefined;

/** Memorise le mode d'execution fourni par VS Code a l'activation. */
export function setExtensionMode(mode: vscode.ExtensionMode) {
    extensionMode = mode;
}

/**
 * Vrai quand l'extension tourne en production (installee par l'utilisateur).
 * Faux en developpement ou en test. En l'absence d'information, on suppose
 * la production pour ne rien divulguer d'interne.
 */
export function isProductionMode(): boolean {
    return extensionMode === undefined || extensionMode === vscode.ExtensionMode.Production;
}

/** Contenu du package.json de l'extension, ou un objet vide si introuvable. */
export function getExtensionPackageJSON(): any {
    return vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON || {};
}
