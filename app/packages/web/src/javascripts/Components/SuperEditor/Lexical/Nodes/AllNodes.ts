import { CodeHighlightNode, CodeNode } from '@lexical/code'
import { HashtagNode } from '@lexical/hashtag'
import { AutoLinkNode, LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { MarkNode } from '@lexical/mark'
import { OverflowNode } from '@lexical/overflow'
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import { TweetNode } from './TweetNode'
import { YouTubeNode } from './YouTubeNode'
import { CollapsibleContainerNode } from '../../Plugins/CollapsiblePlugin/CollapsibleContainerNode'
import { CollapsibleContentNode } from '../../Plugins/CollapsiblePlugin/CollapsibleContentNode'
import { CollapsibleTitleNode } from '../../Plugins/CollapsiblePlugin/CollapsibleTitleNode'
import { FileNode } from '../../Plugins/EncryptedFilePlugin/Nodes/FileNode'
import { BubbleNode } from '../../Plugins/ItemBubblePlugin/Nodes/BubbleNode'
import { RemoteImageNode } from '../../Plugins/RemoteImagePlugin/RemoteImageNode'
import { InlineFileNode } from '../../Plugins/InlineFilePlugin/InlineFileNode'
import { CreateEditorArgs } from 'lexical'
import { FileExportNode } from './FileExportNode'
import { MermaidNode } from './MermaidNode'
import { ExcalidrawNode } from './ExcalidrawNode'
import { KanbanNode } from './KanbanNode'
import { CalendarNode } from './CalendarNode'
import { DataTableNode } from './DataTableNode'
import { CalloutNode } from './CalloutNode'
import { EmbedNode } from './EmbedNode'
import { WebEmbedNode } from './WebEmbedNode'
import { TweetEmbedNode } from './TweetEmbedNode'
import { MathNode } from './MathNode'
import { InlineMathNode } from './InlineMathNode'
import { FootnoteReferenceNode } from './FootnoteReferenceNode'
import { FootnotesNode } from './FootnotesNode'
import { TimelineNode } from './TimelineNode'
import { QrCodeNode } from './QrCodeNode'
import { TradingViewNode } from './TradingViewNode'
import { StockChartNode } from './StockChartNode'
import { SqlQueryNode } from './SqlQueryNode'
import { GanttChartNode } from './GanttChartNode'
import { TimingDiagramNode } from './TimingDiagramNode'
import { MusicStaffNode } from './MusicStaffNode'
import { ClockNode } from './ClockNode'
import { BookmarkAnchorNode } from './BookmarkAnchorNode'

const CommonNodes = [
  AutoLinkNode,
  CodeHighlightNode,
  CodeNode,
  CollapsibleContainerNode,
  CollapsibleContentNode,
  CollapsibleTitleNode,
  HashtagNode,
  HeadingNode,
  HorizontalRuleNode,
  LinkNode,
  ListItemNode,
  MarkNode,
  OverflowNode,
  QuoteNode,
  TableCellNode,
  TableNode,
  TableRowNode,
  TweetNode,
  YouTubeNode,
  FileNode,
  BubbleNode,
  RemoteImageNode,
  InlineFileNode,
  ListNode,
  MermaidNode,
  ExcalidrawNode,
  KanbanNode,
  CalendarNode,
  DataTableNode,
  CalloutNode,
  EmbedNode,
  WebEmbedNode,
  TweetEmbedNode,
  MathNode,
  InlineMathNode,
  FootnoteReferenceNode,
  FootnotesNode,
  TimelineNode,
  QrCodeNode,
  TradingViewNode,
  StockChartNode,
  SqlQueryNode,
  GanttChartNode,
  TimingDiagramNode,
  MusicStaffNode,
  ClockNode,
  BookmarkAnchorNode,
]

export const BlockEditorNodes = CommonNodes

export const SuperExportNodes: CreateEditorArgs['nodes'] = [...CommonNodes, FileExportNode]
