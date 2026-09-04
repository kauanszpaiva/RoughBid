import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientProposal, getClientProposal, signClientProposal, sha256Hex, type ProposalDb } from '../src/proposals/share.ts';

function dbStub(overrides: Partial<ProposalDb> = {}): ProposalDb {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'estimator@example.com' } }, error: null }) },
    from: () => {
      throw new Error('Unexpected table access');
    },
    rpc: async () => ({ data: null, error: null }),
    ...overrides,
  };
}

test('client proposal link creation stores a hash and returns the raw token once', async () => {
  let insertedRow: Record<string, unknown> | undefined;
  const db = dbStub({
    from: (table) => {
      assert.equal(table, 'client_proposals');
      return {
        insert: (row: Record<string, unknown>) => {
          insertedRow = row;
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: 'proposal-1',
                  title: row.title,
                  client_name: row.client_name,
                  client_email: row.client_email,
                  total_amount: row.total_amount,
                  status: 'sent',
                  expires_at: row.expires_at,
                  created_at: '2026-09-04T00:00:00.000Z',
                },
                error: null,
              }),
            }),
          };
        },
      };
    },
  });

  const result = await createClientProposal(db, 'workspace-1', 'project-1', {
    title: 'Kitchen Remodel',
    clientName: 'Jane Client',
    clientEmail: 'jane@example.com',
    totalAmount: 12500,
    estimateId: 'estimate-1',
    publicPayload: { scope: [{ name: 'Demo', price: 2500 }] },
  });

  assert.equal(result.token.length > 32, true);
  assert.equal(insertedRow?.token_hash, await sha256Hex(String(result.token)));
  assert.notEqual(insertedRow?.token_hash, result.token);
  assert.deepEqual(insertedRow?.public_payload, { scope: [{ name: 'Demo', price: 2500 }] });
});

test('public proposal view tracks open through the RPC without direct table access', async () => {
  let rpcCall: { fn: string; args?: Record<string, unknown> } | undefined;
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';
  const db = dbStub({
    rpc: async (fn, args) => {
      rpcCall = { fn, args };
      return { data: [{ proposal_id: 'proposal-1', title: 'Kitchen Remodel', public_payload: { scope: [] } }], error: null };
    },
  });

  const result = await getClientProposal(db, new Request('https://roughbid.vercel.app/api/client-proposals/token', {
    headers: { 'user-agent': 'client-browser' },
  }), token);

  assert.equal((result as { proposal_id: string }).proposal_id, 'proposal-1');
  assert.equal(rpcCall?.fn, 'get_client_proposal');
  assert.equal(rpcCall?.args?.proposal_token_hash, await sha256Hex(token));
  assert.deepEqual(rpcCall?.args?.event_metadata, { user_agent: 'client-browser' });
});

test('public proposal signing validates signer name and signs through the RPC', async () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';
  let rpcCall: { fn: string; args?: Record<string, unknown> } | undefined;
  const db = dbStub({
    rpc: async (fn, args) => {
      rpcCall = { fn, args };
      return { data: [{ proposal_id: 'proposal-1', proposal_status: 'signed', signature_name: 'Jane Client' }], error: null };
    },
  });

  await assert.rejects(
    signClientProposal(db, new Request('https://roughbid.vercel.app/api/client-proposals/token/sign'), token, { signerName: ' ' }),
    /signerName is required/,
  );

  const result = await signClientProposal(db, new Request('https://roughbid.vercel.app/api/client-proposals/token/sign', {
    headers: { 'user-agent': 'client-browser' },
  }), token, { signerName: 'Jane Client' });

  assert.equal((result as { proposal_status: string }).proposal_status, 'signed');
  assert.equal(rpcCall?.fn, 'sign_client_proposal');
  assert.equal(rpcCall?.args?.proposal_token_hash, await sha256Hex(token));
  assert.equal(rpcCall?.args?.signer_name, 'Jane Client');
});
