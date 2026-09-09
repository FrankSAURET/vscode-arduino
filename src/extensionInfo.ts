// Acces centralise aux informations du manifeste de l'extension et a son mode
// d'execution. Les deux sont memorises a l'activation (voir extension.ts) :
// le contexte fourni par VS Code est la seule source fiable, la recherche par
// identifiant echouant des que l'extension tourne sous un autre nom d'editeur.
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const EXTENSION_ID = "electropol-fr.arduino-vscode-ide";

let extensionMode: vscode.ExtensionMode | undefined;
let packageJSON: any;

/** Memorise le mode d'execution et le manifeste fournis a l'activation. */
export function setExtensionContext(context: vscode.ExtensionContext) {
    extensionMode = context.extensionMode;
    packageJSON = (context as any).extension?.packageJSON;
    if (!packageJSON) {
        // Anciennes versions de l'API : le manifeste se lit sur le disque.
        try {
            packageJSON = JSON.parse(fs.readFileSync(path.join(context.extensionPath, "package.json"), "utf8"));
        } catch (error) {
            packageJSON = undefined;
        }
    }
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
    return packageJSON || vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON || {};
}
