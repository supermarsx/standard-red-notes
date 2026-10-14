import { AdminLogsService } from './AdminLogsService'
describe('AdminLogsService shared parser adapter', () => {
  it('preserves capture metadata and forwards bounded query semantics', async () => {
    const readTail = jest.fn().mockResolvedValue('[2026-10-14T10:00:00Z] [auth] [stdout] info: database ready')
    const service = new AdminLogsService('/logs', { readdir: async () => ['auth.log'], readFile: jest.fn(), readTail })
    expect(await service.tail({ limit: 1, order: 'asc', search: 'database', since: '2026-10-14T10:00:00Z' })).toEqual({
      entries: [{ timestamp: '2026-10-14T10:00:00.000Z', service: 'auth', level: 'info', message: 'database ready' }],
      truncated: false,
    })
    expect(readTail).toHaveBeenCalledWith(expect.stringMatching(/auth\.log$/), 512 * 1024)
  })
})
