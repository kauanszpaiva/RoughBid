import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const hash=n=>Number(n).toString(16).padStart(64,'0');
async function fixture(){const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');await db.exec(readFileSync(new URL('../migrations/0033_magic_link_rate_limit.sql',import.meta.url),'utf8'));return db;}
const claim=async(db,email=1,origin=100,unknown=false)=>(await db.query('select reserve_magic_link_attempt($1,$2,$3) as result',[hash(email),hash(origin),unknown])).rows[0].result;

test('SQL magic-link claims serialize simultaneous requests and email cooldown survives changing origins',async()=>{
  const db=await fixture();try{
    const burst=await Promise.all(Array.from({length:12},(_,n)=>claim(db,1,100+n)));
    assert.equal(burst.filter(row=>row.allowed).length,1);
    assert.ok(burst.filter(row=>!row.allowed).every(row=>row.retry_after_seconds>=1&&row.retry_after_seconds<=60));
    assert.equal((await db.query('select count(*)::int as n from auth_magic_link_attempts')).rows[0].n,1);
    await db.exec("update auth_magic_link_attempts set created_at=now()-interval '61 seconds'");
    assert.equal((await claim(db,1,999)).allowed,true);
    await db.exec('set role authenticated');
    await assert.rejects(claim(db,2),/permission denied/);
    await assert.rejects(db.exec('select * from auth_magic_link_attempts'),/permission denied/);
    await db.exec('reset role;set role service_role');
    await assert.rejects(db.exec('delete from auth_magic_link_attempts'),/permission denied/);
    assert.equal((await claim(db,2)).allowed,true);
    await db.exec('reset role');
  }finally{await db.close();}
});

test('SQL magic-link rolling email, origin and unknown-origin caps bound sends without storing denied attempts',async()=>{
  const db=await fixture();try{
    for(let n=0;n<5;n++) await db.query("insert into auth_magic_link_attempts(email_hash,origin_hash,created_at) values($1,$2,now()-($3::int*interval '2 minutes'))",[hash(1),hash(500+n),n+1]);
    assert.equal((await claim(db,1,999)).allowed,false);
    await db.exec("update auth_magic_link_attempts set created_at=now()-interval '2 hours'");
    for(let n=0;n<5;n++) await db.query("insert into auth_magic_link_attempts(email_hash,origin_hash,created_at) values($1,$2,now()-interval '3 hours')",[hash(1),hash(600+n)]);
    assert.equal((await claim(db,1,999)).allowed,false);
    assert.equal((await claim(db,2,999)).allowed,true);
    for(let n=0;n<30;n++) assert.equal((await claim(db,1000+n,10)).allowed,true);
    assert.equal((await claim(db,2000,10)).allowed,false);
    for(let n=0;n<10;n++) assert.equal((await claim(db,3000+n,11,true)).allowed,true);
    assert.equal((await claim(db,4000,11,true)).allowed,false);
    assert.equal((await claim(db,4001,12)).allowed,true);
    assert.equal((await db.query('select count(*)::int as n from auth_magic_link_attempts')).rows[0].n,52);
  }finally{await db.close();}
});

test('SQL magic-link global ceiling resists email/IP rotation, expires old records and fails closed without lock state',async()=>{
  const db=await fixture();try{
    await db.exec("insert into auth_magic_link_attempts(email_hash,origin_hash,created_at) select lpad(n::text,64,'0'),lpad((n+1000)::text,64,'0'),now()-interval '2 minutes' from generate_series(1,200) n");
    assert.equal((await claim(db,99999,88888)).allowed,false);
    await db.exec("update auth_magic_link_attempts set created_at=now()-interval '2 hours'");
    await db.exec("insert into auth_magic_link_attempts(email_hash,origin_hash,created_at) select lpad(n::text,64,'0'),lpad((n+10000)::text,64,'0'),now()-interval '3 hours' from generate_series(201,1000) n");
    assert.equal((await claim(db,99999,88888)).allowed,false);
    await db.exec("update auth_magic_link_attempts set created_at=now()-interval '25 hours'");
    assert.equal((await claim(db,99999,88888)).allowed,true);
    assert.equal((await db.query('select count(*)::int as n from auth_magic_link_attempts')).rows[0].n,1);
    await db.exec('delete from auth_magic_link_rate_state');
    await assert.rejects(claim(db,12,34),/limiter unavailable/);
    assert.equal((await db.query('select count(*)::int as n from auth_magic_link_attempts')).rows[0].n,1);
    await assert.rejects(db.query('select reserve_magic_link_attempt($1,$2,$3)',['user@example.com',hash(1),false]),/Invalid rate-limit identity/);
  }finally{await db.close();}
});
