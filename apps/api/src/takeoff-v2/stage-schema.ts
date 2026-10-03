import type { DeepPassRequest } from './types.ts';

/** Common JSON Schema subset; stronger bounds are enforced by the checkpoint parser. */
export function deepPassOutputSchema(request: DeepPassRequest): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['status', 'checkpoint'],
    properties: {
      status: { type: 'string', enum: ['succeeded', 'blocked'] },
      checkpoint: {
        type: 'object', additionalProperties: false,
        required: ['version', 'physical_page_number', 'pass_type', 'observations', 'blockers'],
        properties: {
          version: { type: 'string', enum: ['claude-deep-v1'] },
          physical_page_number: { type: 'integer', enum: [request.sheet.physicalPageNumber] },
          pass_type: { type: 'string', enum: [request.passType] },
          observations: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            required: ['kind', 'description', 'source_excerpt', 'confidence'],
            properties: {
              kind: { type: 'string' }, description: { type: 'string' },
              source_excerpt: { type: ['string', 'null'] }, confidence: { type: 'number' },
            },
          } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };
}
