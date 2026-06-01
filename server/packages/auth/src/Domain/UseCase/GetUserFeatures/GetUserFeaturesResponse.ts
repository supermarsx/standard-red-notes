import { AnyFeatureDescription } from '@standardnotes/features'

export type GetUserFeaturesResponse =
  | {
      success: true
      features: AnyFeatureDescription[]
      roles?: string[]
      userUuid?: string
    }
  | {
      success: false
      error: {
        message: string
      }
    }
