import {
  calculateProject,
  type ProjectCalculationInput,
} from '../../../../packages/domain/src/index.ts';

export type RecalculationDependencies = {
  authenticate(request: Request): Promise<{ id: string } | null>;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Framework-neutral POST /api/estimates/recalculate endpoint. */
export function createEstimateCalculationHandler(dependencies: RecalculationDependencies) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/estimates/recalculate') return json({ error: 'Not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!await dependencies.authenticate(request)) return json({ error: 'Unauthorized' }, 401);
    try {
      const input = await request.json() as ProjectCalculationInput;
      return json(calculateProject(input));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
        return json({ error: error.message }, 400);
      }
      return json({ error: 'Internal server error' }, 500);
    }
  };
}
