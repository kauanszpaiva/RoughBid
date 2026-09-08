import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMagicLinkRequest } from '../src/auth/routes.ts';

const env={ VERCEL:'1', PILOT_INVITE_SIGNING_SECRET:'local-test-only-hmac-secret-at-least-32-characters', RESEND_API_KEY:'re_local_test_fixture' };
const request=(body:unknown={email:'builder@example.com'},headers:Record<string,string>={'x-vercel-forwarded-for':'192.0.2.1'})=>new Request('https://roughbid.example/api/auth/magic-link',{method:'POST',headers,body:JSON.stringify(body)});
function client(decision:unknown={allowed:true,retry_after_seconds:0}) {
  const events:string[]=[]; const claims:Record<string,unknown>[]=[]; const links:unknown[]=[];
  const admin={
    rpc:async(name:string,args:Record<string,unknown>)=>{events.push('reserve'); assert.equal(name,'reserve_magic_link_attempt'); claims.push(args); return {data:decision,error:null};},
    auth:{admin:{generateLink:async(input:unknown)=>{events.push('generate');links.push(input);return{data:{properties:{action_link:'https://auth.example/verify?token=fake'}},error:null};}}},
  };
  return {admin,events,claims,links};
}
async function fakeEmail<T>(events:string[],run:()=>Promise<T>,fails=false) {
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{events.push('email');return new Response(JSON.stringify(fails?{message:'recipient-sensitive-provider-error'}:{id:'email_test'}),{status:fails?503:200});}) as typeof fetch;
  try{return await run();}finally{globalThis.fetch=previous;}
}

test('magic-link reserves before generating/sending, preserves signup invitations and exposes no identities to limiter',async()=>{
  const c=client(); const pilot='a'.repeat(43);
  const response=await fakeEmail(c.events,()=>handleMagicLinkRequest(request({email:' Builder@Example.COM ',mode:'create-account',inviteToken:'workspace_token',pilotInviteToken:pilot}),c.admin,{appUrl:'https://roughbid.example',env}));
  assert.equal(response.status,202);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{accepted:true,message:'If this address can receive a sign-in link, check your inbox.'});
  assert.deepEqual(c.events,['reserve','generate','email']);
  assert.match(String(c.claims[0]?.p_email_hash),/^[a-f0-9]{64}$/);assert.match(String(c.claims[0]?.p_origin_hash),/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(c.claims).includes('builder@example.com'),false);assert.equal(JSON.stringify(c.claims).includes('192.0.2.1'),false);
  const link=c.links[0] as {type:string,email:string,options:{redirectTo:string}};
  assert.equal(link.type,'signup');assert.equal(link.email,'builder@example.com');
  const redirect=new URL(link.options.redirectTo);assert.equal(redirect.searchParams.get('invite'),'workspace_token');assert.equal(redirect.searchParams.get('pilot_invite'),pilot);
});

test('magic-link throttling and limiter failure never generate or send, including malformed RPC replies',async()=>{
  const denied=client({allowed:false,retry_after_seconds:124});
  const limited=await handleMagicLinkRequest(request(),denied.admin,{appUrl:'https://roughbid.example',env});
  assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'124');assert.deepEqual(denied.events,['reserve']);
  for(const failure of ['rpc-error','rpc-throw','malformed','missing-rpc','missing-secret']) {
    const c=client(null);
    if(failure==='rpc-error') c.admin.rpc=async()=>({data:null,error:{message:'sensitive database details'}} as never);
    if(failure==='rpc-throw') c.admin.rpc=async()=>{throw new TypeError('sensitive transport details');};
    if(failure==='missing-rpc') delete (c.admin as {rpc?:unknown}).rpc;
    const response=await handleMagicLinkRequest(request(),c.admin,{appUrl:'https://roughbid.example',env:failure==='missing-secret'?{VERCEL:'1'}:env});
    assert.equal(response.status,503,failure);assert.equal(c.events.includes('generate'),false);assert.equal(c.events.includes('email'),false);
    assert.equal(JSON.stringify(await response.json()).includes('sensitive'),false);
  }
});

test('magic-link account and provider failures share the same non-enumerating accepted response',async()=>{
  const good=client();const baseline=await fakeEmail(good.events,()=>handleMagicLinkRequest(request(),good.admin,{appUrl:'https://roughbid.example',env}));
  const expected=await baseline.json();
  for(const message of ['User does not exist','Email already registered']) {
    const c=client();c.admin.auth.admin.generateLink=async()=>{c.events.push('generate');return{data:{properties:null},error:{message}} as never;};
    const response=await handleMagicLinkRequest(request(),c.admin,{appUrl:'https://roughbid.example',env});
    assert.equal(response.status,202);assert.deepEqual(await response.json(),expected);assert.deepEqual(c.events,['reserve','generate']);
  }
  const failed=client();const response=await fakeEmail(failed.events,()=>handleMagicLinkRequest(request(),failed.admin,{appUrl:'https://roughbid.example',env}),true);
  assert.equal(response.status,202);assert.deepEqual(await response.json(),expected);assert.deepEqual(failed.events,['reserve','generate','email']);
});

test('magic-link origin uses only trusted Vercel identity, normalizes IPv6 and keeps unknown sources limited',async()=>{
  const capture=async(headers:Record<string,string>,overrides:NodeJS.ProcessEnv=env,email='builder@example.com')=>{
    const c=client({allowed:false,retry_after_seconds:60});
    await handleMagicLinkRequest(request({email},headers),c.admin,{appUrl:'https://roughbid.example',env:overrides});
    return c.claims[0]!;
  };
  const first=await capture({'x-vercel-forwarded-for':'192.0.2.1','x-forwarded-for':'198.51.100.1'});
  const second=await capture({'x-vercel-forwarded-for':'192.0.2.1','x-forwarded-for':'203.0.113.2','origin':'https://attacker.example'},env,' BUILDER@EXAMPLE.COM ');
  assert.equal(first.p_email_hash,second.p_email_hash);assert.equal(first.p_origin_hash,second.p_origin_hash);
  assert.equal(first.p_origin_hash,(await capture({'x-vercel-forwarded-for':'::ffff:192.0.2.1'})).p_origin_hash);
  const v6=await capture({'x-vercel-forwarded-for':'2001:db8:1234:5678::abcd'});
  assert.equal(v6.p_origin_hash,(await capture({'x-vercel-forwarded-for':'2001:0DB8:1234:5678:1111:2222:3333:4444'})).p_origin_hash);
  const unknown=await capture({});assert.equal(unknown.p_origin_unknown,true);
  assert.equal(unknown.p_origin_hash,(await capture({'x-forwarded-for':'192.0.2.1, 203.0.113.1'})).p_origin_hash);
  assert.equal(unknown.p_origin_hash,(await capture({'x-vercel-forwarded-for':'198.51.100.9'},{...env,VERCEL:'0'})).p_origin_hash);
  const allowed=client();const response=await fakeEmail(allowed.events,()=>handleMagicLinkRequest(request(undefined,{}),allowed.admin,{appUrl:'https://roughbid.example',env}));
  assert.equal(response.status,202);assert.equal(allowed.claims[0]?.p_origin_unknown,true);
});
