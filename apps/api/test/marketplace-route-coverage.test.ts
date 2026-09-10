import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';

test('Marketplace catalog has a deployable Vercel function bridge',()=>{
  const file=new URL('../../../api/marketplace/catalog.ts',import.meta.url);
  assert.ok(existsSync(file),'Marketplace catalog would 404 without its function file');
  assert.equal(readFileSync(file,'utf8').replace(/\r\n/g,'\n'),"export { config, default } from '../_bridge.ts';\n");
});

test('supplier import has a deployable Vercel function bridge',()=>{
  const file=new URL('../../../api/marketplace/supplier-import.ts',import.meta.url);
  assert.ok(existsSync(file),'Supplier imports would 404 without their function file');
  assert.equal(readFileSync(file,'utf8').replace(/\r\n/g,'\n'),"export { config, default } from '../_bridge.ts';\n");
});
