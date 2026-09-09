// Identification des ports serie : nomme au mieux un port que arduino-cli
// n'a pas su rattacher a une carte connue.
//
// arduino-cli ne reconnait une carte que par son couple VID/PID USB. Les cartes
// a pont serie generique (CH340, CP2102, FT232...) portent l'identifiant du
// fabricant du pont, partage par des milliers de modeles : le CLI ne peut alors
// rien affirmer et laisse `matching_boards` vide. Plutot que d'afficher
// « Inconnue », on descend une echelle de replis du plus precis au plus vague.
import * as vscode from "vscode";

/** Cle du reglage qui memorise les noms attribues manuellement aux ports. */
export const PORT_NAMES_SETTING = "arduino.portNames";

/** Proprietes USB telles que arduino-cli les expose dans `board list --format json`. */
export interface IPortProperties {
    manufacturer?: string;
    product?: string;
    serialNumber?: string;
    vid?: string;
    pid?: string;
}

/** Origine du nom affiche, du plus precis au plus vague. */
export enum PortNameSource {
    /** Nom attribue manuellement par l'utilisateur. */
    UserDefined = "user",
    /** Carte reconnue par arduino-cli via son VID/PID. */
    MatchingBoard = "board",
    /** Chaine `product` publiee par le pilote USB. */
    Product = "product",
    /** Chaine `manufacturer` publiee par le pilote USB. */
    Manufacturer = "manufacturer",
    /** Pont serie reconnu par notre table VID/PID. */
    KnownBridge = "bridge",
    /** Port serie sans aucune propriete USB (port de carte mere, pont Bluetooth...). */
    PlainSerial = "plain",
    /** Aucune information exploitable. */
    Unknown = "unknown",
}

export interface IPortName {
    /** Libelle a afficher devant l'adresse du port. */
    label: string;
    /** D'ou vient ce libelle : utile pour nuancer l'affichage et pour les tests. */
    source: PortNameSource;
}

/**
 * Ponts USB-serie courants sur les cartes compatibles Arduino.
 * Cette table ne nomme jamais une carte : elle nomme la puce d'interface, ce
 * qui reste plus parlant que « Inconnue » et aide a distinguer deux ports.
 */
const KNOWN_BRIDGES: { [vid: string]: { [pid: string]: string } | string } = {
    // WCH — ponts les plus repandus sur les cartes economiques
    "1a86": {
        "7523": "CH340 (WCH)",
        "7522": "CH340 (WCH)",
        "5523": "CH341 (WCH)",
        "55d4": "CH9102 (WCH)",
        "55d3": "CH9102 (WCH)",
    },
    // Silicon Labs
    "10c4": {
        ea60: "CP2102 (Silicon Labs)",
        ea70: "CP2105 (Silicon Labs)",
        ea71: "CP2108 (Silicon Labs)",
    },
    // FTDI — le PID varie peu, un nom unique suffit
    "0403": "FTDI",
    // Prolific
    "067b": "PL2303 (Prolific)",
    // Espressif (USB natif du microcontroleur)
    "303a": "USB natif (Espressif)",
    // Raspberry Pi (USB natif RP2040 / RP2350)
    "2e8a": "USB natif (Raspberry Pi)",
};

/** Normalise un identifiant USB : « 0x1A86 », « 1A86 » ou « 1a86 » donnent « 1a86 ». */
function normalizeUsbId(value?: string): string {
    if (!value) {
        return "";
    }
    return value.trim().toLowerCase().replace(/^0x/, "");
}

/** Nettoie une chaine venue du pilote : espaces superflus, valeur vide ou nulle. */
function cleanDescriptor(value?: string): string {
    if (!value) {
        return "";
    }
    const trimmed = value.trim();
    // Certains pilotes renvoient litteralement « n/a » ou « unknown ».
    if (!trimmed || /^(n\/a|unknown|none)$/i.test(trimmed)) {
        return "";
    }
    return trimmed;
}

/** Cherche le pont serie correspondant au couple VID/PID, table ci-dessus. */
export function lookupKnownBridge(vid?: string, pid?: string): string {
    const normalizedVid = normalizeUsbId(vid);
    if (!normalizedVid) {
        return "";
    }
    const entry = KNOWN_BRIDGES[normalizedVid];
    if (!entry) {
        return "";
    }
    if (typeof entry === "string") {
        return entry;
    }
    return entry[normalizeUsbId(pid)] || "";
}

/** Lit les noms de ports memorises par l'utilisateur (reglage `arduino.portNames`). */
export function getUserPortNames(): { [port: string]: string } {
    const configured = vscode.workspace
        .getConfiguration()
        .get<{ [port: string]: string }>(PORT_NAMES_SETTING);
    return configured || {};
}

/**
 * Memorise — ou efface, si `name` est vide — le nom attribue a un port.
 * Le reglage est global : un port est rattache a une machine, pas a un projet.
 */
export async function setUserPortName(port: string, name: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration();
    const current = configuration.get<{ [port: string]: string }>(PORT_NAMES_SETTING) || {};
    const updated = { ...current };
    const cleaned = cleanDescriptor(name);
    if (cleaned) {
        updated[port] = cleaned;
    } else {
        delete updated[port];
    }
    await configuration.update(PORT_NAMES_SETTING, updated, vscode.ConfigurationTarget.Global);
}

/**
 * Determine le libelle d'un port, par ordre de precision decroissante :
 *   1. nom attribue par l'utilisateur ;
 *   2. carte reconnue par arduino-cli ;
 *   3. chaine `product` du pilote ;
 *   4. chaine `manufacturer` du pilote ;
 *   5. pont serie reconnu par notre table VID/PID ;
 *   6. port serie sans aucune propriete USB ;
 *   7. rien d'exploitable.
 *
 * `matchingBoardName` reste prioritaire sur les descripteurs USB : quand le CLI
 * identifie la carte, il dit « Arduino UNO » la ou le pilote dirait au mieux
 * « USB Serial Device ».
 */
export function resolvePortName(
    port: string,
    properties: IPortProperties | undefined,
    matchingBoardName: string | undefined,
    userNames: { [port: string]: string },
): IPortName {
    const userName = cleanDescriptor(userNames[port]);
    if (userName) {
        return { label: userName, source: PortNameSource.UserDefined };
    }

    const boardName = cleanDescriptor(matchingBoardName);
    if (boardName) {
        return { label: boardName, source: PortNameSource.MatchingBoard };
    }

    const props = properties || {};

    const product = cleanDescriptor(props.product);
    if (product) {
        return { label: product, source: PortNameSource.Product };
    }

    const manufacturer = cleanDescriptor(props.manufacturer);
    if (manufacturer) {
        return { label: manufacturer, source: PortNameSource.Manufacturer };
    }

    const bridge = lookupKnownBridge(props.vid, props.pid);
    if (bridge) {
        return { label: bridge, source: PortNameSource.KnownBridge };
    }

    // Aucun identifiant USB : ce n'est pas une carte debranchable mais un port
    // de la machine (carte mere, pont Bluetooth). Le distinguer evite de le
    // confondre avec une carte non reconnue.
    if (!normalizeUsbId(props.vid) && !normalizeUsbId(props.pid)) {
        return { label: vscode.l10n.t("Serial port"), source: PortNameSource.PlainSerial };
    }

    return { label: vscode.l10n.t("Unknown"), source: PortNameSource.Unknown };
}
