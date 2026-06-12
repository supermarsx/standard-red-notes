export const ValidAppViewRoutes = ['u2f', 'extension', 'assistant'] as const

export type AppViewRouteParam = (typeof ValidAppViewRoutes)[number]
