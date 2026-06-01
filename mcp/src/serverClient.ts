// Thin HTTP client for the Standard Red Notes server. Keeps the MCP surface
// (index.ts) free of fetch boilerplate and lets us swap in a local-client
// adapter later without rewriting tool handlers.

export interface ServerClientOptions {
  baseUrl: string
  authToken?: string
  allowWrites: boolean
}

export interface NoteSummary {
  uuid: string
  title: string
  updatedAt: string
}

export interface NoteSearchHit {
  uuid: string
  title: string
  snippet: string
}

export interface FullNote {
  uuid: string
  title: string
  body: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface TagSummary {
  uuid: string
  title: string
}

export class ServerClient {
  readonly baseUrl: string
  readonly allowWrites: boolean
  private readonly authToken?: string

  constructor(opts: ServerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.authToken = opts.authToken
    this.allowWrites = opts.allowWrites
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.authToken) h.authorization = `Bearer ${this.authToken}`
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body == null ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`server ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  async listNotes(
    limit: number,
    cursor?: string,
  ): Promise<{ notes: NoteSummary[]; cursor?: string }> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    return this.request('GET', `/v1/notes?${params.toString()}`)
  }

  async searchNotes(query: string, limit: number): Promise<{ hits: NoteSearchHit[] }> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return this.request('GET', `/v1/notes/search?${params.toString()}`)
  }

  async readNote(uuid: string): Promise<FullNote> {
    return this.request('GET', `/v1/notes/${encodeURIComponent(uuid)}`)
  }

  async createNote(input: { title: string; body: string; tags: string[] }): Promise<{ uuid: string; title: string }> {
    return this.request('POST', '/v1/notes', input)
  }

  async updateNote(
    uuid: string,
    patch: { title?: string; body?: string; tags?: string[] },
  ): Promise<{ uuid: string; updatedAt: string }> {
    return this.request('PATCH', `/v1/notes/${encodeURIComponent(uuid)}`, patch)
  }

  async deleteNote(uuid: string): Promise<void> {
    await this.request<void>('DELETE', `/v1/notes/${encodeURIComponent(uuid)}`)
  }

  async listTags(): Promise<TagSummary[]> {
    const res = await this.request<{ tags: TagSummary[] }>('GET', '/v1/tags')
    return res.tags
  }
}
