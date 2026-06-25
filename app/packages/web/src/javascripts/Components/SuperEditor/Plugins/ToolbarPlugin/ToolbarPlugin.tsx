import Icon from '@/Components/Icon/Icon'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import useModal from '../../Lexical/Hooks/useModal'
import { InsertTableDialog } from '../TablePlugin'
import { getSelectedNode } from '../../Lexical/Utils/getSelectedNode'
import {
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_NORMAL,
  FORMAT_TEXT_COMMAND,
  KEY_MODIFIER_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  createCommand,
  $isRootOrShadowRoot,
  ElementFormatType,
  $isElementNode,
  COMMAND_PRIORITY_LOW,
  $createParagraphNode,
  $isTextNode,
  $getNodeByKey,
  TextNode,
  BaseSelection,
} from 'lexical'
import {
  mergeRegister,
  $findMatchingParent,
  $getNearestNodeOfType,
  $getNearestBlockElementAncestorOrThrow,
} from '@lexical/utils'
import { $isLinkNode, TOGGLE_LINK_COMMAND, LinkNode } from '@lexical/link'
import {
  $isListNode,
  ListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import { $patchStyleText, $getSelectionStyleValueForProperty, $setBlocksType } from '@lexical/selection'
import { $createCodeNode, $isCodeNode } from '@lexical/code'
import {
  ComponentPropsWithoutRef,
  ForwardedRef,
  ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { CenterAlignBlock, JustifyAlignBlock, LeftAlignBlock, RightAlignBlock } from '../Blocks/Alignment'
import { BulletedListBlock, ChecklistBlock, NumberedListBlock } from '../Blocks/List'
import { CodeBlock } from '../Blocks/Code'
import { CollapsibleBlock } from '../Blocks/Collapsible'
import { DividerBlock } from '../Blocks/Divider'
import { H1Block, H2Block, H3Block } from '../Blocks/Headings'
import { IndentBlock, OutdentBlock } from '../Blocks/IndentOutdent'
import { ParagraphBlock } from '../Blocks/Paragraph'
import { QuoteBlock } from '../Blocks/Quote'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { LocalPrefKey, PrefKey, classNames } from '@standardnotes/snjs'
import { SUPER_TOGGLE_SEARCH, SUPER_TOGGLE_TOOLBAR } from '@standardnotes/ui-services'
import { useApplication } from '@/Components/ApplicationProvider'
import { InsertRemoteImageDialog } from '../RemoteImagePlugin/RemoteImagePlugin'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { Toolbar, ToolbarItem, useToolbarStore } from '@ariakit/react'
import { PasswordBlock } from '../Blocks/Password'
import { KanbanBlock } from '../Blocks/Kanban'
import { CalendarBlock } from '../Blocks/Calendar'
import { TimelineBlock } from '../Blocks/Timeline'
import { DataviewBlock } from '../Blocks/Dataview'
import { CalloutBlock } from '../Blocks/Callout'
import { EmbedBlock } from '../Blocks/Embed'
import { WebEmbedBlock } from '../Blocks/WebEmbed'
import { TweetEmbedBlock } from '../Blocks/TweetEmbed'
import { MathBlock } from '../Blocks/Math'
import { InlineMathBlock } from '../Blocks/InlineMath'
import { MermaidBlock } from '../Blocks/Mermaid'
import { FootnoteBlock } from '../Blocks/Footnote'
import { URL_REGEX } from '@/Constants/Constants'
import Popover from '@/Components/Popover/Popover'
import { TableOfContentsPlugin } from '@lexical/react/LexicalTableOfContentsPlugin'
import Menu from '@/Components/Menu/Menu'
import MenuItem, { MenuItemProps } from '@/Components/Menu/MenuItem'
import { debounce, remToPx } from '@/Utils'
import LinkEditor, { $isLinkTextNode } from './LinkEditor'
import { LINE_DEDUPE_MODES, LINE_SORT_MODES, LineOperation } from './LineOperations'
import { $applyLineTransform, $transformSelectedLines } from './LineTransform'
import { multiKeySort, MultiKeySortOptions } from './LineSortMultiKey'
import MultiKeySortDialog from './MultiKeySortDialog'
import { $applyFontSizeToSelection, clampFontSize, FONT_SIZE_PRESETS, FONT_SIZE_STEP, parseFontSize } from './FontSize'
import { getSuperHistoryStore, HISTORY_DROPDOWN_LIMIT } from '../HistoryPlugin/SuperHistory'
import MenuItemSeparator from '@/Components/Menu/MenuItemSeparator'
import { useStateRef } from '@/Hooks/useStateRef'
import { getDOMRangeRect } from '../../Lexical/Utils/getDOMRangeRect'
import { getPositionedPopoverStyles } from '@/Components/Popover/GetPositionedPopoverStyles'
import usePreference from '@/Hooks/usePreference'
import { ElementIds } from '@/Constants/ElementIDs'
import { $isDecoratorBlockNode } from '@lexical/react/LexicalDecoratorBlockNode'
import LinkViewer from './LinkViewer'
import { OPEN_FILE_UPLOAD_MODAL_COMMAND } from '../EncryptedFilePlugin/FilePlugin'
import { CREATE_NOTE_FROM_SELECTION_COMMAND } from '../NoteFromSelectionPlugin'
import SelectionTools from './SelectionTools'
import {
  getChecklistAutoMoveEnabled,
  setChecklistAutoMoveEnabled,
  subscribeChecklistAutoMove,
} from '../CheckListAutoMovePlugin/autoMoveSetting'
import { $reorderCheckList } from '../CheckListAutoMovePlugin/reorderCheckList'
import { $getOwningCheckList, $uncheckAllInList } from '../CheckListAutoMovePlugin/bulkUncheck'
import { useLocalPreference } from '@/Hooks/usePreference'
import { applyToolbarConfig, ToolbarButtonId, ToolbarGroupId } from './ToolbarConfig'
import CustomizeToolbarDialog from './CustomizeToolbarDialog'
import { Fragment } from 'react'
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $getTableCellNodeFromLexicalNode,
  $getTableColumnIndexFromTableCellNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableRowIndexFromTableCellNode,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
} from '@lexical/table'
import {
  ContextualWidget,
  ContextualWidgetKind,
  DECORATOR_BLOCK_LABELS,
  isDecoratorBlockType,
  isImageNodeType,
  resolveContextualWidget,
} from './ContextualToolbar'
import BlockZoomOverlay from './BlockZoomOverlay'

const TOGGLE_LINK_AND_EDIT_COMMAND = createCommand<string | null>('TOGGLE_LINK_AND_EDIT_COMMAND')

const blockTypeToBlockName = {
  bullet: 'Bulleted List',
  check: 'Check List',
  code: 'Code Block',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  number: 'Numbered List',
  paragraph: 'Normal',
  quote: 'Quote',
}

const blockTypeToIconName = {
  bullet: 'list-bulleted',
  check: 'list-check',
  code: 'code',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  number: 'list-numbered',
  paragraph: 'paragraph',
  quote: 'quote',
}

const COLOR_PRESETS = [
  '#000000',
  '#5b5b5b',
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#2563eb',
  '#7c3aed',
  '#db2777',
]

const FONT_FAMILIES: { name: string; value: string | null }[] = [
  { name: 'Default', value: null },
  { name: 'Sans-serif', value: 'sans-serif' },
  { name: 'Serif', value: 'serif' },
  { name: 'Monospace', value: 'monospace' },
  { name: 'Arial', value: 'Arial, sans-serif' },
  { name: 'Georgia', value: 'Georgia, serif' },
  { name: 'Times New Roman', value: '"Times New Roman", serif' },
  { name: 'Courier New', value: '"Courier New", monospace' },
  { name: 'Trebuchet MS', value: '"Trebuchet MS", sans-serif' },
]

const toCamelCase = (text: string): string => {
  const words = text.split(/[^a-zA-Z0-9]+/).filter((word) => word.length > 0)
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('')
}

interface ToolbarButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'name'> {
  name: NonNullable<ReactNode>
  active?: boolean
  iconName?: string
  children?: ReactNode
  onSelect: () => void
}

const ToolbarButton = forwardRef(
  (
    { name, active, iconName, children, onSelect, disabled, className, ...props }: ToolbarButtonProps,
    ref: ForwardedRef<HTMLButtonElement>,
  ) => {
    const [editor] = useLexicalComposerContext()

    const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
    const parentElement = editor.getRootElement()?.parentElement ?? document.body

    return (
      <StyledTooltip
        showOnMobile
        showOnHover
        label={name}
        side="top"
        portalElement={isMobile ? parentElement : undefined}
        documentElement={parentElement}
      >
        <ToolbarItem
          className={classNames(
            'flex select-none items-center justify-center rounded-md p-0.5 transition-colors duration-75 focus:shadow-none focus:outline-none md:border md:border-transparent',
            'hover:bg-passive-4 focus-visible:bg-passive-4 active:bg-passive-3 hover:md:border-border',
            // Disabled buttons keep aria-disabled (not the native attribute) so they
            // stay hoverable and their tooltip still explains them; override the
            // interactive styling back so they read as greyed and inert.
            'aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent aria-disabled:hover:md:border-transparent',
            className,
          )}
          onClick={() => {
            if (!disabled) {
              onSelect()
            }
          }}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onContextMenu={(event) => {
            editor.focus()
            event.preventDefault()
          }}
          disabled={disabled}
          // Keep disabled buttons hoverable (aria-disabled, not the native disabled
          // attribute) so their StyledTooltip still explains what the greyed-out
          // button does instead of being inert.
          accessibleWhenDisabled
          ref={ref}
          {...props}
        >
          <div
            className={classNames(
              'flex items-center justify-center rounded-md p-2.5 transition-colors duration-75 md:p-2',
              active && 'bg-info text-info-contrast shadow-sm',
            )}
          >
            {children ? (
              children
            ) : iconName ? (
              <Icon
                type={iconName}
                size="custom"
                className="h-5 w-5 !text-current md:h-4 md:w-4 [&>path]:!text-current"
              />
            ) : null}
          </div>
        </ToolbarItem>
      </StyledTooltip>
    )
  },
)

const ToolbarSeparator = () => (
  <div aria-hidden className="mx-1 my-1 h-6 w-px flex-shrink-0 self-center bg-border" role="separator" />
)

interface ToolbarMenuItemProps extends Omit<MenuItemProps, 'children'> {
  name: string
  iconName: string
  active?: boolean
}

const ToolbarMenuItem = ({ name, iconName, active, onClick, ...props }: ToolbarMenuItemProps) => {
  return (
    <MenuItem
      className={classNames('overflow-hidden md:py-2', active ? '!bg-info !text-info-contrast' : 'hover:bg-contrast')}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      {...props}
    >
      <Icon type={iconName} className="-mt-px mr-2.5 flex-shrink-0" />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
      {active && <Icon type="check" className="ml-auto" />}
    </MenuItem>
  )
}

const ToolbarPlugin = () => {
  const application = useApplication()
  const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  const [modal, showModal] = useModal()

  const [editor] = useLexicalComposerContext()
  const [activeEditor, setActiveEditor] = useState(editor)
  const [isEditable, setIsEditable] = useState(() => editor.isEditable())

  const [blockType, setBlockType] = useState<keyof typeof blockTypeToBlockName>('paragraph')
  const [elementFormat, setElementFormat] = useState<ElementFormatType>('left')

  const [isBold, setIsBold] = useState(false)
  const [isItalic, setIsItalic] = useState(false)
  const [isUnderline, setIsUnderline] = useState(false)
  const [isStrikethrough, setIsStrikethrough] = useState(false)
  const [isSubscript, setIsSubscript] = useState(false)
  const [isSuperscript, setIsSuperscript] = useState(false)
  const [isCode, setIsCode] = useState(false)
  const [isHighlight, setIsHighlight] = useState(false)

  const [hasNonCollapsedSelection, setHasNonCollapsedSelection] = useState(false)

  const [linkNode, setLinkNode] = useState<LinkNode | null>(null)
  const [linkTextNode, setLinkTextNode] = useState<TextNode | null>(null)
  const [isEditingLink, setIsEditingLink] = useState(false)

  // Feature #273: which special widget (if any) the selection is currently in,
  // driving the dynamic contextual toolbar group. Feature #287: the key + label
  // of the active top-level block, used to zoom into it.
  const [contextualWidget, setContextualWidget] = useState<ContextualWidget | null>(null)
  const [activeBlockKey, setActiveBlockKey] = useState<string | null>(null)
  const [activeBlockLabel, setActiveBlockLabel] = useState<string>('Block')
  const [zoomBlockKey, setZoomBlockKey] = useState<string | null>(null)

  const [isTOCOpen, setIsTOCOpen] = useState(false)
  const tocAnchorRef = useRef<HTMLButtonElement>(null)

  const [isTextFormatMenuOpen, setIsTextFormatMenuOpen] = useState(false)
  const textFormatAnchorRef = useRef<HTMLButtonElement>(null)

  const [isTextStyleMenuOpen, setIsTextStyleMenuOpen] = useState(false)
  const textStyleAnchorRef = useRef<HTMLButtonElement>(null)

  const [isAlignmentMenuOpen, setIsAlignmentMenuOpen] = useState(false)
  const alignmentAnchorRef = useRef<HTMLButtonElement>(null)

  const [isInsertMenuOpen, setIsInsertMenuOpen] = useState(false)
  const insertAnchorRef = useRef<HTMLButtonElement>(null)

  const [isTextColorMenuOpen, setIsTextColorMenuOpen] = useState(false)
  const textColorAnchorRef = useRef<HTMLButtonElement>(null)

  const [isBgColorMenuOpen, setIsBgColorMenuOpen] = useState(false)
  const bgColorAnchorRef = useRef<HTMLButtonElement>(null)

  const [isFontFamilyMenuOpen, setIsFontFamilyMenuOpen] = useState(false)
  const fontFamilyAnchorRef = useRef<HTMLButtonElement>(null)

  const [isFontSizeMenuOpen, setIsFontSizeMenuOpen] = useState(false)
  const fontSizeAnchorRef = useRef<HTMLButtonElement>(null)
  // The text shown in the editable font-size field while the user is typing
  // (kept separate from currentFontSize so a half-typed value isn't clobbered).
  const [fontSizeInput, setFontSizeInput] = useState<string>('16')
  // The editor selection at the moment focus left the editor for the font-size
  // field. Typing into the field blurs the editor and can collapse the Lexical
  // selection, so we stash it here and restore it before applying.
  const fontSizeSelectionRef = useRef<BaseSelection | null>(null)

  const [isCaseMenuOpen, setIsCaseMenuOpen] = useState(false)
  const caseAnchorRef = useRef<HTMLButtonElement>(null)

  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)
  const sortAnchorRef = useRef<HTMLButtonElement>(null)

  const [isTypographyMenuOpen, setIsTypographyMenuOpen] = useState(false)
  const typographyAnchorRef = useRef<HTMLButtonElement>(null)

  // Word-style floating mini-toolbar (shown on text selection): a compact "More"
  // overflow menu hosting the less-common quick-format actions.
  const [isSelectionMoreMenuOpen, setIsSelectionMoreMenuOpen] = useState(false)
  const selectionMoreAnchorRef = useRef<HTMLButtonElement>(null)

  const [currentFontFamily, setCurrentFontFamily] = useState<string>('')
  const [currentFontSize, setCurrentFontSize] = useState<number>(16)

  // Mirror the detected size into the editable field (unless the user is mid-edit
  // with the field focused, where fontSizeInput is driven by their keystrokes).
  useEffect(() => {
    setFontSizeInput(String(currentFontSize))
  }, [currentFontSize])

  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // Introspectable history (depths + multi-step jump) backed by SuperHistoryPlugin.
  const historyStore = getSuperHistoryStore(editor)
  const historySnapshot = useSyncExternalStore(historyStore.subscribe, historyStore.getSnapshot)
  const [isUndoMenuOpen, setIsUndoMenuOpen] = useState(false)
  const undoAnchorRef = useRef<HTMLButtonElement>(null)
  const [isRedoMenuOpen, setIsRedoMenuOpen] = useState(false)
  const redoAnchorRef = useRef<HTMLButtonElement>(null)
  const undoPreviews = isUndoMenuOpen ? historyStore.getUndoPreviews(HISTORY_DROPDOWN_LIMIT) : []
  const redoPreviews = isRedoMenuOpen ? historyStore.getRedoPreviews(HISTORY_DROPDOWN_LIMIT) : []

  // Issue 3928: "completed tasks move out of the way" opt-in toggle. Persisted
  // web-locally (localStorage) since synced PrefKeys live in off-limits models.
  const [autoMoveCompleted, setAutoMoveCompleted] = useState(() => getChecklistAutoMoveEnabled())
  useEffect(() => subscribeChecklistAutoMove(() => setAutoMoveCompleted(getChecklistAutoMoveEnabled())), [])

  const toggleAutoMoveCompleted = useCallback(() => {
    const next = !getChecklistAutoMoveEnabled()
    setChecklistAutoMoveEnabled(next)
    setAutoMoveCompleted(next)
    // When turning it ON, immediately tidy the checklist the caret is in so the
    // user sees the effect right away instead of only on the next toggle.
    if (next) {
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }
        const list = $getOwningCheckList(selection.anchor.getNode().getParent())
        if (list) {
          $reorderCheckList(list)
        }
      })
    }
  }, [editor])

  const restoreCompletedTasks = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }
      const list = $getOwningCheckList(selection.anchor.getNode().getParent())
      if (list) {
        $uncheckAllInList(list)
        // Re-tidy so restored items rejoin the active group in a sane order.
        if (getChecklistAutoMoveEnabled()) {
          $reorderCheckList(list)
        }
      }
    })
  }, [editor])

  const containerRef = useRef<HTMLDivElement>(null)

  // Standard Red Notes: user-customizable toolbar layout (which buttons are
  // shown + group order). Stored web-locally; default == full default toolbar.
  const [toolbarConfig, setToolbarConfig] = useLocalPreference(LocalPrefKey.SuperToolbarConfig)

  const alwaysShowToolbar = usePreference(PrefKey.AlwaysShowSuperToolbar)

  const [isToolbarFixedToTop, setIsToolbarFixedToTop] = useState(alwaysShowToolbar)
  const isToolbarFixedRef = useStateRef(isToolbarFixedToTop)

  const updateToolbarFloatingPosition = useCallback(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      return
    }

    if (isMobile) {
      return
    }

    if (isToolbarFixedRef.current) {
      return
    }

    const containerElement = containerRef.current

    if (!containerElement) {
      return
    }

    if (selection.getTextContent() === '') {
      containerElement.style.removeProperty('display')
      return
    }

    const nativeSelection = window.getSelection()
    const rootElement = activeEditor.getRootElement()

    if (nativeSelection !== null && rootElement !== null && rootElement.contains(nativeSelection.anchorNode)) {
      const rangeRect = getDOMRangeRect(nativeSelection, rootElement)
      const containerRect = containerElement.getBoundingClientRect()
      const rootRect = rootElement.getBoundingClientRect()

      const calculatedStyles = getPositionedPopoverStyles({
        align: 'start',
        side: 'top',
        anchorRect: rangeRect,
        popoverRect: containerRect,
        documentRect: rootRect,
        offset: 8,
        maxHeightFunction: () => 'none',
      })

      if (calculatedStyles) {
        Object.entries(calculatedStyles).forEach(([key, value]) => {
          if (key === 'transform') {
            return
          }
          containerElement.style.setProperty(key, value)
        })
        containerElement.style.setProperty('display', 'block')
      }
    }
  }, [activeEditor, isMobile, isToolbarFixedRef])

  const $updateToolbar = useCallback(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      return
    }

    setHasNonCollapsedSelection(!selection.isCollapsed())

    const anchorNode = selection.anchor.getNode()
    const focusNode = selection.focus.getNode()
    const isAnchorSameAsFocus = anchorNode === focusNode
    let element =
      anchorNode.getKey() === 'root'
        ? anchorNode
        : $findMatchingParent(anchorNode, (e) => {
            const parent = e.getParent()
            return parent !== null && $isRootOrShadowRoot(parent)
          })

    if (element === null) {
      element = anchorNode.getTopLevelElementOrThrow()
    }

    const elementKey = element.getKey()
    const elementDOM = activeEditor.getElementByKey(elementKey)

    // Update text format
    setIsBold(selection.hasFormat('bold'))
    setIsItalic(selection.hasFormat('italic'))
    setIsUnderline(selection.hasFormat('underline'))
    setIsStrikethrough(selection.hasFormat('strikethrough'))
    setIsSubscript(selection.hasFormat('subscript'))
    setIsSuperscript(selection.hasFormat('superscript'))
    setIsCode(selection.hasFormat('code'))
    setIsHighlight(selection.hasFormat('highlight'))

    setCurrentFontFamily($getSelectionStyleValueForProperty(selection, 'font-family', ''))
    setCurrentFontSize(parseFontSize($getSelectionStyleValueForProperty(selection, 'font-size', '16px')))

    // Update links
    const node = getSelectedNode(selection)
    const parent = node.getParent()
    setIsEditingLink(false)
    if ($isLinkNode(node) && isAnchorSameAsFocus) {
      setLinkNode(node)
    } else if ($isLinkNode(parent) && isAnchorSameAsFocus) {
      setLinkNode(parent)
    } else {
      setLinkNode(null)
    }
    if ($isLinkTextNode(node, selection)) {
      setLinkTextNode(node)
    } else {
      setLinkTextNode(null)
    }

    if (elementDOM !== null) {
      if ($isListNode(element)) {
        const parentList = $getNearestNodeOfType<ListNode>(anchorNode, ListNode)
        const type = parentList ? parentList.getListType() : element.getListType()
        setBlockType(type)
      } else {
        const type = $isHeadingNode(element) ? element.getTag() : element.getType()
        if (type in blockTypeToBlockName) {
          setBlockType(type as keyof typeof blockTypeToBlockName)
        }
      }
    }

    setElementFormat(($isElementNode(node) ? node.getFormatType() : parent?.getFormatType()) || 'left')

    // Feature #273 — detect the active special widget for the contextual group.
    // Tables: the caret is inside a table cell. Images: a selected/adjacent node
    // is an image-like node. Link: reuse the link detection above. Code: the
    // top-level element is a code block. Decorator blocks: matched by type.
    const tableCellNode = $getTableCellNodeFromLexicalNode(node)
    const isTable = tableCellNode != null || $isTableNode(element)

    const selectedNodes = selection.getNodes()
    const isImage =
      isImageNodeType(node.getType()) ||
      (parent != null && isImageNodeType(parent.getType())) ||
      selectedNodes.some((n) => isImageNodeType(n.getType()))

    const isLinkActive = $isLinkNode(node) || $isLinkNode(parent)
    const isCodeBlock = $isCodeNode(element)
    const activeBlockType = element.getType()

    setContextualWidget(
      resolveContextualWidget({
        isTable,
        isImage,
        isLink: isLinkActive,
        isCode: isCodeBlock,
        activeBlockType,
      }),
    )

    // Feature #287 — remember the active top-level block so it can be zoomed.
    // For a table cell we want the table node, not the cell, as the zoom target.
    let zoomTarget = element
    if (tableCellNode != null) {
      zoomTarget = $getTableNodeFromLexicalNodeOrThrow(tableCellNode)
    }
    setActiveBlockKey(zoomTarget.getKey())
    setActiveBlockLabel(
      isTable
        ? 'Table'
        : isCodeBlock
          ? 'Code Block'
          : isImage
            ? 'Image'
            : isDecoratorBlockType(activeBlockType)
              ? DECORATOR_BLOCK_LABELS[activeBlockType]
              : blockTypeToBlockName[blockType] || 'Block',
    )

    updateToolbarFloatingPosition()
  }, [activeEditor, updateToolbarFloatingPosition, blockType])

  const clearContainerFloatingStyles = useCallback(() => {
    const containerElement = containerRef.current
    if (!containerElement) {
      return
    }
    containerElement.style.removeProperty('--translate-x')
    containerElement.style.removeProperty('--translate-y')
    containerElement.style.removeProperty('transform')
    containerElement.style.removeProperty('transform-origin')
    containerElement.style.removeProperty('opacity')
  }, [])

  const clearFormatting = useCallback(() => {
    activeEditor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        const anchor = selection.anchor
        const focus = selection.focus
        const nodes = selection.getNodes()

        if (anchor.key === focus.key && anchor.offset === focus.offset) {
          return
        }

        nodes.forEach((node, idx) => {
          // We split the first and last node by the selection
          // So that we don't format unselected text inside those nodes
          if ($isTextNode(node)) {
            // Use a separate variable to ensure TS does not lose the refinement
            let textNode = node
            if (idx === 0 && anchor.offset !== 0) {
              textNode = textNode.splitText(anchor.offset)[1] || textNode
            }
            if (idx === nodes.length - 1) {
              textNode = textNode.splitText(focus.offset)[0] || textNode
            }

            if (textNode.__style !== '') {
              textNode.setStyle('')
            }
            if (textNode.__format !== 0) {
              textNode.setFormat(0)
              $getNearestBlockElementAncestorOrThrow(textNode).setFormat('')
            }
            node = textNode
          } else if ($isHeadingNode(node) || $isQuoteNode(node)) {
            node.replace($createParagraphNode(), true)
          } else if ($isDecoratorBlockNode(node)) {
            node.setFormat('')
          }
        })
      }
    })
  }, [activeEditor])

  const applyStyleText = useCallback(
    (styles: Record<string, string | null>) => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          $patchStyleText(selection, styles)
        }
      })
    },
    [activeEditor],
  )

  // Toggle a CSS property on/off across the selection (used for emphasis marks
  // and the text outline, which have no Lexical command).
  const toggleSelectionStyle = useCallback(
    (property: string, onValue: string) => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }
        const current = $getSelectionStyleValueForProperty(selection, property, '')
        $patchStyleText(selection, { [property]: current ? null : onValue })
      })
    },
    [activeEditor],
  )

  const stepFontSize = useCallback(
    (direction: 1 | -1) => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }
        const current = parseFontSize($getSelectionStyleValueForProperty(selection, 'font-size', '16px'))
        const next = clampFontSize(current + direction * FONT_SIZE_STEP)
        setCurrentFontSize(next)
        $patchStyleText(selection, { 'font-size': `${next}px` })
      })
    },
    [activeEditor],
  )

  // Stash the current editor selection before focus moves to the font-size
  // field; without this, typing a size and pressing Enter would find a collapsed
  // (or null) selection and silently do nothing.
  const captureFontSizeSelection = useCallback(() => {
    activeEditor.getEditorState().read(() => {
      const selection = $getSelection()
      fontSizeSelectionRef.current = $isRangeSelection(selection) ? selection.clone() : null
    })
  }, [activeEditor])

  // Apply an exact font size (from the field or a preset), clamped to the allowed
  // range. Restores the stashed selection when the live one is no longer a range
  // (i.e. the editor lost focus to the toolbar field).
  const applyFontSize = useCallback(
    (size: number) => {
      const clamped = clampFontSize(size)
      setCurrentFontSize(clamped)
      setFontSizeInput(String(clamped))
      activeEditor.update(() => {
        $applyFontSizeToSelection(clamped, fontSizeSelectionRef.current)
      })
    },
    [activeEditor],
  )

  const toggleList = useCallback(
    (listType: 'number' | 'bullet') => {
      const isActive = blockType === listType
      if (isActive) {
        activeEditor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)
      } else if (listType === 'number') {
        activeEditor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
      } else {
        activeEditor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
      }
    },
    [activeEditor, blockType],
  )

  const insertCodeBlock = useCallback(() => {
    activeEditor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) {
        return
      }
      if (selection.isCollapsed()) {
        $setBlocksType(selection, () => $createCodeNode())
      } else {
        const textContent = selection.getTextContent()
        const codeNode = $createCodeNode()
        selection.insertNodes([codeNode])
        const newSelection = $getSelection()
        if ($isRangeSelection(newSelection)) {
          newSelection.insertRawText(textContent)
        }
      }
    })
  }, [activeEditor])

  const transformCase = useCallback(
    (transform: 'upper' | 'lower' | 'camel') => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          return
        }
        const text = selection.getTextContent()
        if (text.length === 0) {
          return
        }
        const transformed =
          transform === 'upper' ? text.toUpperCase() : transform === 'lower' ? text.toLowerCase() : toCamelCase(text)
        selection.insertText(transformed)
      })
    },
    [activeEditor],
  )

  // Sort / deduplicate the block-level "lines" (paragraphs, headings, list items)
  // intersected by a multi-line selection. Operates on the nodes (not the joined
  // text) so block boundaries are preserved; dedupe removes the surplus blocks.
  const transformLines = useCallback(
    (operation: LineOperation) => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          return
        }
        $transformSelectedLines(selection, operation)
      })
    },
    [activeEditor],
  )

  // Word-style multi-key sort of the selected lines (sort by / then by / then by).
  const sortLinesMultiKey = useCallback(
    (options: MultiKeySortOptions) => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          return
        }
        $applyLineTransform(selection, (texts) => multiKeySort(texts, options))
      })
    },
    [activeEditor],
  )

  const openMultiKeySortDialog = useCallback(() => {
    setIsSortMenuOpen(false)
    showModal('Sort lines', (onClose) => (
      <MultiKeySortDialog
        onApply={(options) => {
          sortLinesMultiKey(options)
          onClose()
        }}
        onClose={onClose}
      />
    ))
  }, [showModal, sortLinesMultiKey])

  const handleClipboardCopy = useCallback(() => {
    activeEditor.getEditorState().read(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        const text = selection.getTextContent()
        if (text) {
          void navigator.clipboard?.writeText?.(text).catch(() => {
            /* clipboard unavailable */
          })
        }
      }
    })
  }, [activeEditor])

  const handleClipboardCut = useCallback(() => {
    let text = ''
    activeEditor.getEditorState().read(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        text = selection.getTextContent()
      }
    })
    if (!text) {
      return
    }
    void navigator.clipboard?.writeText?.(text).catch(() => {
      /* clipboard unavailable */
    })
    activeEditor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText('')
      }
    })
  }, [activeEditor])

  const handleClipboardPaste = useCallback(async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (!text) {
      return
    }
    activeEditor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText(text)
      }
    })
  }, [activeEditor])

  // ----- Feature #273: contextual widget actions -------------------------
  // These reuse the same Lexical operations the existing inline widget UIs use
  // (@lexical/table ops, FORMAT_ELEMENT_COMMAND for alignment, the link toggle
  // command, the code-language popover) — surfaced as a single contextual group.

  const runTableAction = useCallback(
    (action: (cell: ReturnType<typeof $getTableCellNodeFromLexicalNode>) => void) => {
      activeEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }
        const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode())
        if (!cell) {
          return
        }
        action(cell)
      })
    },
    [activeEditor],
  )

  const toggleTableRowHeader = useCallback(() => {
    runTableAction((cell) => {
      if (!cell) {
        return
      }
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(cell)
      const rowIndex = $getTableRowIndexFromTableCellNode(cell)
      const row = tableNode.getChildren()[rowIndex]
      if (!$isTableRowNode(row)) {
        return
      }
      row.getChildren().forEach((c) => {
        if ($isTableCellNode(c)) {
          c.toggleHeaderStyle(TableCellHeaderStates.ROW)
        }
      })
    })
  }, [runTableAction])

  const toggleTableColumnHeader = useCallback(() => {
    runTableAction((cell) => {
      if (!cell) {
        return
      }
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(cell)
      const colIndex = $getTableColumnIndexFromTableCellNode(cell)
      tableNode.getChildren().forEach((row) => {
        if (!$isTableRowNode(row)) {
          return
        }
        const c = row.getChildren()[colIndex]
        if ($isTableCellNode(c)) {
          c.toggleHeaderStyle(TableCellHeaderStates.COLUMN)
        }
      })
    })
  }, [runTableAction])

  const deleteTable = useCallback(() => {
    runTableAction((cell) => {
      if (!cell) {
        return
      }
      $getTableNodeFromLexicalNodeOrThrow(cell).remove()
    })
  }, [runTableAction])

  const removeLink = useCallback(() => {
    activeEditor.dispatchCommand(TOGGLE_LINK_COMMAND, null)
  }, [activeEditor])

  const enterZoom = useCallback(() => {
    if (activeBlockKey) {
      setZoomBlockKey(activeBlockKey)
    }
  }, [activeBlockKey])

  useEffect(() => {
    if (isMobile) {
      return
    }

    const scrollerElem = activeEditor.getRootElement()

    const update = () => {
      activeEditor.getEditorState().read(() => {
        updateToolbarFloatingPosition()
      })
    }
    const debouncedUpdate = debounce(update, 50)

    window.addEventListener('resize', debouncedUpdate)
    if (scrollerElem) {
      scrollerElem.addEventListener('scroll', debouncedUpdate)
    }

    return () => {
      window.removeEventListener('resize', debouncedUpdate)
      if (scrollerElem) {
        scrollerElem.removeEventListener('scroll', debouncedUpdate)
      }
    }
  }, [activeEditor, isMobile, updateToolbarFloatingPosition])

  useEffect(() => {
    return mergeRegister(
      editor.registerEditableListener((editable) => {
        setIsEditable(editable)
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        (_payload, newEditor) => {
          $updateToolbar()
          setActiveEditor(newEditor)
          return false
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    )
  }, [editor, $updateToolbar])

  useEffect(() => {
    return mergeRegister(
      activeEditor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          $updateToolbar()
        })
      }),
      activeEditor.registerCommand<boolean>(
        CAN_UNDO_COMMAND,
        (payload) => {
          setCanUndo(payload)
          return false
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      activeEditor.registerCommand<boolean>(
        CAN_REDO_COMMAND,
        (payload) => {
          setCanRedo(payload)
          return false
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      activeEditor.registerCommand(
        TOGGLE_LINK_AND_EDIT_COMMAND,
        (payload) => {
          if (payload === null) {
            setIsEditingLink(false)
            return activeEditor.dispatchCommand(TOGGLE_LINK_COMMAND, null)
          } else {
            setIsEditingLink(true)
            return true
          }
          return false
        },
        COMMAND_PRIORITY_LOW,
      ),
    )
  }, [$updateToolbar, activeEditor])

  useEffect(() => {
    return activeEditor.registerCommand(
      KEY_MODIFIER_COMMAND,
      (payload) => {
        const event: KeyboardEvent = payload
        const { code, ctrlKey, metaKey, shiftKey } = event

        if (code === 'KeyK' && (ctrlKey || metaKey) && !shiftKey) {
          event.preventDefault()
          if ('readText' in navigator.clipboard) {
            navigator.clipboard
              .readText()
              .then((text) => {
                if (URL_REGEX.test(text)) {
                  activeEditor.dispatchCommand(TOGGLE_LINK_COMMAND, text)
                } else {
                  throw new Error('Not a valid URL')
                }
              })
              .catch((error) => {
                console.error(error)
                activeEditor.dispatchCommand(TOGGLE_LINK_AND_EDIT_COMMAND, '')
              })
          } else {
            activeEditor.dispatchCommand(TOGGLE_LINK_AND_EDIT_COMMAND, '')
          }
          return true
        }

        return false
      },
      COMMAND_PRIORITY_NORMAL,
    )
  }, [activeEditor])

  const dismissButtonRef = useRef<HTMLButtonElement>(null)

  const [isFocusInEditor, setIsFocusInEditor] = useState(false)
  const [isFocusInToolbar, setIsFocusInToolbar] = useState(false)
  const canShowToolbarOnMobile = isFocusInEditor || isFocusInToolbar
  const canShowAllItems = isMobile || isToolbarFixedToTop

  useEffect(() => {
    const container = containerRef.current
    const rootElement = editor.getRootElement()

    if (!rootElement) {
      return
    }

    const handleToolbarFocus = () => setIsFocusInToolbar(true)
    const handleToolbarBlur = () => setIsFocusInToolbar(false)

    const handleRootFocus = () => setIsFocusInEditor(true)
    const handleRootBlur = (event: FocusEvent) => {
      const elementToBeFocused = event.relatedTarget as Node
      const containerContainsElementToFocus = container?.contains(elementToBeFocused)
      const linkEditorContainsElementToFocus = document
        .getElementById(ElementIds.SuperEditor)
        ?.contains(elementToBeFocused)
      const willFocusDismissButton = dismissButtonRef.current === elementToBeFocused
      if ((containerContainsElementToFocus || linkEditorContainsElementToFocus) && !willFocusDismissButton) {
        return
      }
      setIsFocusInEditor(false)
    }

    rootElement.addEventListener('focus', handleRootFocus)
    rootElement.addEventListener('blur', handleRootBlur)

    if (container) {
      container.addEventListener('focus', handleToolbarFocus)
      container.addEventListener('blur', handleToolbarBlur)
    }

    return () => {
      rootElement.removeEventListener('focus', handleRootFocus)
      rootElement.removeEventListener('blur', handleRootBlur)
      container?.removeEventListener('focus', handleToolbarFocus)
      container?.removeEventListener('blur', handleToolbarBlur)
    }
  }, [editor])

  const toolbarRef = useRef<HTMLDivElement>(null)
  const toolbarStore = useToolbarStore()
  // Separate store for the element-specific contextual tools, which render on
  // their own line below the main toolbar.
  const contextualToolbarStore = useToolbarStore()
  useEffect(() => {
    return application.keyboardService.addCommandHandler({
      command: SUPER_TOGGLE_TOOLBAR,
      category: 'Super notes',
      description: 'Toggle Super note toolbar',
      onKeyDown(event) {
        if (isMobile) {
          return
        }
        if (!alwaysShowToolbar) {
          return
        }

        event.preventDefault()

        if (!isToolbarFixedToTop) {
          setIsToolbarFixedToTop(true)
          clearContainerFloatingStyles()
          toolbarStore.move(toolbarStore.first())
          return
        } else {
          setIsToolbarFixedToTop(false)
          editor.focus()
        }
      },
    })
  }, [
    alwaysShowToolbar,
    application.keyboardService,
    clearContainerFloatingStyles,
    editor,
    isMobile,
    isToolbarFixedToTop,
    toolbarStore,
  ])

  const popoverDocumentElement =
    document.getElementById(ElementIds.SuperEditor) ?? editor.getRootElement()?.parentElement ?? document.body

  const openCustomizeDialog = useCallback(() => {
    showModal('Customize toolbar', (onClose) => (
      <CustomizeToolbarDialog
        config={toolbarConfig}
        onChange={(next) => setToolbarConfig(next)}
        onClose={onClose}
      />
    ))
  }, [showModal, toolbarConfig, setToolbarConfig])

  // Declarative render map keyed by stable button id. The toolbar is rendered by
  // iterating the config-resolved group/button order over this map, so adding,
  // hiding, or reordering is driven entirely by the saved config. Buttons that
  // were previously gated behind `canShowAllItems` (floating selection toolbar)
  // render `null` there, preserving the exact prior behavior.
  const buttonRenderers: Partial<Record<ToolbarButtonId, ReactNode>> = {
    [ToolbarButtonId.Cut]: (
      <ToolbarButton
        name="Cut"
        iconName="scissors"
        disabled={!hasNonCollapsedSelection}
        onSelect={handleClipboardCut}
      />
    ),
    [ToolbarButtonId.Copy]: (
      <ToolbarButton
        name="Copy"
        iconName="copy"
        disabled={!hasNonCollapsedSelection}
        onSelect={handleClipboardCopy}
      />
    ),
    [ToolbarButtonId.Paste]: (
      <ToolbarButton name="Paste" iconName="clipboard" onSelect={() => void handleClipboardPaste()} />
    ),
    [ToolbarButtonId.TableOfContents]: canShowAllItems ? (
      <ToolbarButton
        name="Table of Contents"
        iconName="toc"
        active={isTOCOpen}
        onSelect={() => setIsTOCOpen(!isTOCOpen)}
        ref={tocAnchorRef}
      />
    ) : null,
    [ToolbarButtonId.Search]: canShowAllItems ? (
      <ToolbarButton
        name="Search"
        iconName="search"
        onSelect={() => application.keyboardService.triggerCommand(SUPER_TOGGLE_SEARCH)}
      />
    ) : null,
    [ToolbarButtonId.Undo]: canShowAllItems ? (
      <div className="flex flex-shrink-0 items-center" key="undo">
        <ToolbarButton
          name="Undo"
          iconName="undo"
          disabled={!canUndo}
          onSelect={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        />
        <StyledTooltip
          showOnHover
          showOnMobile
          side="top"
          label={
            historySnapshot.undoDepth === 0
              ? 'Undo history — nothing to undo yet'
              : 'Undo history — go back several steps at once'
          }
        >
          <button
            type="button"
            aria-label="Undo history"
            ref={undoAnchorRef}
            aria-disabled={historySnapshot.undoDepth === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (historySnapshot.undoDepth > 0) {
                setIsUndoMenuOpen(!isUndoMenuOpen)
              }
            }}
            className={classNames(
              'flex h-8 items-center rounded-md px-0.5 md:h-7',
              historySnapshot.undoDepth === 0
                ? 'cursor-default opacity-40'
                : isUndoMenuOpen
                  ? 'bg-contrast'
                  : 'hover:bg-contrast',
            )}
          >
            <Icon type="chevron-down" size="custom" className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </button>
        </StyledTooltip>
      </div>
    ) : null,
    [ToolbarButtonId.Redo]: canShowAllItems ? (
      <div className="flex flex-shrink-0 items-center" key="redo">
        <ToolbarButton
          name="Redo"
          iconName="redo"
          disabled={!canRedo}
          onSelect={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        />
        <StyledTooltip
          showOnHover
          showOnMobile
          side="top"
          label={
            historySnapshot.redoDepth === 0
              ? 'Redo history — nothing to redo'
              : 'Redo history — jump forward several steps at once'
          }
        >
          <button
            type="button"
            aria-label="Redo history"
            ref={redoAnchorRef}
            aria-disabled={historySnapshot.redoDepth === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (historySnapshot.redoDepth > 0) {
                setIsRedoMenuOpen(!isRedoMenuOpen)
              }
            }}
            className={classNames(
              'flex h-8 items-center rounded-md px-0.5 md:h-7',
              historySnapshot.redoDepth === 0
                ? 'cursor-default opacity-40'
                : isRedoMenuOpen
                  ? 'bg-contrast'
                  : 'hover:bg-contrast',
            )}
          >
            <Icon type="chevron-down" size="custom" className="h-4 w-4 md:h-3.5 md:w-3.5" />
          </button>
        </StyledTooltip>
      </div>
    ) : null,
    [ToolbarButtonId.BlockStyle]: (
      <ToolbarButton
        name="Formatting options"
        onSelect={() => {
          setIsTextStyleMenuOpen(!isTextStyleMenuOpen)
        }}
        ref={textStyleAnchorRef}
        className={isTextStyleMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type={blockTypeToIconName[blockType]} size="custom" className="h-5 w-5 md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-2 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.Bold]: (
      <ToolbarButton
        name="Bold"
        iconName="bold"
        active={isBold}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
      />
    ),
    [ToolbarButtonId.Italic]: (
      <ToolbarButton
        name="Italic"
        iconName="italic"
        active={isItalic}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
      />
    ),
    [ToolbarButtonId.Underline]: (
      <ToolbarButton
        name="Underline"
        iconName="underline"
        active={isUnderline}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}
      />
    ),
    [ToolbarButtonId.InlineCode]: (
      <ToolbarButton
        name="Inline Code"
        iconName="code-tags"
        active={isCode}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}
      />
    ),
    [ToolbarButtonId.Link]: (
      <ToolbarButton
        name="Link"
        iconName="link"
        active={!!linkNode}
        onSelect={() => {
          editor.dispatchCommand(TOGGLE_LINK_AND_EDIT_COMMAND, '')
        }}
      />
    ),
    [ToolbarButtonId.TextStyleMenu]: (
      <ToolbarButton
        name="Text style"
        onSelect={() => {
          setIsTextFormatMenuOpen(!isTextFormatMenuOpen)
        }}
        ref={textFormatAnchorRef}
        className={isTextFormatMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type="text" size="custom" className="h-5 w-5 md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.TextColor]: (
      <ToolbarButton
        name="Text color"
        onSelect={() => setIsTextColorMenuOpen(!isTextColorMenuOpen)}
        ref={textColorAnchorRef}
        className={isTextColorMenuOpen ? 'md:bg-default' : ''}
      >
        <span className="flex flex-col items-center justify-center leading-none">
          <span className="text-sm font-semibold">A</span>
          <span className="-mt-0.5 h-1 w-3.5 rounded-sm bg-info" />
        </span>
      </ToolbarButton>
    ),
    [ToolbarButtonId.HighlightColor]: (
      <ToolbarButton
        name="Highlight color"
        onSelect={() => setIsBgColorMenuOpen(!isBgColorMenuOpen)}
        ref={bgColorAnchorRef}
        className={isBgColorMenuOpen ? 'md:bg-default' : ''}
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-info text-xs font-semibold text-info-contrast md:h-4 md:w-4">
          H
        </span>
      </ToolbarButton>
    ),
    [ToolbarButtonId.Typography]: (
      <ToolbarButton
        name="Typography — emphasis, outline, letter & word spacing"
        onSelect={() => setIsTypographyMenuOpen(!isTypographyMenuOpen)}
        ref={typographyAnchorRef}
        className={isTypographyMenuOpen ? 'md:bg-default' : ''}
      >
        <span className="text-sm font-semibold italic leading-none">Tt</span>
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.FontSize]: (
      <div
        className="flex h-8 flex-shrink-0 items-center overflow-hidden rounded-md border border-border bg-default focus-within:border-info md:h-7"
        key="fontSizeInput"
      >
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label="Font size"
          title="Font size"
          value={fontSizeInput}
          onFocus={(event) => {
            captureFontSizeSelection()
            event.target.select()
          }}
          onChange={(event) => {
            // Allow only digits while typing; apply on Enter/blur.
            setFontSizeInput(event.target.value.replace(/[^0-9]/g, ''))
          }}
          onBlur={() => {
            const next = parseInt(fontSizeInput, 10)
            applyFontSize(Number.isNaN(next) ? currentFontSize : next)
          }}
          onKeyDown={(event) => {
            // Don't let the Ariakit toolbar hijack typing/arrow keys.
            event.stopPropagation()
            if (event.key === 'Enter') {
              const next = parseInt((event.target as HTMLInputElement).value, 10)
              applyFontSize(Number.isNaN(next) ? currentFontSize : next)
              ;(event.target as HTMLInputElement).blur()
            } else if (event.key === 'Escape') {
              setFontSizeInput(String(currentFontSize))
              ;(event.target as HTMLInputElement).blur()
            }
          }}
          className="h-full w-9 bg-transparent px-1 text-center text-sm focus:outline-none"
        />
        <button
          type="button"
          aria-label="Choose font size"
          title="Font size"
          ref={fontSizeAnchorRef}
          onMouseDown={(event) => {
            // Keep the editor selection alive when opening the preset list.
            event.preventDefault()
            captureFontSizeSelection()
          }}
          onClick={() => setIsFontSizeMenuOpen(!isFontSizeMenuOpen)}
          className={classNames(
            'flex h-full items-center border-l border-border px-0.5 hover:bg-contrast',
            isFontSizeMenuOpen ? 'bg-contrast' : '',
          )}
        >
          <Icon type="chevron-down" size="custom" className="h-4 w-4 md:h-3.5 md:w-3.5" />
        </button>
      </div>
    ),
    [ToolbarButtonId.DecreaseFontSize]: (
      <ToolbarButton name="Decrease font size" onSelect={() => stepFontSize(-1)}>
        <span className="text-xs font-semibold leading-none">A&minus;</span>
      </ToolbarButton>
    ),
    [ToolbarButtonId.IncreaseFontSize]: (
      <ToolbarButton name="Increase font size" onSelect={() => stepFontSize(1)}>
        <span className="text-sm font-semibold leading-none">A+</span>
      </ToolbarButton>
    ),
    [ToolbarButtonId.FontFamily]: (
      <ToolbarButton
        name="Font family"
        onSelect={() => setIsFontFamilyMenuOpen(!isFontFamilyMenuOpen)}
        ref={fontFamilyAnchorRef}
        className={isFontFamilyMenuOpen ? 'md:bg-default' : ''}
      >
        <span
          className="max-w-[6.5rem] overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-none"
          style={{ fontFamily: currentFontFamily || undefined }}
        >
          {FONT_FAMILIES.find((font) =>
            font.value === null ? currentFontFamily === '' : currentFontFamily === font.value,
          )?.name ?? 'Custom'}
        </span>
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.BulletedList]: (
      <ToolbarButton
        name="Bulleted List"
        iconName="list-bulleted"
        active={blockType === 'bullet'}
        onSelect={() => toggleList('bullet')}
      />
    ),
    [ToolbarButtonId.NumberedList]: (
      <ToolbarButton
        name="Numbered List"
        iconName="list-numbered"
        active={blockType === 'number'}
        onSelect={() => toggleList('number')}
      />
    ),
    [ToolbarButtonId.Quote]: (
      <ToolbarButton
        name="Quote"
        iconName="quote"
        active={blockType === 'quote'}
        onSelect={() => QuoteBlock.onSelect(editor)}
      />
    ),
    [ToolbarButtonId.CodeBlock]: (
      <ToolbarButton name="Code Block" iconName="code" active={blockType === 'code'} onSelect={insertCodeBlock} />
    ),
    [ToolbarButtonId.ChangeCase]: (
      <ToolbarButton
        name="Change case"
        onSelect={() => setIsCaseMenuOpen(!isCaseMenuOpen)}
        ref={caseAnchorRef}
        className={isCaseMenuOpen ? 'md:bg-default' : ''}
      >
        <span className="text-xs font-semibold leading-none">aA</span>
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.SortLines]: (
      <ToolbarButton
        name="Sort & dedupe lines"
        onSelect={() => setIsSortMenuOpen(!isSortMenuOpen)}
        ref={sortAnchorRef}
        className={isSortMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type="sort-descending" size="custom" className="h-5 w-5 md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.Alignment]: (
      <ToolbarButton
        name="Alignment"
        onSelect={() => {
          setIsAlignmentMenuOpen(!isAlignmentMenuOpen)
        }}
        ref={alignmentAnchorRef}
        className={isAlignmentMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type="align-left" size="custom" className="h-5 w-5 md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-2 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ),
    [ToolbarButtonId.Indent]: (
      <ToolbarButton
        name={IndentBlock.name}
        iconName={IndentBlock.iconName}
        onSelect={() => IndentBlock.onSelect(editor)}
      />
    ),
    [ToolbarButtonId.Outdent]: (
      <ToolbarButton
        name={OutdentBlock.name}
        iconName={OutdentBlock.iconName}
        onSelect={() => OutdentBlock.onSelect(editor)}
      />
    ),
    [ToolbarButtonId.InsertMenu]: canShowAllItems ? (
      <ToolbarButton
        name="Insert"
        onSelect={() => {
          setIsInsertMenuOpen(!isInsertMenuOpen)
        }}
        ref={insertAnchorRef}
        className={isInsertMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type="add" size="custom" className="h-5 w-5 md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-2 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
    ) : null,
    [ToolbarButtonId.NoteFromSelection]: (
      <ToolbarButton
        name={
          <>
            <div className="mb-1 font-semibold">Create new note from selection</div>
            <div className="max-w-[35ch] text-xs">
              Creates a new note containing the current selection and replaces the selection with a link to the new
              note.
            </div>
          </>
        }
        iconName="notes"
        onSelect={() => {
          editor.dispatchCommand(CREATE_NOTE_FROM_SELECTION_COMMAND, undefined)
        }}
        disabled={!hasNonCollapsedSelection}
      />
    ),
    [ToolbarButtonId.AI]: <SelectionTools editor={activeEditor} hasSelection={hasNonCollapsedSelection} />,
  }

  // Resolve the config into the ordered, filtered groups to render, then emit
  // each group's buttons with a separator between non-empty groups.
  const resolvedGroups = applyToolbarConfig(toolbarConfig).filter((group) =>
    group.buttons.some((button) => buttonRenderers[button.id] != null),
  )

  // Feature #273 — build the dynamic contextual group for the active widget. It
  // is appended *after* the config-resolved groups (never part of the persisted
  // config), so show/hide/reorder customization is unaffected. Always ends with
  // a "Zoom into block" action (Feature #287) for the active block.
  const contextualButtons: ReactNode[] = []
  if (contextualWidget) {
    switch (contextualWidget.kind) {
      case ContextualWidgetKind.Table:
        contextualButtons.push(
          <ToolbarButton
            key="ctx-row-above"
            name="Insert row above"
            iconName="arrow-up"
            onSelect={() => activeEditor.update(() => $insertTableRowAtSelection(false))}
          />,
          <ToolbarButton
            key="ctx-row-below"
            name="Insert row below"
            iconName="arrow-down"
            onSelect={() => activeEditor.update(() => $insertTableRowAtSelection(true))}
          />,
          <ToolbarButton
            key="ctx-col-left"
            name="Insert column left"
            iconName="arrow-left"
            onSelect={() => activeEditor.update(() => $insertTableColumnAtSelection(false))}
          />,
          <ToolbarButton
            key="ctx-col-right"
            name="Insert column right"
            iconName="arrow-right"
            onSelect={() => activeEditor.update(() => $insertTableColumnAtSelection(true))}
          />,
          <ToolbarButton
            key="ctx-del-row"
            name="Delete row"
            iconName="trash"
            onSelect={() => activeEditor.update(() => $deleteTableRowAtSelection())}
          />,
          <ToolbarButton
            key="ctx-del-col"
            name="Delete column"
            iconName="trash-sweep"
            onSelect={() => activeEditor.update(() => $deleteTableColumnAtSelection())}
          />,
          <ToolbarButton
            key="ctx-row-header"
            name="Toggle row header"
            iconName="tasks"
            onSelect={toggleTableRowHeader}
          />,
          <ToolbarButton
            key="ctx-col-header"
            name="Toggle column header"
            iconName="select-all"
            onSelect={toggleTableColumnHeader}
          />,
          <ToolbarButton key="ctx-del-table" name="Delete table" iconName="trash-filled" onSelect={deleteTable} />,
        )
        break
      case ContextualWidgetKind.Image:
        contextualButtons.push(
          <ToolbarButton
            key="ctx-img-left"
            name="Align left"
            iconName="align-left"
            active={elementFormat === 'left'}
            onSelect={() => LeftAlignBlock.onSelect(activeEditor)}
          />,
          <ToolbarButton
            key="ctx-img-center"
            name="Align center"
            iconName="align-center"
            active={elementFormat === 'center'}
            onSelect={() => CenterAlignBlock.onSelect(activeEditor)}
          />,
          <ToolbarButton
            key="ctx-img-right"
            name="Align right"
            iconName="align-right"
            active={elementFormat === 'right'}
            onSelect={() => RightAlignBlock.onSelect(activeEditor)}
          />,
        )
        break
      case ContextualWidgetKind.Link:
        contextualButtons.push(
          <ToolbarButton
            key="ctx-link-edit"
            name="Edit link"
            iconName="pencil"
            onSelect={() => activeEditor.dispatchCommand(TOGGLE_LINK_AND_EDIT_COMMAND, '')}
          />,
          <ToolbarButton key="ctx-link-remove" name="Remove link" iconName="link-off" onSelect={removeLink} />,
        )
        break
      case ContextualWidgetKind.Code:
        // Language selection is handled by the dedicated CodeOptionsPlugin
        // popover; the contextual group surfaces the zoom affordance (below).
        break
      case ContextualWidgetKind.Block:
        break
    }

    // Every contextual widget gets a "Zoom into block" affordance (Feature #287).
    contextualButtons.push(
      <ToolbarButton
        key="ctx-zoom"
        name="Zoom into block"
        iconName="fullscreen"
        disabled={!activeBlockKey}
        onSelect={enterZoom}
      />,
    )
  }

  // Standard Red Notes — Word-like floating selection mini-toolbar.
  //
  // When the toolbar is floating on a text selection (i.e. not docked to the top
  // via the "always show toolbar" preference, and not on mobile), we render a
  // compact, curated quick-format bar instead of the full, sprawling, config-
  // driven toolbar. The goal is Microsoft Word's mini-toolbar feel: the most-used
  // controls in a single tight row, active state reflected on each button, and
  // everything else tucked behind a "More" overflow menu.
  //
  // All controls reuse the same editor state + handlers + popovers already wired
  // for the docked toolbar (block-style menu, alignment menu, link command, AI
  // SelectionTools, etc.), so behavior stays identical — only the layout changes.
  const floatingSelectionToolbar = (
    <>
      {/* Block type (paragraph / headings / lists / quote / code) — reuses the
          existing block-style popover anchored at textStyleAnchorRef. */}
      <ToolbarButton
        name="Block style"
        onSelect={() => setIsTextStyleMenuOpen(!isTextStyleMenuOpen)}
        ref={textStyleAnchorRef}
        className={isTextStyleMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type={blockTypeToIconName[blockType]} size="custom" className="h-5 w-5 md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>
      <ToolbarSeparator />

      {/* Core inline formatting: bold / italic / underline / strikethrough. */}
      <ToolbarButton
        name="Bold"
        iconName="bold"
        active={isBold}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
      />
      <ToolbarButton
        name="Italic"
        iconName="italic"
        active={isItalic}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
      />
      <ToolbarButton
        name="Underline"
        iconName="underline"
        active={isUnderline}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}
      />
      <ToolbarButton
        name="Strikethrough"
        iconName="strikethrough"
        active={isStrikethrough}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')}
      />
      <ToolbarButton
        name="Inline Code"
        iconName="code-tags"
        active={isCode}
        onSelect={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}
      />
      <ToolbarSeparator />

      {/* Headings + paragraph quick toggles. */}
      <ToolbarButton
        name="Heading 1"
        iconName="h1"
        active={blockType === 'h1'}
        onSelect={() => H1Block.onSelect(editor)}
      />
      <ToolbarButton
        name="Heading 2"
        iconName="h2"
        active={blockType === 'h2'}
        onSelect={() => H2Block.onSelect(editor)}
      />
      <ToolbarButton
        name="Heading 3"
        iconName="h3"
        active={blockType === 'h3'}
        onSelect={() => H3Block.onSelect(editor)}
      />
      <ToolbarButton
        name="Normal text"
        iconName="paragraph"
        active={blockType === 'paragraph'}
        onSelect={() => ParagraphBlock.onSelect(editor)}
      />
      <ToolbarSeparator />

      {/* Lists + block quote. */}
      <ToolbarButton
        name="Bulleted List"
        iconName="list-bulleted"
        active={blockType === 'bullet'}
        onSelect={() => toggleList('bullet')}
      />
      <ToolbarButton
        name="Numbered List"
        iconName="list-numbered"
        active={blockType === 'number'}
        onSelect={() => toggleList('number')}
      />
      <ToolbarButton
        name="Check List"
        iconName="list-check"
        active={blockType === 'check'}
        onSelect={() => ChecklistBlock.onSelect(editor)}
      />
      <ToolbarButton
        name="Quote"
        iconName="quote"
        active={blockType === 'quote'}
        onSelect={() => QuoteBlock.onSelect(editor)}
      />
      <ToolbarSeparator />

      {/* Alignment — reuses the existing alignment popover anchored at
          alignmentAnchorRef. The icon reflects the current alignment. */}
      <ToolbarButton
        name="Alignment"
        onSelect={() => setIsAlignmentMenuOpen(!isAlignmentMenuOpen)}
        ref={alignmentAnchorRef}
        className={isAlignmentMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon
          type={
            elementFormat === 'center'
              ? 'align-center'
              : elementFormat === 'right'
                ? 'align-right'
                : elementFormat === 'justify'
                  ? 'align-justify'
                  : 'align-left'
          }
          size="custom"
          className="h-5 w-5 md:h-4 md:w-4"
        />
        <Icon type="chevron-down" size="custom" className="ml-1 h-4 w-4 md:h-3.5 md:w-3.5" />
      </ToolbarButton>

      {/* Link toggle. */}
      <ToolbarButton
        name="Link"
        iconName="link"
        active={!!linkNode}
        onSelect={() => editor.dispatchCommand(TOGGLE_LINK_AND_EDIT_COMMAND, '')}
      />
      <ToolbarSeparator />

      {/* AI actions + language picker (SelectionTools) — preserved as-is. */}
      <SelectionTools editor={activeEditor} hasSelection={hasNonCollapsedSelection} />

      {/* Overflow "More" menu for the less-common quick-format actions, keeping
          the visible bar compact. */}
      <ToolbarButton
        name="More formatting"
        onSelect={() => setIsSelectionMoreMenuOpen(!isSelectionMoreMenuOpen)}
        ref={selectionMoreAnchorRef}
        className={isSelectionMoreMenuOpen ? 'md:bg-default' : ''}
      >
        <Icon type="more" size="custom" className="h-5 w-5 md:h-4 md:w-4" />
      </ToolbarButton>
    </>
  )

  return (
    <>
      {modal}
      <div
        className={classNames(
          'bg-contrast',
          !isEditable ? 'hidden opacity-0' : '',
          isMobile && !canShowToolbarOnMobile ? 'hidden' : '',
          !isMobile && 'border-b border-border bg-default',
          !isMobile
            ? !isToolbarFixedToTop
              ? 'fixed left-0 top-0 z-tooltip hidden translate-x-[--translate-x] translate-y-[--translate-y] rounded border py-0.5 translucent-ui:border-[--popover-border-color] translucent-ui:bg-[--popover-background-color] translucent-ui:[backdrop-filter:var(--popover-backdrop-filter)]'
              : 'w-full px-1 py-1'
            : '',
        )}
        id="super-mobile-toolbar"
        ref={containerRef}
      >
        {linkNode && !isEditingLink && (
          <LinkViewer
            key={linkNode.__key}
            linkNode={linkNode}
            isMobile={isMobile}
            setIsEditingLink={setIsEditingLink}
            editor={activeEditor}
          />
        )}
        {isEditingLink && (
          <LinkEditor
            editor={activeEditor}
            setIsEditingLink={setIsEditingLink}
            isMobile={isMobile}
            linkNode={linkNode}
            linkTextNode={linkTextNode}
          />
        )}
        <div className="flex w-full flex-shrink-0 border-t border-border md:border-0">
          <Toolbar
            className="super-toolbar flex items-center gap-1.5 overflow-x-auto px-1 py-0.5 md:flex-wrap md:gap-y-1"
            ref={toolbarRef}
            store={toolbarStore}
          >
            {canShowAllItems
              ? resolvedGroups.map((group) => (
                  // Word/Office-style segmented groups: each group is a rounded
                  // cluster (tight inner spacing) with a small caption title beneath
                  // it, so related formatting controls are visually chunked and named.
                  <div
                    key={group.id}
                    role="group"
                    aria-label={group.label}
                    className="super-toolbar-group flex flex-shrink-0 flex-col rounded-lg bg-contrast px-1 py-0.5"
                  >
                    <div className="flex items-center justify-center gap-0.5">
                      {group.buttons.map((button) => (
                        <Fragment key={button.id}>{buttonRenderers[button.id]}</Fragment>
                      ))}
                    </div>
                    <span
                      aria-hidden
                      className="mt-px hidden select-none truncate text-center text-[10px] font-medium uppercase leading-none tracking-wide text-passive-1 md:block"
                    >
                      {group.caption ?? group.label}
                    </span>
                  </div>
                ))
              : floatingSelectionToolbar}
          </Toolbar>
          {isMobile && (
            <button
              className="flex flex-shrink-0 items-center justify-center rounded border-l border-border px-3 py-3"
              aria-label="Dismiss keyboard"
              ref={dismissButtonRef}
            >
              <Icon type="keyboard-close" size="medium" />
            </button>
          )}
        </div>
        {/* Element-specific tooling on its own line: when a table/image/link/etc.
            is active, its tailored actions get a dedicated row labelled with the
            element type, instead of being crammed onto the main toolbar. */}
        {contextualWidget && contextualButtons.length > 0 && (
          <div className="flex w-full flex-shrink-0 items-start gap-1.5 border-t border-border px-1 py-0.5">
            <span className="mt-0.5 flex-shrink-0 select-none whitespace-nowrap rounded bg-info/10 px-1.5 py-0.5 text-xs font-semibold uppercase text-info">
              {contextualWidget.label}
            </span>
            <Toolbar
              className="super-toolbar flex flex-1 flex-wrap items-center gap-0.5 gap-y-1"
              store={contextualToolbarStore}
              aria-label={`${contextualWidget.label} tools`}
            >
              {contextualButtons}
            </Toolbar>
          </div>
        )}
      </div>
      <Popover
        title="Table of contents"
        anchorElement={tocAnchorRef}
        open={isTOCOpen}
        togglePopover={() => setIsTOCOpen(!isTOCOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        disableApplyingMobileWidth
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <div className="mb-1.5 mt-1 px-3 text-sm font-semibold uppercase text-text">Table of Contents</div>
        <TableOfContentsPlugin>
          {(tableOfContents) => {
            if (!tableOfContents.length) {
              return <div className="py-2 text-center">No headings found</div>
            }

            return (
              <Menu a11yLabel="Table of contents" className="!px-0">
                {tableOfContents.map(([key, text, tag]) => {
                  const level = parseInt(tag.slice(1)) || 1
                  if (level > 3) {
                    return null
                  }
                  return (
                    <MenuItem
                      key={key}
                      className="overflow-hidden md:py-2"
                      onClick={() => {
                        setIsTOCOpen(false)
                        editor.update(() => {
                          const node = $getNodeByKey(key)
                          if (!node) {
                            return
                          }
                          node.selectEnd()
                          editor.focus()
                          const domElement = editor.getElementByKey(key)
                          if (!domElement) {
                            return
                          }
                          setTimeout(() => {
                            domElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }, 1)
                        })
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      style={{
                        paddingLeft: `${(level - 1) * remToPx(1) + remToPx(0.75)}px`,
                      }}
                    >
                      <Icon type={tag} className="-mt-px mr-2.5 flex-shrink-0" />
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{text}</span>
                    </MenuItem>
                  )
                })}
              </Menu>
            )
          }}
        </TableOfContentsPlugin>
      </Popover>
      <Popover
        title="Text formatting options"
        anchorElement={textFormatAnchorRef}
        open={isTextFormatMenuOpen}
        togglePopover={() => setIsTextFormatMenuOpen(!isTextFormatMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Text formatting options" className="!px-0" onClick={() => setIsTextFormatMenuOpen(false)}>
          <ToolbarMenuItem
            name="Highlight"
            iconName="draw"
            active={isHighlight}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'highlight')}
          />
          <ToolbarMenuItem
            name="Strikethrough"
            iconName="strikethrough"
            active={isStrikethrough}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')}
          />
          <ToolbarMenuItem
            name="Subscript"
            iconName="subscript"
            active={isSubscript}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'subscript')}
          />
          <ToolbarMenuItem
            name="Superscript"
            iconName="superscript"
            active={isSuperscript}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'superscript')}
          />
          <ToolbarMenuItem name="Clear formatting" iconName="trash" onClick={clearFormatting} />
        </Menu>
      </Popover>
      <Popover
        title="Block style"
        anchorElement={textStyleAnchorRef}
        open={isTextStyleMenuOpen}
        togglePopover={() => setIsTextStyleMenuOpen(!isTextStyleMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Block style" className="!px-0" onClick={() => setIsTextStyleMenuOpen(false)}>
          <ToolbarMenuItem
            name="Normal"
            iconName="paragraph"
            active={blockType === 'paragraph'}
            onClick={() => ParagraphBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Heading 1"
            iconName="h1"
            active={blockType === 'h1'}
            onClick={() => H1Block.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Heading 2"
            iconName="h2"
            active={blockType === 'h2'}
            onClick={() => H2Block.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Heading 3"
            iconName="h3"
            active={blockType === 'h3'}
            onClick={() => H3Block.onSelect(editor)}
          />
          <MenuItemSeparator />
          <ToolbarMenuItem
            name="Bulleted List"
            iconName="list-bulleted"
            active={blockType === 'bullet'}
            onClick={() => BulletedListBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Numbered List"
            iconName="list-numbered"
            active={blockType === 'number'}
            onClick={() => NumberedListBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Check List"
            iconName="list-check"
            active={blockType === 'check'}
            onClick={() => ChecklistBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Auto-move completed to bottom"
            iconName="list-check"
            active={autoMoveCompleted}
            onClick={toggleAutoMoveCompleted}
          />
          <ToolbarMenuItem name="Restore completed tasks" iconName="arrow-left" onClick={restoreCompletedTasks} />
          <MenuItemSeparator />
          <ToolbarMenuItem
            name="Quote"
            iconName="quote"
            active={blockType === 'quote'}
            onClick={() => QuoteBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Code Block"
            iconName="code"
            active={blockType === 'code'}
            onClick={() => CodeBlock.onSelect(editor)}
          />
        </Menu>
      </Popover>
      <Popover
        title="Alignment"
        anchorElement={alignmentAnchorRef}
        open={isAlignmentMenuOpen}
        togglePopover={() => setIsAlignmentMenuOpen(!isAlignmentMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Alignment" className="!px-0" onClick={() => setIsAlignmentMenuOpen(false)}>
          <ToolbarMenuItem
            name="Left align"
            iconName="align-left"
            active={elementFormat === 'left'}
            onClick={() => LeftAlignBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Center align"
            iconName="align-center"
            active={elementFormat === 'center'}
            onClick={() => CenterAlignBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Right align"
            iconName="align-right"
            active={elementFormat === 'right'}
            onClick={() => RightAlignBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name="Justify"
            iconName="align-justify"
            active={elementFormat === 'justify'}
            onClick={() => JustifyAlignBlock.onSelect(editor)}
          />
        </Menu>
      </Popover>
      <Popover
        title="Insert"
        anchorElement={insertAnchorRef}
        open={isInsertMenuOpen}
        togglePopover={() => setIsInsertMenuOpen(!isInsertMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Insert" className="!px-0" onClick={() => setIsInsertMenuOpen(false)}>
          <ToolbarMenuItem
            name="Table"
            iconName="table"
            onClick={() =>
              showModal('Insert Table', (onClose) => <InsertTableDialog activeEditor={editor} onClose={onClose} />)
            }
          />
          <ToolbarMenuItem
            name="Upload file"
            iconName="file"
            onClick={() => activeEditor.dispatchCommand(OPEN_FILE_UPLOAD_MODAL_COMMAND, undefined)}
          />
          <ToolbarMenuItem
            name="Image from URL"
            iconName="image"
            onClick={() =>
              showModal('Insert image from URL', (onClose) => <InsertRemoteImageDialog onClose={onClose} />)
            }
          />
          <ToolbarMenuItem
            name={DividerBlock.name}
            iconName={DividerBlock.iconName}
            onClick={() => DividerBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={CollapsibleBlock.name}
            iconName={CollapsibleBlock.iconName}
            onClick={() => CollapsibleBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={PasswordBlock.name}
            iconName={PasswordBlock.iconName}
            onClick={() => PasswordBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={KanbanBlock.name}
            iconName={KanbanBlock.iconName}
            onClick={() => KanbanBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={CalendarBlock.name}
            iconName={CalendarBlock.iconName}
            onClick={() => CalendarBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={TimelineBlock.name}
            iconName={TimelineBlock.iconName}
            onClick={() => TimelineBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={DataviewBlock.name}
            iconName={DataviewBlock.iconName}
            onClick={() => DataviewBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={CalloutBlock.name}
            iconName={CalloutBlock.iconName}
            onClick={() => CalloutBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={EmbedBlock.name}
            iconName={EmbedBlock.iconName}
            onClick={() => EmbedBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={WebEmbedBlock.name}
            iconName={WebEmbedBlock.iconName}
            onClick={() => WebEmbedBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={TweetEmbedBlock.name}
            iconName={TweetEmbedBlock.iconName}
            onClick={() => TweetEmbedBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={MathBlock.name}
            iconName={MathBlock.iconName}
            onClick={() => MathBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={InlineMathBlock.name}
            iconName={InlineMathBlock.iconName}
            onClick={() => InlineMathBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={MermaidBlock.name}
            iconName={MermaidBlock.iconName}
            onClick={() => MermaidBlock.onSelect(editor)}
          />
          <ToolbarMenuItem
            name={FootnoteBlock.name}
            iconName={FootnoteBlock.iconName}
            onClick={() => FootnoteBlock.onSelect(editor)}
          />
          <MenuItemSeparator />
          <ToolbarMenuItem name="Customize toolbar" iconName="settings" onClick={openCustomizeDialog} />
        </Menu>
      </Popover>
      <Popover
        title="Text color"
        anchorElement={textColorAnchorRef}
        open={isTextColorMenuOpen}
        togglePopover={() => setIsTextColorMenuOpen(!isTextColorMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="p-3"
        disableMobileFullscreenTakeover
        disableFlip
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <div className="mb-2 text-sm font-semibold text-text">Text color</div>
        <div className="grid grid-cols-5 gap-2" onMouseDown={(e) => e.preventDefault()}>
          {COLOR_PRESETS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Text color ${color}`}
              className="h-8 w-8 touch-manipulation rounded border border-border md:h-6 md:w-6"
              style={{ backgroundColor: color }}
              onClick={() => {
                applyStyleText({ color })
                setIsTextColorMenuOpen(false)
              }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2" onMouseDown={(e) => e.preventDefault()}>
          <label className="flex items-center gap-2 text-sm">
            Custom
            <input
              type="color"
              className="h-9 w-12 cursor-pointer touch-manipulation rounded border border-border bg-transparent p-0 md:h-7 md:w-10"
              onChange={(event) => applyStyleText({ color: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-sm hover:bg-contrast"
            onClick={() => {
              applyStyleText({ color: null })
              setIsTextColorMenuOpen(false)
            }}
          >
            Clear
          </button>
        </div>
      </Popover>
      <Popover
        title="Highlight color"
        anchorElement={bgColorAnchorRef}
        open={isBgColorMenuOpen}
        togglePopover={() => setIsBgColorMenuOpen(!isBgColorMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="p-3"
        disableMobileFullscreenTakeover
        disableFlip
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <div className="mb-2 text-sm font-semibold text-text">Highlight color</div>
        <div className="grid grid-cols-5 gap-2" onMouseDown={(e) => e.preventDefault()}>
          {COLOR_PRESETS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Highlight color ${color}`}
              className="h-8 w-8 touch-manipulation rounded border border-border md:h-6 md:w-6"
              style={{ backgroundColor: color }}
              onClick={() => {
                applyStyleText({ 'background-color': color })
                setIsBgColorMenuOpen(false)
              }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2" onMouseDown={(e) => e.preventDefault()}>
          <label className="flex items-center gap-2 text-sm">
            Custom
            <input
              type="color"
              className="h-9 w-12 cursor-pointer touch-manipulation rounded border border-border bg-transparent p-0 md:h-7 md:w-10"
              onChange={(event) => applyStyleText({ 'background-color': event.target.value })}
            />
          </label>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-sm hover:bg-contrast"
            onClick={() => {
              applyStyleText({ 'background-color': null })
              setIsBgColorMenuOpen(false)
            }}
          >
            Clear
          </button>
        </div>
      </Popover>
      <Popover
        title="Font family"
        anchorElement={fontFamilyAnchorRef}
        open={isFontFamilyMenuOpen}
        togglePopover={() => setIsFontFamilyMenuOpen(!isFontFamilyMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Font family" className="!px-0" onClick={() => setIsFontFamilyMenuOpen(false)}>
          {FONT_FAMILIES.map((font) => {
            const isActive =
              font.value === null ? currentFontFamily === '' : currentFontFamily === font.value
            return (
              <MenuItem
                key={font.name}
                className={classNames(
                  'overflow-hidden md:py-2',
                  isActive ? '!bg-info !text-info-contrast' : 'hover:bg-contrast',
                )}
                onClick={() => applyStyleText({ 'font-family': font.value })}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span
                  className="overflow-hidden text-ellipsis whitespace-nowrap"
                  style={{ fontFamily: font.value ?? undefined }}
                >
                  {font.name}
                </span>
                {isActive && <Icon type="check" className="ml-auto" />}
              </MenuItem>
            )
          })}
        </Menu>
      </Popover>
      <Popover
        title="Font size"
        anchorElement={fontSizeAnchorRef}
        open={isFontSizeMenuOpen}
        togglePopover={() => setIsFontSizeMenuOpen(!isFontSizeMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-0 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Font size" className="!px-0" onClick={() => setIsFontSizeMenuOpen(false)}>
          {FONT_SIZE_PRESETS.map((size) => {
            const isActive = currentFontSize === size
            return (
              <MenuItem
                key={size}
                className={classNames(
                  'justify-center md:py-1.5',
                  isActive ? '!bg-info !text-info-contrast' : 'hover:bg-contrast',
                )}
                onClick={() => applyFontSize(size)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <span className="text-sm">{size}</span>
                {isActive && <Icon type="check" className="ml-auto" />}
              </MenuItem>
            )
          })}
        </Menu>
      </Popover>
      <Popover
        title="Change case"
        anchorElement={caseAnchorRef}
        open={isCaseMenuOpen}
        togglePopover={() => setIsCaseMenuOpen(!isCaseMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Change case" className="!px-0" onClick={() => setIsCaseMenuOpen(false)}>
          <MenuItem
            className="overflow-hidden hover:bg-contrast md:py-2"
            onClick={() => transformCase('upper')}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">UPPERCASE</span>
          </MenuItem>
          <MenuItem
            className="overflow-hidden hover:bg-contrast md:py-2"
            onClick={() => transformCase('lower')}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">lowercase</span>
          </MenuItem>
          <MenuItem
            className="overflow-hidden hover:bg-contrast md:py-2"
            onClick={() => transformCase('camel')}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">camelCase</span>
          </MenuItem>
        </Menu>
      </Popover>
      <Popover
        title="Sort & dedupe lines"
        anchorElement={sortAnchorRef}
        open={isSortMenuOpen}
        togglePopover={() => setIsSortMenuOpen(!isSortMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-64 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Sort and deduplicate lines" className="!px-0" onClick={() => setIsSortMenuOpen(false)}>
          <div className="px-3 py-1 text-xs font-semibold uppercase text-passive-0">Sort lines</div>
          {LINE_SORT_MODES.map(({ mode, label }) => (
            <MenuItem
              key={mode}
              className="overflow-hidden hover:bg-contrast md:py-2"
              onClick={() => transformLines(mode)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            </MenuItem>
          ))}
          <MenuItemSeparator />
          <div className="px-3 py-1 text-xs font-semibold uppercase text-passive-0">Deduplicate</div>
          {LINE_DEDUPE_MODES.map(({ mode, label }) => (
            <MenuItem
              key={mode}
              className="overflow-hidden hover:bg-contrast md:py-2"
              onClick={() => transformLines(mode)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            </MenuItem>
          ))}
          <MenuItemSeparator />
          <MenuItem
            className="overflow-hidden hover:bg-contrast md:py-2"
            onClick={openMultiKeySortDialog}
            onMouseDown={(e) => e.preventDefault()}
          >
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">Multi-key sort (1st, 2nd, 3rd)…</span>
          </MenuItem>
        </Menu>
      </Popover>
      <Popover
        title="Typography"
        anchorElement={typographyAnchorRef}
        open={isTypographyMenuOpen}
        togglePopover={() => setIsTypographyMenuOpen(!isTypographyMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <div className="flex flex-col gap-1 p-1 text-sm" onMouseDown={(e) => e.preventDefault()}>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-left hover:bg-contrast"
            onClick={() => toggleSelectionStyle('text-emphasis', 'filled dot')}
          >
            Emphasis marks
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-left hover:bg-contrast"
            onClick={() => toggleSelectionStyle('-webkit-text-stroke', '1px currentColor')}
          >
            Outline (text stroke)
          </button>
          <div className="px-3 pt-1 text-xs font-semibold uppercase text-passive-0">Letter spacing (kerning)</div>
          <div className="flex flex-wrap gap-1 px-2">
            {[
              { label: 'Tight', value: '-0.5px' },
              { label: 'Normal', value: '0' },
              { label: 'Wide', value: '0.5px' },
              { label: 'Wider', value: '1px' },
              { label: 'Widest', value: '2px' },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="rounded border border-border px-2 py-0.5 text-xs hover:bg-contrast"
                onClick={() => applyStyleText({ 'letter-spacing': preset.value })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="px-3 pt-1 text-xs font-semibold uppercase text-passive-0">Word spacing</div>
          <div className="flex flex-wrap gap-1 px-2">
            {[
              { label: 'Normal', value: '0' },
              { label: 'Wide', value: '2px' },
              { label: 'Wider', value: '4px' },
              { label: 'Widest', value: '8px' },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="rounded border border-border px-2 py-0.5 text-xs hover:bg-contrast"
                onClick={() => applyStyleText({ 'word-spacing': preset.value })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mt-1 rounded px-3 py-1.5 text-left text-danger hover:bg-contrast"
            onClick={() =>
              applyStyleText({
                'text-emphasis': null,
                '-webkit-text-stroke': null,
                'letter-spacing': null,
                'word-spacing': null,
              })
            }
          >
            Clear typography
          </button>
        </div>
      </Popover>
      <Popover
        title="Undo history"
        anchorElement={undoAnchorRef}
        open={isUndoMenuOpen}
        togglePopover={() => setIsUndoMenuOpen(!isUndoMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-64 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Undo multiple steps" className="!px-0" onClick={() => setIsUndoMenuOpen(false)}>
          {undoPreviews.map((preview, index) => (
            <MenuItem
              key={index}
              className="flex items-center gap-2 overflow-hidden hover:bg-contrast md:py-1.5"
              onClick={() => historyStore.undo(index + 1)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="w-7 flex-shrink-0 text-right text-xs text-passive-1">{index + 1}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{preview || '(empty)'}</span>
            </MenuItem>
          ))}
        </Menu>
      </Popover>
      <Popover
        title="Redo history"
        anchorElement={redoAnchorRef}
        open={isRedoMenuOpen}
        togglePopover={() => setIsRedoMenuOpen(!isRedoMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="start"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-64 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="Redo multiple steps" className="!px-0" onClick={() => setIsRedoMenuOpen(false)}>
          {redoPreviews.map((preview, index) => (
            <MenuItem
              key={index}
              className="flex items-center gap-2 overflow-hidden hover:bg-contrast md:py-1.5"
              onClick={() => historyStore.redo(index + 1)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="w-7 flex-shrink-0 text-right text-xs text-passive-1">{index + 1}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{preview || '(empty)'}</span>
            </MenuItem>
          ))}
        </Menu>
      </Popover>
      {/* Word-style floating mini-toolbar "More" overflow menu. Hosts the
          quick-format actions that don't earn a spot on the compact visible bar:
          highlight, sub/superscript, inline code block, change case, color, and
          clear formatting. Active state is reflected per item. */}
      <Popover
        title="More formatting"
        anchorElement={selectionMoreAnchorRef}
        open={isSelectionMoreMenuOpen}
        togglePopover={() => setIsSelectionMoreMenuOpen(!isSelectionMoreMenuOpen)}
        side={isMobile ? 'top' : 'bottom'}
        align="end"
        className="py-1"
        disableMobileFullscreenTakeover
        disableFlip
        containerClassName="md:!min-w-60 md:!w-auto"
        portal={false}
        documentElement={popoverDocumentElement}
      >
        <Menu a11yLabel="More formatting" className="!px-0" onClick={() => setIsSelectionMoreMenuOpen(false)}>
          <ToolbarMenuItem
            name="Highlight"
            iconName="draw"
            active={isHighlight}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'highlight')}
          />
          <ToolbarMenuItem
            name="Subscript"
            iconName="subscript"
            active={isSubscript}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'subscript')}
          />
          <ToolbarMenuItem
            name="Superscript"
            iconName="superscript"
            active={isSuperscript}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'superscript')}
          />
          <MenuItemSeparator />
          <ToolbarMenuItem
            name="Code Block"
            iconName="code"
            active={blockType === 'code'}
            onClick={insertCodeBlock}
          />
          <MenuItemSeparator />
          <ToolbarMenuItem name="UPPERCASE" iconName="text" onClick={() => transformCase('upper')} />
          <ToolbarMenuItem name="lowercase" iconName="text" onClick={() => transformCase('lower')} />
          <ToolbarMenuItem name="camelCase" iconName="text" onClick={() => transformCase('camel')} />
          <MenuItemSeparator />
          {/* Inline color swatches keep these actions self-contained so no
              secondary anchor (absent in floating mode) is needed. */}
          <div className="px-3 py-1.5" onMouseDown={(e) => e.preventDefault()}>
            <div className="mb-1 text-xs font-semibold text-text">Text color</div>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={`fg-${color}`}
                  type="button"
                  aria-label={`Text color ${color}`}
                  className="h-6 w-6 rounded border border-border"
                  style={{ backgroundColor: color }}
                  onClick={() => applyStyleText({ color })}
                />
              ))}
              <button
                type="button"
                className="rounded px-1.5 text-xs hover:bg-contrast"
                onClick={() => applyStyleText({ color: null })}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="px-3 py-1.5" onMouseDown={(e) => e.preventDefault()}>
            <div className="mb-1 text-xs font-semibold text-text">Highlight color</div>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={`bg-${color}`}
                  type="button"
                  aria-label={`Highlight color ${color}`}
                  className="h-6 w-6 rounded border border-border"
                  style={{ backgroundColor: color }}
                  onClick={() => applyStyleText({ 'background-color': color })}
                />
              ))}
              <button
                type="button"
                className="rounded px-1.5 text-xs hover:bg-contrast"
                onClick={() => applyStyleText({ 'background-color': null })}
              >
                Clear
              </button>
            </div>
          </div>
          <MenuItemSeparator />
          <ToolbarMenuItem name="Clear formatting" iconName="trash" onClick={clearFormatting} />
        </Menu>
      </Popover>
      {zoomBlockKey && (
        <BlockZoomOverlay
          blockKey={zoomBlockKey}
          label={contextualWidget?.label ?? activeBlockLabel}
          onClose={() => setZoomBlockKey(null)}
          portalElement={popoverDocumentElement}
        />
      )}
    </>
  )
}

export default ToolbarPlugin
