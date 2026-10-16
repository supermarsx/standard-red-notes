import { SVGProps } from 'react'

/** A pane silhouette with content identity and a chevron describing the action. */
const PaneIcon = ({ topics, expand, ...props }: SVGProps<SVGSVGElement> & { topics?: boolean; expand?: boolean }) => (
  <svg viewBox="0 0 24 24" {...props}>
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M12 4.5v15" opacity="0.6" />
      {topics ? (
        <>
          <path d="M6 9.5V16h1.5M6 12h1.5" />
          <circle cx="6" cy="8" r="1.2" />
          <circle cx="9" cy="12" r="1.2" />
          <circle cx="9" cy="16" r="1.2" />
        </>
      ) : (
        <>
          <rect x="5" y="7.5" width="4.5" height="3" rx="0.6" />
          <rect x="5" y="13.5" width="4.5" height="3" rx="0.6" />
        </>
      )}
      <path d={expand ? 'm15.5 9 3 3-3 3' : 'm18.5 9-3 3 3 3'} />
    </g>
  </svg>
)

export const ExpandTopicsPaneIcon = (props: SVGProps<SVGSVGElement>) => <PaneIcon topics expand {...props} />
export const CollapseTopicsPaneIcon = (props: SVGProps<SVGSVGElement>) => <PaneIcon topics {...props} />
export const ExpandNotesPaneIcon = (props: SVGProps<SVGSVGElement>) => <PaneIcon expand {...props} />
export const CollapseNotesPaneIcon = (props: SVGProps<SVGSVGElement>) => <PaneIcon {...props} />
