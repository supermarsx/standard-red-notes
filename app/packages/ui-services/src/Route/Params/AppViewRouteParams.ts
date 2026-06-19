export const ValidAppViewRoutes = ['u2f', 'extension', 'assistant', 'constellation'] as const

export type AppViewRouteParam = (typeof ValidAppViewRoutes)[number]
