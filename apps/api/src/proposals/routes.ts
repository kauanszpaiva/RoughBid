import { createClientProposal, getClientProposal, signClientProposal, ProposalApiError, type ProposalDb } from './share.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function handleClientProposalRequest(
  request: Request,
  db: ProposalDb,
  options: {
    sendProposalOpenedEmail?: (input: { to: string; proposalTitle: string; clientName: string; proposalUrl: string }) => Promise<unknown>;
    sendProposalSignedEmail?: (input: { to: string; proposalTitle: string; clientName: string; proposalUrl: string }) => Promise<unknown>;
  } = {},
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (parts[0] === 'projects' && parts[1] && parts[2] === 'client-proposals' && request.method === 'POST') {
      const workspaceId = request.headers.get('x-workspace-id') ?? '';
      return json(await createClientProposal(db, workspaceId, parts[1], await request.json()), 201);
    }

    if (parts[0] === 'client-proposals' && parts[1] && parts.length === 2 && request.method === 'GET') {
      const proposal = await getClientProposal(db, request, parts[1]);
      if (proposal.was_first_open && proposal.notification_email && options.sendProposalOpenedEmail) {
        await options.sendProposalOpenedEmail({
          to: String(proposal.notification_email),
          proposalTitle: String(proposal.title),
          clientName: String(proposal.client_name),
          proposalUrl: new URL(`/proposal/${parts[1]}`, request.url).toString(),
        }).catch(() => undefined);
      }
      return json(stripInternalNotificationFields(proposal));
    }

    if (parts[0] === 'client-proposals' && parts[1] && parts[2] === 'sign' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const signed = await signClientProposal(db, request, parts[1], body);
      if (signed.notification_email && options.sendProposalSignedEmail) {
        await options.sendProposalSignedEmail({
          to: String(signed.notification_email),
          proposalTitle: String(signed.proposal_title ?? 'Client proposal'),
          clientName: String(signed.signature_name),
          proposalUrl: new URL(`/proposal/${parts[1]}`, request.url).toString(),
        }).catch(() => undefined);
      }
      return json(stripInternalNotificationFields(signed));
    }

    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof ProposalApiError) return json({ error: error.message }, error.status);
    return json({ error: 'Internal server error' }, 500);
  }
}

function stripInternalNotificationFields(row: Record<string, unknown>) {
  const { notification_email: _notificationEmail, was_first_open: _wasFirstOpen, ...publicRow } = row;
  return publicRow;
}
