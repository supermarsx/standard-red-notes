import { ReactNode } from 'react'

export function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="super-toolbar-group bg-contrast flex flex-shrink-0 flex-col rounded-lg px-1 py-0.5"
    >
      <div className="super-ribbon-commands">{children}</div>
      <span
        aria-hidden
        className="text-passive-1 mt-px hidden text-center text-[0.625rem] font-medium uppercase md:block"
      >
        {label}
      </span>
    </div>
  )
}
