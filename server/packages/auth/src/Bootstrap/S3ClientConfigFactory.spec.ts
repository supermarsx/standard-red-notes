import { S3Client } from '@aws-sdk/client-s3'

import { createS3ClientConfig } from './S3ClientConfigFactory'

describe('createS3ClientConfig', () => {
  it('omits blank optional S3 settings so the AWS SDK can use its defaults', () => {
    const config = createS3ClientConfig({
      accessKeyId: ' ',
      endpoint: '',
      region: '   ',
      secretAccessKey: '\t',
    })

    expect(config).toEqual({ apiVersion: 'latest' })
    const client = new S3Client(config)
    client.destroy()
  })

  it('normalizes configured S3 settings and requires a complete credential pair', () => {
    expect(
      createS3ClientConfig({
        accessKeyId: ' access-key ',
        endpoint: ' https://s3.example.test ',
        region: ' eu-west-2 ',
        secretAccessKey: ' secret-key ',
      }),
    ).toEqual({
      apiVersion: 'latest',
      credentials: {
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      },
      endpoint: 'https://s3.example.test',
      region: 'eu-west-2',
    })

    expect(createS3ClientConfig({ accessKeyId: 'access-key' })).toEqual({ apiVersion: 'latest' })
    expect(createS3ClientConfig({ secretAccessKey: 'secret-key' })).toEqual({ apiVersion: 'latest' })
  })
})
