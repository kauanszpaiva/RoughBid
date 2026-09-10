import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSupplierPriceCsv } from '../app/src/utils/supplierPriceImport.ts';

test('supplier CSV import accepts quoted values and assigns estimator-editable costs',()=>{
  let id=0;const result=parseSupplierPriceCsv('Name,Category,Unit,Unit cost,Supplier\n"Board, gypsum",Drywall,EA,$14.25,"Supply, Inc."\n',()=>String(++id));
  assert.equal(result.length,1);assert.equal(result[0].name,'Board, gypsum');assert.equal(result[0].supplier,'Supply, Inc.');
  assert.equal(result[0].unitCost,14.25);assert.equal(result[0].unitPrice,14.25);assert.equal(result[0].id,'mat-1');
});

test('supplier CSV import rejects missing headers, invalid costs and duplicate rows',()=>{
  assert.throws(()=>parseSupplierPriceCsv('Name,Unit\nBoard,EA'),/headers/i);
  assert.throws(()=>parseSupplierPriceCsv('Name,Unit,Cost\nBoard,EA,-1'),/row 2/i);
  assert.throws(()=>parseSupplierPriceCsv('Name,Unit,Cost,Supplier\nBoard,EA,1,A\nBoard,EA,2,A'),/duplicates/i);
});

test('supplier CSV import is bounded to two thousand data rows',()=>{
  const body=Array.from({length:2001},(_,i)=>`Item ${i},EA,1`).join('\n');
  assert.throws(()=>parseSupplierPriceCsv(`Name,Unit,Cost\n${body}`),/2,000 rows/i);
});
