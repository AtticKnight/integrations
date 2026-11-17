import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from '../../test/support/temporary-directory.mjs';

const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const cliDirectory=process.env.ATTO_TEST_CLI_PACKAGE_DIR??fileURLToPath(new URL('../',import.meta.resolve('@attocash/cli/core')));
const {AttoApplication}=await import(pathToFileURL(join(cliDirectory,'dist/application/app.js')));
const {StateStore}=await import(pathToFileURL(join(cliDirectory,'dist/storage/state.js')));
const {SpendLedger}=await import(pathToFileURL(join(cliDirectory,'dist/spending/ledger.js')));
const {OsSecretStore}=await import(pathToFileURL(join(cliDirectory,'dist/storage/secrets.js')));
const {inspectMarketplaceWalletSetup}=await import(pathToFileURL(join(cliDirectory,'dist/internal-marketplace.js')));
const {prepareAttoWalletInteractive,setupAttoWalletInteractive}=await import(pathToFileURL(join(packageDirectory,'dist/atto-setup.js')));
const {runWalletWizard}=await import(pathToFileURL(join(packageDirectory,'dist/guided-setup.js')));
const {selectedAttoWallet}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-access.js')));
const {readWalletSelection,saveWalletSelection}=await import(pathToFileURL(join(packageDirectory,'dist/wallet-preferences.js')));
const phrase=`${'abandon '.repeat(23)}art`;
const bounded={perRequest:{amount:'100',unit:'ATTO'},rolling:[{days:1,amount:'1000',unit:'ATTO'}]};
const unlimited={perRequest:null,rolling:[]};
const approval=/^Type APPROVE to save this Marketplace wallet setup: /;

async function terminal(action){
  const descriptors=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));
  for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
  const originalOut=process.stdout.write,originalError=process.stderr.write;
  let stdout='',stderr='';
  process.stdout.write=(chunk,...rest)=>{if(typeof chunk!=='string')return originalOut.call(process.stdout,chunk,...rest);stdout+=chunk;return true;};
  process.stderr.write=(chunk,...rest)=>{if(typeof chunk!=='string')return originalError.call(process.stderr,chunk,...rest);stderr+=chunk;return true;};
  try{return {result:await action(),stdout,stderr};}
  finally{
    process.stdout.write=originalOut;process.stderr.write=originalError;
    [process.stdin,process.stderr].forEach((stream,index)=>descriptors[index]?Object.defineProperty(stream,'isTTY',descriptors[index]):delete stream.isTTY);
  }
}

async function initializeFixtureWallet(directory,{access='spend',policy=bounded,pool=[0,1],messageSigningIndexes=[]}={}){
  const app=new AttoApplication({directory,secrets:{get:async()=>phrase,set:async()=>{},remove:async()=>{}}});
  try{
    // Synthetic recovery is fixture-only; compact preparation has no credential adapter.
    await app.createWallet(phrase);
    for(const index of [1,7])await app.call('address_derive',{index});
    const status=await app.call('wallet_status');
    app.store.set('settings',{...status.settings,network:'LOCAL',nodeUrl:'http://127.0.0.1:41234',workerUrl:'http://127.0.0.1:41235',autoReceive:false});
    app.ledger.reserve({id:'retained-reservation',index:0,destination:status.identity.address,raw:'1000',network:'LOCAL',createdAt:Date.now()});
    app.ledger.setPolicy(policy);app.store.set('spending.mcpAccess',access);
    app.store.set('spending.pool',{indexes:pool,consolidate:true});app.store.set('signing.messageIndexes',messageSigningIndexes);
  }finally{await app.close();}
}

async function fixture(t,configuration={}){
  const root=await mkdtemp(join(tmpdir(),'marketplace-compact-atto-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'marketplace'),directory=join(root,'existing-cli');await mkdir(home,{mode:0o700});
  await initializeFixtureWallet(directory,configuration);
  async function state(action){const store=new StateStore(directory);try{return await action(store);}finally{store.close();}}
  return {home,directory,env:{MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR:directory},
    snapshot:(index=0)=>inspectMarketplaceWalletSetup({directory,index}),rows:()=>state(store=>store.entries('')),
    journal:()=>state(store=>store.get('spending.records')),
    mutate:action=>state(store=>store.withWalletLock(async()=>action(store)))};
}

function interaction(steps){
  const questions=[];
  return {questions,prompt:async question=>{
    questions.push(question);const step=steps.shift();assert.ok(step,`Unexpected prompt: ${question}`);assert.match(question,step[0]);
    return typeof step[1]==='function'?step[1](question):step[1];
  },done:()=>assert.equal(steps.length,0,'Expected every workflow decision to be reached')};
}

async function pendingPayment(f,overrides={}){
  const before=await f.snapshot();
  return f.mutate(store=>new SpendLedger(store).proposePolicy(
    overrides.policy??{perRequest:{amount:'7',unit:'ATTO'},rolling:[{days:2,amount:'11',unit:'ATTO'}]},overrides.access??'spend',
    {directory:f.directory,walletFingerprint:before.fingerprint,network:before.settings.network},
    overrides.pool??before.pool,overrides.messageSigningIndexes??before.messageSigningIndexes));
}

for(const [choice,mode] of [['1','login-only'],['2','limited'],['3','unlimited']])test(`preparing ${mode} preserves native and Marketplace state`,async t=>terminal(async()=>{
  // Given read-only authority, saved bounded caps, a journal and no Marketplace selection.
  const f=await fixture(t,{access:'read-only'}),before=await f.snapshot(),rows=await f.rows();
  for(const method of ['get','set','remove'])t.mock.method(OsSecretStore.prototype,method,()=>{throw new Error('Preparation cannot use credentials');});
  t.mock.method(globalThis,'fetch',()=>{throw new Error('Preparation cannot use networking');});
  const script=interaction([[/^Atto access:.*Login only.*Limited spending.*Unlimited spending/,choice]]);
  // When source/mode questions return a deferred plan before the caller's final approval.
  const plan=await prepareAttoWalletInteractive({...f,prompt:script.prompt});await plan.validate();
  // Then preparation returns public review/intent without approving native authority or saving selection.
  script.done();assert.equal(script.questions.length,1);assert.equal(plan.mode,mode);
  assert.deepEqual(await f.rows(),rows);assert.equal(readWalletSelection(f.home),undefined);
  assert.ok(plan.review.includes(before.address));assert.match(plan.review,/Account index: 0 \| Network: atto:local/);
  assert.match(plan.review,new RegExp(`Marketplace payments for selected account 0: denied → ${mode==='login-only'?'denied':'allowed'}`));
  for(const value of [before.fingerprint,before.settings.nodeUrl,before.settings.workerUrl,phrase])assert.equal(plan.review.includes(value),false);
  assert.doesNotMatch(plan.review,/"policy"|messageSigningIndexes|walletFingerprint|\[\]/);assert.equal(JSON.stringify(plan.intent).includes(phrase),false);
  if(mode==='unlimited')assert.match(plan.review,/including future deposits/);
}));

for(const [choice,mode] of [['','login-only'],['2','limited'],['3','unlimited']])test(`standalone ${mode} uses exactly one final typed approval`,async t=>terminal(async()=>{
  // Given an unbounded read-only wallet with retained shared payment history.
  const f=await fixture(t,{access:'read-only',policy:unlimited}),before=await f.snapshot(),journal=await f.journal();
  const script=interaction([[/^Atto access:.*Login only \(default\)/,choice],
    ...(mode==='limited'?[[/^Maximum ATTO per payment/,'3'],[/^Maximum ATTO across/,'8']]:[]),[approval,'APPROVE']]);
  // When the one combined wallet review is approved.
  const wallet=await setupAttoWalletInteractive({...f,prompt:script.prompt});
  // Then the exact policy and narrow grant are saved with no separate native yes or grant approval.
  script.done();assert.equal(script.questions.filter(question=>question.startsWith('Type ')).length,1);
  assert.equal(wallet.address,before.address);assert.equal(wallet.index,0);
  const after=await f.snapshot();assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,mode!=='login-only');
  assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.pool,before.pool);
  assert.deepEqual(after.messageSigningIndexes,before.messageSigningIndexes);assert.deepEqual(await f.journal(),journal);
  if(mode==='login-only')assert.deepEqual(after,before);
  else{assert.equal(after.access,'spend');assert.deepEqual(after.policy,mode==='unlimited'?unlimited:{perRequest:{amount:'3',unit:'ATTO'},rolling:[{days:1,amount:'8',unit:'ATTO'}]});}
}));

test('ordinary discovery shows its source choice while an explicit directory skips technical questions',async t=>terminal(async()=>{
  // Given a selected existing wallet supplied through the ordinary environment.
  const f=await fixture(t),before=await f.snapshot();
  const script=interaction([[/^Atto wallet source: \[1\] Continue selected wallet \(default\)/,''],[/^Atto access:/,'1'],[approval,'APPROVE']]);
  // When setup discovers its source instead of receiving an explicit directory option.
  const wallet=await setupAttoWalletInteractive({home:f.home,env:f.env,prompt:script.prompt});
  // Then the source is explicitly chosen once and basic setup asks no path/index/REUSE or endpoint questions.
  script.done();assert.equal(wallet.directory,f.directory);assert.deepEqual(await f.snapshot(),before);
  assert.doesNotMatch(script.questions.join('\n'),/controller account index|Type REUSE|node URL|work-service URL/);
}));

test('an interrupted managed alternate is explicitly rediscovered without recreating keys or changing the original wallet',async t=>terminal(async()=>{
  // Given the original external wallet and a managed alternate created before an earlier interruption.
  const f=await fixture(t),originalRows=await f.rows(),alternate=join(f.home,'wallets','atto-import-2');
  await initializeFixtureWallet(alternate,{access:'read-only',policy:unlimited});
  const alternateBefore=await inspectMarketplaceWalletSetup({directory:alternate,index:0});
  const cancelled=Object.assign(new Error('Synthetic cap cancellation'),{code:'CANCELLED'});
  for(const method of ['get','set','remove'])t.mock.method(OsSecretStore.prototype,method,()=>{throw new Error('Continuing recovery cannot access keys');});
  t.mock.method(AttoApplication.prototype,'createWallet',()=>{throw new Error('Continuing recovery cannot recreate a wallet');});
  const choosePrepared=question=>{
    const match=question.match(/\[([0-9]+)\] Continue prepared Atto wallet/);assert.ok(match,'Prepared alternate must be offered explicitly');return match[1];
  };
  const first=interaction([[/^Atto wallet source:/,choosePrepared],[/^Atto access:/,'2'],[/^Maximum ATTO per payment/,()=>{throw cancelled;}]]);
  // When Limited preparation is cancelled and ordinary discovery is run again.
  await assert.rejects(prepareAttoWalletInteractive({home:f.home,env:f.env,prompt:first.prompt}),failure=>failure===cancelled);
  const second=interaction([[/^Atto wallet source:/,choosePrepared],[/^Atto access:/,'2'],[/^Maximum ATTO per payment/,'3'],[/^Maximum ATTO across/,'8']]);
  const plan=await prepareAttoWalletInteractive({home:f.home,env:f.env,prompt:second.prompt});await plan.validate();
  // Then the same alternate is continued without hidden replacement and the original external wallet remains unchanged.
  first.done();second.done();assert.equal(plan.wallet.directory,alternate);assert.equal(plan.wallet.address,alternateBefore.address);
  assert.deepEqual(await inspectMarketplaceWalletSetup({directory:alternate,index:0}),alternateBefore);
  assert.deepEqual(await f.rows(),originalRows);assert.equal(readWalletSelection(f.home),undefined);
}));

for(const mode of ['1','2','3'])test(`declining access choice ${mode} preserves all rows and the absent Marketplace grant`,async t=>terminal(async()=>{
  // Given read-only authority and no Marketplace selection.
  const f=await fixture(t,{access:'read-only'}),rows=await f.rows(),script=interaction([[/^Atto access:/,mode],[approval,'NO']]);
  // When the only final wallet approval is declined.
  await assert.rejects(setupAttoWalletInteractive({...f,prompt:script.prompt}),{code:'APPROVAL_DECLINED'});
  // Then authority, proposal, financial journal and selection remain untouched.
  script.done();assert.deepEqual(await f.rows(),rows);assert.equal(readWalletSelection(f.home),undefined);
}));

test('Limited retains intentional zero caps and authorizes receiving without widening the send policy',async t=>terminal(async()=>{
  // Given effective spend access with a finite zero cap that intentionally blocks sends.
  const f=await fixture(t,{policy:{perRequest:{amount:'0',unit:'ATTO'},rolling:[]}}),before=await f.snapshot();
  const script=interaction([[/^Atto access:/,'2'],[approval,'APPROVE']]);
  // When Limited is selected under these saved terms.
  await setupAttoWalletInteractive({...f,prompt:script.prompt});
  // Then no caps are recollected, receiving has its narrow grant, and the ledger still blocks sends.
  script.done();assert.deepEqual(await f.snapshot(),before);const app=new AttoApplication({directory:f.directory});
  try{assert.deepEqual(selectedAttoWallet({...f.env,MARKETPLACE_MCP_HOME:f.home},await app.call('wallet_status')).permissions,{externalTransfers:true,receive:true});
    assert.throws(()=>app.ledger.assertCanReserve('1'),{code:'SPENDING_LIMIT'});}finally{await app.close();}
}));

test('selected nonzero activation reviews the full preserved pool and generic signing without changing journals',async t=>{
  // Given selected account 7, read-only pool [0,7] and saved generic signing for [1,7].
  let selected;
  const output=await terminal(async()=>{
    const f=await fixture(t,{access:'read-only',pool:[0,7],messageSigningIndexes:[1,7]});selected=await f.snapshot(7);const journal=await f.journal();
    await saveWalletSelection(f.home,{attoDirectory:f.directory,attoAccess:{address:selected.address,index:7,network:selected.network,fingerprint:selected.fingerprint,externalTransfers:false}});
    const script=interaction([[/^Atto access:/,'2'],[approval,'APPROVE']]);
    // When one combined wallet approval enables native spend and the selected-account Marketplace grant.
    const wallet=await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then saved index, policy, pool, consolidation, generic grants and history are preserved.
    script.done();const after=await f.snapshot(7);assert.equal(wallet.index,7);assert.equal(after.access,'spend');
    for(const key of ['pool','policy','messageSigningIndexes','settings','identity','addresses'])assert.deepEqual(after[key],selected[key]);
    assert.deepEqual(await f.journal(),journal);assert.equal(readWalletSelection(f.home).attoAccess.index,7);
  });
  assert.ok(output.stderr.includes(selected.address));assert.match(output.stderr,/Native payments become enabled for pool indexes 0, 7; consolidation enabled/);
  assert.match(output.stderr,/generic message signing becomes available for account indexes 1, 7/);
  assert.doesNotMatch(output.stderr,/Payment pool: indexes|Type yes|walletFingerprint/);
});

test('compatible pending Limited terms resume their exact identity and expiry without recollecting caps',async t=>terminal(async()=>{
  // Given a pending native request with deliberate pool/consolidation changes.
  const f=await fixture(t,{access:'read-only'}),proposal=await pendingPayment(f,{pool:{indexes:[0],consolidate:false}}),rows=await f.rows();
  const script=interaction([[/^Atto access:/,'2']]);
  // When preparation returns its exact review and the caller commits after combined consent.
  const plan=await prepareAttoWalletInteractive({...f,prompt:script.prompt});assert.deepEqual(await f.rows(),rows);
  assert.match(plan.review,/Per payment: 7 ATTO; rolling: 11 ATTO \/ 2 days/);assert.match(plan.review,/indexes 0, 1 → 0; consolidation enabled → disabled/);
  assert.ok(plan.review.includes(new Date(proposal.expiresAt).toISOString()));await plan.validate();await plan.commit();await plan.saveSelection(undefined);
  // Then no replacement ID, renewed expiry or additional native approval appears.
  script.done();const after=await f.snapshot();assert.equal(after.proposal.id,proposal.id);assert.equal(after.proposal.expiresAt,proposal.expiresAt);
  assert.equal(after.proposal.status,'approved');assert.deepEqual(after.policy,proposal.policy);assert.deepEqual(after.pool,proposal.pool);
}));

test('incompatible pending replacement is disclosed before the sole final approval',async t=>{
  // Given pending terms asking for generic signing absent from active authority.
  let proposal;
  const output=await terminal(async()=>{
    const f=await fixture(t,{access:'read-only'});proposal=await pendingPayment(f,{messageSigningIndexes:[1]});const before=await f.snapshot(),rows=await f.rows();
    const script=interaction([[/^Atto access:/,'3'],[approval,async()=>{assert.deepEqual(await f.rows(),rows);return 'APPROVE';}]]);
    // When Unlimited explicitly replaces the old pending terms through its combined final review.
    await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then replacement preserves the current pool and signing grants.
    script.done();const after=await f.snapshot();assert.notEqual(after.proposal.id,proposal.id);
    assert.deepEqual(after.policy,unlimited);assert.deepEqual(after.pool,before.pool);assert.deepEqual(after.messageSigningIndexes,before.messageSigningIndexes);
  });
  assert.match(output.stderr,/replaces the existing pending native settings only after approval/);
  assert.match(output.stderr,/Pending native settings to replace: access spend; Per payment: 7 ATTO; rolling: 11 ATTO \/ 2 days/);
  assert.match(output.stderr,/Pending generic message signing indexes to replace: 1/);
  assert.ok(output.stderr.includes(new Date(proposal.expiresAt).toISOString()));assert.equal(output.stderr.includes(proposal.id),false);
});

for(const changed of ['settings','proposal','selection'])test(`changed ${changed} during final review rejects authority before commit`,async t=>terminal(async()=>{
  // Given a reviewed native change and no Marketplace selection.
  const f=await fixture(t,{access:'read-only'});let concurrentRows;
  const script=interaction([[/^Atto access:/,'3'],[approval,async()=>{
    if(changed==='selection')await saveWalletSelection(f.home,{attoDirectory:f.directory});
    else if(changed==='proposal')await pendingPayment(f);
    else await f.mutate(store=>store.set('settings',{...store.get('settings'),workerUrl:'http://127.0.0.1:49999'}));
    concurrentRows=await f.rows();return 'APPROVE';
  }]]);
  // When another owner changes the reviewed wallet or selection before consent is applied.
  await assert.rejects(setupAttoWalletInteractive({...f,prompt:script.prompt}),{code:changed==='selection'?'WALLET_CONFIGURATION_CHANGED':'PROPOSAL_STALE'});
  // Then no new spend/grant overwrites the newer state.
  script.done();assert.deepEqual(await f.rows(),concurrentRows);assert.equal((await f.snapshot()).access,'read-only');assert.equal(readWalletSelection(f.home)?.attoAccess,undefined);
}));

test('native approval survives a later Marketplace selection CAS failure',async t=>terminal(async()=>{
  // Given committed native authority followed by another writer selecting the wallet.
  const f=await fixture(t,{access:'read-only'}),script=interaction([[/^Atto access:/,'2']]);
  const plan=await prepareAttoWalletInteractive({...f,prompt:script.prompt});await plan.validate();await plan.commit();const committed=await f.snapshot();
  await saveWalletSelection(f.home,{attoDirectory:f.directory});const concurrent=readWalletSelection(f.home);
  // When the caller saves using its previously absent selection snapshot.
  await assert.rejects(plan.saveSelection(undefined),{code:'WALLET_CONFIGURATION_CHANGED'});
  // Then approved native state persists while the newer selection remains without a payment grant.
  script.done();assert.equal(committed.access,'spend');assert.deepEqual(await f.snapshot(),committed);assert.deepEqual(readWalletSelection(f.home),concurrent);assert.equal(concurrent.attoAccess,undefined);
}));

test('Marketplace selection cannot be saved before the reviewed native commit',async t=>terminal(async()=>{
  // Given an uncommitted native plan without final caller consent.
  const f=await fixture(t,{access:'read-only'}),rows=await f.rows(),script=interaction([[/^Atto access:/,'2']]);const plan=await prepareAttoWalletInteractive({...f,prompt:script.prompt});
  // When a caller skips native commit and tries to publish its narrow grant.
  await assert.rejects(plan.saveSelection(undefined),{code:'WALLET_CONSENT_REQUIRED'});
  // Then neither store gains authority or a pending proposal.
  script.done();assert.deepEqual(await f.rows(),rows);assert.equal(readWalletSelection(f.home),undefined);
}));

for(const cap of ['per-payment','rolling'])test(`invalid ${cap} caps are corrected locally before final approval`,async t=>{
  // Given an unbounded read-only wallet and invalid empty, zero, precision and range answers.
  const output=await terminal(async()=>{
    const f=await fixture(t,{access:'read-only',policy:unlimited}),rows=await f.rows();
    const invalid=['','0','word','1.0000000001','9'.repeat(100)],pattern=cap==='per-payment'?/^Maximum ATTO per payment/:/^Maximum ATTO across/;
    const script=interaction([[/^Atto access:/,'2'],...(cap==='rolling'?[[/^Maximum ATTO per payment/,'3']]:[]),
      ...invalid.map(value=>[pattern,async()=>{assert.deepEqual(await f.rows(),rows);return value;}]),[pattern,cap==='per-payment'?'3':'8'],
      ...(cap==='per-payment'?[[/^Maximum ATTO across/,'8']]:[]),[approval,'APPROVE']]);
    // When each invalid answer is corrected within its original cap question.
    await setupAttoWalletInteractive({...f,prompt:script.prompt});
    // Then both exact caps are committed once and no authority changed during correction.
    script.done();assert.deepEqual((await f.snapshot()).policy,{perRequest:{amount:'3',unit:'ATTO'},rolling:[{days:1,amount:'8',unit:'ATTO'}]});
    assert.equal(script.questions.filter(question=>question.startsWith('Type ')).length,1);
    if(cap==='rolling')assert.equal(script.questions.filter(question=>/^Maximum ATTO per payment/.test(question)).length,1);
  });
  assert.equal((output.stderr.match(/Enter an ATTO amount greater than zero, with up to 9 decimal places\./g)||[]).length,5);
});

for(const code of ['CANCELLED','ERR_USE_AFTER_CLOSE'])test(`cap correction propagates terminal ${code} without mutation`,async t=>terminal(async()=>{
  // Given invalid input followed by cancellation or EOF while correcting that cap.
  const f=await fixture(t,{access:'read-only',policy:unlimited}),rows=await f.rows(),error=Object.assign(new Error('Synthetic terminal ended'),{code});
  const script=interaction([[/^Atto access:/,'2'],[/^Maximum ATTO per payment/,'0'],[/^Maximum ATTO per payment/,()=>{throw error;}]]);
  // When the prompt itself fails after a known pure validation failure.
  await assert.rejects(prepareAttoWalletInteractive({...f,prompt:script.prompt}),failure=>failure===error);
  // Then terminal failure is propagated without retrying or changing authority/proposals/selection.
  script.done();assert.deepEqual(await f.rows(),rows);assert.equal(readWalletSelection(f.home),undefined);
}));

test('public saved intent rebuilds an interrupted Limited review without repeating caps or choices',async t=>terminal(async()=>{
  // Given an uncommitted plan with explicit caps and a serialized public descriptor.
  const f=await fixture(t,{access:'read-only',policy:unlimited}),rows=await f.rows();
  const script=interaction([[/^Atto access:/,'2'],[/^Maximum ATTO per payment/,'3'],[/^Maximum ATTO across/,'8']]);
  const first=await prepareAttoWalletInteractive({...f,prompt:script.prompt}),resumeIntent=JSON.parse(JSON.stringify(first.intent));
  // When recovery rebuilds its review before a fresh combined final approval.
  const resumed=await prepareAttoWalletInteractive({home:f.home,env:{},resumeIntent,prompt:async question=>assert.fail(`Recovery must not repeat ${question}`)});await resumed.validate();
  // Then the same chosen terms are reviewed again read-only and still require commit before selection.
  script.done();assert.equal(resumed.review,first.review);assert.deepEqual(await f.rows(),rows);assert.equal(readWalletSelection(f.home),undefined);
  await resumed.commit();await resumed.saveSelection(undefined);assert.deepEqual((await f.snapshot()).policy,resumeIntent.policy);
}));

for(const changed of ['fingerprint','network','address'])test(`mismatched saved ${changed} defaults to Login only`,async t=>terminal(async()=>{
  // Given grants whose identity binding differs from the selected wallet.
  const f=await fixture(t),before=await f.snapshot(),other=await f.snapshot(1);
  const access={address:before.address,index:0,network:before.network,fingerprint:before.fingerprint,externalTransfers:true};
  access[changed]=changed==='fingerprint'?'ab'.repeat(32):changed==='network'?'atto:beta':other.address;
  await saveWalletSelection(f.home,{attoDirectory:f.directory,attoAccess:access});const script=interaction([[/^Atto access:.*Login only \(default\)/,''],[approval,'APPROVE']]);
  // When the current source is reviewed under its corrected default.
  await setupAttoWalletInteractive({...f,prompt:script.prompt});
  // Then stale grants cannot carry payment access across the changed binding.
  script.done();assert.deepEqual(await f.snapshot(),before);assert.equal(readWalletSelection(f.home).attoAccess.externalTransfers,false);
}));

test('--advanced remains reachable for explicit native account and pool setup',async t=>terminal(async()=>{
  // Given an existing CLI wallet selected through the normal environment.
  const f=await fixture(t),rows=await f.rows(),script=interaction([[/^Atto wallet:/,''],[/^Atto controller account index/,'0'],[/^Type REUSE/,'NO']]);
  // When advanced setup is requested and its explicit existing-wallet reuse is declined.
  await assert.rejects(runWalletWizard(['--home',f.home,'--asset','ATTO','--advanced'],f.env,script.prompt),{code:'CANCELLED'});
  // Then the advanced path remains separate from the basic mode choice and changes no authority.
  script.done();assert.deepEqual(await f.rows(),rows);assert.equal(readWalletSelection(f.home),undefined);
}));
