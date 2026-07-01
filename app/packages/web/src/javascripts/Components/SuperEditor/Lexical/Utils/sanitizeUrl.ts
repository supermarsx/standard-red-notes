/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

export const sanitizeUrl = (url: string): string => {
  /**
   * A pattern that matches safe URLs.
   *
   * Standard Red Notes: the allowlist is intentionally restricted to http(s)
   * and mailto. The `file:` scheme (and other risky schemes such as ftp/tel/sms)
   * is deliberately NOT permitted, since `file:` hrefs can reference the local
   * filesystem. Anything not matching here falls through to the safe fallback
   * below. Safe relative/anchor URLs (no scheme) are still allowed via the
   * `[^&:/?#]*(?:[/?#]|$)` branch.
   */
  const SAFE_URL_PATTERN = /^(?:(?:https?|mailto):|[^&:/?#]*(?:[/?#]|$))/gi

  /** A pattern that matches safe data URLs. */
  const DATA_URL_PATTERN =
    /^data:(?:image\/(?:bmp|gif|jpeg|jpg|png|tiff|webp)|video\/(?:mpeg|mp4|ogg|webm)|audio\/(?:mp3|oga|ogg|opus));base64,[a-z0-9+/]+=*$/i

  url = String(url).trim()

  if (url.match(SAFE_URL_PATTERN) || url.match(DATA_URL_PATTERN)) {
    return url
  }

  return 'https://'
}
