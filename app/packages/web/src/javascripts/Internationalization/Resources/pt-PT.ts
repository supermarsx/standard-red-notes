import type { LocaleResource } from './en'

// Português europeu (pt-PT). Uses European Portuguese vocabulary and spelling
// (e.g. "ficheiros" not "arquivos", "registar" not "cadastrar", "eliminar").
const ptPT: LocaleResource = {
  common: {
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    confirm: 'Confirmar',
    close: 'Fechar',
    edit: 'Editar',
    rename: 'Mudar o nome',
    duplicate: 'Duplicar',
    remove: 'Remover',
    open: 'Abrir',
    create: 'Criar',
    add: 'Adicionar',
    done: 'Concluído',
    back: 'Voltar',
    next: 'Seguinte',
    search: 'Pesquisar',
    clear: 'Limpar',
    loading: 'A carregar…',
    copy: 'Copiar',
    copied: 'Copiado',
    download: 'Transferir',
    upload: 'Carregar',
    export: 'Exportar',
    import: 'Importar',
    yes: 'Sim',
    no: 'Não',
    enabled: 'Ativado',
    disabled: 'Desativado',
    on: 'Ligado',
    off: 'Desligado',
    learnMore: 'Saber mais',
    options: 'Opções',
    settings: 'Definições',
    preferences: 'Preferências',
    help: 'Ajuda',
    pin: 'Fixar',
    unpin: 'Desafixar',
    star: 'Marcar com estrela',
    unstar: 'Retirar estrela',
    archive: 'Arquivar',
    unarchive: 'Desarquivar',
    restore: 'Restaurar',
    moveToTrash: 'Mover para o lixo',
    deletePermanently: 'Eliminar definitivamente',
    protect: 'Proteger',
    unprotect: 'Desproteger',
  },
  navigation: {
    notes: 'Notas',
    allNotes: 'Todas as notas',
    files: 'Ficheiros',
    starred: 'Com estrela',
    archived: 'Arquivadas',
    trash: 'Lixo',
    untagged: 'Sem tópico',
    conflicts: 'Conflitos',
    views: 'Vistas',
    smartViews: 'Vistas inteligentes',
    tags: 'Tópicos',
    folders: 'Pastas',
    favorites: 'Favoritos',
    dashboard: 'Painel',
    createNewNote: 'Criar uma nova nota',
    createNewTag: 'Criar um novo tópico',
    createNewFolder: 'Criar uma nova pasta',
    createNewSmartView: 'Criar uma nova vista inteligente',
    searchTags: 'Pesquisar tópicos…',
    noTagsFound: 'Nenhum tópico encontrado. Tente outra pesquisa.',
    noSmartViewsFound: 'Nenhuma vista inteligente encontrada. Tente outra pesquisa.',
    collapseTagsPanel: 'Recolher painel de tópicos',
    expandTagsPanel: 'Expandir painel de tópicos',
    goToItemsList: 'Ir para a lista de itens',
    goToAccountMenu: 'Ir para o menu da conta',
    openPreferences: 'Abrir preferências',
  },
  account: {
    account: 'Conta',
    signIn: 'Iniciar sessão',
    signOut: 'Terminar sessão',
    signUp: 'Registar',
    register: 'Registar',
    you: 'Você',
    encryptionOn: 'Encriptação ponta a ponta ativada',
    notSignedIn: 'Sessão não iniciada',
    signInOrRegister: 'Inicie sessão ou registe-se para sincronizar as suas notas',
    email: 'Correio eletrónico',
    password: 'Palavra-passe',
    confirmPassword: 'Confirmar palavra-passe',
    syncNow: 'Sincronizar agora',
    lastSynced: 'Última sincronização',
    importData: 'Importar',
    switchWorkspace: 'Mudar de espaço de trabalho',
    lockApplication: 'Bloquear a aplicação',
    helpAndFeedback: 'Ajuda e comentários',
  },
  preferences: {
    title: 'Preferências',
    general: 'Geral',
    account: 'Conta',
    security: 'Segurança',
    appearance: 'Aparência',
    backups: 'Cópias de segurança',
    listed: 'Listed',
    plugins: 'Extensões',
    whatsNew: 'Novidades',
    helpAndFeedback: 'Ajuda e comentários',
    language: 'Idioma',
    languageTitle: 'Idioma',
    languageDescription:
      'Escolha o idioma utilizado em toda a interface da aplicação. A aplicação recorre ao inglês para o que ainda não estiver traduzido.',
    languageChanged: 'Idioma atualizado',
    defaults: 'Predefinições',
    tools: 'Ferramentas',
    spellcheck: 'Verificação ortográfica',
    labs: 'Laboratórios',
  },
  editor: {
    // Clipboard
    cut: 'Cortar',
    copy: 'Copiar',
    paste: 'Colar',
    moreCutOptions: 'Mais opções de cortar',
    moreCopyOptions: 'Mais opções de copiar',
    morePasteOptions: 'Mais opções de colar',

    // History / navigation
    tableOfContents: 'Índice',
    selectAll: 'Selecionar tudo',
    selectAllText: 'Selecionar apenas o texto',
    deselectAll: 'Desselecionar tudo',
    search: 'Pesquisar',
    undo: 'Anular',
    redo: 'Refazer',
    undoHistory: 'Histórico de anulações',
    redoHistory: 'Histórico de repetições',
    undoHistoryEmpty: 'Histórico de anulações — ainda não há nada para anular',
    undoHistoryAvailable: 'Histórico de anulações — recuar vários passos de uma vez',
    redoHistoryEmpty: 'Histórico de repetições — nada para refazer',
    redoHistoryAvailable: 'Histórico de repetições — avançar vários passos de uma vez',

    // Text formatting
    formattingOptions: 'Opções de formatação',
    bold: 'Negrito',
    italic: 'Itálico',
    underline: 'Sublinhado',
    strikethrough: 'Rasurado',
    inlineCode: 'Código em linha',
    link: 'Ligação',
    formatPainter: 'Pincel de formatação — copiar formatação (clique duplo para manter ativo)',
    textStyle: 'Estilo de texto',
    textColor: 'Cor do texto',
    highlightColor: 'Cor de destaque',
    typography: 'Tipografia — ênfase, contorno, espaçamento de letras e palavras',
    typographyTitle: 'Tipografia',

    // Font size / family
    fontSize: 'Tamanho da letra',
    chooseFontSize: 'Escolher o tamanho da letra',
    decreaseFontSize: 'Diminuir o tamanho da letra',
    increaseFontSize: 'Aumentar o tamanho da letra',
    fontFamily: 'Tipo de letra',
    customFontFamily: 'Personalizado',

    // Blocks / lists
    bulletedList: 'Lista com marcas',
    numberedList: 'Lista numerada',
    checkList: 'Lista de verificação',
    quote: 'Citação',
    codeBlock: 'Bloco de código',
    changeCase: 'Mudar maiúsculas/minúsculas',
    sortAndDedupeLines: 'Ordenar e remover linhas duplicadas',
    alignment: 'Alinhamento',
    paragraphLayout: 'Disposição do parágrafo — espaçamento de linhas e parágrafos, indentação, sombreado',
    paragraphLayoutTitle: 'Disposição do parágrafo',
    listStyleMarker: 'Estilo de lista — marca de marcador e número',
    formattingMarks: 'Marcas de formatação',
    insert: 'Inserir',

    // Contextual table tools
    insertRowAbove: 'Inserir linha acima',
    insertRowBelow: 'Inserir linha abaixo',
    insertColumnLeft: 'Inserir coluna à esquerda',
    insertColumnRight: 'Inserir coluna à direita',
    deleteRow: 'Eliminar linha',
    deleteColumn: 'Eliminar coluna',
    toggleRowHeader: 'Alternar cabeçalho de linha',
    toggleColumnHeader: 'Alternar cabeçalho de coluna',
    deleteTable: 'Eliminar tabela',

    // Contextual ribbon segment captions (Office-style grouping)
    rows: 'Linhas',
    columns: 'Colunas',
    cells: 'Células',
    table: 'Tabela',
    block: 'Bloco',

    // Contextual image tools
    alignLeft: 'Alinhar à esquerda',
    alignCenter: 'Alinhar ao centro',
    alignRight: 'Alinhar à direita',

    // Contextual link tools
    editLink: 'Editar ligação',
    removeLink: 'Remover ligação',

    // Zoom
    zoomIntoBlock: 'Ampliar bloco',

    // Floating selection toolbar
    blockStyle: 'Estilo de bloco',
    heading1: 'Título 1',
    heading2: 'Título 2',
    heading3: 'Título 3',
    normalText: 'Texto normal',
    moreFormatting: 'Mais formatação',

    // Note from selection
    createNoteFromSelectionTitle: 'Criar nova nota a partir da seleção',
    createNoteFromSelectionDescription:
      'Cria uma nova nota com a seleção atual e substitui a seleção por uma ligação para a nova nota.',

    // Mobile
    dismissKeyboard: 'Fechar o teclado',

    // Popover titles / a11y labels
    tableOfContentsLower: 'Índice',
    noHeadingsFound: 'Nenhum título encontrado',
    textFormattingOptions: 'Opções de formatação de texto',
    highlight: 'Destaque',
    subscript: 'Subscrito',
    superscript: 'Sobrescrito',
    clearFormatting: 'Limpar formatação',
    normal: 'Normal',
    smartChecklist: 'Lista de verificação inteligente',
    restoreCompletedTasks: 'Restaurar tarefas concluídas',
    leftAlign: 'Alinhar à esquerda',
    centerAlign: 'Alinhar ao centro',
    rightAlign: 'Alinhar à direita',
    justify: 'Justificar',

    // Insert menu
    searchBlocksPlaceholder: 'Pesquisar blocos…',
    searchBlocksToInsert: 'Pesquisar blocos a inserir',
    clearSearch: 'Limpar pesquisa',
    noBlocksMatch: 'Nenhum bloco corresponde a “{{query}}”',
    customizeToolbar: 'Personalizar barra de ferramentas',

    // Color popovers
    custom: 'Personalizado',
    clear: 'Limpar',
    textColorSwatch: 'Cor do texto {{color}}',
    highlightColorSwatch: 'Cor de destaque {{color}}',
    textShadingSwatch: 'Sombreado do texto {{color}}',
    noTextShading: 'Sem sombreado do texto',

    // Change case
    uppercase: 'MAIÚSCULAS',
    lowercase: 'minúsculas',
    camelCase: 'camelCase',

    // Sort lines
    sortLines: 'Ordenar linhas',
    deduplicate: 'Remover duplicados',
    multiKeySort: 'Ordenação por várias chaves (1.ª, 2.ª, 3.ª)…',
    sortAndDeduplicateLines: 'Ordenar e remover linhas duplicadas',

    // Typography popover
    emphasisMarks: 'Marcas de ênfase',
    outlineTextStroke: 'Contorno (traço do texto)',
    letterSpacingKerning: 'Espaçamento de letras (kerning)',
    wordSpacing: 'Espaçamento de palavras',
    clearTypography: 'Limpar tipografia',
    spacingTight: 'Apertado',
    spacingNormal: 'Normal',
    spacingWide: 'Largo',
    spacingWider: 'Mais largo',
    spacingWidest: 'O mais largo',

    // History popovers
    undoMultipleSteps: 'Anular vários passos',
    redoMultipleSteps: 'Refazer vários passos',
    emptyHistoryPreview: '(vazio)',

    // Clipboard option menus
    pasteOptions: 'Opções de colar',
    copyOptions: 'Opções de copiar',
    cutOptions: 'Opções de cortar',
    pasteWithoutFormatting: 'Colar sem formatação',
    pasteClean: 'Colar limpo (remover caracteres ocultos)',
    keepSourceFormatting: 'Manter a formatação de origem',
    matchDestinationFormatting: 'Corresponder à formatação de destino',
    pasteAsImage: 'Colar como imagem',
    copyWithoutFormatting: 'Copiar sem formatação',
    copyTextOnly: 'Copiar apenas o texto',
    copyImagesOnly: 'Copiar apenas as imagens',
    cutWithoutFormatting: 'Cortar sem formatação',
    cutTextOnly: 'Cortar apenas o texto',
    cutImagesOnly: 'Cortar apenas as imagens',

    // Paragraph layout popover
    lineSpacing: 'Espaçamento entre linhas',
    spaceBefore: 'Espaço antes',
    spaceAfter: 'Espaço depois',
    indentation: 'Indentação',
    none: 'Nenhum',
    increaseLeft: 'Aumentar à esquerda',
    decreaseLeft: 'Diminuir à esquerda',
    increaseRight: 'Aumentar à direita',
    decreaseRight: 'Diminuir à direita',
    firstLine: 'Primeira linha',
    noFirstLine: 'Sem primeira linha',
    textShading: 'Sombreado do texto',

    // List style popover
    listStyle: 'Estilo de lista',
    bulleted: 'Com marcas',
    numbered: 'Numerada',
    bulletedListMarkers: 'Estilo de marcador',
    numberedListMarkers: 'Estilo de numeração',
    multilevelList: 'Lista multinível',
    multilevelListHint: 'Escolha um marcador por nível de indentação',
    multilevelLevelDefault: 'Predefinição',
    level: 'Nível',
    apply: 'Aplicar',

    // Modal titles
    insertTable: 'Inserir tabela',
    insertImageFromUrl: 'Inserir imagem a partir de URL',
    sortLinesModalTitle: 'Ordenar linhas',

    // Block picker
    blockPicker: 'Seletor de blocos',

    // Block catalog display names
    blockParagraph: 'Parágrafo',
    blockCallout: 'Destaque',
    blockDivider: 'Separador',
    blockCollapsible: 'Recolhível',
    blockImageFromUrl: 'Imagem a partir de URL',
    blockUploadFile: 'Carregar ficheiro',
    blockDrawing: 'Desenho',
    blockQrCode: 'Código QR',
    blockTable: 'Tabela',
    blockKanbanBoard: 'Quadro Kanban',
    blockCalendar: 'Calendário',
    blockTimeline: 'Cronologia',
    blockDataTable: 'Tabela de dados',
    blockSqlQuery: 'Consulta SQL',
    blockMermaidDiagram: 'Diagrama Mermaid',
    blockGanttChart: 'Gráfico de Gantt',
    blockTimingDiagram: 'Diagrama de temporização',
    blockMusicStaff: 'Pauta musical',
    blockTradingViewChart: 'Gráfico TradingView',
    blockStockChart: 'Gráfico de ações',
    blockEmbed: 'Incorporação',
    blockEmbedWebsite: 'Incorporar site',
    blockTweet: 'Tweet',
    blockEquation: 'Equação',
    blockInlineEquation: 'Equação em linha',
    blockFootnote: 'Nota de rodapé',
    blockBookmark: 'Marcador',
    blockGeneratePassword: 'Gerar palavra-passe criptograficamente segura',
    blockClock: 'Relógio',
    blockCurrentDateTime: 'Data e hora atuais',
    blockCurrentTime: 'Hora atual',
    blockCurrentDate: 'Data atual',

    // Block catalog category headers
    blockCategoryBasic: 'Básico',
    blockCategoryLists: 'Listas',
    blockCategoryMedia: 'Multimédia',
    blockCategoryDataTables: 'Dados e tabelas',
    blockCategoryDiagramsCharts: 'Diagramas e gráficos',
    blockCategoryFinance: 'Finanças',
    blockCategoryEmbeds: 'Incorporações',
    blockCategoryAdvanced: 'Avançado',
  },
  files: {
    // FileViewWithoutProtection
    dropToUploadTooltip: 'Largue os seus ficheiros para os carregar e associar ao ficheiro atual',
    fileAriaLabel: 'Ficheiro',
    fileReadonly: 'Este ficheiro é só de leitura',
    fileInformationPanel: 'Painel de informações do ficheiro',
    details: 'Detalhes',

    // MultipleSelectedFiles
    selectedFilesCount: '{{count}} ficheiros selecionados',
    actionsPerformedOnSelected: 'As ações serão aplicadas a todos os ficheiros selecionados.',
    cancelMultipleSelection: 'Cancelar seleção múltipla',

    // FileContextMenu / FileOptionsPanel
    fileOptions: 'Opções do ficheiro',
    fileContextMenu: 'Menu de contexto do ficheiro',
    fileOptionsMenu: 'Menu de opções do ficheiro',
    fileOptionsPanel: 'Painel de opções do ficheiro',

    // FileMenuOptions
    noFilesSelected: 'Nenhum ficheiro selecionado',
    detachFromNote: 'Desassociar da nota',
    attachToNote: 'Associar à nota',
    passwordProtect: 'Proteger com palavra-passe',
    downloadSeparately: 'Transferir separadamente',
    downloadAsArchive: 'Transferir como arquivo',
    failedToDownloadArchive: 'Falha ao transferir os ficheiros como arquivo',
    fileId: 'ID do ficheiro:',
    size: 'Tamanho:',
    totalSize: 'Tamanho total:',

    // FileContextMenuBackupOption
    backedUpOn: 'Cópia de segurança em {{date}}',
    configureFileBackups: 'Configurar cópias de segurança de ficheiros',
    fileNotBackedUpLocally: 'Ficheiro sem cópia de segurança local',

    // MoveFileToFolderOption
    noFoldersYet: 'Ainda não há pastas',
    moveToFolder: 'Mover para pasta',
    folderSelectionMenu: 'Menu de seleção de pasta',
    noFolder: 'Sem pasta',

    // FilePreview
    fileProtected: 'Este ficheiro está protegido.',
    authenticateToView: 'Autentique-se para ver este ficheiro.',
    addPasscodeToView: 'Adicione um código de acesso ou crie uma conta para exigir autenticação para ver este ficheiro.',
    openAccountMenu: 'Abrir menu da conta',
    authenticate: 'Autenticar',
    viewFile: 'Ver ficheiro',
    loading: 'A carregar...',

    // FilePreviewError
    fileCannotBePreviewed: 'Não é possível pré-visualizar este ficheiro.',
    errorLoadingFile: 'Ocorreu um erro ao carregar o ficheiro. Tente novamente ou transfira o ficheiro e abra-o com outra aplicação.',
    tryAgain: 'Tentar novamente',
    downloadToView: 'Para ver este ficheiro, transfira-o e abra-o com outra aplicação.',

    // FilePreviewInfoPanel
    fileInformation: 'Informações do ficheiro',
    type: 'Tipo:',
    decryptedSize: 'Tamanho desencriptado:',
    encryptedSize: 'Tamanho encriptado:',
    created: 'Criado:',
    lastModified: 'Última modificação:',

    // FilePreviewModal
    done: 'Concluído',
    showFileOptions: 'Mostrar opções do ficheiro',
    showFileInfo: 'Mostrar informações do ficheiro',
    hideFileInfo: 'Ocultar informações do ficheiro',
    showLinksSection: 'Mostrar secção de ligações',
    hideLinksSection: 'Ocultar secção de ligações',
    submit: 'Submeter',
    renameFile: 'Mudar o nome do ficheiro',
    showLinkedItems: 'Mostrar itens associados',
    closeModal: 'Fechar janela',
    filePreviewModal: 'Janela de pré-visualização do ficheiro',

    // ImageAlignmentOptions
    leftAlign: 'Alinhar à esquerda',
    centerAlign: 'Alinhar ao centro',
    rightAlign: 'Alinhar à direita',

    // VideoPreview
    videoCannotBePreviewed: 'Não é possível pré-visualizar este vídeo.',

    // AudioPreview
    audioCannotBePlayed: 'Não é possível reproduzir este áudio.',
    downloadToListen: 'Para ouvir este ficheiro, transfira-o e abra-o com outra aplicação.',

    // PreviewComponent
    externalAppOnly: 'Este ficheiro só pode ser pré-visualizado numa aplicação externa',
    openFilePreview: 'Abrir pré-visualização do ficheiro',
    loadingPdfViewer: 'A carregar o visualizador de PDF...',

    // ZoomableImage
    zoomOut: 'Reduzir',
    zoomIn: 'Ampliar',
    resetToActualSize: 'Repor o tamanho real',
    resetTo100: 'Repor a 100%',
    fitToScreen: 'Ajustar ao ecrã',

    // PdfPreview
    unableToRenderPdf: 'Não é possível apresentar este PDF.',
    pdfCorruptedOrProtected: 'O ficheiro pode estar danificado ou protegido por palavra-passe.',
    loadingPdf: 'A carregar PDF...',
    previousPage: 'Página anterior',
    pageNumber: 'Número da página',
    nextPage: 'Página seguinte',
    fitWidth: 'Ajustar à largura',
    searchInDocumentShortcut: 'Pesquisar no documento (Ctrl/Cmd+F)',
    searchInDocument: 'Pesquisar no documento',
    copyLinkToPage: 'Copiar ligação para a página {{page}}',
    copyLinkToThisPage: 'Copiar ligação para esta página',
    copyLinkToSelectedText: 'Copiar ligação para o texto selecionado',
    cancelOcr: 'Cancelar OCR',
    preparingOcr: 'A preparar o OCR...',
    ocrProgress: 'OCR página {{current}} / {{total}} ({{percent}}%)',
    ocrCachedReRunTooltip: 'Texto já extraído (em cache). Voltar a executar o OCR no seu navegador (permanece no seu dispositivo).',
    ocrExtractedReRunTooltip: 'Texto extraído. Voltar a executar o OCR no seu navegador (permanece no seu dispositivo).',
    ocrExtractTooltip: 'Extrair texto de páginas digitalizadas com OCR. É executado no seu navegador; nada sai do seu dispositivo (lento; transfere dados de idioma).',
    extractTextWithOcrBrowser: 'Extrair texto com OCR no seu navegador',
    reRunOcrBrowser: 'Voltar a executar o OCR (navegador)',
    extractTextOcr: 'Extrair texto (OCR)',
    serverOcrTooltip:
      'Executar o OCR no SERVIDOR. Isto envia as imagens das páginas deste PDF para o servidor e ABANDONA a encriptação ponta a ponta — o servidor pode ler esse conteúdo. O OCR no navegador mantém tudo no seu dispositivo.',
    runOcrOnServerAria: 'Executar o OCR no servidor (envia as imagens das páginas para o servidor; abandona a encriptação ponta a ponta)',
    runOcrOnServer: 'Executar OCR no servidor',
    copyAllExtractedText: 'Copiar todo o texto extraído',
    copyExtractedTextAria: 'Copiar texto extraído',
    findInDocument: 'Localizar no documento',
    matchCase: 'Coincidir maiúsculas/minúsculas',
    noResults: 'Sem resultados',
    matchOfTotal: '{{current}} de {{total}}',
    previousMatch: 'Correspondência anterior',
    nextMatch: 'Correspondência seguinte',
    closeSearch: 'Fechar pesquisa',
    serverOcrDisclosurePrefix: 'O OCR no servidor está disponível para a sua conta. Envia as imagens das páginas deste PDF para o servidor e',
    serverOcrDisclosureBold: 'abandona a encriptação ponta a ponta',
    serverOcrDisclosureSuffix:
      ' — o servidor (e quem o controla) pode ler esse conteúdo. O OCR no navegador mantém tudo no seu dispositivo. A predefinição é o OCR no navegador.',
    ocrRunningServer:
      'OCR no servidor: as imagens das páginas deste PDF estão a ser carregadas para o servidor, o que ABANDONA a encriptação ponta a ponta — o servidor pode ler esse conteúdo. (O OCR no navegador mantém tudo no seu dispositivo.)',
    ocrRunningBrowser:
      'O OCR é executado no seu navegador, neste dispositivo (os seus ficheiros permanecem encriptados ponta a ponta). É lento e transfere dados de idioma na primeira utilização.',
    ocrDoneServer:
      'OCR no servidor concluído. As imagens das páginas foram enviadas para o servidor (isto abandonou a encriptação ponta a ponta). A precisão varia consoante a qualidade da digitalização; o texto extraído está agora pesquisável e pode ser copiado, e fica em cache neste dispositivo.',
    ocrDoneBrowser:
      'OCR concluído. A precisão varia consoante a qualidade da digitalização; o texto extraído está agora pesquisável e pode ser copiado, e fica em cache neste dispositivo.',

    // PdfPreview toasts (call-time)
    copiedExtractedText: 'Texto extraído copiado',
    copiedLinkToPage: 'Ligação para a página {{page}} copiada',
    copiedLinkToSelectedText: 'Ligação para o texto selecionado copiada',

    // PdfPreview OCR errors (call-time)
    serverOcrFailed: 'O OCR no servidor falhou: {{message}}',
    ocrUnknownError: 'erro desconhecido',
    ocrFailed: 'O OCR falhou. Os dados de idioma podem não ter sido transferidos.',
  },
  notes: {
    // ContentListView
    notesAndFiles: 'Notas e ficheiros',
    selectAllItems: 'Selecionar todos os itens',
    selectedCount: '{{count}} selecionados',
    cancelMultipleSelection: 'Cancelar seleção múltipla',
    noFilesInFolder: 'Nenhum ficheiro nesta pasta.',
    noItems: 'Nenhum item.',
    loading: 'A carregar...',
    uploadFileWithShortcut: 'Carregar ficheiro {{shortcut}}',
    createNoteInTopicWithShortcut: 'Criar uma nova nota no tópico selecionado {{shortcut}}',
    dropFilesToUpload: 'Largue os seus ficheiros para os carregar e associar ao tópico "{{title}}"',

    // EmptyFilesView
    noFilesYet: 'Ainda não tem ficheiros',
    filesAttachedAppearHere:
      'Os ficheiros associados às suas notas aparecem aqui. Também pode carregar ficheiros diretamente a partir desta página.',
    uploadFiles: 'Carregar ficheiros',

    // ContentListHeader
    syncing: 'A sincronizar...',
    loadingItemsProgress: 'A carregar {{current}}/{{total}} itens...',
    potentiallyOutOfSync: 'Possivelmente dessincronizado',
    openDisplayOptionsMenu: 'Abrir menu de opções de apresentação',
    displayOptionsMenu: 'Menu de opções de apresentação',
    displayOptions: 'Opções de apresentação',
    expandTopicsPanel: 'Expandir painel de tópicos',
    collapseNotesPanel: 'Recolher painel de notas',

    // AddItemMenuButton
    addItem: 'Adicionar item',
    uploadFolder: 'Carregar pasta',
    takePhoto: 'Tirar fotografia',
    recordVideo: 'Gravar vídeo',

    // SearchButton
    searchPlaceholder: 'Pesquisar...',

    // DisplayOptionsMenu
    notesListOptionsMenu: 'Menu de opções da lista de notas',
    preferencesFor: 'Preferências para',
    global: 'Global',
    reset: 'Repor',
    upgradeForPerTopicPreferences: 'Atualize para preferências por tópico',
    perTopicPreferencesMessageWithDaily:
      'Crie fluxos de trabalho e disposições organizacionais poderosos com preferências de apresentação por tópico e a nova disposição de calendário Daily Notebook.',
    perTopicPreferencesMessage:
      'Crie fluxos de trabalho e disposições organizacionais poderosos com preferências de apresentação por tópico.',
    sortBy: 'Ordenar por',
    relevanceBestMatch: 'Relevância (melhor correspondência)',
    dateModified: 'Data de modificação',
    creationDate: 'Data de criação',
    title: 'Título',
    customDragToReorder: 'Personalizado (arraste para reordenar)',
    view: 'Vista',
    showNotePreview: 'Mostrar pré-visualização da nota',
    showDate: 'Mostrar data',
    showTags: 'Mostrar tópicos',
    showIcon: 'Mostrar ícone',
    other: 'Outros',
    showPinned: 'Mostrar fixadas',
    showProtected: 'Mostrar protegidas',
    showArchived: 'Mostrar arquivadas',
    showTrashed: 'Mostrar no lixo',
    dailyNotebook: 'Daily Notebook',
    labs: 'Labs',
    dailyNotebookDescription: 'Capture novas notas diariamente com uma disposição baseada em calendário',
    tableView: 'Vista de tabela',
    tableViewDescription: 'Apresentar as notas e os ficheiros do tópico atual numa disposição de tabela',
    newNoteDefaults: 'Predefinições de novas notas',

    // NewNotePreferences
    noteType: 'Tipo de nota',
    selectDefaultNoteType: 'Selecione o tipo de nota predefinido',
    titleFormat: 'Formato do título',
    selectTitleFormat: 'Selecione o formato do título da nota',
    customFormatPlaceholder: 'ex.: AAAA-MM-DD',
    preview: 'Pré-visualização: ',
    useBracketsToEscape: '. Utilize ',
    toEscapeFormatting: ' para escapar à formatação.',

    // ListItemMetadata
    protected: 'Protegida',
    modified: 'Modificada',
    now: 'Agora',

    // ListItemFlagIcons
    editingDisabled: 'Edição desativada',
    trashed: 'No lixo',
    archived: 'Arquivada',
    files: 'Ficheiros',
    starred: 'Com estrela',
    fileBackedUpLocally: 'O ficheiro tem cópia de segurança local',

    // ListItemConflictIndicator
    conflictedCopy: 'Cópia em conflito',

    // FilesFolderBar
    allFiles: 'Todos os ficheiros',
    noFolder: 'Sem pasta',
    folderNamePlaceholder: 'Nome da pasta',
    createNewFolder: 'Criar uma nova pasta',
    newFolder: 'Nova pasta',

    // DailyContentList
    currentStreak: 'Sequência atual',
    dayWithCount_one: 'Dia',
    dayWithCount_many: 'Dias',
    dayWithCount_other: 'Dias',
  },
  auth: {
    // AdvancedOptions
    unableToComputePrivateUsername: 'Não foi possível calcular o nome de utilizador privado.',
    advancedOptions: 'Opções avançadas',
    privateUsernameMode: 'Modo de nome de utilizador privado',
    username: 'Nome de utilizador',
    useStrictSignIn: 'Utilizar início de sessão restrito',
    useRecoveryCode: 'Utilizar código de recuperação',
    recoveryCode: 'Código de recuperação',

    // ConfirmNoMergeDialog
    deleteLocalDataTitle: 'Eliminar dados locais?',
    noMergeWarning:
      'Optou por não fundir os seus dados locais. Se continuar, as suas notas e tópicos locais serão eliminados definitivamente e substituídos pelos dados da sua conta. Esta ação não pode ser anulada.',
    noMergeConfirmQuestion: 'Tem a certeza de que pretende continuar sem fundir?',
    deleteLocalDataAndContinue: 'Eliminar dados locais e continuar',

    // ConfirmPassword
    passwordResetWarningPart1: 'Como as suas notas são encriptadas com a sua palavra-passe,',
    passwordResetWarningHighlight: 'o Standard Red Notes não dispõe de opção de reposição de palavra-passe',
    passwordResetWarningPart2: '. Se esquecer a sua palavra-passe, perderá definitivamente o acesso aos seus dados.',
    confirmPassword: 'Confirmar palavra-passe',
    creatingAccount: 'A criar conta...',
    createAccountAndSignIn: 'Criar conta e iniciar sessão',
    staySignedIn: 'Manter sessão iniciada',
    goBack: 'Voltar',
    humanVerification: 'Verificação humana',
    confirmPasswordTitle: 'Confirmar palavra-passe',

    // CreateAccount
    createAccount: 'Criar conta',
    workspaceNameOptional: 'Nome do espaço de trabalho (opcional)',

    // GeneralAccountMenu
    generalAccountMenuLabel: 'Menu geral da conta',
    signedInAs: 'Sessão iniciada como:',
    syncing: 'A sincronizar...',
    lastSynced: 'Última sincronização:',
    offlineSignInPrompt:
      'Está offline. Inicie sessão para sincronizar as suas notas e preferências em todos os seus dispositivos e ativar a encriptação ponta a ponta.',
    offline: 'Offline',
    accountSettings: 'Definições da conta',
    createFreeAccount: 'Criar conta gratuita',
    documentation: 'Documentação',
    keyboardShortcuts: 'Atalhos de teclado',
    commandPalette: 'Paleta de comandos',
    signOutWorkspace: 'Terminar sessão do espaço de trabalho',

    // MergeLocalDataCheckbox
    mergeLocalData: 'Fundir dados locais ({{count}} notas e tópicos)',
    mergeLocalDataTooltip:
      'Se não estiver assinalado, as suas notas e tópicos locais serão eliminados definitivamente e substituídos pelos dados da sua conta.',

    // ServerPicker
    homeServerNotRunning:
      'O servidor doméstico não está em execução. Abra as preferências e o separador do servidor doméstico para o iniciar.',
    serverDefault: 'Predefinição',
    serverCustom: 'Personalizado',
    serverHomeServer: 'Servidor doméstico',
    syncServer: 'Servidor de sincronização',

    // SignIn
    signingIn: 'A iniciar sessão...',

    // User
    syncUnreachable: 'Sincronização inacessível',
    syncUnreachableMessage: 'Hmm... parece que não conseguimos sincronizar a sua conta. O motivo: {{reason}}',

    // WorkspaceSwitcherMenu
    workspaceSwitcherMenuLabel: 'Menu de mudança de espaço de trabalho',
    signOutAllWorkspacesConfirm: 'Tem a certeza de que pretende terminar a sessão de todos os espaços de trabalho neste dispositivo?',
    signOutAll: 'Terminar sessão de todos',
    addAnotherWorkspace: 'Adicionar outro espaço de trabalho',
    signOutAllWorkspaces: 'Terminar sessão de todos os espaços de trabalho',

    // ConfirmDeleteAccountModal
    deleteAccountTitle: 'Eliminar conta?',
    deleteMyAccountForGood: 'Eliminar a minha conta definitivamente',

    // NoAccountWarningContent
    dataNotBackedUp: 'Dados sem cópia de segurança',
    signInOrRegisterToSync:
      'Inicie sessão ou registe-se para sincronizar as suas notas com os seus outros dispositivos com encriptação ponta a ponta.',
    openAccountMenu: 'Abrir menu da conta',
    ignoreWarning: 'Ignorar aviso',

    // U2FAuthIframe
    waitingForSecurityKey: 'A aguardar pela chave de segurança...',
    authenticationSuccessful: 'Autenticação bem-sucedida!',
    insertSecurityKeyPrompt: 'Insira a sua chave de segurança de hardware e, em seguida, prima o botão abaixo para autenticar.',
    authenticate: 'Autenticar',
  },
  search: {
    // SearchBar
    placeholder: 'Pesquisar...',

    // SearchOptions (quick toggle bubbles)
    protectedContents: 'Conteúdos protegidos',
    archived: 'Arquivadas',
    trashed: 'No lixo',

    // AiContextualSearch
    aiUnavailable: 'A reordenação por IA está indisponível ou não devolveu resultados.',
    aiUnavailableTooltip: 'A pesquisa contextual por IA está indisponível.',
    aiTypeQueryFirst: 'Escreva primeiro uma consulta de pesquisa.',
    aiTooltip:
      'Reordene os melhores resultados por relevância semântica utilizando o seu fornecedor de IA configurado. ' +
      'Envia os títulos e pequenos excertos desses candidatos, juntamente com a sua consulta, ao fornecedor.',
    aiSearchWithAi: 'Pesquisar com IA',
    aiRanking: 'A ordenar…',
    aiRankedByRelevance: 'Ordenado por relevância da IA',
    aiPrivacyNotice:
      'Envia os títulos e excertos dos melhores resultados e a sua consulta ao seu fornecedor de IA. Os fornecedores na nuvem irão vê-los — ' +
      'um modelo local mantém tudo no dispositivo.',

    // AdvancedSearchOptions
    advancedFilters: 'Filtros de pesquisa avançados',
    filters: 'Filtros',
    noteTypeAny: 'Qualquer tipo',
    noteTypePlainText: 'Texto simples',
    noteTypeRichText: 'Texto formatado',
    noteTypeSuper: 'Super',
    noteTypeMarkdown: 'Markdown',
    noteTypeCode: 'Código',
    noteTypeTask: 'Tarefa',
    noteTypeSpreadsheet: 'Folha de cálculo',
    flagProtected: 'Protegida',
    flagPinned: 'Fixada',
    flagArchived: 'Arquivada',
    flagStarred: 'Com estrela',
    flagTrashed: 'No lixo',
    topicsLabel: 'Tópicos (separados por vírgulas)',
    topicsPlaceholder: 'trabalho, pessoal',
    noteTypeLabel: 'Tipo de nota',
    searchInLabel: 'Pesquisar em',
    searchInTitleAndContent: 'Título e conteúdo',
    modifiedWithinLabel: 'Modificado nos últimos',
    datePreset: 'Últimos {{label}}',
    createdAfterLabel: 'Criado após',
    createdBeforeLabel: 'Criado antes de',
    updatedAfterLabel: 'Atualizado após',
    updatedBeforeLabel: 'Atualizado antes de',
    statusLabel: 'Estado',
    hasAttachments: 'Tem anexos',
    caseSensitive: 'Distinguir maiúsculas/minúsculas',
    clearAllFilters: 'Limpar todos os filtros',
  },
  sharing: {
    vaultSelectionMenu: 'Menu de seleção de cofre',
    vaultOptionsMenu: 'Menu de opções do cofre',
    vaultOptions: 'Opções do cofre',
    noVaultsFound: 'Nenhum cofre encontrado',
    moveToVault: 'Mover para cofre',
    moveOutOfVault: 'Retirar de {{name}}',
    vaultsFallbackName: 'cofres',
    editVault: 'Editar cofre',
    lockVault: 'Bloquear cofre',
    unlockVault: 'Desbloquear cofre',
    openVaultSettings: 'Abrir definições do cofre',
    selectionModeMultiple: 'Múltiplos',
    selectionModeOne: 'Um',
    lastEditedBy: 'Última edição por',
    sharedBy: 'Partilhado por',
    sharedByContact: 'Partilhado por contacto',
    vaultName: 'Nome do cofre',
    sharedInVault: 'Partilhado no cofre',
    copiedToClipboard: 'Copiado para a área de transferência',
    failedToCopyToClipboard: 'Falha ao copiar para a área de transferência',
    copyExampleToClipboard: 'Copiar exemplo para a área de transferência',
    copiedExclaim: 'Copiado!',
    shareUnavailableTitle: 'Partilha indisponível',
    shareUnavailableMessage: 'Esta ligação de partilha já não está disponível.',
    invalidLinkTitle: 'Ligação inválida',
    invalidLinkMessage: 'Esta ligação de partilha é inválida ou falta a chave.',
    selfDestructTitle: 'Esta nota autodestrói-se após a visualização',
    oneTimeViewConsumed: 'Está a ler uma ligação de visualização única. Foi agora consumida e não pode ser reaberta',
    oneTimeViewExpiresClause_one: ', e expira totalmente {{count}} minuto após a primeira abertura',
    oneTimeViewExpiresClause_many: ', e expira totalmente {{count}} minutos após a primeira abertura',
    oneTimeViewExpiresClause_other: ', e expira totalmente {{count}} minutos após a primeira abertura',
    linkExpires_one: 'Esta ligação expira {{count}} minuto após ter sido aberta pela primeira vez.',
    linkExpires_many: 'Esta ligação expira {{count}} minutos após ter sido aberta pela primeira vez.',
    linkExpires_other: 'Esta ligação expira {{count}} minutos após ter sido aberta pela primeira vez.',
    untitled: 'Sem título',
    tagHasNoNotes: 'Este tópico não tem notas.',
    publicReadOnlyFooter: 'Esta é uma ligação partilhada pública e só de leitura. O conteúdo foi desencriptado no seu navegador.',
    confidentialWatermark: 'Confidencial · {{datetime}}',
    contentHiddenTitle: 'Conteúdo oculto',
    contentHiddenMessage: 'Devolva o foco a esta janela para ver o conteúdo partilhado.',
  },
}

export default ptPT
