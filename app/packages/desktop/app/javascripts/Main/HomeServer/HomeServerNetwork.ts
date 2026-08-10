export const HOME_SERVER_HOST = '127.0.0.1'

export function getLoopbackHomeServerUrl(port: number): string {
  return `http://${HOME_SERVER_HOST}:${port}`
}
