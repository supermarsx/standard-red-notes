export interface CreateTrustedDeviceDTO {
  userUuid: string
  // Human-readable label, typically derived from the user agent on the client
  // or server. Required and non-empty.
  label: string
}
