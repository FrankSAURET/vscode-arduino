# À faire
1. ⬜ Tester l'installation d'une plateforme tierce (ESP32) via URL additionnelle (correctif v2026.7.0)
3. ⏳ macOS / Linux : valider la détection du CLI embarqué d'Arduino IDE 2 sur machine réelle (v2026.7.3)
8. ⬜ Vérifier l'affichage réel de la notification Kablix (premier lancement + après mise à jour) sur une instance VS Code


# v2026.9.0.15 — Numéro de version sur la page d'accueil

1. ✅ **Ligne de version en bas de l'accueil** du panneau « VsCode Arduino » (`src/arduino/arduinoHomePanel.ts`) : nouveau paragraphe `.welcome-version`, sous l'astuce, discret (11 px, opacité 0,55).
2. ✅ **Deux numéros selon le mode** : en production, la version publique du manifeste (`2026.9.0`) ; hors production, le numéro interne à 4 segments (`buildNumber`, `2026.9.0.15`). Conforme à la règle « l'utilisateur ne voit jamais le 4e segment ».
3. ✅ Nouveau `src/extensionInfo.ts` : le mode d'exécution n'était mémorisé nulle part. `setExtensionMode(context.extensionMode)` est appelé en tête d'`activate`, `isProductionMode()` et `getExtensionPackageJSON()` servent de point d'accès unique. Sans information de mode, on suppose la production — un doute ne doit rien divulguer d'interne.
4. ✅ Chaîne « Version {0} » passée par `vscode.l10n.t`, langue de base seulement.
5. ⏳ Traduction de la chaîne « Version {0} » à faire avant publication.
6. ✅ Compilation TypeScript propre.

# v2026.9.0.14 — Installation guidée de l'environnement Arduino (machine sans Arduino IDE)

1. ✅ **Cause du « ça ne fonctionne pas sur une machine neuve »** : le téléchargement d'`arduino-cli` existait déjà, mais le CLI seul n'embarque **aucun compilateur**. Sans cœur installé : liste de cartes vide, `Vérifier` en échec, IntelliSense sans chemins d'en-têtes. Rien ne proposait d'installer un cœur.
2. ✅ Nouveau `src/arduino/environmentSetup.ts` : parcours complet en une barre de progression — `arduino-cli` (téléchargé si absent) → `core update-index` → `core install arduino:avr` (avr-gcc + avrdude) → `lib update-index` → extension C/C++. Chaque étape est sautée si déjà satisfaite.
3. ✅ **Détection de l'état réel** (`getEnvironmentStatus`) : le CLI doit *répondre* (`arduino-cli version`), pas seulement exister — un binaire tronqué ou d'architecture étrangère existe sans fonctionner. Cœurs lus par `core list --json`, filtrés sur `installed_version` pour ne jamais compter une simple entrée d'index.
4. ✅ **Repli hors CLI** (`hasCoreOnDisk`) : un cœur se voit au dossier `packages/<éditeur>/hardware/<arch>/<version>/boards.txt`. Sert quand le CLI ne répond pas.
5. ✅ **Une seule notification** au lieu de trois : « environnement Arduino incomplet — Installer / Plus tard / Ne plus proposer » (état dans `globalState`, clé `arduino.environmentSetupPrompt`). Remplace l'ancien prompt qui ne parlait que du CLI. La recommandation C/C++ isolée ne s'affiche plus que si l'environnement est déjà complet — les deux ne se superposent jamais.
6. ✅ Commande `arduino.setupEnvironment` (« Arduino : Installer l'environnement Arduino ») pour relancer le parcours à la main. Enregistrée hors de `registerArduinoCommand` : celui-ci exige un CLI valide, ce que la commande a précisément pour rôle de fournir.
7. ✅ `arduinoActivator` : `promptAndReloadCli` remplacé par `reloadAfterEnvironmentChange()` publique — réinit des réglages + rechargement cartes/bibliothèques après installation d'un CLI ou d'un cœur. Toujours hors du chemin critique d'activation (un `await` sur un clic y ferait annuler l'activation par VS Code).
8. ✅ Après installation d'un cœur, `arduino.rebuildIntelliSenseConfig` est relancé : le `c_cpp_properties.json` généré sans cœur ne pouvait pas contenir de chemins d'en-têtes valides.
9. ✅ Un seul cœur installé d'office (`arduino:avr`), choix assumé : c'est celui des Uno/Nano/Mega. Les autres passent par le gestionnaire de cartes.
10. ⏳ À valider sur une machine réellement vierge (sans Arduino IDE ni arduino-cli) : affichage de la notification et déroulé complet du parcours.
11. ⏳ Traductions : chaînes anglaises et françaises du manifeste faites ; les chaînes `vscode.l10n.t` de `environmentSetup.ts` restent à traduire dans `l10n/` avant publication.
12. ✅ Compilation TypeScript et tslint propres. Détection vérifiée à l'exécution sur code compilé (CLI présent → cœurs vus ; CLI absent + disque → repli ; rien → environnement incomplet).

# v2026.9.0.13 — MiniCore ajouté aux URLs de cartes par défaut

1. ✅ **URL MiniCore par défaut** : `https://mcudude.github.io/MiniCore/package_MCUdude_MiniCore_index.json` ajoutée en `default` du réglage `arduino.additionalUrls` dans le manifeste. Les nouvelles installations voient MiniCore sans rien configurer — utile pour l'ATmega328PB de la Joy-IT ARD-One-C (v2026.9.0.12).
2. ✅ **Réglages déjà personnalisés couverts** : un `default` de manifeste est ignoré dès que l'utilisateur a enregistré sa propre liste. `VscodeSettings.additionalUrls` complète donc la valeur lue avec les URLs par défaut manquantes, sans réécrire les réglages de l'utilisateur (constante `defaultAdditionalUrls` dans `src/arduino/vscodeSettings.ts`).
3. ℹ️ Le complément est fait à la lecture : l'URL part au CLI (`--additional-urls`) et alimente le gestionnaire de cartes, mais n'apparaît pas ajoutée de force dans le fichier de réglages. L'utilisateur qui la retire la reverra revenir — comportement voulu pour une URL « par défaut ».
4. ✅ Construction (`npm run build:ext`) propre.

# v2026.9.0.12 — Identification des ports série

1. ✅ **Carte Joy-IT ARD-One-C diagnostiquée.** Échec de téléversement : la carte porte un **ATmega328PB** (`1E 95 16`) et non un ATmega328P (`1E 95 0F`). Cause extérieure à l'extension, message d'avrdude. Solution : MiniCore, carte ATmega328 / variante 328PB / bootloader UNO / 16 MHz externe. Le message « Aucune nouvelle donnée IntelliSense capturée » qui suivait est indépendant et normal (cache de compilation réutilisé).
2. ✅ **Ports non reconnus mieux nommés.** Les cartes à pont USB-série générique portent le VID/PID du fabricant du pont, partagé par des milliers de modèles : `arduino-cli` ne peut rien affirmer et laissait « Unknown ». Nouveau `src/arduino/portIdentification.ts` : échelle de replis à six rangs — nom attribué par l'utilisateur, carte reconnue par le CLI, `product`, `manufacturer`, table VID/PID interne, port sans propriété USB.
3. ✅ **Table des ponts série courants** : CH340/CH341/CH9102 (WCH), CP2102/CP2105/CP2108 (Silicon Labs), FTDI, PL2303 (Prolific), USB natif Espressif et Raspberry Pi.
4. ✅ **Ports de la machine distingués des cartes.** Un port sans aucun identifiant USB (COM1, port de carte mère) s'affiche « Port série » et non plus « Unknown » — il n'était pas distinguable d'une carte non reconnue.
5. ✅ **Commande `arduino.renamePort`** (« Arduino : Renommer un port série ») : nom mémorisé par port dans le réglage global `arduino.portNames`. Saisie vide = retour à la détection automatique. Seul moyen d'obtenir « Joy-IT ARD-One-C — COM5 », aucun outil ne pouvant deviner le modèle.
6. ✅ `ArduinoHomePanel.refreshConnectedBoards()` ajouté : le sélecteur se rafraîchit aussitôt après un renommage, sans attendre la scrutation suivante.
7. ✅ Résolution vérifiée sur les trois ports réels de la machine plus quatre cas de repli : les six rangs sortent le libellé attendu. Construction et `tslint` propres.
8. ℹ️ **La signature de la puce ne peut pas servir à remplir la liste** : la lire impose d'ouvrir le port et de réinitialiser la carte, ce qui couperait un croquis en cours ou un moniteur série ouvert. Elle identifie de plus le microcontrôleur, jamais le modèle de carte.
9. ⏳ Traduction : seul le français est à jour (langue de base anglaise incluse). Autres langues à faire avant publication.

# v2026.9.0.11 — F5 : retour au fonctionnement d'origine

1. ✅ **Extensions réactivées au F5.** `--disable-extensions` retiré des trois configurations de `.vscode/launch.json` : la fenêtre de mise au point recharge les extensions de Frank comme avant la séance de diagnostic.
2. ✅ Configuration de diagnostic `Launch Extension (sans debogueur)` (`noDebug: true`) retirée. `Launch Extension` redevient la première, donc celle lancée par défaut au F5.
3. ✅ `"trace": true` retiré : journal de l'adaptateur de mise au point, posé pour capturer un échec d'attachement qui n'a jamais été démontré.
4. ✅ Reliquats de diagnostic vérifiés absents : `--sync=off`, `--verbose`, `--log=trace`, `--user-data-dir`, `env`/`NODE_OPTIONS`, `runtimeArgs`. `launch.json` revenu à **3 configurations**, JSON validé.
5. ✅ **Seul acquis conservé** : `runtimeExecutable: "${execPath}"` et `stopOnEntry` restés retirés. Le champ faisait relancer VS Code comme un simple programme node, l'hôte démarrait en pause (`STOPPED on first line for debugging`). Kablix, sans ce champ, ne plante pas.
6. ℹ️ **Le plantage 134 se reproduit avec une autre extension que celles de Frank** : la cause est extérieure au code du projet. Recherche mise en pause à sa demande.
7. ℹ️ Modifications système de la séance toutes annulées : `argv.json` (créé puis supprimé, n'existait pas), clé de registre `LocalDumps\Code.exe` (créée puis retirée avec son parent vide).
8. ⏳ À faire par Frank : **réactiver la synchronisation des réglages** (palette → « Synchronisation des paramètres : activer »), coupée par lui pour une contre-épreuve.

# v2026.9.0.10 — Plantage 134 : trois hypothèses infirmées, corrections conservées ; préparation de la publication

1. ℹ️ **Le plantage 134 n'est toujours pas expliqué.** Trois hypothèses successives ont été formulées puis **infirmées par contre-épreuve**. Aucune correction du jour ne le traite. À dire tel quel : ne pas créditer ces changements du correctif.
2. ❌ **Hypothèse « ressources non libérées à l'arrêt » (v2026.8.0.8) : fausse.** L'hôte meurt 1,2 s après *son propre* démarrage, pas à la fermeture du précédent.
3. ❌ **Hypothèse « corps de `activate()` » : fausse.** Les fenêtres mortes n'ont **aucun dossier `exthost/`** et s'arrêtent toutes à la même ligne (manifeste de `idleberg.nsis`). L'hôte meurt pendant *son démarrage*, avant d'ouvrir son journal, donc avant que le moindre code d'extension soit chargé. Bissection menée sur 44 lancements : elle n'a jamais rien testé du code d'`activate()`.
4. ❌ **Hypothèse « `activationEvents` » : fausse.** Contre-épreuve décisive exigée par Frank : code d'origine restauré, **10 lancements, 0 plantage**. Au passage, `workspaceContains:**/*.ino` **se déclenche bel et bien** en F5 — VS Code applique le motif au dossier de développement lui-même, qui contient des `.ino` de test. L'affirmation inverse, tenue plus tôt dans la journée, était fausse.
5. ℹ️ **Piste non tranchée — le rythme des lancements.** Sur les 152 lancements journalisés du jour : **83 % de plantages** quand le lancement suit le précédent de 19 à 25 s (10 sur 12), contre **6 %** pour tout autre écart (8 sur 140). Échantillon trop mince (12 cas) et non reproduit : le test de confirmation a échoué à viser la bande (écarts réels de 29 à 39 s, la mesure portant sur les *sorties* d'hôte et non sur les F5). À reprendre avec un script qui contrôle le rythme.
6. ℹ️ **Fait solide, invariant sur toutes les sessions** : dans une fenêtre morte l'hôte meurt pendant son démarrage, à 1,20–1,25 s, avec une régularité de métronome, sans jamais créer `exthost/`. Les fenêtres saines atteignent leur `exthost.log` à 1,80–1,93 s.
7. ℹ️ Le défaut ne s'est plus manifesté après 16:23:47, sur ~80 lancements et près de deux heures, toutes configurations confondues. Il ne touche que le F5 de développement, jamais les utilisateurs.
8. ✅ **Corrections conservées, sur leur seul mérite** : libération des ressources à la désactivation (serveur HTTP local, minuteur du panneau d'accueil, minuteurs différés, `deactivate()` en `try/catch` isolés).
9. ✅ **Vrai trou bouché** : `debuggerManager.ts` chargeait `usb-detection` **sans garde-fou ABI** alors que `onDebug` est un événement d'activation. Nouveau `src/common/usbDetectionLoader.ts` — chargeur unique, garde-fou ABI, cache ; les deux appelants y passent.
10. ✅ Dépôt nettoyé : 64 artefacts de construction (`test/resources/blink/.build/`) sortis du suivi git, fichiers **conservés sur disque**, dossier ajouté à `.gitignore`.
11. ✅ Version publique passée en **2026.9.0** (calver : mois de septembre, incrément reparti à 0), interne **2026.9.0.10**.
12. ✅ README et CHANGELOG mis à jour pour la publication.
13. ⏳ **À trancher par Frank** : reprendre la piste du rythme avec un script de reproduction automatisée, ou classer le défaut (il ne gêne que la mise au point).
14. ⏳ Branche `diag/plantage-134-sonde` conservée, **à ne pas fusionner** : elle ne contient que l'instrumentation de bissection.

# v2026.8.0.9 — Plantage 134 : un délai fixe mesuré, le code de l'extension est hors de cause

1. ℹ️ **Correction du diagnostic v2026.8.0.8.** « Le 134 tombe à la fermeture d'un hôte » était faux. La coïncidence avec la fermeture de la fenêtre précédente venait simplement de l'enchaînement rapide des F5.
2. ✅ Mesure sur les 18 fenêtres de la session 15:16:47, entre `Started local extension host` et soit la 1re ligne de `exthost.log`, soit la mort : **11 vivantes à 1,80–1,93 s**, **7 mortes à 1,20–1,25 s**. Sept plantages dans 50 ms d'écart.
3. ✅ Conclusion : un **délai d'attente qui expire**, pas une pénurie de ressources ni un aléa. L'hôte est abattu **avant d'ouvrir son propre `exthost.log`**, donc avant tout code d'extension, `activate()` compris — d'où l'absence systématique du dossier `exthost/` chez les fenêtres mortes.
4. ℹ️ **Le code de l'extension est hors de cause.** Toutes les hypothèses qui le visaient tombent : `execSync` (v2026.8.0.x), ABI de `usb-detection`, ressources non libérées (v2026.8.0.8). Les correctifs de la .8 restent justes en soi et sont conservés, mais ils ne traitent pas le plantage.
5. ℹ️ La v2026.8.0.7 concluait « cause : mémoire ». Écarté : une pénurie ne produit pas sept morts à 50 ms d'écart.
6. ✅ Suspect restant : l'**attachement du débogueur** — seul mécanisme imposant un délai fixe à cet instant, et cohérent avec le seul gain déjà obtenu (retrait de `runtimeExecutable`).
7. ✅ Configuration **« Launch Extension (sans debogueur) »** ajoutée (`noDebug: true`) et `"trace": true` posé sur la configuration normale pour capturer le journal js-debug.
8. ⏳ **À faire par Frank — test discriminant** : lancer « Launch Extension (sans debogueur) » une dizaine de fois d'affilée. Aucun plantage → l'attachement du débogueur est la cause. Plantages identiques → chercher dans l'initialisation de l'hôte (verrou `workspaceStorage`, chargement des ~40 extensions installées).
9. ℹ️ `--disable-extensions`, ajouté en v2026.8.0.7, ne figure plus dans `launch.json` ; les journaux montrent de toute façon cortex-debug et consorts toujours chargés.

# v2026.8.0.8 — Plantage 134 : cause trouvée, ressources non libérées à l'arrêt

1. ✅ Corrélation établie sur cinq sessions de `main.log` : le code 134 tombe **à la fermeture** d'un hôte d'extensions, jamais pendant son fonctionnement. Les fermetures propres sortent en `code: 0`. Exemple net (session 15:50:52) : l'hôte 24072 sort en 0 et l'hôte 30524, démarré 1,2 s plus tôt, sort en 134 **à la même milliseconde**.
2. ℹ️ **Correction des diagnostics précédents.** La v2026.8.0.7 concluait « cause : mémoire, l'hôte s'avorte faute de tas ». Faux : `abort()` sans le moindre vidage mémoire n'est pas une pénurie, c'est VS Code qui abat un hôte qui refuse de se terminer. Les ~1,2 s observées sont le délai d'arrêt accordé, pas un délai de démarrage.
3. ✅ Trois ressources empêchaient la boucle d'événements de se vider : le serveur HTTP local (`localWebServer.ts`) **jamais fermé**, le `setInterval` de 5 s du panneau d'accueil, et les quatre `setTimeout` de démarrage différé de `extension.ts` (200 ms, 5 s, 8 s, 20 s). `deactivate()` n'appelait que `stopListening()`.
4. ✅ `LocalWebServer.stop()` ajouté : `closeAllConnections()` puis `close()`. Sans la coupure des sockets maintenues ouvertes par les vues, `close()` attend indéfiniment.
5. ✅ `ArduinoContentProvider.dispose()` ajouté : ferme le serveur, élimine l'émetteur d'événements.
6. ✅ `ArduinoHomePanel.disposeCurrent()` ajouté : élimine le panneau resté ouvert, donc son minuteur.
7. ✅ `extension.ts` : le fournisseur de contenu est remonté au niveau module (il était local à `activate()`, donc hors de portée de `deactivate()`), les minuteurs différés sont enregistrés et annulables, et `deactivate()` libère tout avec chaque étape isolée en `try/catch`.
8. ✅ Trou réel bouché : `debuggerManager.ts` appelait `require("usb-detection")` **sans le garde-fou ABI** ajouté en v2026.8.0.7 dans `usbDetector.ts`. Or `activationEvents` contient `onDebug`, donc ce chemin s'exécute. Nouveau module `src/common/usbDetectionLoader.ts` : chargeur unique, garde-fou ABI, cache ; les deux appelants y passent désormais.
9. ✅ `startListening()` était appelé sans `.catch()` dans un `setTimeout` — un rejet non géré. Corrigé.
10. ✅ Construction et `tslint` propres.
11. ⏳ À valider par Frank : plusieurs F5 d'affilée, en fermant chaque fenêtre de test, sans plantage.

# v2026.8.0.7 — F5 : `--disable-extensions` enfin appliqué

1. ✅ Journaux frais capturés sur deux plantages consécutifs (14:03:58 et 14:05:07) : signature identique aux précédents — 60 lignes de `renderer.log`, aucun `exthost.log`, `crashed with code 134`.
2. ✅ L'hôte d'extensions meurt à **1,2 s** du démarrage, **avant d'avoir écrit une seule ligne**. Chez une fenêtre qui survit, la ligne suivante est toujours le `[DEP0040] punycode` émis par l'hôte lui-même ; chez une fenêtre qui plante, elle n'arrive jamais.
3. ✅ Cause : mémoire. L'hôte réserve son tas d'un coup pour charger les ~40 extensions ; s'il n'obtient pas la place il s'avorte lui-même (134 = SIGABRT, pas un processus tué de l'extérieur). Relevé au moment des plantages : 4,2 Go libres sur 15,9, VS Code seul à 5,3 Go sur 30 processus. Cela explique l'intermittence que rien d'autre n'expliquait — même configuration, 5 plantages contre 4 réussites le matin, 2 contre 1 l'après-midi.
4. ✅ Correction : `--disable-extensions` placé dans `args`, où VS Code le **reconnaît** et le transmet, sur les trois configurations de `.vscode/launch.json`.
5. ✅ `runtimeArgs` et `--user-data-dir` retirés : ni l'un ni l'autre n'était appliqué. Preuve : la fenêtre plantée de 14:03 chargeait toujours cortex-debug, docsmsft, twxs.cmake, pythonsnippets3 et nsis, et écrivait dans le profil principal.
6. ℹ️ **Correction des diagnostics précédents.** La v2026.8.0.6 affirmait que `runtimeArgs` réglait le problème : c'est faux, il est ignoré lui aussi. Les v2026.8.0.2 (« mutex coincé ») et v2026.8.0.4 (« profil trop lent à recréer ») étaient fausses également. Seul le constat du plantage lui-même tenait.
7. ℹ️ Piste du doublon **abandonnée** : `extensions.json` (le registre que VS Code lit réellement) liste 91 extensions, aucune Arduino. Les deux dossiers `electropol-fr.arduino-vscode-ide-2026.7.5` et `electropol-fr.vscode-arduino-ide-2026.4.1` sont des résidus de désinstallation sans `package.json` : VS Code ne les voit pas. Non supprimés.
8. ⏳ À valider par Frank : plusieurs F5 d'affilée, mémoire basse, sans plantage.

# v2026.8.0.6 — F5 : la vraie cause, l'hôte d'extensions qui plante

1. ✅ Le correctif de la v2026.8.0.4 n'a rien changé : la fenêtre continuait à s'ouvrir puis à se refermer.
2. ✅ Preuve dans les journaux : les fenêtres de débogage écrivaient dans le profil **principal** `%APPDATA%\Code\logs` et chargeaient les ~40 extensions installées (Copilot, Pylance, cortex-debug, Vue, .NET…). Le profil isolé n'était jamais utilisé — sa dernière session de journal datait d'un test, pas d'un F5.
3. ❌ **Faux** (voir v2026.8.0.7) — `runtimeArgs` est ignoré lui aussi. Affirmait : cause réelle = `--user-data-dir` placé dans `args` est **jeté en silence**. Pour le type `extensionHost`, VS Code filtre `args` et ne garde que les arguments qu'il reconnaît. Le profil isolé des v2026.8.0.2 et .4 n'a donc jamais été appliqué.
4. ✅ Conséquence : la fenêtre repartait sur le profil principal, empilait toutes les extensions, et l'hôte d'extensions tombait **une seconde après le démarrage** — `crashed with code 134` (SIGABRT), 8 fois dans le journal du jour. Le renderer démarrait, mais aucun `exthost.log` n'était créé.
5. ❌ **Faux** (voir v2026.8.0.7) — correctif jamais appliqué. Affirmait : `--user-data-dir` et `--disable-extensions` déplacés dans `runtimeArgs`, qui est transmis tel quel à l'exécutable, sur les trois configurations de `.vscode/launch.json`.
6. ✅ Vérifié que `--disable-extensions` ne casse rien : aucun `extensionDependencies` au manifeste, `ms-vscode.cpptools` n'est qu'une recommandation depuis la v2026.8.0.
7. ❌ **Non probant** (voir v2026.8.0.7) — testé : fenêtre ouverte, toujours vivante 28 s plus tard, journal créé dans le profil isolé, **0 plantage** — contre une mort en ~1 s auparavant.
8. ℹ️ Les diagnostics des v2026.8.0.2 (« mutex coincé ») et v2026.8.0.4 (« profil trop lent à recréer ») étaient tous deux faux. Le profil hors dépôt de la .4 reste utile, mais il ne servait à rien tant que l'argument était ignoré.

# v2026.8.0.5 — Arduino CLI mis a jour en 1.5.1

1. ✅ Verification : le binaire embarque dans `arduino-cli/` etait en **1.4.1**, la derniere version publiee par Arduino est la **1.5.1** (5 juin 2026).
2. ✅ Aucun changement de code necessaire : `src/arduino/cliDownloader.ts` n'ecrit aucun numero en dur, il interroge l'API GitHub « derniere version » a chaque fois. Le retard venait seulement du fichier livre avec le projet.
3. ✅ Ancien binaire 1.4.1 conserve dans `A Examiner/arduino-cli-1.4.1/` (executable + VERSION + licence), rien d'efface.
4. ✅ Binaire 1.5.1 installe dans `arduino-cli/`, fichier `VERSION` mis a jour.
5. ✅ Nouveautes recuperees : le croquis ne se recompile plus quand rien n'a bouge (et le defaut inverse, « croquis cru a jour alors qu'il ne l'est pas », corrige en 1.5.1) ; les bibliotheques listees dans un profil mais non utilisees ne sont plus compilees ; une plateforme peut declarer ses bibliotheques requises ; messages parasites d'installation supprimes.
6. ✅ Aucune rupture pour l'extension : les deux commandes dont la sortie est relue (`board list --format json` et `config dump --json`) rendent exactement la meme structure qu'avant.
7. ✅ Verifie : construction (`npm run build:ext`) OK, **47 tests passent**, compilation reelle d'un croquis Blink pour Arduino UNO reussie avec le nouveau binaire.

# v2026.8.0.4 — F5 : le profil de débogage sort du projet

1. ✅ Symptôme revenu : la fenêtre « Extension Development Host » s'ouvrait puis se refermait aussitôt.
2. ✅ Vraie cause (le diagnostic « mutex coincé » de la v2026.8.0.2 était faux) : le dossier de profil `.vscode-test-profile` avait disparu. Quand il manque, VS Code doit le reconstruire de zéro — **environ 40 secondes**. Le débogueur attend la fenêtre bien moins longtemps, conclut à un échec, et ferme tout.
3. ✅ Mesuré : lancement avec profil existant → fenêtre en quelques secondes. Lancement avec profil absent → première fenêtre à ~40 s (journal détaillé capturé, aucune erreur dedans, juste la lenteur).
4. ✅ Piège de fond : le profil était **dans** le projet et listé au `.gitignore`. Chaque `git clean`, changement de machine ou nettoyage de disque l'effaçait — et le F5 suivant échouait à nouveau. Le remède de la v2026.8.0.2 s'auto-détruisait.
5. ✅ Correction : les trois configurations de `.vscode/launch.json` pointent désormais vers `${env:LOCALAPPDATA}/Arduino-VsCode-IDE-debug-profile`, hors du dépôt. Plus aucun nettoyage du projet ne peut l'effacer.
6. ✅ `.gitignore` : ligne `.vscode-test-profile` retirée, l'ancien dossier n'existe plus dans le projet.
7. ✅ Profil pré-créé sur la machine : le premier F5 de la journée démarre déjà vite.
8. ℹ️ Rappel : ce profil démarre sans les extensions ni les réglages de l'instance principale — c'est l'environnement propre voulu pour mettre au point une extension.

# v2026.8.0.3 — Panneau de sortie : messages entre crochets colorises

1. ✅ Demande : coloriser `[Démarrage]`, `[Terminé]`, `[Avertissement]`, `[Erreur]` selon leur sens, dans toutes les langues, avec des couleurs qui suivent le thème clair ou foncé.
2. ✅ Défaut trouvé : `syntaxes/arduino.output.tmLanguage` existait déjà et était bien déclaré dans `package.json`, mais **ne s'appliquait jamais** — `createOutputChannel("Arduino")` ne rattachait le panneau à aucun langage. Second argument `"arduino-output"` ajouté : la coloration s'active enfin.
3. ✅ Deuxième défaut : l'ancienne grammaire reconnaissait les mots traduits **en dur** (`Erreur|Fehler|エラー`…). Toute langue non prévue perdait sa couleur.
4. ✅ Correction : `src/common/outputChannel.ts` ajoute en fin de ligne un caractère **invisible** propre à chaque catégorie (`U+200B` démarrage, `U+200C` terminé, `U+200D` avertissement, `U+2060` erreur). La grammaire reconnaît ce repère, plus le mot — donc n'importe quelle langue, y compris celles ajoutées plus tard.
5. ✅ Couleurs (jetons du thème, donc adaptées clair/foncé automatiquement) : `[Démarrage]` et `[Terminé]` → `token.info-token` (bleu), `[Avertissement]` → `token.warn-token` (jaune-orange), `[Erreur]` → `token.error-token` (rouge).
6. ✅ Le texte du message derrière le crochet reste en couleur normale — l'ancienne grammaire le peignait en `string` (orange), ce qui saturait le panneau.
7. ✅ Règle de repli conservée : une ligne `[Quelque chose]` sans repère (sortie d'un outil externe) garde le bleu d'information.
8. ✅ Transtypage sur `createOutputChannel` : les typages `@types/vscode` du projet sont figés en 1.56 et ignorent cette surcharge, disponible depuis la 1.57. Les monter exigerait aussi de monter TypeScript (3.9 aujourd'hui, incapable de lire les typages récents) — hors périmètre, donc contourné localement avec un commentaire explicatif.
9. ✅ Vérifié : `tsc --noEmit` sans erreur, `npm run lint` propre, `npm run build:ext` OK, simulation des expressions sur 9 lignes types (fr, en, de, ja, sans repère) toutes correctement classées.
10. ⏳ À vérifier sur une instance VS Code réelle : rendu des couleurs sur un thème clair et un thème foncé, après un Vérifier et un Téléverser.
# v2026.8.0.2 — F5 : la fenêtre de débogage ne se referme plus toute seule

1. ✅ Symptôme : à chaque F5, la fenêtre « Extension Development Host » s'ouvrait puis disparaissait aussitôt.
2. ✅ Cause (hors code de l'extension) : VS Code pose un jeton unique (« mutex ») pour signaler qu'une instance tourne. Ce jeton restait coincé (`Error: Error mutex already exists` dans le journal, plus de 40 processus `Code` résiduels). La nouvelle fenêtre était alors renvoyée vers l'instance existante et fermée immédiatement.
3. ✅ Vérifié : une fenêtre lancée **sans** `--extensionDevelopmentPath` mourait pareil — l'extension était hors de cause. Avec un profil isolé (`--user-data-dir`), la fenêtre survit.
4. ✅ `.vscode/launch.json` : `--user-data-dir=${workspaceRoot}/.vscode-test-profile` ajouté aux trois configurations (Launch Extension, Launch Tests, Launch Extension in Development). Le débogage utilise désormais son propre profil, séparé de l'instance de travail.
5. ✅ `.gitignore` : `.vscode-test-profile` ajouté. Le paquet publié n'est pas concerné, `.vscode/**` étant déjà exclu par `.vscodeignore`.
6. ✅ Testé en conditions réelles : la fenêtre de développement reste ouverte. Suite de tests **47 passing**.
7. ℹ️ Effet de bord voulu : ce profil démarre vierge (pas les extensions ni les réglages de l'instance principale) — c'est l'environnement propre recommandé pour mettre au point une extension.

# v2026.8.0.1 — Panneau de sortie : plus d'ouverture pendant l'analyse IntelliSense

1. ✅ Cause : `src/arduino/arduino.ts` appelait `arduinoChannel.show()` pour **tous** les modes de construction, y compris `BuildMode.Analyze` — la compilation de fond qui sert uniquement à générer la configuration IntelliSense. Le panneau « Arduino » s'ouvrait donc tout seul à chaque analyse (ouverture de croquis, changement de carte, enregistrement).
2. ✅ `show()` désormais conditionné à `buildMode !== BuildMode.Analyze` : seules les vraies compilations (Vérifier, Téléverser, Téléverser via programmateur) affichent le panneau.
3. ✅ `clearOutputOnBuild` (effacement du panneau) déplacé dans le même test : une analyse de fond n'efface plus le journal de la compilation précédente.
4. ✅ Les messages de l'analyse continuent d'être écrits dans le panneau — ils sont simplement consultables sans être imposés.
5. ✅ Vérification des types (`tsc --noEmit`) : aucune erreur.

# v2026.8.0 — `ms-vscode.cpptools` : dépendance dure → recommandation

1. ✅ Cause : `extensionDependencies: ["ms-vscode.cpptools"]` forçait l'installation de C/C++ alors que l'extension n'appelle **aucune** de ses API — le seul lien est le fichier `.vscode/c_cpp_properties.json` généré par `src/arduino/intellisense.ts`, que cpptools lit pour l'IntelliSense.
2. ✅ Blocage Open VSX : `ms-vscode.cpptools` n'y est pas publié (licence Microsoft, non redistribuable) → sur VSCodium/Gitpod l'installation échouait avec « dépendance introuvable », rendant la publication Open VSX inutilisable.
3. ✅ `package.json` : bloc `extensionDependencies` supprimé. Compilation, téléversement, moniteur série, gestionnaires de cartes/bibliothèques : aucun impact (aucun appel à cpptools dans `src/`).
4. ✅ Coloration syntaxique préservée : elle vient de `syntaxes/arduino.tmLanguage` + la grammaire `cpp` native de VS Code, pas de cpptools.
5. ✅ `src/arduino/extensionRecommendation.ts` : logique factorisée (`shouldRecommend` + `promptRecommendation`) et nouvelle `recommendCppTools()` — notification douce proposant d'installer C/C++, affichée **uniquement** si cpptools est absent **et** que la génération IntelliSense est active (`isCompilerParserEnabled()`).
6. ✅ Même cadence que Kablix : premier lancement + après chaque mise à jour, état dans `globalState` (`arduino.cppToolsRecommendation`), boutons « Installer C/C++ » / « Plus tard » / « Ne plus proposer ». Repli sur la recherche du Marketplace si l'installation automatique échoue (cas Open VSX).
7. ✅ Appel non bloquant dans `extension.ts` à 20 s (après Kablix à 8 s) pour ne jamais empiler deux notifications.
8. ✅ `gulpfile.js` : suppression du hack qui vidait puis restaurait `extensionDependencies` autour de `npm test` (et de l'import `fs` devenu inutile) — devenu sans objet.
9. ✅ Traductions FR ajoutées à `l10n/bundle.l10n.fr.json` (3 chaînes).
10. ✅ README : nouvelle section « C/C++ extension (optional) » sous *Prerequisites*, mentionnant clangd comme solution de repli sur les éditeurs sans Marketplace Microsoft.
11. ✅ Build + lint OK, suite de tests **47 passing** — dont la suite exécutée pour la première fois sans le contournement du gulpfile.
12. ℹ️ `shouldRecommendKablix` conservé comme alias de `shouldRecommend` (compatibilité des tests existants).

# v2026.7.5 — Recommandation de l'extension Kablix

1. ✅ `src/arduino/extensionRecommendation.ts` : notification recommandant `electropol-fr.kablix` (simulateur Arduino et Pico pi, C/C++ et MicroPython).
2. ✅ Déclenchement au **premier lancement** et **après chaque mise à jour** : la version de l'extension du dernier affichage est mémorisée dans `globalState` (`arduino.kablixRecommendation`) ; un numéro de version différent rejoue la proposition.
3. ✅ Pas de notification si Kablix est déjà installée. Boutons : « Installer Kablix » (installe via `workbench.extensions.installExtension`), « Plus tard », « Ne plus proposer » (silence définitif).
4. ✅ Marquage « affiché » **avant** l'attente de la réponse : fermer la notification sans répondre ne la fait pas revenir à l'activation suivante.
5. ✅ Appel non bloquant dans `extension.ts` (`setTimeout` 8 s, après le contrôle de mise à jour du CLI) — aucun impact sur le chemin critique d'activation.
6. ✅ Repli si l'installation automatique échoue : avertissement + ouverture du Marketplace filtré sur `@id:electropol-fr.kablix`.
7. ✅ Traductions FR ajoutées à `l10n/bundle.l10n.fr.json` (texte exact demandé, avec guillemets français).
8. ✅ 8 assertions vérifiées sur `shouldRecommendKablix` (premier lancement, mise à jour, même version, déjà installée, refus définitif, version inconnue) + `test/extensionRecommendation.test.ts` ajouté à la suite.

# v2026.7.4 — Traduction française du Marketplace + fuites de ressources

1. ✅ `package.nls.fr.json` créé : 48 clés traduites (titres de commandes, noms de vues, descriptions des réglages). Parité vérifiée par script — aucune clé manquante ni en trop, toutes les clés `%…%` de `package.json` résolues.
2. ✅ Terminologie alignée sur Arduino IDE 2 en français : « Vérifier », « Téléverser », « Croquis », « Gestionnaire de bibliothèques », « programmateur ».
3. ✅ `deviceContext.dispose()` : `_sketchStatusBar` désormais libéré (l'instance est déjà dans `context.subscriptions`, donc réellement appelé).
4. ✅ `completionProvider` : ajout d'un `dispose()` libérant son `FileSystemWatcher`, **et** enregistrement de l'instance dans `context.subscriptions` — le disposable de `registerCompletionItemProvider` ne libère que l'enregistrement, pas l'instance, donc le watcher fuyait à chaque désactivation.
5. ℹ️ `arduino.view.container.title` reste « Arduino » en français (nom propre) ; 4 clés définies mais non référencées dans `package.json` (`view.launcher`, `view.boardManager`, `view.libraryManager`, `view.examples`) — préexistant, hors périmètre.
6. ⬜ Non vérifié : rendu réel des chaînes traduites dans une instance VS Code configurée en français.

# v2026.7.3 — Détection de l'arduino-cli embarqué dans Arduino IDE 2

1. ✅ Cause : Arduino IDE 2 embarque son propre `arduino-cli` dans ses ressources internes (`resources/app/lib/backend/resources`) **sans l'exposer au PATH**. Les 3 étapes de résolution échouaient toutes (réglage `arduino.path` non défini, `where arduino-cli` négatif, dossier `arduino-cli/` exclu du VSIX) → prompt de téléchargement affiché alors qu'un CLI valide était installé.
2. ✅ `win32.ts` : repli sur `%ProgramFiles%`, `%ProgramFiles(x86)%` et `%LOCALAPPDATA%\Programs` + `Arduino IDE\resources\app\lib\backend\resources`.
3. ✅ `darwin.ts` : repli sur `/Applications` et `~/Applications` + `Arduino IDE.app/Contents/Resources/app/lib/backend/resources`.
4. ✅ `linux.ts` : repli sur `/opt`, `/usr/local/share`, `/usr/share`, `~/.local/share`, `~` (dossiers `arduino-ide` / `Arduino IDE`).
5. ✅ Le repli ne s'active que si le PATH n'a rien donné : aucun changement de comportement pour un CLI déjà dans le PATH.
6. ✅ Effet de bord bénéfique : `applyCliConfigDirectories()` interroge ce CLI et récupère les dossiers réels de l'IDE 2 (`arduino-cli.yaml`) → cartes et sketchbook partagés avec l'IDE, sans duplication.
7. ✅ Vérifié à l'exécution sous Windows (vrai code compilé) : `resolveArduinoPath()` → `C:\Program Files\Arduino IDE\resources\app\lib\backend\resources`, `usableCli` = true.
8. ⏳ macOS et Linux non testés sur machine réelle (chemins déduits du packaging Electron).
9. ⏳ AppImage Linux non couvert : ressources montées dans un dossier temporaire imprévisible → `arduino.path` reste nécessaire pour ce format.

# v2026.7.1 — Régression 2026.7.0 : plus aucune carte ni bibliothèque

1. ✅ Cause : sans `arduino-cli` présent, le prompt de téléchargement était `await` dans le chemin critique d'activation → VS Code annulait l'activation (« Canceled ») → `boardManager` jamais créé → tous les handlers du webview en échec (cartes, bibliothèques, exemples, config vides).
2. ✅ `arduinoActivator` : le prompt de téléchargement du CLI passe **hors du chemin critique** (non bloquant). Les cartes/bibliothèques déjà installées se chargent depuis les fichiers d'index sans CLI. Après téléchargement, réinit des réglages + rechargement cartes/bibliothèques.
3. ✅ `arduinoSettings.usableCli` : détection d'un `arduino-cli` réellement invocable (le binaire existe), au lieu de se fier à `arduinoPath` (qui peut désigner un IDE Arduino 1.x sans CLI).
4. ✅ `tryResolveArduinoPath` : un `arduino-cli` téléchargé par l'extension prime sur un chemin Arduino résolu qui ne fournit pas de CLI.

# v2026.7.0 — Audit complet : 25 bugs corrigés + réduction du VSIX

## Bugs critiques
1. ✅ `libraryManager`/`arduinoSettings` : les bibliothèques installées n'étaient pas détectées — l'extension lisait le sketchbook depuis le registre Windows (`H:\OneDrive\Documents\Arduino`) au lieu de la config réelle du CLI (`arduino-cli config dump` → `directories.user` = `h:\Nuage\Documents\Arduino`). Idem pour `directories.data` (packages). **Bug n°1 du todo résolu.**
2. ✅ `util.ts cp()` : condition inversée — la copie de fichier ne copiait jamais (et pouvait tronquer un fichier copié sur lui-même). « Ouvrir un exemple » mono-fichier créait un dossier vide.
3. ✅ `arduino.ts setPref()` : commande CLI invalide (`--build-property` en flag racine) — les URLs additionnelles (ESP32, STM32…) n'étaient jamais transmises au CLI → plateformes tierces invisibles. Remplacé par `--additional-urls` passé à `core install` / `update-index`.
4. ✅ `arduinoActivator` : une activation échouée (réseau coupé…) restait en cache pour toute la session — toutes les commandes mortes jusqu'au reload. Le cache est maintenant purgé pour permettre un nouvel essai.

## Bugs majeurs
5. ✅ « Refresh index » n'exécutait rien (`core/lib install dummy` au lieu de `update-index`) — nouvelles libs/versions invisibles à jamais.
6. ✅ Exit code 1 du CLI traité comme succès : tout échec d'installation (réseau, nom introuvable) affichait « Installed » — l'erreur remonte maintenant au webview (HTTP 500).
7. ✅ `configurationProvider` : `output: "."` dans arduino.yaml + F5 supprimait récursivement **tout le workspace** — garde-fou ajouté (le dossier de sortie doit être un sous-dossier strict).
8. ✅ `debuggerManager` : chemin OpenOCD non quoté — debug impossible si nom d'utilisateur Windows avec espace.
9. ✅ `boardManager` : fuite de listeners à chaque ouverture du Board Manager (analyses IntelliSense et rechargements en cascade).
10. ✅ `arduino.ts includeLibrary()` : glob avec backslashes Windows — « Include Library » n'insérait aucun `#include`.
11. ✅ Flags de compilation (`--library`, `--build-property`) passés à `arduino-cli upload` → « Upload using CLI » échouait si customLibraryPath défini.
12. ✅ `libraryManager` : index JSON corrompu ou `library.properties` sans `name` → vue bloquée sur « Loading... » pour toujours (+ réponse HTTP 500 systématique dans `arduinoContentProvider`).
13. ✅ `extension.ts` : activation au démarrage sans `.catch` → échec silencieux, extension morte sans message.
14. ✅ `extension.ts selectSketch` : `replace("\\", "/")` ne convertissait que le premier backslash → exclusions de recherche inopérantes.
15. ✅ Ouverture d'un `.pde` : double renommage (2 listeners) → exception ENOENT + fermeture d'éditeur intempestive.

## Bugs mineurs
16. ✅ `win32.ts` : `where arduino-cli` multi-résultats (choco + winget) → chemin poubelle multi-lignes.
17. ✅ `configurationProvider` : `indexOf > 0` ratait `${file}` en début de commande gdb + replace non global.
18. ✅ `usbDetector` : promesses flottantes sans `.catch` (update index, install board) → unhandled rejections.
19. ✅ `extension.ts commandExecution` : erreurs avalées sans notification — l'utilisateur voyait des commandes « qui ne font rien ».
20. ✅ `cliDownloader` : coupure réseau pendant le téléchargement du CLI → notification de progression bloquée à l'infini.
21. ✅ `boardManager updatePackageIndex` : écriture de config non attendue (race avec relecture immédiate).
22. ✅ `programmer.ts` : regex de split `[\r|\r\n|\n]` splittait aussi sur `|`.
23. ✅ `arduino.ts installBoard` : nettoyage pré-install sur un chemin qui n'existe jamais — supprimé (le CLI gère le remplacement).
24. ✅ `arduinoHomePanel` : traductions injectées dans du JS entre quotes simples (cassait si apostrophe) + variables inutilisées nettoyées.
25. ✅ README : lien image `<images/Doc-Page 1.png>` mal réécrit par vsce → **image cassée sur le Marketplace** ; remplacé par `%20`.

## Réduction du VSIX (.vscodeignore)
1. ✅ Bug corrigé : `images/examples/**` était exclu alors que l'arbre d'exemples l'utilise à l'exécution (icônes manquantes en prod)
2. ✅ Exclus en plus : `todo.md` (était publié !), `images/Doc-Page 1.png` (243 Ko, servie par GitHub via le README réécrit), prebuilds serialport Android (228 Ko), sources C++ de serialport/usb-detection (~110 Ko), polices .eot/.ttf des webviews (64 Ko), libs uuid navigateur
3. ✅ ~650 Ko de moins dans le VSIX décompressé (~10 %)

## Fichiers supprimables du repo (RIEN n'a été supprimé)
- `images/serialMonitor - Copie.svg`, `images/serialTracer-V1.svg`, `images/upload-v1.svg`, `images/verify-V1.svg` (anciennes versions d'icônes, non référencées)
- `images/ArduinoCommunityLogo_Complet.svg`, `images/ArduinoCommunityLogo_Couleur.svg` (non référencées ; seule `_Gris.svg` est utilisée)
- `arduino.log`, `debug.log` (journaux d'exécution)
- `arduino-vscode-ide-2026.06.1.vsix` (artefact régénérable)
- `azure-pipelines.yml`, `build/` (pipeline Azure DevOps de Microsoft ; la CI est sur GitHub Actions et ne les référence pas)
- `.ackrc` (config de l'outil `ack`, obsolète)
- `NEWS.md` (annonces historiques Microsoft)
- `.vscode-test/` (cache de tests, retéléchargé automatiquement)
- ⚠️ NON supprimables : `typings/` (déclare `vscode.l10n` pour la compilation), `tslint.json` (utilisé par `npm run lint`), `misc/` (mappings usb/débogueur utilisés à l'exécution), `snippets/sample.ino` (utilisé par « nouveau projet »)

# v2026.06.1
1. ✅ les mots de code tels que HIGH, pinMode ou encore millis sont soulignés en rouge
2. ✅ Réouverture de l'onglet VsCode Arduino : suivait le mauvais groupe d'éditeurs / largeur minimale
