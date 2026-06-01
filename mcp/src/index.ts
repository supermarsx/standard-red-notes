#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  {
    name: 'standard-red-notes',
    version: '0.1.0',
  },
  {
    instructions:
      'Standard Red Notes MCP bridge. This bootstrap server exposes status only; note access must be added through the local unlocked client adapter.',
  },
)

server.registerTool(
  'standard_red_notes_status',
  {
    title: 'Standard Red Notes Status',
    description: 'Report MCP bridge status and the planned note/server capability lanes.',
    inputSchema: {
      includeRoadmap: z.boolean().optional().describe('Include the next implementation slices.'),
    },
    outputSchema: {
      status: z.string(),
      transport: z.string(),
      contentAccess: z.string(),
      serverAccess: z.string(),
      next: z.array(z.string()).optional(),
    },
  },
  async ({ includeRoadmap }) => {
    const structuredContent = {
      status: 'bootstrap-ready',
      transport: 'stdio',
      contentAccess: 'planned-local-client-only-after-unlock',
      serverAccess: 'planned-admin-and-diagnostics-only',
      next: includeRoadmap
        ? [
            'Add local unlocked client adapter',
            'Add read-only decrypted note search',
            'Add write tools with confirmation hooks',
            'Add server health and entitlement tools',
            'Add Streamable HTTP after auth and DNS rebinding protection',
          ]
        : undefined,
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
