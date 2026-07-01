import type { LocaleResource } from './en'

const fr: LocaleResource = {
  common: {
    save: 'Enregistrer',
    cancel: 'Annuler',
    delete: 'Supprimer',
    confirm: 'Confirmer',
    close: 'Fermer',
    edit: 'Modifier',
    rename: 'Renommer',
    duplicate: 'Dupliquer',
    remove: 'Retirer',
    open: 'Ouvrir',
    create: 'Créer',
    add: 'Ajouter',
    done: 'Terminé',
    back: 'Retour',
    next: 'Suivant',
    search: 'Rechercher',
    clear: 'Effacer',
    loading: 'Chargement…',
    copy: 'Copier',
    copied: 'Copié',
    download: 'Télécharger',
    upload: 'Téléverser',
    export: 'Exporter',
    import: 'Importer',
    yes: 'Oui',
    no: 'Non',
    enabled: 'Activé',
    disabled: 'Désactivé',
    on: 'Activé',
    off: 'Désactivé',
    learnMore: 'En savoir plus',
    options: 'Options',
    settings: 'Paramètres',
    preferences: 'Préférences',
    help: 'Aide',
    pin: 'Épingler',
    unpin: 'Désépingler',
    star: 'Mettre en favori',
    unstar: 'Retirer des favoris',
    archive: 'Archiver',
    unarchive: 'Désarchiver',
    restore: 'Restaurer',
    moveToTrash: 'Mettre à la corbeille',
    deletePermanently: 'Supprimer définitivement',
    protect: 'Protéger',
    unprotect: 'Déprotéger',
  },
  navigation: {
    notes: 'Notes',
    allNotes: 'Toutes les notes',
    files: 'Fichiers',
    starred: 'Favoris',
    archived: 'Archivées',
    trash: 'Corbeille',
    untagged: 'Sans sujet',
    conflicts: 'Conflits',
    views: 'Vues',
    smartViews: 'Vues intelligentes',
    tags: 'Sujets',
    folders: 'Dossiers',
    favorites: 'Favoris',
    dashboard: 'Tableau de bord',
    createNewNote: 'Créer une nouvelle note',
    createNewTag: 'Créer un nouveau sujet',
    createNewFolder: 'Créer un nouveau dossier',
    createNewSmartView: 'Créer une nouvelle vue intelligente',
    searchTags: 'Rechercher des sujets…',
    noTagsFound: 'Aucun sujet trouvé. Essayez une autre recherche.',
    noSmartViewsFound: 'Aucune vue intelligente trouvée. Essayez une autre recherche.',
    collapseTagsPanel: 'Réduire le panneau des sujets',
    expandTagsPanel: 'Développer le panneau des sujets',
    goToItemsList: 'Aller à la liste des éléments',
    goToAccountMenu: 'Aller au menu du compte',
    openPreferences: 'Ouvrir les préférences',
  },
  account: {
    account: 'Compte',
    signIn: 'Se connecter',
    signOut: 'Se déconnecter',
    signUp: "S'inscrire",
    register: "S'inscrire",
    you: 'Vous',
    encryptionOn: 'Chiffrement de bout en bout activé',
    notSignedIn: 'Vous n’êtes pas connecté',
    signInOrRegister: 'Connectez-vous ou inscrivez-vous pour synchroniser vos notes',
    email: 'Adresse e-mail',
    password: 'Mot de passe',
    confirmPassword: 'Confirmer le mot de passe',
    syncNow: 'Synchroniser maintenant',
    lastSynced: 'Dernière synchronisation',
    importData: 'Importer',
    switchWorkspace: 'Changer d’espace de travail',
    lockApplication: 'Verrouiller l’application',
    helpAndFeedback: 'Aide et commentaires',
  },
  preferences: {
    title: 'Préférences',
    general: 'Général',
    account: 'Compte',
    security: 'Sécurité',
    appearance: 'Apparence',
    backups: 'Sauvegardes',
    listed: 'Listed',
    plugins: 'Extensions',
    whatsNew: 'Nouveautés',
    helpAndFeedback: 'Aide et commentaires',
    language: 'Langue',
    languageTitle: 'Langue',
    languageDescription:
      "Choisissez la langue utilisée dans toute l'interface de l'application. L'application utilise l'anglais pour ce qui n'est pas encore traduit.",
    languageChanged: 'Langue mise à jour',
    defaults: 'Valeurs par défaut',
    tools: 'Outils',
    spellcheck: 'Vérification orthographique',
    labs: 'Laboratoires',
  },
  editor: {
    // Clipboard
    cut: 'Couper',
    copy: 'Copier',
    paste: 'Coller',
    moreCutOptions: 'Plus d\'options de coupe',
    moreCopyOptions: 'Plus d\'options de copie',
    morePasteOptions: 'Plus d\'options de collage',

    // History / navigation
    tableOfContents: 'Table des matières',
    selectAll: 'Tout sélectionner',
    selectAllText: 'Sélectionner uniquement le texte',
    deselectAll: 'Tout désélectionner',
    search: 'Rechercher',
    undo: 'Annuler',
    redo: 'Rétablir',
    undoHistory: 'Historique des annulations',
    redoHistory: 'Historique des rétablissements',
    undoHistoryEmpty: 'Historique des annulations — rien à annuler pour l\'instant',
    undoHistoryAvailable: 'Historique des annulations — revenir plusieurs étapes en arrière d\'un coup',
    redoHistoryEmpty: 'Historique des rétablissements — rien à rétablir',
    redoHistoryAvailable: 'Historique des rétablissements — avancer plusieurs étapes d\'un coup',

    // Text formatting
    formattingOptions: 'Options de mise en forme',
    bold: 'Gras',
    italic: 'Italique',
    underline: 'Souligné',
    strikethrough: 'Barré',
    inlineCode: 'Code en ligne',
    link: 'Lien',
    formatPainter: 'Reproduire la mise en forme — copier la mise en forme (double-cliquer pour conserver)',
    textStyle: 'Style de texte',
    textColor: 'Couleur du texte',
    highlightColor: 'Couleur de surlignage',
    typography: 'Typographie — accentuation, contour, espacement des lettres et des mots',
    typographyTitle: 'Typographie',

    // Font size / family
    fontSize: 'Taille de police',
    chooseFontSize: 'Choisir la taille de police',
    decreaseFontSize: 'Réduire la taille de police',
    increaseFontSize: 'Augmenter la taille de police',
    fontFamily: 'Police',
    customFontFamily: 'Personnalisée',

    // Blocks / lists
    bulletedList: 'Liste à puces',
    numberedList: 'Liste numérotée',
    checkList: 'Liste de contrôle',
    quote: 'Citation',
    codeBlock: 'Bloc de code',
    changeCase: 'Changer la casse',
    sortAndDedupeLines: 'Trier et dédupliquer les lignes',
    alignment: 'Alignement',
    paragraphLayout: 'Mise en page du paragraphe — espacement des lignes et des paragraphes, indentation, ombrage',
    paragraphLayoutTitle: 'Mise en page du paragraphe',
    listStyleMarker: 'Style de liste — marqueur de puce et de numéro',
    formattingMarks: 'Marques de mise en forme',
    insert: 'Insérer',

    // Contextual table tools
    insertRowAbove: 'Insérer une ligne au-dessus',
    insertRowBelow: 'Insérer une ligne en dessous',
    insertColumnLeft: 'Insérer une colonne à gauche',
    insertColumnRight: 'Insérer une colonne à droite',
    deleteRow: 'Supprimer la ligne',
    deleteColumn: 'Supprimer la colonne',
    toggleRowHeader: 'Activer/désactiver l\'en-tête de ligne',
    toggleColumnHeader: 'Activer/désactiver l\'en-tête de colonne',
    deleteTable: 'Supprimer le tableau',

    // Contextual ribbon segment captions (Office-style grouping)
    rows: 'Lignes',
    columns: 'Colonnes',
    cells: 'Cellules',
    table: 'Tableau',
    block: 'Bloc',

    // Contextual image tools
    alignLeft: 'Aligner à gauche',
    alignCenter: 'Centrer',
    alignRight: 'Aligner à droite',

    // Contextual link tools
    editLink: 'Modifier le lien',
    removeLink: 'Supprimer le lien',

    // Zoom
    zoomIntoBlock: 'Zoomer sur le bloc',

    // Floating selection toolbar
    blockStyle: 'Style de bloc',
    heading1: 'Titre 1',
    heading2: 'Titre 2',
    heading3: 'Titre 3',
    normalText: 'Texte normal',
    moreFormatting: 'Plus de mise en forme',

    // Note from selection
    createNoteFromSelectionTitle: 'Créer une note à partir de la sélection',
    createNoteFromSelectionDescription:
      'Crée une nouvelle note contenant la sélection actuelle et remplace la sélection par un lien vers la nouvelle note.',

    // Mobile
    dismissKeyboard: 'Masquer le clavier',

    // Popover titles / a11y labels
    tableOfContentsLower: 'Table des matières',
    noHeadingsFound: 'Aucun titre trouvé',
    textFormattingOptions: 'Options de mise en forme du texte',
    highlight: 'Surligner',
    subscript: 'Indice',
    superscript: 'Exposant',
    clearFormatting: 'Effacer la mise en forme',
    normal: 'Normal',
    smartChecklist: 'Liste de contrôle intelligente',
    restoreCompletedTasks: 'Restaurer les tâches terminées',
    leftAlign: 'Aligner à gauche',
    centerAlign: 'Centrer',
    rightAlign: 'Aligner à droite',
    justify: 'Justifier',

    // Insert menu
    searchBlocksPlaceholder: 'Rechercher des blocs…',
    searchBlocksToInsert: 'Rechercher des blocs à insérer',
    clearSearch: 'Effacer la recherche',
    noBlocksMatch: 'Aucun bloc ne correspond à « {{query}} »',
    customizeToolbar: 'Personnaliser la barre d\'outils',

    // Color popovers
    custom: 'Personnalisé',
    clear: 'Effacer',
    textColorSwatch: 'Couleur du texte {{color}}',
    highlightColorSwatch: 'Couleur de surlignage {{color}}',
    textShadingSwatch: 'Ombrage du texte {{color}}',
    noTextShading: 'Aucun ombrage du texte',

    // Change case
    uppercase: 'MAJUSCULES',
    lowercase: 'minuscules',
    camelCase: 'camelCase',

    // Sort lines
    sortLines: 'Trier les lignes',
    deduplicate: 'Dédupliquer',
    multiKeySort: 'Tri multi-clés (1re, 2e, 3e)…',
    sortAndDeduplicateLines: 'Trier et dédupliquer les lignes',

    // Typography popover
    emphasisMarks: 'Marques d\'accentuation',
    outlineTextStroke: 'Contour (trait du texte)',
    letterSpacingKerning: 'Espacement des lettres (crénage)',
    wordSpacing: 'Espacement des mots',
    clearTypography: 'Effacer la typographie',
    spacingTight: 'Serré',
    spacingNormal: 'Normal',
    spacingWide: 'Large',
    spacingWider: 'Plus large',
    spacingWidest: 'Le plus large',

    // History popovers
    undoMultipleSteps: 'Annuler plusieurs étapes',
    redoMultipleSteps: 'Rétablir plusieurs étapes',
    emptyHistoryPreview: '(vide)',

    // Clipboard option menus
    pasteOptions: 'Options de collage',
    copyOptions: 'Options de copie',
    cutOptions: 'Options de coupe',
    pasteWithoutFormatting: 'Coller sans mise en forme',
    pasteClean: 'Coller proprement (supprimer les caractères masqués)',
    keepSourceFormatting: 'Conserver la mise en forme source',
    matchDestinationFormatting: 'Adopter la mise en forme de destination',
    pasteAsImage: 'Coller en tant qu\'image',
    copyWithoutFormatting: 'Copier sans mise en forme',
    copyTextOnly: 'Copier le texte uniquement',
    copyImagesOnly: 'Copier les images uniquement',
    cutWithoutFormatting: 'Couper sans mise en forme',
    cutTextOnly: 'Couper le texte uniquement',
    cutImagesOnly: 'Couper les images uniquement',

    // Paragraph layout popover
    lineSpacing: 'Espacement des lignes',
    spaceBefore: 'Espace avant',
    spaceAfter: 'Espace après',
    indentation: 'Indentation',
    none: 'Aucun',
    increaseLeft: 'Augmenter à gauche',
    decreaseLeft: 'Diminuer à gauche',
    increaseRight: 'Augmenter à droite',
    decreaseRight: 'Diminuer à droite',
    firstLine: 'Première ligne',
    noFirstLine: 'Aucune première ligne',
    textShading: 'Ombrage du texte',

    // List style popover
    listStyle: 'Style de liste',
    bulleted: 'À puces',
    numbered: 'Numérotée',
    bulletedListMarkers: 'Style de marqueur de puce',
    numberedListMarkers: 'Style de numérotation',
    multilevelList: 'Liste à plusieurs niveaux',
    multilevelListHint: 'Choisir un marqueur par niveau d\'imbrication',
    multilevelLevelDefault: 'Par défaut',
    level: 'Niveau',
    apply: 'Appliquer',

    // Modal titles
    insertTable: 'Insérer un tableau',
    insertImageFromUrl: 'Insérer une image depuis une URL',
    sortLinesModalTitle: 'Trier les lignes',

    // Block picker
    blockPicker: 'Sélecteur de blocs',

    // Block catalog display names
    blockParagraph: 'Paragraphe',
    blockCallout: 'Encadré',
    blockDivider: 'Séparateur',
    blockCollapsible: 'Bloc repliable',
    blockImageFromUrl: 'Image depuis une URL',
    blockUploadFile: 'Téléverser un fichier',
    blockDrawing: 'Dessin',
    blockQrCode: 'Code QR',
    blockTable: 'Tableau',
    blockKanbanBoard: 'Tableau Kanban',
    blockCalendar: 'Calendrier',
    blockTimeline: 'Chronologie',
    blockDataTable: 'Table de données',
    blockSqlQuery: 'Requête SQL',
    blockMermaidDiagram: 'Diagramme Mermaid',
    blockGanttChart: 'Diagramme de Gantt',
    blockTimingDiagram: 'Diagramme de temporisation',
    blockMusicStaff: 'Portée musicale',
    blockTradingViewChart: 'Graphique TradingView',
    blockStockChart: 'Graphique boursier',
    blockEmbed: 'Intégration',
    blockEmbedWebsite: 'Intégrer un site web',
    blockTweet: 'Tweet',
    blockEquation: 'Équation',
    blockInlineEquation: 'Équation en ligne',
    blockFootnote: 'Note de bas de page',
    blockBookmark: 'Signet',
    blockGeneratePassword: 'Générer un mot de passe cryptographiquement sûr',
    blockClock: 'Horloge',
    blockCurrentDateTime: 'Date et heure actuelles',
    blockCurrentTime: 'Heure actuelle',
    blockCurrentDate: 'Date actuelle',

    // Block catalog category headers
    blockCategoryBasic: 'Base',
    blockCategoryLists: 'Listes',
    blockCategoryMedia: 'Média',
    blockCategoryDataTables: 'Données et tableaux',
    blockCategoryDiagramsCharts: 'Diagrammes et graphiques',
    blockCategoryFinance: 'Finance',
    blockCategoryEmbeds: 'Intégrations',
    blockCategoryAdvanced: 'Avancé',
  },
  files: {
    // FileViewWithoutProtection
    dropToUploadTooltip: 'Déposez vos fichiers pour les téléverser et les lier au fichier actuel',
    fileAriaLabel: 'Fichier',
    fileReadonly: 'Ce fichier est en lecture seule',
    fileInformationPanel: 'Panneau d\'informations du fichier',
    details: 'Détails',

    // MultipleSelectedFiles
    selectedFilesCount: '{{count}} fichiers sélectionnés',
    actionsPerformedOnSelected: 'Les actions seront effectuées sur tous les fichiers sélectionnés.',
    cancelMultipleSelection: 'Annuler la sélection multiple',

    // FileContextMenu / FileOptionsPanel
    fileOptions: 'Options du fichier',
    fileContextMenu: 'Menu contextuel du fichier',
    fileOptionsMenu: 'Menu des options du fichier',
    fileOptionsPanel: 'Panneau des options du fichier',

    // FileMenuOptions
    noFilesSelected: 'Aucun fichier sélectionné',
    detachFromNote: 'Détacher de la note',
    attachToNote: 'Joindre à la note',
    passwordProtect: 'Protéger par mot de passe',
    downloadSeparately: 'Télécharger séparément',
    downloadAsArchive: 'Télécharger sous forme d\'archive',
    failedToDownloadArchive: 'Échec du téléchargement des fichiers sous forme d\'archive',
    fileId: 'ID du fichier :',
    size: 'Taille :',
    totalSize: 'Taille totale :',

    // FileContextMenuBackupOption
    backedUpOn: 'Sauvegardé le {{date}}',
    configureFileBackups: 'Configurer les sauvegardes de fichiers',
    fileNotBackedUpLocally: 'Fichier non sauvegardé localement',

    // MoveFileToFolderOption
    noFoldersYet: 'Aucun dossier pour le moment',
    moveToFolder: 'Déplacer vers un dossier',
    folderSelectionMenu: 'Menu de sélection de dossier',
    noFolder: 'Aucun dossier',

    // FilePreview
    fileProtected: 'Ce fichier est protégé.',
    authenticateToView: 'Authentifiez-vous pour afficher ce fichier.',
    addPasscodeToView: 'Ajoutez un code d\'accès ou créez un compte pour exiger une authentification afin d\'afficher ce fichier.',
    openAccountMenu: 'Ouvrir le menu du compte',
    authenticate: 'S\'authentifier',
    viewFile: 'Afficher le fichier',
    loading: 'Chargement...',

    // FilePreviewError
    fileCannotBePreviewed: 'Ce fichier ne peut pas être prévisualisé.',
    errorLoadingFile: 'Une erreur s\'est produite lors du chargement du fichier. Réessayez ou téléchargez le fichier et ouvrez-le avec une autre application.',
    tryAgain: 'Réessayer',
    downloadToView: 'Pour afficher ce fichier, téléchargez-le et ouvrez-le avec une autre application.',

    // FilePreviewInfoPanel
    fileInformation: 'Informations du fichier',
    type: 'Type :',
    decryptedSize: 'Taille déchiffrée :',
    encryptedSize: 'Taille chiffrée :',
    created: 'Créé :',
    lastModified: 'Dernière modification :',

    // FilePreviewModal
    done: 'Terminé',
    showFileOptions: 'Afficher les options du fichier',
    showFileInfo: 'Afficher les informations du fichier',
    hideFileInfo: 'Masquer les informations du fichier',
    showLinksSection: 'Afficher la section des liens',
    hideLinksSection: 'Masquer la section des liens',
    submit: 'Envoyer',
    renameFile: 'Renommer le fichier',
    showLinkedItems: 'Afficher les éléments liés',
    closeModal: 'Fermer la fenêtre',
    filePreviewModal: 'Fenêtre d\'aperçu du fichier',

    // ImageAlignmentOptions
    leftAlign: 'Aligner à gauche',
    centerAlign: 'Centrer',
    rightAlign: 'Aligner à droite',

    // VideoPreview
    videoCannotBePreviewed: 'Cette vidéo ne peut pas être prévisualisée.',

    // AudioPreview
    audioCannotBePlayed: 'Cet audio ne peut pas être lu.',
    downloadToListen: 'Pour écouter ce fichier, téléchargez-le et ouvrez-le avec une autre application.',

    // PreviewComponent
    externalAppOnly: 'Ce fichier ne peut être prévisualisé que dans une application externe',
    openFilePreview: 'Ouvrir l\'aperçu du fichier',
    loadingPdfViewer: 'Chargement de la visionneuse PDF...',

    // ZoomableImage
    zoomOut: 'Dézoomer',
    zoomIn: 'Zoomer',
    resetToActualSize: 'Rétablir la taille réelle',
    resetTo100: 'Rétablir à 100 %',
    fitToScreen: 'Ajuster à l\'écran',

    // PdfPreview
    unableToRenderPdf: 'Impossible d\'afficher ce PDF.',
    pdfCorruptedOrProtected: 'Le fichier est peut-être corrompu ou protégé par mot de passe.',
    loadingPdf: 'Chargement du PDF...',
    previousPage: 'Page précédente',
    pageNumber: 'Numéro de page',
    nextPage: 'Page suivante',
    fitWidth: 'Ajuster à la largeur',
    searchInDocumentShortcut: 'Rechercher dans le document (Ctrl/Cmd+F)',
    searchInDocument: 'Rechercher dans le document',
    copyLinkToPage: 'Copier le lien vers la page {{page}}',
    copyLinkToThisPage: 'Copier le lien vers cette page',
    copyLinkToSelectedText: 'Copier le lien vers le texte sélectionné',
    cancelOcr: 'Annuler l\'OCR',
    preparingOcr: 'Préparation de l\'OCR...',
    ocrProgress: 'OCR page {{current}} / {{total}} ({{percent}} %)',
    ocrCachedReRunTooltip: 'Texte déjà extrait (en cache). Relancez l\'OCR dans votre navigateur (reste sur votre appareil).',
    ocrExtractedReRunTooltip: 'Texte extrait. Relancez l\'OCR dans votre navigateur (reste sur votre appareil).',
    ocrExtractTooltip: 'Extraire le texte des pages numérisées avec l\'OCR. S\'exécute dans votre navigateur ; rien ne quitte votre appareil (lent ; télécharge les données linguistiques).',
    extractTextWithOcrBrowser: 'Extraire le texte avec l\'OCR dans votre navigateur',
    reRunOcrBrowser: 'Relancer l\'OCR (navigateur)',
    extractTextOcr: 'Extraire le texte (OCR)',
    serverOcrTooltip:
      'Exécuter l\'OCR sur le SERVEUR. Cela envoie les images des pages de ce PDF au serveur et QUITTE le chiffrement de bout en bout — le serveur peut lire ce contenu. L\'OCR du navigateur conserve tout sur votre appareil.',
    runOcrOnServerAria: 'Exécuter l\'OCR sur le serveur (envoie les images des pages au serveur ; quitte le chiffrement de bout en bout)',
    runOcrOnServer: 'Exécuter l\'OCR sur le serveur',
    copyAllExtractedText: 'Copier tout le texte extrait',
    copyExtractedTextAria: 'Copier le texte extrait',
    findInDocument: 'Rechercher dans le document',
    matchCase: 'Respecter la casse',
    noResults: 'Aucun résultat',
    matchOfTotal: '{{current}} sur {{total}}',
    previousMatch: 'Résultat précédent',
    nextMatch: 'Résultat suivant',
    closeSearch: 'Fermer la recherche',
    serverOcrDisclosurePrefix: 'L\'OCR serveur est disponible pour votre compte. Il envoie les images des pages de ce PDF au serveur et',
    serverOcrDisclosureBold: 'quitte le chiffrement de bout en bout',
    serverOcrDisclosureSuffix:
      ' — le serveur (et quiconque le contrôle) peut lire ce contenu. L\'OCR du navigateur conserve tout sur votre appareil. Par défaut, l\'OCR du navigateur est utilisé.',
    ocrRunningServer:
      'OCR serveur : les images des pages de ce PDF sont en cours de téléversement vers le serveur, ce qui QUITTE le chiffrement de bout en bout — le serveur peut lire ce contenu. (L\'OCR du navigateur conserve tout sur votre appareil.)',
    ocrRunningBrowser:
      'L\'OCR s\'exécute dans votre navigateur sur cet appareil (vos fichiers restent chiffrés de bout en bout). Il est lent et télécharge les données linguistiques à la première utilisation.',
    ocrDoneServer:
      'OCR serveur terminé. Les images des pages ont été envoyées au serveur (cela a quitté le chiffrement de bout en bout). La précision varie selon la qualité de la numérisation ; le texte extrait est désormais recherchable et copiable, et est mis en cache sur cet appareil.',
    ocrDoneBrowser:
      'OCR terminé. La précision varie selon la qualité de la numérisation ; le texte extrait est désormais recherchable et copiable, et est mis en cache sur cet appareil.',

    // PdfPreview toasts (call-time)
    copiedExtractedText: 'Texte extrait copié',
    copiedLinkToPage: 'Lien vers la page {{page}} copié',
    copiedLinkToSelectedText: 'Lien vers le texte sélectionné copié',

    // PdfPreview OCR errors (call-time)
    serverOcrFailed: 'Échec de l\'OCR serveur : {{message}}',
    ocrUnknownError: 'erreur inconnue',
    ocrFailed: 'Échec de l\'OCR. Le téléchargement des données linguistiques a peut-être échoué.',
  },
  notes: {
    // ContentListView
    notesAndFiles: 'Notes et fichiers',
    selectAllItems: 'Sélectionner tous les éléments',
    selectedCount: '{{count}} sélectionné(s)',
    cancelMultipleSelection: 'Annuler la sélection multiple',
    noFilesInFolder: 'Aucun fichier dans ce dossier.',
    noItems: 'Aucun élément.',
    loading: 'Chargement...',
    uploadFileWithShortcut: 'Téléverser un fichier {{shortcut}}',
    createNoteInTopicWithShortcut: 'Créer une nouvelle note dans le sujet sélectionné {{shortcut}}',
    dropFilesToUpload: 'Déposez vos fichiers pour les téléverser et les lier au sujet « {{title}} »',

    // EmptyFilesView
    noFilesYet: 'Vous n\'avez pas encore de fichiers',
    filesAttachedAppearHere:
      'Les fichiers joints à vos notes apparaissent ici. Vous pouvez également téléverser des fichiers directement depuis cette page.',
    uploadFiles: 'Téléverser des fichiers',

    // ContentListHeader
    syncing: 'Synchronisation...',
    loadingItemsProgress: 'Chargement de {{current}}/{{total}} éléments...',
    potentiallyOutOfSync: 'Potentiellement désynchronisé',
    openDisplayOptionsMenu: 'Ouvrir le menu des options d\'affichage',
    displayOptionsMenu: 'Menu des options d\'affichage',
    displayOptions: 'Options d\'affichage',
    expandTopicsPanel: 'Développer le panneau des sujets',
    collapseNotesPanel: 'Réduire le panneau des notes',

    // AddItemMenuButton
    addItem: 'Ajouter un élément',
    uploadFolder: 'Téléverser un dossier',
    takePhoto: 'Prendre une photo',
    recordVideo: 'Enregistrer une vidéo',

    // SearchButton
    searchPlaceholder: 'Rechercher...',

    // DisplayOptionsMenu
    notesListOptionsMenu: 'Menu des options de la liste des notes',
    preferencesFor: 'Préférences pour',
    global: 'Global',
    reset: 'Réinitialiser',
    upgradeForPerTopicPreferences: 'Passez à la version supérieure pour les préférences par sujet',
    perTopicPreferencesMessageWithDaily:
      'Créez des flux de travail puissants et des dispositions organisationnelles grâce aux préférences d\'affichage par sujet et à la toute nouvelle disposition calendaire du carnet quotidien.',
    perTopicPreferencesMessage:
      'Créez des flux de travail puissants et des dispositions organisationnelles grâce aux préférences d\'affichage par sujet.',
    sortBy: 'Trier par',
    relevanceBestMatch: 'Pertinence (meilleure correspondance)',
    dateModified: 'Date de modification',
    creationDate: 'Date de création',
    title: 'Titre',
    customDragToReorder: 'Personnalisé (glisser pour réorganiser)',
    view: 'Affichage',
    showNotePreview: 'Afficher l\'aperçu de la note',
    showDate: 'Afficher la date',
    showTags: 'Afficher les sujets',
    showIcon: 'Afficher l\'icône',
    other: 'Autre',
    showPinned: 'Afficher les épinglées',
    showProtected: 'Afficher les protégées',
    showArchived: 'Afficher les archivées',
    showTrashed: 'Afficher les supprimées',
    dailyNotebook: 'Carnet quotidien',
    labs: 'Labs',
    dailyNotebookDescription: 'Capturez de nouvelles notes chaque jour avec une disposition calendaire',
    tableView: 'Vue tableau',
    tableViewDescription: 'Afficher les notes et les fichiers du sujet actuel dans une disposition en tableau',
    newNoteDefaults: 'Valeurs par défaut des nouvelles notes',

    // NewNotePreferences
    noteType: 'Type de note',
    selectDefaultNoteType: 'Sélectionner le type de note par défaut',
    titleFormat: 'Format du titre',
    selectTitleFormat: 'Sélectionner le format du titre de la note',
    customFormatPlaceholder: 'ex. AAAA-MM-JJ',
    preview: 'Aperçu : ',
    useBracketsToEscape: '. Utilisez ',
    toEscapeFormatting: ' pour échapper la mise en forme.',

    // ListItemMetadata
    protected: 'Protégée',
    modified: 'Modifiée',
    now: 'Maintenant',

    // ListItemFlagIcons
    editingDisabled: 'Modification désactivée',
    trashed: 'Supprimée',
    archived: 'Archivée',
    files: 'Fichiers',
    starred: 'Favoris',
    fileBackedUpLocally: 'Le fichier est sauvegardé localement',

    // ListItemConflictIndicator
    conflictedCopy: 'Copie en conflit',

    // FilesFolderBar
    allFiles: 'Tous les fichiers',
    noFolder: 'Aucun dossier',
    folderNamePlaceholder: 'Nom du dossier',
    createNewFolder: 'Créer un nouveau dossier',
    newFolder: 'Nouveau dossier',

    // DailyContentList
    currentStreak: 'Série actuelle',
    dayWithCount_one: 'Jour',
    dayWithCount_many: 'Jours',
    dayWithCount_other: 'Jours',
  },
  auth: {
    // AdvancedOptions
    unableToComputePrivateUsername: 'Impossible de calculer le nom d\'utilisateur privé.',
    advancedOptions: 'Options avancées',
    privateUsernameMode: 'Mode nom d\'utilisateur privé',
    username: 'Nom d\'utilisateur',
    useStrictSignIn: 'Utiliser la connexion stricte',
    useRecoveryCode: 'Utiliser un code de récupération',
    recoveryCode: 'Code de récupération',

    // ConfirmNoMergeDialog
    deleteLocalDataTitle: 'Supprimer les données locales ?',
    noMergeWarning:
      'Vous avez choisi de ne pas fusionner vos données locales. Si vous continuez, vos notes et sujets locaux seront définitivement supprimés et remplacés par les données de votre compte. Cette action est irréversible.',
    noMergeConfirmQuestion: 'Voulez-vous vraiment continuer sans fusionner ?',
    deleteLocalDataAndContinue: 'Supprimer les données locales et continuer',

    // ConfirmPassword
    passwordResetWarningPart1: 'Comme vos notes sont chiffrées à l\'aide de votre mot de passe,',
    passwordResetWarningHighlight: 'Standard Red Notes ne propose pas d\'option de réinitialisation du mot de passe',
    passwordResetWarningPart2: '. Si vous oubliez votre mot de passe, vous perdrez définitivement l\'accès à vos données.',
    confirmPassword: 'Confirmer le mot de passe',
    creatingAccount: 'Création du compte...',
    createAccountAndSignIn: 'Créer un compte et se connecter',
    staySignedIn: 'Rester connecté',
    goBack: 'Retour',
    humanVerification: 'Vérification humaine',
    confirmPasswordTitle: 'Confirmer le mot de passe',

    // CreateAccount
    createAccount: 'Créer un compte',
    workspaceNameOptional: 'Nom de l\'espace de travail (facultatif)',

    // GeneralAccountMenu
    generalAccountMenuLabel: 'Menu général du compte',
    signedInAs: 'Vous êtes connecté en tant que :',
    syncing: 'Synchronisation...',
    lastSynced: 'Dernière synchronisation :',
    offlineSignInPrompt:
      'Vous êtes hors ligne. Connectez-vous pour synchroniser vos notes et préférences sur tous vos appareils et activer le chiffrement de bout en bout.',
    offline: 'Hors ligne',
    accountSettings: 'Paramètres du compte',
    createFreeAccount: 'Créer un compte gratuit',
    documentation: 'Documentation',
    keyboardShortcuts: 'Raccourcis clavier',
    commandPalette: 'Palette de commandes',
    signOutWorkspace: 'Déconnecter l\'espace de travail',

    // MergeLocalDataCheckbox
    mergeLocalData: 'Fusionner les données locales ({{count}} notes et sujets)',
    mergeLocalDataTooltip:
      'Si cette case n\'est pas cochée, vos notes et sujets locaux seront définitivement supprimés et remplacés par les données de votre compte.',

    // ServerPicker
    homeServerNotRunning:
      'Le serveur personnel n\'est pas en cours d\'exécution. Veuillez ouvrir les préférences et l\'onglet du serveur personnel pour le démarrer.',
    serverDefault: 'Par défaut',
    serverCustom: 'Personnalisé',
    serverHomeServer: 'Serveur personnel',
    syncServer: 'Serveur de synchronisation',

    // SignIn
    signingIn: 'Connexion...',

    // User
    syncUnreachable: 'Synchronisation inaccessible',
    syncUnreachableMessage: 'Hmm... nous ne parvenons pas à synchroniser votre compte. La raison : {{reason}}',

    // WorkspaceSwitcherMenu
    workspaceSwitcherMenuLabel: 'Menu de changement d\'espace de travail',
    signOutAllWorkspacesConfirm: 'Voulez-vous vraiment vous déconnecter de tous les espaces de travail sur cet appareil ?',
    signOutAll: 'Tout déconnecter',
    addAnotherWorkspace: 'Ajouter un autre espace de travail',
    signOutAllWorkspaces: 'Déconnecter tous les espaces de travail',

    // ConfirmDeleteAccountModal
    deleteAccountTitle: 'Supprimer le compte ?',
    deleteMyAccountForGood: 'Supprimer définitivement mon compte',

    // NoAccountWarningContent
    dataNotBackedUp: 'Données non sauvegardées',
    signInOrRegisterToSync:
      'Connectez-vous ou inscrivez-vous pour synchroniser vos notes sur vos autres appareils avec un chiffrement de bout en bout.',
    openAccountMenu: 'Ouvrir le menu du compte',
    ignoreWarning: 'Ignorer l\'avertissement',

    // U2FAuthIframe
    waitingForSecurityKey: 'En attente de la clé de sécurité...',
    authenticationSuccessful: 'Authentification réussie !',
    insertSecurityKeyPrompt: 'Insérez votre clé de sécurité matérielle, puis appuyez sur le bouton ci-dessous pour vous authentifier.',
    authenticate: 'S\'authentifier',
  },
  search: {
    // SearchBar
    placeholder: 'Rechercher...',

    // SearchOptions (quick toggle bubbles)
    protectedContents: 'Contenus protégés',
    archived: 'Archivées',
    trashed: 'Supprimées',

    // AiContextualSearch
    aiUnavailable: 'Le reclassement par IA est indisponible ou n\'a renvoyé aucun résultat.',
    aiUnavailableTooltip: 'La recherche contextuelle par IA est indisponible.',
    aiTypeQueryFirst: 'Saisissez d\'abord une requête de recherche.',
    aiTooltip:
      'Reclassez les meilleurs résultats par pertinence sémantique à l\'aide de votre fournisseur d\'IA configuré. ' +
      'Envoie les titres et de courts extraits de ces candidats, ainsi que votre requête, au fournisseur.',
    aiSearchWithAi: 'Rechercher avec l\'IA',
    aiRanking: 'Classement…',
    aiRankedByRelevance: 'Classé par pertinence IA',
    aiPrivacyNotice:
      'Envoie les titres et extraits des meilleurs résultats ainsi que votre requête à votre fournisseur d\'IA. Les fournisseurs cloud les verront — ' +
      'un modèle local conserve tout sur l\'appareil.',

    // AdvancedSearchOptions
    advancedFilters: 'Filtres de recherche avancés',
    filters: 'Filtres',
    noteTypeAny: 'Tout type',
    noteTypePlainText: 'Texte brut',
    noteTypeRichText: 'Texte enrichi',
    noteTypeSuper: 'Super',
    noteTypeMarkdown: 'Markdown',
    noteTypeCode: 'Code',
    noteTypeTask: 'Tâche',
    noteTypeSpreadsheet: 'Feuille de calcul',
    flagProtected: 'Protégée',
    flagPinned: 'Épinglée',
    flagArchived: 'Archivée',
    flagStarred: 'Favori',
    flagTrashed: 'Supprimée',
    topicsLabel: 'Sujets (séparés par des virgules)',
    topicsPlaceholder: 'travail, personnel',
    noteTypeLabel: 'Type de note',
    searchInLabel: 'Rechercher dans',
    searchInTitleAndContent: 'Titre et contenu',
    modifiedWithinLabel: 'Modifié au cours de',
    datePreset: 'Derniers {{label}}',
    createdAfterLabel: 'Créé après',
    createdBeforeLabel: 'Créé avant',
    updatedAfterLabel: 'Modifié après',
    updatedBeforeLabel: 'Modifié avant',
    statusLabel: 'Statut',
    hasAttachments: 'Contient des pièces jointes',
    caseSensitive: 'Sensible à la casse',
    clearAllFilters: 'Effacer tous les filtres',
  },
  sharing: {
    vaultSelectionMenu: 'Menu de sélection de coffre',
    vaultOptionsMenu: 'Menu des options du coffre',
    vaultOptions: 'Options du coffre',
    noVaultsFound: 'Aucun coffre trouvé',
    moveToVault: 'Déplacer vers un coffre',
    moveOutOfVault: 'Sortir de {{name}}',
    vaultsFallbackName: 'coffres',
    editVault: 'Modifier le coffre',
    lockVault: 'Verrouiller le coffre',
    unlockVault: 'Déverrouiller le coffre',
    openVaultSettings: 'Ouvrir les paramètres du coffre',
    selectionModeMultiple: 'Plusieurs',
    selectionModeOne: 'Un seul',
    lastEditedBy: 'Dernière modification par',
    sharedBy: 'Partagé par',
    sharedByContact: 'Partagé par un contact',
    vaultName: 'Nom du coffre',
    sharedInVault: 'Partagé dans le coffre',
    copiedToClipboard: 'Copié dans le presse-papiers',
    failedToCopyToClipboard: 'Échec de la copie dans le presse-papiers',
    copyExampleToClipboard: 'Copier l\'exemple dans le presse-papiers',
    copiedExclaim: 'Copié !',
    shareUnavailableTitle: 'Partage indisponible',
    shareUnavailableMessage: 'Ce lien de partage n\'est plus disponible.',
    invalidLinkTitle: 'Lien invalide',
    invalidLinkMessage: 'Ce lien de partage est invalide ou la clé est manquante.',
    selfDestructTitle: 'Cette note s\'autodétruit après consultation',
    oneTimeViewConsumed: 'Vous consultez un lien à usage unique. Il a maintenant été consommé et ne peut plus être rouvert',
    oneTimeViewExpiresClause_one: ', et expire complètement {{count}} minute après la première ouverture',
    oneTimeViewExpiresClause_many: ', et expire complètement {{count}} minutes après la première ouverture',
    oneTimeViewExpiresClause_other: ', et expire complètement {{count}} minutes après la première ouverture',
    linkExpires_one: 'Ce lien expire {{count}} minute après sa première ouverture.',
    linkExpires_many: 'Ce lien expire {{count}} minutes après sa première ouverture.',
    linkExpires_other: 'Ce lien expire {{count}} minutes après sa première ouverture.',
    untitled: 'Sans titre',
    tagHasNoNotes: 'Ce sujet ne contient aucune note.',
    publicReadOnlyFooter: 'Il s\'agit d\'un lien partagé public en lecture seule. Le contenu a été déchiffré dans votre navigateur.',
    confidentialWatermark: 'Confidentiel · {{datetime}}',
    contentHiddenTitle: 'Contenu masqué',
    contentHiddenMessage: 'Redonnez le focus à cette fenêtre pour afficher le contenu partagé.',
  },
}

export default fr
