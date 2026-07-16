import type { LocaleResource } from './en'

const de: LocaleResource = {
  common: {
    save: 'Speichern',
    cancel: 'Abbrechen',
    delete: 'Löschen',
    confirm: 'Bestätigen',
    close: 'Schließen',
    edit: 'Bearbeiten',
    rename: 'Umbenennen',
    duplicate: 'Duplizieren',
    remove: 'Entfernen',
    open: 'Öffnen',
    create: 'Erstellen',
    add: 'Hinzufügen',
    done: 'Fertig',
    back: 'Zurück',
    next: 'Weiter',
    search: 'Suchen',
    clear: 'Löschen',
    loading: 'Wird geladen…',
    copy: 'Kopieren',
    copied: 'Kopiert',
    download: 'Herunterladen',
    upload: 'Hochladen',
    export: 'Exportieren',
    import: 'Importieren',
    yes: 'Ja',
    no: 'Nein',
    enabled: 'Aktiviert',
    disabled: 'Deaktiviert',
    on: 'Ein',
    off: 'Aus',
    learnMore: 'Mehr erfahren',
    options: 'Optionen',
    settings: 'Einstellungen',
    preferences: 'Einstellungen',
    help: 'Hilfe',
    pin: 'Anheften',
    unpin: 'Lösen',
    star: 'Markieren',
    unstar: 'Markierung entfernen',
    archive: 'Archivieren',
    unarchive: 'Aus Archiv holen',
    restore: 'Wiederherstellen',
    moveToTrash: 'In den Papierkorb verschieben',
    deletePermanently: 'Endgültig löschen',
    protect: 'Schützen',
    unprotect: 'Schutz aufheben',
  },
  navigation: {
    notes: 'Notizen',
    allNotes: 'Alle Notizen',
    files: 'Dateien',
    starred: 'Markiert',
    archived: 'Archiviert',
    trash: 'Papierkorb',
    untagged: 'Ohne Thema',
    conflicts: 'Konflikte',
    views: 'Ansichten',
    smartViews: 'Intelligente Ansichten',
    tags: 'Themen',
    folders: 'Ordner',
    favorites: 'Favoriten',
    dashboard: 'Übersicht',
    createNewNote: 'Neue Notiz erstellen',
    createNewTag: 'Neues Thema erstellen',
    createNewFolder: 'Neuen Ordner erstellen',
    createNewSmartView: 'Neue intelligente Ansicht erstellen',
    searchTags: 'Themen suchen…',
    noTagsFound: 'Keine Themen gefunden. Versuchen Sie eine andere Suche.',
    noSmartViewsFound: 'Keine intelligenten Ansichten gefunden. Versuchen Sie eine andere Suche.',
    collapseTagsPanel: 'Themen-Bereich einklappen',
    expandTagsPanel: 'Themen-Bereich ausklappen',
    goToItemsList: 'Zur Elementliste',
    goToAccountMenu: 'Zum Kontomenü',
    openPreferences: 'Einstellungen öffnen',
  },
  account: {
    account: 'Konto',
    signIn: 'Anmelden',
    signOut: 'Abmelden',
    signUp: 'Registrieren',
    register: 'Registrieren',
    you: 'Sie',
    encryptionOn: 'Ende-zu-Ende-Verschlüsselung aktiv',
    notSignedIn: 'Sie sind nicht angemeldet',
    signInOrRegister: 'Melden Sie sich an oder registrieren Sie sich, um Ihre Notizen zu synchronisieren',
    email: 'E-Mail',
    password: 'Passwort',
    confirmPassword: 'Passwort bestätigen',
    syncNow: 'Jetzt synchronisieren',
    lastSynced: 'Zuletzt synchronisiert',
    importData: 'Importieren',
    switchWorkspace: 'Arbeitsbereich wechseln',
    lockApplication: 'Anwendung sperren',
    helpAndFeedback: 'Hilfe & Feedback',
  },
  preferences: {
    title: 'Einstellungen',
    general: 'Allgemein',
    account: 'Konto',
    security: 'Sicherheit',
    appearance: 'Darstellung',
    backups: 'Sicherungen',
    listed: 'Listed',
    plugins: 'Erweiterungen',
    whatsNew: 'Neuigkeiten',
    helpAndFeedback: 'Hilfe & Feedback',
    language: 'Sprache',
    languageTitle: 'Sprache',
    languageDescription:
      'Wählen Sie die Sprache der Benutzeroberfläche. Für noch nicht übersetzte Inhalte wird Englisch verwendet.',
    languageChanged: 'Sprache aktualisiert',
    defaults: 'Standardwerte',
    tools: 'Werkzeuge',
    spellcheck: 'Rechtschreibprüfung',
    labs: 'Labs',
  },
  editor: {
    // Clipboard
    cut: 'Ausschneiden',
    copy: 'Kopieren',
    paste: 'Einfügen',
    moreCutOptions: 'Weitere Ausschneide-Optionen',
    moreCopyOptions: 'Weitere Kopier-Optionen',
    morePasteOptions: 'Weitere Einfüge-Optionen',

    // History / navigation
    tableOfContents: 'Inhaltsverzeichnis',
    selectAll: 'Alles auswählen',
    selectAllText: 'Nur Text auswählen',
    deselectAll: 'Auswahl aufheben',
    search: 'Suchen',
    undo: 'Rückgängig',
    redo: 'Wiederholen',
    undoHistory: 'Rückgängig-Verlauf',
    redoHistory: 'Wiederholen-Verlauf',
    undoHistoryEmpty: 'Rückgängig-Verlauf — noch nichts rückgängig zu machen',
    undoHistoryAvailable: 'Rückgängig-Verlauf — mehrere Schritte auf einmal zurückgehen',
    redoHistoryEmpty: 'Wiederholen-Verlauf — nichts zu wiederholen',
    redoHistoryAvailable: 'Wiederholen-Verlauf — mehrere Schritte auf einmal vorspringen',

    // Text formatting
    formattingOptions: 'Formatierungsoptionen',
    bold: 'Fett',
    italic: 'Kursiv',
    underline: 'Unterstrichen',
    strikethrough: 'Durchgestrichen',
    inlineCode: 'Inline-Code',
    link: 'Link',
    formatPainter: 'Format übertragen — Formatierung kopieren (Doppelklick zum Beibehalten)',
    textStyle: 'Textstil',
    textColor: 'Textfarbe',
    highlightColor: 'Hervorhebungsfarbe',
    typography: 'Typografie — Betonung, Kontur, Zeichen- & Wortabstand',
    typographyTitle: 'Typografie',

    // Font size / family
    fontSize: 'Schriftgröße',
    chooseFontSize: 'Schriftgröße wählen',
    decreaseFontSize: 'Schriftgröße verkleinern',
    increaseFontSize: 'Schriftgröße vergrößern',
    fontFamily: 'Schriftart',
    customFontFamily: 'Benutzerdefiniert',

    // Blocks / lists
    bulletedList: 'Aufzählungsliste',
    numberedList: 'Nummerierte Liste',
    checkList: 'Checkliste',
    quote: 'Zitat',
    codeBlock: 'Codeblock',
    changeCase: 'Groß-/Kleinschreibung ändern',
    sortAndDedupeLines: 'Zeilen sortieren & Duplikate entfernen',
    alignment: 'Ausrichtung',
    paragraphLayout: 'Absatzlayout — Zeilen- & Absatzabstand, Einzug, Schattierung',
    paragraphLayoutTitle: 'Absatzlayout',
    listStyleMarker: 'Listenstil — Aufzählungs- & Nummernmarkierung',
    formattingMarks: 'Formatierungszeichen',
    insert: 'Einfügen',

    // Contextual table tools
    insertRowAbove: 'Zeile oberhalb einfügen',
    insertRowBelow: 'Zeile unterhalb einfügen',
    insertColumnLeft: 'Spalte links einfügen',
    insertColumnRight: 'Spalte rechts einfügen',
    deleteRow: 'Zeile löschen',
    deleteColumn: 'Spalte löschen',
    toggleRowHeader: 'Zeilenkopf umschalten',
    toggleColumnHeader: 'Spaltenkopf umschalten',
    deleteTable: 'Tabelle löschen',

    // Contextual ribbon segment captions (Office-style grouping)
    rows: 'Zeilen',
    columns: 'Spalten',
    cells: 'Zellen',
    table: 'Tabelle',
    block: 'Block',

    // Contextual image tools
    alignLeft: 'Linksbündig',
    alignCenter: 'Zentriert',
    alignRight: 'Rechtsbündig',

    // Contextual link tools
    editLink: 'Link bearbeiten',
    removeLink: 'Link entfernen',

    // Zoom
    zoomIntoBlock: 'In Block hineinzoomen',

    // Floating selection toolbar
    blockStyle: 'Blockstil',
    heading1: 'Überschrift 1',
    heading2: 'Überschrift 2',
    heading3: 'Überschrift 3',
    normalText: 'Normaler Text',
    moreFormatting: 'Weitere Formatierung',

    // Note from selection
    createNoteFromSelectionTitle: 'Neue Notiz aus Auswahl erstellen',
    createNoteFromSelectionDescription:
      'Erstellt eine neue Notiz mit der aktuellen Auswahl und ersetzt die Auswahl durch einen Link zur neuen Notiz.',

    // Mobile
    dismissKeyboard: 'Tastatur ausblenden',

    // Popover titles / a11y labels
    tableOfContentsLower: 'Inhaltsverzeichnis',
    noHeadingsFound: 'Keine Überschriften gefunden',
    textFormattingOptions: 'Textformatierungsoptionen',
    highlight: 'Hervorheben',
    subscript: 'Tiefgestellt',
    superscript: 'Hochgestellt',
    clearFormatting: 'Formatierung entfernen',
    normal: 'Normal',
    smartChecklist: 'Intelligente Checkliste',
    restoreCompletedTasks: 'Erledigte Aufgaben wiederherstellen',
    leftAlign: 'Linksbündig',
    centerAlign: 'Zentriert',
    rightAlign: 'Rechtsbündig',
    justify: 'Blocksatz',

    // Insert menu
    searchBlocksPlaceholder: 'Blöcke suchen…',
    searchBlocksToInsert: 'Blöcke zum Einfügen suchen',
    clearSearch: 'Suche löschen',
    noBlocksMatch: 'Keine Blöcke stimmen mit „{{query}}“ überein',
    customizeToolbar: 'Symbolleiste anpassen',

    // Color popovers
    custom: 'Benutzerdefiniert',
    clear: 'Löschen',
    textColorSwatch: 'Textfarbe {{color}}',
    highlightColorSwatch: 'Hervorhebungsfarbe {{color}}',
    textShadingSwatch: 'Textschattierung {{color}}',
    noTextShading: 'Keine Textschattierung',

    // Change case
    uppercase: 'GROSSBUCHSTABEN',
    lowercase: 'kleinbuchstaben',
    camelCase: 'camelCase',

    // Sort lines
    sortLines: 'Zeilen sortieren',
    deduplicate: 'Duplikate entfernen',
    multiKeySort: 'Mehrschlüssel-Sortierung (1., 2., 3.)…',
    sortAndDeduplicateLines: 'Zeilen sortieren und Duplikate entfernen',

    // Typography popover
    emphasisMarks: 'Betonungszeichen',
    outlineTextStroke: 'Kontur (Textumriss)',
    letterSpacingKerning: 'Zeichenabstand (Kerning)',
    wordSpacing: 'Wortabstand',
    clearTypography: 'Typografie zurücksetzen',
    spacingTight: 'Eng',
    spacingNormal: 'Normal',
    spacingWide: 'Weit',
    spacingWider: 'Weiter',
    spacingWidest: 'Am weitesten',

    // History popovers
    undoMultipleSteps: 'Mehrere Schritte rückgängig machen',
    redoMultipleSteps: 'Mehrere Schritte wiederholen',
    emptyHistoryPreview: '(leer)',

    // Clipboard option menus
    pasteOptions: 'Einfüge-Optionen',
    copyOptions: 'Kopier-Optionen',
    cutOptions: 'Ausschneide-Optionen',
    pasteWithoutFormatting: 'Ohne Formatierung einfügen',
    pasteClean: 'Sauber einfügen (versteckte Zeichen entfernen)',
    keepSourceFormatting: 'Quellformatierung beibehalten',
    matchDestinationFormatting: 'An Zielformatierung anpassen',
    pasteAsImage: 'Als Bild einfügen',
    copyWithoutFormatting: 'Ohne Formatierung kopieren',
    copyTextOnly: 'Nur Text kopieren',
    copyImagesOnly: 'Nur Bilder kopieren',
    cutWithoutFormatting: 'Ohne Formatierung ausschneiden',
    cutTextOnly: 'Nur Text ausschneiden',
    cutImagesOnly: 'Nur Bilder ausschneiden',

    // Paragraph layout popover
    lineSpacing: 'Zeilenabstand',
    spaceBefore: 'Abstand davor',
    spaceAfter: 'Abstand danach',
    indentation: 'Einzug',
    none: 'Keine',
    increaseLeft: 'Links vergrößern',
    decreaseLeft: 'Links verkleinern',
    increaseRight: 'Rechts vergrößern',
    decreaseRight: 'Rechts verkleinern',
    firstLine: 'Erste Zeile',
    noFirstLine: 'Keine erste Zeile',
    textShading: 'Textschattierung',

    // List style popover
    listStyle: 'Listenstil',
    bulleted: 'Aufzählung',
    numbered: 'Nummeriert',
    bulletedListMarkers: 'Aufzählungszeichen-Stil',
    numberedListMarkers: 'Nummerierungsstil',
    multilevelList: 'Mehrstufige Liste',
    multilevelListHint: 'Wählen Sie eine Markierung pro Verschachtelungsebene',
    multilevelLevelDefault: 'Standard',
    level: 'Ebene',
    apply: 'Anwenden',

    // Modal titles
    insertTable: 'Tabelle einfügen',
    insertImageFromUrl: 'Bild von URL einfügen',
    sortLinesModalTitle: 'Zeilen sortieren',

    // Block picker
    blockPicker: 'Blockauswahl',

    // Block catalog display names (Insert menu + slash picker). The English value
    // here must match the catalog's source name exactly; search still matches on
    // the original English string, so these are display-only.
    blockParagraph: 'Absatz',
    blockCallout: 'Hinweis',
    blockDivider: 'Trennlinie',
    blockCollapsible: 'Einklappbar',
    blockImageFromUrl: 'Bild von URL',
    blockUploadFile: 'Datei hochladen',
    blockDrawing: 'Zeichnung',
    blockQrCode: 'QR-Code',
    blockTable: 'Tabelle',
    blockKanbanBoard: 'Kanban-Board',
    blockCalendar: 'Kalender',
    blockTimeline: 'Zeitleiste',
    blockDataTable: 'Datentabelle',
    blockSqlQuery: 'SQL-Abfrage',
    blockMermaidDiagram: 'Mermaid-Diagramm',
    blockGanttChart: 'Gantt-Diagramm',
    blockTimingDiagram: 'Timing-Diagramm',
    blockMusicStaff: 'Notenlinien',
    blockTradingViewChart: 'TradingView-Chart',
    blockStockChart: 'Aktienchart',
    blockEmbed: 'Einbettung',
    blockEmbedWebsite: 'Website einbetten',
    blockTweet: 'Tweet',
    blockEquation: 'Gleichung',
    blockInlineEquation: 'Inline-Gleichung',
    blockFootnote: 'Fußnote',
    blockBookmark: 'Lesezeichen',
    blockGeneratePassword: 'Kryptografisch sicheres Passwort generieren',
    blockClock: 'Uhr',
    blockCurrentDateTime: 'Aktuelles Datum und Uhrzeit',
    blockCurrentTime: 'Aktuelle Uhrzeit',
    blockCurrentDate: 'Aktuelles Datum',

    // Block catalog category headers
    blockCategoryBasic: 'Grundlegend',
    blockCategoryLists: 'Listen',
    blockCategoryMedia: 'Medien',
    blockCategoryDataTables: 'Daten & Tabellen',
    blockCategoryDiagramsCharts: 'Diagramme & Charts',
    blockCategoryFinance: 'Finanzen',
    blockCategoryEmbeds: 'Einbettungen',
    blockCategoryAdvanced: 'Erweitert',
  },
  files: {
    // FileViewWithoutProtection
    dropToUploadTooltip: 'Legen Sie Ihre Dateien ab, um sie hochzuladen und mit der aktuellen Datei zu verknüpfen',
    fileAriaLabel: 'Datei',
    fileReadonly: 'Diese Datei ist schreibgeschützt',
    fileInformationPanel: 'Dateiinformationsbereich',
    details: 'Details',

    // MultipleSelectedFiles
    selectedFilesCount: '{{count}} ausgewählte Dateien',
    actionsPerformedOnSelected: 'Aktionen werden auf alle ausgewählten Dateien angewendet.',
    cancelMultipleSelection: 'Mehrfachauswahl abbrechen',

    // FileContextMenu / FileOptionsPanel
    fileOptions: 'Dateioptionen',
    fileContextMenu: 'Datei-Kontextmenü',
    fileOptionsMenu: 'Dateioptionen-Menü',
    fileOptionsPanel: 'Dateioptionen-Bereich',

    // FileMenuOptions
    noFilesSelected: 'Keine Dateien ausgewählt',
    detachFromNote: 'Von Notiz trennen',
    attachToNote: 'An Notiz anhängen',
    passwordProtect: 'Mit Passwort schützen',
    downloadSeparately: 'Einzeln herunterladen',
    downloadAsArchive: 'Als Archiv herunterladen',
    failedToDownloadArchive: 'Dateien konnten nicht als Archiv heruntergeladen werden',
    fileId: 'Datei-ID:',
    size: 'Größe:',
    totalSize: 'Gesamtgröße:',

    // FileContextMenuBackupOption
    backedUpOn: 'Gesichert am {{date}}',
    configureFileBackups: 'Dateisicherungen konfigurieren',
    fileNotBackedUpLocally: 'Datei nicht lokal gesichert',

    // MoveFileToFolderOption
    noFoldersYet: 'Noch keine Ordner',
    moveToFolder: 'In Ordner verschieben',
    folderSelectionMenu: 'Ordnerauswahl-Menü',
    noFolder: 'Kein Ordner',

    // FilePreview
    fileProtected: 'Diese Datei ist geschützt.',
    authenticateToView: 'Authentifizieren Sie sich, um diese Datei anzuzeigen.',
    addPasscodeToView:
      'Fügen Sie einen Zugangscode hinzu oder erstellen Sie ein Konto, um für die Anzeige dieser Datei eine Authentifizierung zu verlangen.',
    openAccountMenu: 'Kontomenü öffnen',
    authenticate: 'Authentifizieren',
    viewFile: 'Datei anzeigen',
    loading: 'Wird geladen...',

    // FilePreviewError
    fileCannotBePreviewed: 'Diese Datei kann nicht in der Vorschau angezeigt werden.',
    errorLoadingFile:
      'Beim Laden der Datei ist ein Fehler aufgetreten. Versuchen Sie es erneut oder laden Sie die Datei herunter und öffnen Sie sie mit einer anderen Anwendung.',
    tryAgain: 'Erneut versuchen',
    downloadToView: 'Um diese Datei anzuzeigen, laden Sie sie herunter und öffnen Sie sie mit einer anderen Anwendung.',

    // FilePreviewInfoPanel
    fileInformation: 'Dateiinformationen',
    type: 'Typ:',
    decryptedSize: 'Entschlüsselte Größe:',
    encryptedSize: 'Verschlüsselte Größe:',
    created: 'Erstellt:',
    lastModified: 'Zuletzt geändert:',

    // FilePreviewModal
    done: 'Fertig',
    showFileOptions: 'Dateioptionen anzeigen',
    showFileInfo: 'Dateiinfo anzeigen',
    hideFileInfo: 'Dateiinfo ausblenden',
    showLinksSection: 'Verknüpfungsbereich anzeigen',
    hideLinksSection: 'Verknüpfungsbereich ausblenden',
    submit: 'Absenden',
    renameFile: 'Datei umbenennen',
    showLinkedItems: 'Verknüpfte Elemente anzeigen',
    closeModal: 'Dialog schließen',
    filePreviewModal: 'Dateivorschau-Dialog',

    // ImageAlignmentOptions
    leftAlign: 'Linksbündig',
    centerAlign: 'Zentriert',
    rightAlign: 'Rechtsbündig',

    // VideoPreview
    videoCannotBePreviewed: 'Dieses Video kann nicht in der Vorschau angezeigt werden.',

    // AudioPreview
    audioCannotBePlayed: 'Diese Audiodatei kann nicht abgespielt werden.',
    downloadToListen:
      'Um diese Datei anzuhören, laden Sie sie herunter und öffnen Sie sie mit einer anderen Anwendung.',

    // PreviewComponent
    externalAppOnly: 'Diese Datei kann nur in einer externen App in der Vorschau angezeigt werden',
    openFilePreview: 'Dateivorschau öffnen',
    loadingPdfViewer: 'PDF-Viewer wird geladen...',

    // ZoomableImage
    zoomOut: 'Verkleinern',
    zoomIn: 'Vergrößern',
    resetToActualSize: 'Auf tatsächliche Größe zurücksetzen',
    resetTo100: 'Auf 100 % zurücksetzen',
    fitToScreen: 'An Bildschirm anpassen',

    // PdfPreview
    unableToRenderPdf: 'Dieses PDF kann nicht dargestellt werden.',
    pdfCorruptedOrProtected: 'Die Datei ist möglicherweise beschädigt oder passwortgeschützt.',
    loadingPdf: 'PDF wird geladen...',
    previousPage: 'Vorherige Seite',
    pageNumber: 'Seitenzahl',
    nextPage: 'Nächste Seite',
    fitWidth: 'An Breite anpassen',
    searchInDocumentShortcut: 'Im Dokument suchen (Strg/Cmd+F)',
    searchInDocument: 'Im Dokument suchen',
    copyLinkToPage: 'Link zu Seite {{page}} kopieren',
    copyLinkToThisPage: 'Link zu dieser Seite kopieren',
    copyLinkToSelectedText: 'Link zum ausgewählten Text kopieren',
    cancelOcr: 'OCR abbrechen',
    preparingOcr: 'OCR wird vorbereitet...',
    ocrProgress: 'OCR Seite {{current}} / {{total}} ({{percent}}%)',
    ocrCachedReRunTooltip:
      'Text bereits extrahiert (zwischengespeichert). OCR in Ihrem Browser erneut ausführen (bleibt auf Ihrem Gerät).',
    ocrExtractedReRunTooltip: 'Text extrahiert. OCR in Ihrem Browser erneut ausführen (bleibt auf Ihrem Gerät).',
    ocrExtractTooltip:
      'Text aus gescannten Seiten mit OCR extrahieren. Läuft in Ihrem Browser; nichts verlässt Ihr Gerät (langsam; lädt Sprachdaten herunter).',
    extractTextWithOcrBrowser: 'Text mit OCR in Ihrem Browser extrahieren',
    reRunOcrBrowser: 'OCR erneut ausführen (Browser)',
    extractTextOcr: 'Text extrahieren (OCR)',
    serverOcrTooltip:
      'OCR auf dem SERVER ausführen. Dabei werden die Seitenbilder dieses PDFs an den Server gesendet und die Ende-zu-Ende-Verschlüsselung VERLASSEN — der Server kann diesen Inhalt lesen. Browser-OCR belässt alles auf Ihrem Gerät.',
    runOcrOnServerAria:
      'OCR auf dem Server ausführen (sendet Seitenbilder an den Server; verlässt die Ende-zu-Ende-Verschlüsselung)',
    runOcrOnServer: 'OCR auf Server ausführen',
    copyAllExtractedText: 'Gesamten extrahierten Text kopieren',
    copyExtractedTextAria: 'Extrahierten Text kopieren',
    findInDocument: 'Im Dokument suchen',
    matchCase: 'Groß-/Kleinschreibung beachten',
    noResults: 'Keine Ergebnisse',
    matchOfTotal: '{{current}} von {{total}}',
    previousMatch: 'Vorheriger Treffer',
    nextMatch: 'Nächster Treffer',
    closeSearch: 'Suche schließen',
    serverOcrDisclosurePrefix:
      'Server-OCR ist für Ihr Konto verfügbar. Dabei werden die Seitenbilder dieses PDFs an den Server gesendet und',
    serverOcrDisclosureBold: 'verlässt die Ende-zu-Ende-Verschlüsselung',
    serverOcrDisclosureSuffix:
      ' — der Server (und jeder, der ihn kontrolliert) kann diesen Inhalt lesen. Browser-OCR belässt alles auf Ihrem Gerät. Standard ist Browser-OCR.',
    ocrRunningServer:
      'Server-OCR: Die Seitenbilder dieses PDFs werden auf den Server hochgeladen, was die Ende-zu-Ende-Verschlüsselung VERLÄSST — der Server kann diesen Inhalt lesen. (Browser-OCR belässt alles auf Ihrem Gerät.)',
    ocrRunningBrowser:
      'OCR läuft in Ihrem Browser auf diesem Gerät (Ihre Dateien bleiben Ende-zu-Ende-verschlüsselt). Es ist langsam und lädt bei der ersten Verwendung Sprachdaten herunter.',
    ocrDoneServer:
      'Server-OCR abgeschlossen. Die Seitenbilder wurden an den Server gesendet (dies hat die Ende-zu-Ende-Verschlüsselung verlassen). Die Genauigkeit hängt von der Scanqualität ab; der extrahierte Text ist nun durchsuchbar und kopierbar und wird auf diesem Gerät zwischengespeichert.',
    ocrDoneBrowser:
      'OCR abgeschlossen. Die Genauigkeit hängt von der Scanqualität ab; der extrahierte Text ist nun durchsuchbar und kopierbar und wird auf diesem Gerät zwischengespeichert.',

    // PdfPreview toasts (call-time)
    copiedExtractedText: 'Extrahierter Text kopiert',
    copiedLinkToPage: 'Link zu Seite {{page}} kopiert',
    copiedLinkToSelectedText: 'Link zum ausgewählten Text kopiert',

    // PdfPreview OCR errors (call-time)
    serverOcrFailed: 'Server-OCR fehlgeschlagen: {{message}}',
    ocrUnknownError: 'unbekannter Fehler',
    ocrFailed: 'OCR fehlgeschlagen. Die Sprachdaten konnten möglicherweise nicht heruntergeladen werden.',
  },
  notes: {
    // ContentListView
    notesAndFiles: 'Notizen & Dateien',
    selectAllItems: 'Alle Elemente auswählen',
    selectedCount: '{{count}} ausgewählt',
    cancelMultipleSelection: 'Mehrfachauswahl abbrechen',
    noFilesInFolder: 'Keine Dateien in diesem Ordner.',
    noItems: 'Keine Elemente.',
    loading: 'Wird geladen...',
    uploadFileWithShortcut: 'Datei hochladen {{shortcut}}',
    createNoteInTopicWithShortcut: 'Neue Notiz im ausgewählten Thema erstellen {{shortcut}}',
    dropFilesToUpload: 'Legen Sie Ihre Dateien ab, um sie hochzuladen und mit dem Thema „{{title}}“ zu verknüpfen',

    // EmptyFilesView
    noFilesYet: 'Sie haben noch keine Dateien',
    filesAttachedAppearHere:
      'An Ihre Notizen angehängte Dateien erscheinen hier. Sie können Dateien auch direkt von dieser Seite hochladen.',
    uploadFiles: 'Dateien hochladen',

    // ContentListHeader
    syncing: 'Wird synchronisiert...',
    loadingItemsProgress: '{{current}}/{{total}} Elemente werden geladen...',
    potentiallyOutOfSync: 'Möglicherweise nicht synchron',
    openDisplayOptionsMenu: 'Anzeigeoptionen-Menü öffnen',
    displayOptionsMenu: 'Anzeigeoptionen-Menü',
    displayOptions: 'Anzeigeoptionen',
    expandTopicsPanel: 'Themen-Bereich ausklappen',
    collapseNotesPanel: 'Notizen-Bereich einklappen',

    // AddItemMenuButton
    addItem: 'Element hinzufügen',
    uploadFolder: 'Ordner hochladen',
    takePhoto: 'Foto aufnehmen',
    recordVideo: 'Video aufnehmen',

    // SearchButton
    searchPlaceholder: 'Suchen...',

    // DisplayOptionsMenu
    notesListOptionsMenu: 'Notizenlisten-Optionsmenü',
    preferencesFor: 'Einstellungen für',
    global: 'Global',
    reset: 'Zurücksetzen',
    upgradeForPerTopicPreferences: 'Upgrade für themenspezifische Einstellungen',
    perTopicPreferencesMessageWithDaily:
      'Erstellen Sie leistungsstarke Arbeitsabläufe und Organisationslayouts mit themenspezifischen Anzeigeeinstellungen und dem brandneuen Kalenderlayout des Täglichen Notizbuchs.',
    perTopicPreferencesMessage:
      'Erstellen Sie leistungsstarke Arbeitsabläufe und Organisationslayouts mit themenspezifischen Anzeigeeinstellungen.',
    sortBy: 'Sortieren nach',
    relevanceBestMatch: 'Relevanz (beste Übereinstimmung)',
    dateModified: 'Änderungsdatum',
    creationDate: 'Erstellungsdatum',
    title: 'Titel',
    customDragToReorder: 'Benutzerdefiniert (zum Umsortieren ziehen)',
    view: 'Ansicht',
    showNotePreview: 'Notizvorschau anzeigen',
    showDate: 'Datum anzeigen',
    showTags: 'Themen anzeigen',
    showIcon: 'Symbol anzeigen',
    other: 'Sonstiges',
    showPinned: 'Angeheftete anzeigen',
    showProtected: 'Geschützte anzeigen',
    showArchived: 'Archivierte anzeigen',
    showTrashed: 'Gelöschte anzeigen',
    dailyNotebook: 'Tägliches Notizbuch',
    labs: 'Labs',
    dailyNotebookDescription: 'Erfassen Sie täglich neue Notizen mit einem kalenderbasierten Layout',
    tableView: 'Tabellenansicht',
    tableViewDescription: 'Notizen und Dateien im aktuellen Thema in einem Tabellenlayout anzeigen',
    newNoteDefaults: 'Standardwerte für neue Notizen',

    // NewNotePreferences
    noteType: 'Notiztyp',
    selectDefaultNoteType: 'Standard-Notiztyp auswählen',
    titleFormat: 'Titelformat',
    selectTitleFormat: 'Format für den Notiztitel auswählen',
    customFormatPlaceholder: 'z. B. YYYY-MM-DD',
    preview: 'Vorschau: ',
    useBracketsToEscape: '. Verwenden Sie ',
    toEscapeFormatting: ' zum Umgehen der Formatierung.',

    // ListItemMetadata
    protected: 'Geschützt',
    modified: 'Geändert',
    now: 'Jetzt',

    // ListItemFlagIcons
    editingDisabled: 'Bearbeitung deaktiviert',
    trashed: 'Gelöscht',
    archived: 'Archiviert',
    files: 'Dateien',
    starred: 'Markiert',
    fileBackedUpLocally: 'Datei ist lokal gesichert',

    // ListItemConflictIndicator
    conflictedCopy: 'Konfliktkopie',

    // FilesFolderBar
    allFiles: 'Alle Dateien',
    noFolder: 'Kein Ordner',
    folderNamePlaceholder: 'Ordnername',
    createNewFolder: 'Neuen Ordner erstellen',
    newFolder: 'Neuer Ordner',

    // DailyContentList
    currentStreak: 'Aktuelle Serie',
    dayWithCount_one: 'Tag',
    dayWithCount_other: 'Tage',
  },
  auth: {
    // AdvancedOptions
    unableToComputePrivateUsername: 'Privater Benutzername kann nicht berechnet werden.',
    advancedOptions: 'Erweiterte Optionen',
    privateUsernameMode: 'Modus für privaten Benutzernamen',
    username: 'Benutzername',
    useStrictSignIn: 'Strikte Anmeldung verwenden',
    useRecoveryCode: 'Wiederherstellungscode verwenden',
    recoveryCode: 'Wiederherstellungscode',

    // ConfirmNoMergeDialog
    deleteLocalDataTitle: 'Lokale Daten löschen?',
    noMergeWarning:
      'Sie haben sich entschieden, Ihre lokalen Daten nicht zusammenzuführen. Wenn Sie fortfahren, werden Ihre lokalen Notizen und Themen dauerhaft gelöscht und durch die Daten aus Ihrem Konto ersetzt. Diese Aktion kann nicht rückgängig gemacht werden.',
    noMergeConfirmQuestion: 'Möchten Sie wirklich ohne Zusammenführen fortfahren?',
    deleteLocalDataAndContinue: 'Lokale Daten löschen und fortfahren',

    // ConfirmPassword
    passwordResetWarningPart1: 'Da Ihre Notizen mit Ihrem Passwort verschlüsselt sind,',
    passwordResetWarningHighlight: 'bietet Standard Red Notes keine Option zum Zurücksetzen des Passworts',
    passwordResetWarningPart2: '. Wenn Sie Ihr Passwort vergessen, verlieren Sie dauerhaft den Zugriff auf Ihre Daten.',
    confirmPassword: 'Passwort bestätigen',
    creatingAccount: 'Konto wird erstellt...',
    createAccountAndSignIn: 'Konto erstellen & anmelden',
    staySignedIn: 'Angemeldet bleiben',
    goBack: 'Zurück',
    humanVerification: 'Menschliche Verifizierung',
    confirmPasswordTitle: 'Passwort bestätigen',

    // CreateAccount
    createAccount: 'Konto erstellen',
    workspaceNameOptional: 'Arbeitsbereichsname (optional)',

    // GeneralAccountMenu
    generalAccountMenuLabel: 'Allgemeines Kontomenü',
    signedInAs: 'Sie sind angemeldet als:',
    syncing: 'Wird synchronisiert...',
    lastSynced: 'Zuletzt synchronisiert:',
    offlineSignInPrompt:
      'Sie sind offline. Melden Sie sich an, um Ihre Notizen und Einstellungen auf allen Ihren Geräten zu synchronisieren und die Ende-zu-Ende-Verschlüsselung zu aktivieren.',
    offline: 'Offline',
    accountSettings: 'Kontoeinstellungen',
    createFreeAccount: 'Kostenloses Konto erstellen',
    documentation: 'Dokumentation',
    keyboardShortcuts: 'Tastaturkürzel',
    commandPalette: 'Befehlspalette',
    signOutWorkspace: 'Arbeitsbereich abmelden',

    // MergeLocalDataCheckbox
    mergeLocalData: 'Lokale Daten zusammenführen ({{count}} Notizen und Themen)',
    mergeLocalDataTooltip:
      'Wenn nicht aktiviert, werden Ihre lokalen Notizen und Themen dauerhaft gelöscht und durch die Daten aus Ihrem Konto ersetzt.',

    // ServerPicker
    homeServerNotRunning:
      'Der Home-Server läuft nicht. Bitte öffnen Sie die Einstellungen und den Home-Server-Tab, um ihn zu starten.',
    serverDefault: 'Standard',
    serverCustom: 'Benutzerdefiniert',
    serverHomeServer: 'Home-Server',
    syncServer: 'Sync-Server',

    // SignIn
    signingIn: 'Anmeldung läuft...',

    // User
    syncUnreachable: 'Synchronisierung nicht erreichbar',
    syncUnreachableMessage: 'Hmm... wir können Ihr Konto anscheinend nicht synchronisieren. Der Grund: {{reason}}',

    // WorkspaceSwitcherMenu
    workspaceSwitcherMenuLabel: 'Arbeitsbereich-Wechsler-Menü',
    signOutAllWorkspacesConfirm: 'Möchten Sie sich wirklich von allen Arbeitsbereichen auf diesem Gerät abmelden?',
    signOutAll: 'Alle abmelden',
    addAnotherWorkspace: 'Weiteren Arbeitsbereich hinzufügen',
    signOutAllWorkspaces: 'Alle Arbeitsbereiche abmelden',

    // ConfirmDeleteAccountModal
    deleteAccountTitle: 'Konto löschen?',
    deleteMyAccountForGood: 'Mein Konto endgültig löschen',

    // NoAccountWarningContent
    dataNotBackedUp: 'Daten nicht gesichert',
    signInOrRegisterToSync:
      'Melden Sie sich an oder registrieren Sie sich, um Ihre Notizen mit Ende-zu-Ende-Verschlüsselung auf Ihre anderen Geräte zu synchronisieren.',
    openAccountMenu: 'Kontomenü öffnen',
    ignoreWarning: 'Warnung ignorieren',

    // U2FAuthIframe
    waitingForSecurityKey: 'Warten auf Sicherheitsschlüssel...',
    authenticationSuccessful: 'Authentifizierung erfolgreich!',
    insertSecurityKeyPrompt:
      'Stecken Sie Ihren Hardware-Sicherheitsschlüssel ein und drücken Sie dann die Schaltfläche unten, um sich zu authentifizieren.',
    authenticate: 'Authentifizieren',
  },
  search: {
    // SearchBar
    placeholder: 'Suchen...',

    // SearchOptions (quick toggle bubbles)
    protectedContents: 'Geschützte Inhalte',
    archived: 'Archiviert',
    trashed: 'Gelöscht',

    // AiContextualSearch
    aiUnavailable: 'KI-Neuordnung ist nicht verfügbar oder hat kein Ergebnis geliefert.',
    aiUnavailableTooltip: 'KI-Kontextsuche ist nicht verfügbar.',
    aiTypeQueryFirst: 'Geben Sie zuerst eine Suchanfrage ein.',
    aiTooltip:
      'Ordnen Sie die besten Ergebnisse mit Ihrem konfigurierten KI-Anbieter nach semantischer Relevanz neu. ' +
      'Sendet die Titel und kurzen Ausschnitte dieser Kandidaten sowie Ihre Anfrage an den Anbieter.',
    aiSearchWithAi: 'Mit KI suchen',
    aiRanking: 'Wird geordnet…',
    aiRankedByRelevance: 'Nach KI-Relevanz geordnet',
    aiPrivacyNotice:
      'Sendet die Titel & Ausschnitte der besten Ergebnisse und Ihre Anfrage an Ihren KI-Anbieter. Cloud-Anbieter sehen ' +
      'sie — ein lokales Modell belässt alles auf dem Gerät.',

    // AdvancedSearchOptions
    advancedFilters: 'Erweiterte Suchfilter',
    filters: 'Filter',
    noteTypeAny: 'Beliebiger Typ',
    noteTypePlainText: 'Einfacher Text',
    noteTypeRichText: 'Rich Text',
    noteTypeSuper: 'Super',
    noteTypeMarkdown: 'Markdown',
    noteTypeCode: 'Code',
    noteTypeTask: 'Aufgabe',
    noteTypeSpreadsheet: 'Tabelle',
    flagProtected: 'Geschützt',
    flagPinned: 'Angeheftet',
    flagArchived: 'Archiviert',
    flagStarred: 'Markiert',
    flagTrashed: 'Gelöscht',
    topicsLabel: 'Themen (durch Kommas getrennt)',
    topicsPlaceholder: 'Arbeit, Privat',
    noteTypeLabel: 'Notiztyp',
    searchInLabel: 'Suchen in',
    searchInTitleAndContent: 'Titel & Inhalt',
    modifiedWithinLabel: 'Geändert innerhalb von',
    datePreset: 'Letzte {{label}}',
    createdAfterLabel: 'Erstellt nach',
    createdBeforeLabel: 'Erstellt vor',
    updatedAfterLabel: 'Aktualisiert nach',
    updatedBeforeLabel: 'Aktualisiert vor',
    statusLabel: 'Status',
    hasAttachments: 'Hat Anhänge',
    caseSensitive: 'Groß-/Kleinschreibung beachten',
    clearAllFilters: 'Alle Filter löschen',
  },
  sharing: {
    vaultSelectionMenu: 'Tresor-Auswahlmenü',
    vaultOptionsMenu: 'Tresor-Optionsmenü',
    vaultOptions: 'Tresor-Optionen',
    noVaultsFound: 'Keine Tresore gefunden',
    moveToVault: 'In Tresor verschieben',
    moveOutOfVault: 'Aus {{name}} verschieben',
    vaultsFallbackName: 'Tresore',
    editVault: 'Tresor bearbeiten',
    lockVault: 'Tresor sperren',
    unlockVault: 'Tresor entsperren',
    openVaultSettings: 'Tresor-Einstellungen öffnen',
    selectionModeMultiple: 'Mehrere',
    selectionModeOne: 'Einzeln',
    lastEditedBy: 'Zuletzt bearbeitet von',
    sharedBy: 'Geteilt von',
    sharedByContact: 'Geteilt von Kontakt',
    vaultName: 'Tresorname',
    sharedInVault: 'In Tresor geteilt',
    copiedToClipboard: 'In die Zwischenablage kopiert',
    failedToCopyToClipboard: 'Kopieren in die Zwischenablage fehlgeschlagen',
    copyExampleToClipboard: 'Beispiel in die Zwischenablage kopieren',
    copiedExclaim: 'Kopiert!',
    shareUnavailableTitle: 'Teilen nicht verfügbar',
    shareUnavailableMessage: 'Dieser Freigabelink ist nicht mehr verfügbar.',
    invalidLinkTitle: 'Ungültiger Link',
    invalidLinkMessage: 'Dieser Freigabelink ist ungültig oder der Schlüssel fehlt.',
    selfDestructTitle: 'Diese Notiz zerstört sich nach dem Ansehen selbst',
    oneTimeViewConsumed:
      'Sie lesen einen Einmalansicht-Link. Er wurde nun verbraucht und kann nicht erneut geöffnet werden',
    oneTimeViewExpiresClause_one: ' und läuft {{count}} Minute nach dem ersten Öffnen vollständig ab',
    oneTimeViewExpiresClause_other: ' und läuft {{count}} Minuten nach dem ersten Öffnen vollständig ab',
    linkExpires_one: 'Dieser Link läuft {{count}} Minute nach dem ersten Öffnen ab.',
    linkExpires_other: 'Dieser Link läuft {{count}} Minuten nach dem ersten Öffnen ab.',
    untitled: 'Ohne Titel',
    tagHasNoNotes: 'Dieses Thema hat keine Notizen.',
    publicReadOnlyFooter:
      'Dies ist ein öffentlicher, schreibgeschützter Freigabelink. Der Inhalt wurde in Ihrem Browser entschlüsselt.',
    confidentialWatermark: 'Vertraulich · {{datetime}}',
    contentHiddenTitle: 'Inhalt verborgen',
    contentHiddenMessage: 'Geben Sie diesem Fenster den Fokus zurück, um den geteilten Inhalt anzuzeigen.',
  },
}

export default de
