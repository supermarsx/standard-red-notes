/**
 * The client consumes `@standardnotes/domain-core` from node_modules (published) and
 * therefore cannot extend `ContentType.TYPES` with `Folder`. The server's domain-core
 * has been updated to accept the literal string `'Folder'`, so we use that literal value
 * everywhere a Folder content_type is needed on the client.
 */
export const FolderContentType = 'Folder'
