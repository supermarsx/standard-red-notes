import { Request, Response } from 'express'
import { inject, optional } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import { SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import { OcrPageImage, OcrService } from '../../Service/Ocr/OcrService'
import { ResolvedOcrConfig, ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

interface RecognizeRequestBody {
  /** tesseract language code (e.g. "eng", "eng+deu"). Optional -> server default. */
  language?: string
  /** Base64-encoded page images (PNG/JPEG) of rasterized PDF pages. */
  pages?: Array<{ pageNumber?: number; imageBase64?: string }>
}

/**
 * Server-side PDF OCR endpoint.
 *
 * ---------------------------------------------------------------------------
 * E2E PRIVACY (READ THIS)
 * ---------------------------------------------------------------------------
 * Files are end-to-end encrypted. To OCR a page here, the client must DECRYPT
 * the PDF and POST the resulting page image(s) to `/recognize`. That content
 * LEAVES end-to-end encryption: this server sees the page imagery for the
 * duration of the request — exactly like the AI assistant proxy. The feature is
 * therefore strictly OPT-IN, gated by THREE layers:
 *   1. operator env master switch  OCR_SERVER_ENABLED (default false),
 *   2. admin-manageable per-user setting OCR_SERVER_ALLOWED (default off),
 *   3. the client only offering it when both of the above are satisfied.
 *
 * The browser OCR path (which never leaves the device) remains the default. This
 * controller is stateless: it holds nothing, persists nothing, and returns the
 * extracted text to the caller.
 *
 * `/config` is authenticated because the per-user allow flag is read from the
 * request's resolved settings; `/recognize` is authenticated because it spends
 * server CPU.
 */
@controller('/v1/ocr')
export class OcrController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_OCR_SERVER_ENABLED) private serverOcrEnabled: boolean,
    @inject(TYPES.ApiGateway_OCR_DEFAULT_LANGUAGE) private defaultLanguage: string,
    @inject(TYPES.ApiGateway_OcrService) private ocrService: OcrService,
    // Standard Red Notes: runtime overlay resolver (persisted admin value wins over
    // env). When present, the master switch + default language + per-request bounds
    // are re-read per request so admin changes take effect WITHOUT a restart. When
    // absent (unit tests) the boot-time injected env constants are used.
    @inject(TYPES.ApiGateway_ServerSettingsResolver)
    @optional()
    private serverSettingsResolver?: ServerSettingsResolver,
  ) {
    super()
  }

  /**
   * The effective OCR config: persisted admin overlay wins over env, per request.
   * Falls back to the boot-time injected env constants if the resolver is absent
   * or the overlay read fails, so a broken overlay never breaks OCR harder than
   * its env config already would.
   */
  private async resolveConfig(): Promise<ResolvedOcrConfig> {
    if (this.serverSettingsResolver) {
      try {
        return await this.serverSettingsResolver.resolveOcrConfig()
      } catch {
        // fall through to the env baseline below.
      }
    }

    return {
      serverEnabled: this.serverOcrEnabled,
      defaultLanguage: this.defaultLanguage,
      // Bounds are enforced inside OcrService from its own boot options when we do
      // not pass overrides, so these two only matter for the resolver path.
      maxPages: 0,
      maxImageBytes: 0,
      clientEnabled: false,
      clientDefaultLanguage: this.defaultLanguage,
    }
  }

  /**
   * Tells the client whether server-side OCR is available FOR THIS USER:
   * `serverOcrEnabled` (env master switch) AND `allowed` (the admin-manageable
   * per-user OCR_SERVER_ALLOWED flag). Both must be true before the client offers
   * the "Run OCR on server" action. Also returns the server's default language.
   */
  @httpGet('/config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async config(_request: Request, response: Response): Promise<void> {
    const allowed = this.userAllowed(response)
    const config = await this.resolveConfig()

    response.json({
      serverOcrEnabled: config.serverEnabled,
      allowed,
      // The client should only offer server OCR when BOTH are satisfied.
      available: config.serverEnabled && allowed,
      defaultLanguage: config.defaultLanguage,
      // Standard Red Notes: the BROWSER-OCR intent (admin overlay over OCR_ENABLED
      // / OCR_DEFAULT_LANGUAGE). Surfaced here so a fresh page can pick up an admin
      // change WITHOUT a web-container rebuild; the baked window.* globals remain
      // the fallback when this endpoint is unavailable.
      clientOcrEnabled: config.clientEnabled,
      clientDefaultLanguage: config.clientDefaultLanguage,
    })
  }

  /**
   * Recognize text from uploaded, DECRYPTED PDF page images and return per-page
   * extracted text. Re-checks the env master switch and the per-user allow flag
   * server-side (never trust the client's gating) before doing any work.
   */
  @httpPost('/recognize', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async recognize(request: Request, response: Response): Promise<void> {
    const config = await this.resolveConfig()
    if (!config.serverEnabled) {
      response.status(403).json({
        error: { tag: 'ocr-server-disabled', message: 'Server-side OCR is disabled on this server.' },
      })
      return
    }

    if (!this.userAllowed(response)) {
      response.status(403).json({
        error: {
          tag: 'ocr-server-not-allowed',
          message: 'Server-side OCR is not enabled for your account.',
        },
      })
      return
    }

    const body = (request.body ?? {}) as RecognizeRequestBody
    const rawPages = Array.isArray(body.pages) ? body.pages : []

    if (rawPages.length === 0) {
      response.status(400).json({ error: { message: 'No pages provided for OCR.' } })
      return
    }

    let pages: OcrPageImage[]
    try {
      pages = rawPages.map((page, index) => {
        const imageBase64 = typeof page.imageBase64 === 'string' ? page.imageBase64 : ''
        if (imageBase64.length === 0) {
          throw new Error(`Missing image for page at index ${index}.`)
        }
        return {
          pageNumber: typeof page.pageNumber === 'number' ? page.pageNumber : index + 1,
          image: Buffer.from(imageBase64, 'base64'),
        }
      })
    } catch (error) {
      response.status(400).json({ error: { message: (error as Error).message } })
      return
    }

    try {
      // Pass the resolved overlay bounds/default-language so an admin can retune
      // them at runtime. maxPages/maxImageBytes of 0 (the env-baseline fallback
      // when no resolver is bound) mean "use the OcrService boot options".
      const results = await this.ocrService.recognizePages(pages, body.language, {
        defaultLanguage: config.defaultLanguage,
        maxPages: config.maxPages > 0 ? config.maxPages : undefined,
        maxImageBytes: config.maxImageBytes > 0 ? config.maxImageBytes : undefined,
      })
      response.json({ pages: results })
    } catch (error) {
      // Bounds violations (too many pages / oversized image) and recognition
      // failures both surface here; treat bounds as 413, everything else as 500.
      const message = (error as Error).message
      const isBounds = /too large|too many pages|empty image/i.test(message)
      response.status(isBounds ? 413 : 500).json({ error: { message } })
    }
  }

  /**
   * Resolve the per-user OCR_SERVER_ALLOWED flag from the request's settings, if
   * an upstream populated them on `response.locals.settings` (same channel the AI
   * proxy uses for AI_ENABLED). Absent/unresolvable -> NOT allowed: this is a
   * privacy-sensitive E2E downgrade, so it fails CLOSED rather than open.
   */
  private userAllowed(response: Response): boolean {
    const settings = (response.locals as { settings?: Record<string, unknown> }).settings
    if (!settings) {
      return false
    }
    const raw = settings[SettingName.NAMES.OcrServerAllowed]
    return raw !== undefined && raw !== null && `${raw}`.toLowerCase() === 'true'
  }
}
