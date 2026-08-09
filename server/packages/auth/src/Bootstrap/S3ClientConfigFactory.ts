import { S3ClientConfig } from '@aws-sdk/client-s3'

export type S3Environment = {
  accessKeyId?: string
  endpoint?: string
  region?: string
  secretAccessKey?: string
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function createS3ClientConfig(environment: S3Environment): S3ClientConfig {
  const config: S3ClientConfig = { apiVersion: 'latest' }
  const region = optionalValue(environment.region)
  const endpoint = optionalValue(environment.endpoint)
  const accessKeyId = optionalValue(environment.accessKeyId)
  const secretAccessKey = optionalValue(environment.secretAccessKey)

  if (region) {
    config.region = region
  }
  if (endpoint) {
    config.endpoint = endpoint
  }
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey }
  }

  return config
}
