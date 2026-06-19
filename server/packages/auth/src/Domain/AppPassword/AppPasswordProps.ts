export interface AppPasswordProps {
  userUuid: string
  label: string
  hashedPassword: string
  createdAt: Date
  lastUsedAt: Date | null
}
