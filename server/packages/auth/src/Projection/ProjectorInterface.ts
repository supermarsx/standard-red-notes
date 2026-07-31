export interface ProjectorInterface<T> {
  projectSimple(object: T): Record<string, unknown>
}

export interface CustomProjectorInterface<T> extends ProjectorInterface<T> {
  projectCustom(projectionType: string, object: T, ...args: any[]): Record<string, unknown>
}
