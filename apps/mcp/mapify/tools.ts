import { MapifyClient } from './client.ts';

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export const mapifyTools = [
  {
    name: 'mapify_measure_building',
    description: 'Start a real-time Mapify building measurement from a postal address.',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: 'Complete postal address' }, externalProjectId: { type: 'string', description: 'Optional RoughBid project ID for correlation' } }, required: ['address'], additionalProperties: false },
  },
  {
    name: 'mapify_get_blueprint',
    description: 'Retrieve a generated building blueprint in PDF, SVG, or DXF format.',
    inputSchema: { type: 'object', properties: { buildingId: { type: 'string' }, format: { type: 'string', enum: ['pdf', 'svg', 'dxf'], default: 'pdf' } }, required: ['buildingId'], additionalProperties: false },
  },
  {
    name: 'mapify_get_job',
    description: 'Get the latest status and result of a Mapify measurement or blueprint job.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'], additionalProperties: false },
  },
] as const;

const requiredString = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
};

export async function handleMapifyMessage(message: JsonRpcRequest, client: MapifyClient): Promise<JsonRpcResponse | null> {
  if (message.id === undefined) return null;
  const id = message.id ?? null;
  try {
    if (message.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'roughbid-mapify', version: '1.0.0' } } };
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: mapifyTools } };
    if (message.method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };

    const args = message.params?.arguments ?? {};
    let data: unknown;
    if (message.params?.name === 'mapify_measure_building') {
      const externalProjectId = args.externalProjectId;
      if (externalProjectId !== undefined && typeof externalProjectId !== 'string') throw new Error('externalProjectId must be a string');
      data = await client.requestMeasurements({ address: requiredString(args, 'address'), ...(externalProjectId ? { externalProjectId } : {}) });
    } else if (message.params?.name === 'mapify_get_blueprint') {
      const format = args.format ?? 'pdf';
      if (format !== 'pdf' && format !== 'svg' && format !== 'dxf') throw new Error('format must be pdf, svg, or dxf');
      data = await client.getBlueprint(requiredString(args, 'buildingId'), format);
    } else if (message.params?.name === 'mapify_get_job') {
      data = await client.getJob(requiredString(args, 'jobId'));
    } else {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown Mapify tool' } };
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data } };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Mapify request failed' }], isError: true } };
  }
}
