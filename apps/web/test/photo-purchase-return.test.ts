import test from 'node:test';
import assert from 'node:assert/strict';
import { readPhotoPurchaseReturn } from '../app/src/utils/photoPurchaseReturn.ts';

test('photo return selects its server purchase without claiming payment or modifying PDF scope', () => {
  const search = '?reading_mode=photo_batch&payment=returned&workspace_id=workspace&project_id=project&photo_quote_id=quote';
  assert.deepEqual(readPhotoPurchaseReturn(search), { workspaceId: 'workspace', projectId: 'project', quoteId: 'quote', payment: 'returned' });
  assert.equal(readPhotoPurchaseReturn(search.replace('returned', 'canceled'))?.payment, 'canceled');
  for (const changed of [search.replace('returned', 'paid'), search.replace('photo_batch', 'full_order'), search.replace('photo_quote_id=quote', 'quote_id=quote'), search.replace('project_id=project', 'project_id=../project')]) assert.equal(readPhotoPurchaseReturn(changed), null);
});
