import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectApiError, ProjectService } from '../src/projects/service.ts';

type DbError = { message: string; code?: string } | null;

function projectClient(deleteError: DbError) {
  const trace: string[] = [];
  const project = { id: 'project-1', workspace_id: 'workspace-1', name: 'Delete me' };
  const storagePath = 'workspace-1/project-1/file-1.pdf';

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, 'plan-files');
        return {
          async remove(paths: string[]) {
            trace.push('storage-remove');
            assert.deepEqual(paths, [storagePath]);
            return { data: null, error: null };
          },
        };
      },
    },
    from(table: string) {
      let operation = 'select';
      const builder: any = {
        select() { operation = 'select'; return builder; },
        delete() { operation = 'delete'; return builder; },
        eq() { return builder; },
        async maybeSingle() {
          assert.equal(table, 'projects');
          return { data: project, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          let result: unknown;
          if (table === 'project_files') {
            result = { data: [{ storage_path: storagePath }], error: null };
          } else if (table === 'projects' && operation === 'delete') {
            trace.push('db-delete');
            result = { data: null, error: deleteError };
          } else {
            result = { data: null, error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return { client, project, trace };
}

test('project delete never removes plan blobs before a blocked database delete', async () => {
  const { client, trace } = projectClient({ message: 'violates foreign key constraint', code: '23503' });
  const service = new ProjectService(client as never, 'user-1', 'workspace-1');

  await assert.rejects(
    service.remove('project-1'),
    (error: unknown) => error instanceof ProjectApiError && error.status === 409,
  );
  assert.deepEqual(trace, ['db-delete']);
});

test('successful project delete commits the database delete before storage cleanup', async () => {
  const { client, project, trace } = projectClient(null);
  const service = new ProjectService(client as never, 'user-1', 'workspace-1');

  assert.deepEqual(await service.remove('project-1'), project);
  assert.deepEqual(trace, ['db-delete', 'storage-remove']);
});
