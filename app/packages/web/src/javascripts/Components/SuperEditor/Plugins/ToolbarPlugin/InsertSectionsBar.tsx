/**
 * Standard Red Notes: the Insert tab's always-visible captioned sections.
 *
 * The former general Insert control was an `add ▾` dropdown popover listing every
 * insertable block. This replaces it with inline Office-ribbon segments — one per
 * catalog-derived section (Basic / Lists / Media / Data & tables / Diagrams &
 * charts / Finance / Others) — that sit side by side exactly like the Home tab's
 * groups. The slash ("/") BlockPicker still offers search-driven insert, so no
 * search box is needed here.
 *
 * This component is deliberately PURE and presentational: it takes already-built,
 * already-translated `sections` (each a caption + pre-rendered button rows) and
 * has NO editor / Lexical / provider dependencies. That keeps it trivially
 * jsdom-testable (the required render-path guard for the Insert UI, since the
 * full ToolbarPlugin can't be mounted) and keeps this file structurally isolated
 * from the large ToolbarPlugin. The per-section segment markup is copied verbatim
 * from the normal super-toolbar-group segment for exact visual parity.
 */
import { Fragment, ReactElement, ReactNode } from 'react'

export type InsertSectionsBarSection = {
  /** Stable React key (the section id). */
  key: string
  /** Localized caption shown beneath the segment. */
  caption: string
  /** Pre-rendered button rows (top-heavy packed), mirroring a normal group's rows. */
  rows: ReactNode[][]
}

export type InsertSectionsBarProps = {
  sections: InsertSectionsBarSection[]
}

/**
 * Render each Insert section as a sibling `super-toolbar-group` segment. Wrapped
 * in a Fragment so the segments render as direct siblings inside the Insert tab's
 * `<Toolbar>`, matching the layout of the Home tab's groups.
 */
const InsertSectionsBar = ({ sections }: InsertSectionsBarProps): ReactElement => (
  <Fragment>
    {sections.map((section) => (
      <div
        key={section.key}
        role="group"
        aria-label={section.caption}
        className="super-toolbar-group bg-contrast flex flex-shrink-0 flex-col rounded-lg px-1 py-0.5"
      >
        <div className="flex flex-col items-start justify-center gap-0.5 md:min-h-[7.375rem]">
          {section.rows.map((rowButtons, rowIndex) => (
            <div key={rowIndex} className="flex items-center justify-start gap-0.5">
              {rowButtons.map((button, buttonIndex) => (
                <Fragment key={buttonIndex}>{button}</Fragment>
              ))}
            </div>
          ))}
        </div>
        <span
          aria-hidden
          className="text-passive-1 mt-px hidden truncate text-center text-[10px] leading-none font-medium tracking-wide uppercase select-none md:block"
        >
          {section.caption}
        </span>
      </div>
    ))}
  </Fragment>
)

export default InsertSectionsBar
