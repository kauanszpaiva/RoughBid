import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
const playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH || new URL('../.browser-tests/node_modules/playwright/index.mjs', import.meta.url).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(repo, '.page-review-test-'));
let server;
const stub = `
export async function bootstrapAuth(){return {profile:{isPlatformAdmin:!location.search.includes('customer')}};}
const pages=Array.from({length:3},(_,i)=>({pageNumber:i+1,jobId:i===0?'saved-1':null,status:i===0?'needs_review':'not_started',processingError:null,findingCount:i===0?1:null}));
window.pageHarness={calls:[],loads:0,reviews:[],pages};
export async function getPageReviewInventory(){window.pageHarness.loads++;return {strategy:'sheet-v1',fileId:'f',sourceSha256:'a'.repeat(64),totalPages:3,scope:'Test',trades:['Framing'],completeTakeoffVerified:false,pages:structuredClone(pages)};}
export async function startPhysicalPageReading(w,p,inventory,pageNumber){const h=window.pageHarness;h.calls.push(pageNumber);await new Promise(resolve=>setTimeout(resolve,220));if(location.search.includes('fail')){h.pages[pageNumber-1]={...h.pages[pageNumber-1],jobId:'uncertain',status:'processing',processingError:'Uncertain'};throw Error('Synthetic transport failure');}h.pages[pageNumber-1]={pageNumber,jobId:'job-'+pageNumber,status:'needs_review',processingError:null,findingCount:1};return {id:'job-'+pageNumber,status:'needs_review',processing_error:null,output_summary:{},plan_reading_findings:[{id:'finding-'+pageNumber}]};}
`;
try {
  await writeFile(path.join(root,'index.html'),'<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await writeFile(path.join(root,'main.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {PageReviewPanel} from '../apps/web/app/src/components/PageReviewPanel';createRoot(document.getElementById('root')).render(<PageReviewPanel workspaceId="w" projectId="p" fileId="f" scope="Test" canWrite={true} onBusyChange={()=>{}} onOpenJob={(id)=>window.pageHarness.reviews.push(id)}/>);`);
  const config={configFile:false,root,plugins:[react(),{name:'page-review-test-api',enforce:'pre',resolveId(source,importer){if(importer?.endsWith('/PageReviewPanel.tsx')&&source==='../services/api')return '\0page-api';},load(id){if(id==='\0page-api')return stub;}}],build:{outDir:path.join(root,'dist'),emptyOutDir:true},preview:{host:'127.0.0.1',port:4183,strictPort:true}};
  await build(config);server=await preview(config);
  const browser=await playwright.chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  try {
    for(const width of [1365,390]){
      const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://127.0.0.1:4183');
      await page.getByRole('button',{name:'Load PDF page inventory'}).click();
      await page.getByText('1 of 3 physical pages have saved results.',{exact:false}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.pageHarness.calls),[]);
      await page.getByRole('button',{name:'Analyze remaining pages (2)'}).evaluate(b=>{b.click();b.click();});
      await page.getByText('3 of 3 physical pages have saved results.',{exact:false}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.pageHarness.calls),[2,3]);
      await page.getByRole('button',{name:'Review findings for page 3'}).click();
      assert.deepEqual(await page.evaluate(()=>window.pageHarness.reviews),['job-3']);
      await page.getByRole('button',{name:'Reload saved pages'}).click();
      await page.getByRole('button',{name:'Analyze remaining pages (0)'}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.pageHarness.calls),[2,3]);
      assert.match(await page.locator('body').innerText(),/Complete takeoff is not verified/);
      assert.deepEqual(errors,[]);await mkdir(path.join(repo,'test-results'),{recursive:true});await page.screenshot({path:path.join(repo,`test-results/page-review-${width}.png`),fullPage:true});await page.close();
    }
    const page=await browser.newPage();await page.goto('http://127.0.0.1:4183/?fail');
    await page.getByRole('button',{name:'Load PDF page inventory'}).click();await page.getByRole('button',{name:'Analyze remaining pages (2)'}).click();await page.getByRole('alert').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.pageHarness.calls),[2]);
    await page.getByText('Needs attention',{exact:true}).waitFor();
    await page.goto('http://127.0.0.1:4183/?customer');await page.waitForTimeout(200);assert.equal(await page.getByRole('region',{name:'Page-by-page AI review'}).count(),0);await page.close();
    console.log('PASS: desktop/mobile sequential pages, no duplicate or replay, saved-page review, error stop and owner-only UI.');
  } finally {await browser.close();}
} finally {await server?.httpServer.close();await rm(root,{recursive:true,force:true});}
