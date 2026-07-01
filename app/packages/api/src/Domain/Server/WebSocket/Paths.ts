const TokenPaths = {
  createConnectionToken: '/v1/sockets/tokens',
  // Standard Red Notes: mint a short-lived collaboration-room capability for a note.
  authorizeCollaboration: '/v1/collaboration/authorize',
}

export const Paths = {
  v1: {
    ...TokenPaths,
  },
}
