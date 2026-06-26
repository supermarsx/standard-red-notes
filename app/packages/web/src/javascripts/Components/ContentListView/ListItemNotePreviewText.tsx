import { classNames, sanitizeHtmlString, SNNote } from '@standardnotes/snjs'
import { FunctionComponent, memo, useMemo } from 'react'

type Props = {
  item: SNNote
  hidePreview: boolean
  lineLimit?: number
}

const ListItemNotePreviewText: FunctionComponent<Props> = ({ item, hidePreview, lineLimit = 1 }) => {
  const hidden = item.hidePreview || item.protected || hidePreview

  // sanitizeHtmlString() runs a full DOMPurify pass; memoize it so it only
  // re-runs when the preview HTML actually changes, not on every parent re-render.
  const sanitizedPreviewHtml = useMemo(
    () => (!hidden && item.preview_html ? sanitizeHtmlString(item.preview_html) : undefined),
    [hidden, item.preview_html],
  )

  if (hidden) {
    return null
  }

  return (
    <div
      className={classNames(
        'overflow-hidden overflow-ellipsis text-sm lg:text-xs',
        item.archived ? 'opacity-60' : '',
      )}
    >
      {item.preview_html && sanitizedPreviewHtml !== undefined && (
        <div
          className="my-0.5"
          dangerouslySetInnerHTML={{
            __html: sanitizedPreviewHtml,
          }}
        ></div>
      )}
      {!item.preview_html && item.preview_plain && (
        <div className={`leading-1.3 line-clamp-${lineLimit} mt-0.5 overflow-hidden`}>{item.preview_plain}</div>
      )}
    </div>
  )
}

export default memo(ListItemNotePreviewText)
