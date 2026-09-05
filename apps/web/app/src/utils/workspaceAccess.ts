/** Unknown and missing membership roles always stay read-only. */
export function canWriteWorkspace(role: unknown): boolean {
  return role === 'admin' || role === 'estimator';
}
