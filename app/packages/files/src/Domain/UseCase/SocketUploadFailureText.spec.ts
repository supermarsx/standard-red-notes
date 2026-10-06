import { socketUploadFailureText } from './SocketUploadFailureText'

describe('socketUploadFailureText', () => {
  /**
   * The whole report used to be `Failed to push file bytes to server
   * (SOCKET_CLOSED)` — the one sentence a person sees in the upload error toast.
   * It never answered the only question that decides what to do next.
   */
  it('says the file was not saved while a restart is still provably safe', () => {
    const text = socketUploadFailureText('SOCKET_CLOSED', true)

    expect(text).toContain('SOCKET_CLOSED')
    expect(text).toContain('Nothing was saved')
    expect(text).toContain('upload it again')
    expect(text).not.toContain('may already')
  })

  /**
   * FINISH is the server's commit, and the client cannot know whether a FINISH
   * it never got an answer to was applied. Telling someone to upload again here
   * would be inventing a fact the transfer explicitly does not have.
   */
  it('refuses to claim nothing was saved once FINISH has been attempted', () => {
    const text = socketUploadFailureText('SOCKET_CLOSED', false)

    expect(text).toContain('SOCKET_CLOSED')
    expect(text).toContain('may already have been saved')
    expect(text).toContain('check before uploading it again')
    expect(text).not.toContain('Nothing was saved')
  })

  it('carries whichever protocol code actually ended the transfer', () => {
    for (const code of ['SOCKET_CLOSED', 'FILE_RESUME_UNSUPPORTED', 'OPERATION_UNAVAILABLE']) {
      expect(socketUploadFailureText(code, true)).toContain(`(${code})`)
      expect(socketUploadFailureText(code, false)).toContain(`(${code})`)
    }
  })

  /** Two different situations must not read as the same sentence. */
  it('reads differently in the two cases', () => {
    expect(socketUploadFailureText('SOCKET_CLOSED', true)).not.toBe(socketUploadFailureText('SOCKET_CLOSED', false))
  })
})
