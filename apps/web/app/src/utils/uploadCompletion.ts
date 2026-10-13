/** Resume only completion after a successful byte transfer. A lost response must
 * not create a second source or overwrite an already-completed storage object.
 * Callers serialize actions and clear the map when their project scope changes.
 */
export async function completeTransferredUpload<Source extends object, Result>(
  source: Source,
  transferred: Map<Source, string>,
  options: {
    isCurrent: () => boolean;
    transfer: () => Promise<string | undefined>;
    complete: (id: string) => Promise<Result>;
  },
): Promise<Result | undefined> {
  if (!options.isCurrent()) return undefined;
  let id = transferred.get(source);
  if (!id) {
    id = await options.transfer();
    if (!id || !options.isCurrent()) return undefined;
    transferred.set(source, id);
  }
  const result = await options.complete(id);
  if (!options.isCurrent()) return undefined;
  transferred.delete(source);
  return result;
}
