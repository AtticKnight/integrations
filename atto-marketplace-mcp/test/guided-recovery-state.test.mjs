import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {MarketplaceProfileStore} from '../dist/profile-store.js';
import {runGuidedSetup} from '../dist/guided-setup.js';
import {runSetup,unknownSetupOutcome} from '../dist/setup.js';
import {yesNo,menuChoice} from '../dist/terminal-input.js';
import {shellQuote} from '../dist/shell-quote.js';
import {OsSecretStore} from '../../atto-cli/dist/storage/secrets.js';

async function terminal(action){
  const descriptors=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));
  for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
  try{return await action();}
  finally{[process.stdin,process.stderr].forEach((stream,index)=>descriptors[index]?Object.defineProperty(stream,'isTTY',descriptors[index]):delete stream.isTTY);}
}
const saved={profileId:'agent',origin:'https://custom.market.example',audience:"custom-audience's binding",controllerNetwork:'NANO',
  controllerAddress:'nano_1111111111111111111111111111111111111111111111111111hifc8npp',controllerIndex:7,mode:'controller-session'};

for(const state of ['LOGIN_UNKNOWN','LOGIN_SUBMITTING','SCOPED_KEY_UNKNOWN','SCOPED_KEY_SUBMITTING','SCOPED_KEY_CHALLENGE_IN_FLIGHT']){
  test(`${state} guided restart reports exact fresh-profile recovery before prompting or sending`,async t=>terminal(async()=>{
    // Given an uncertain prior request with a custom binding and a colliding suggested retry name.
    const home=await mkdtemp(join(tmpdir(),"marketplace-unknown's-home-"));t.after(()=>rm(home,{recursive:true,force:true}));
    const payload=JSON.stringify(saved),store=await MarketplaceProfileStore.open(home);
    try{store.createSetupState('agent',state,payload);store.createSetupState('agent-retry','LOGIN_READY',payload);}finally{store.close();}
    const originalFetch=globalThis.fetch,originalKeyGet=OsSecretStore.prototype.get;let requests=0,prompts=0,keyReads=0;
    OsSecretStore.prototype.get=async()=>{keyReads++;throw new Error('Unknown recovery must not read keys.');};
    globalThis.fetch=async()=>{requests++;throw new Error('Unknown recovery must not contact Marketplace.');};
    try{
      // When normal guided setup or explicit completion is restarted.
      for(const run of [()=>runGuidedSetup(['--home',home,'--profile','agent'],{},async()=>{prompts++;throw new Error('Unknown recovery must not prompt.');}),
        ()=>runSetup(['--home',home,'--profile','agent','--complete'],{})]){
        await assert.rejects(run,error=>{
          assert.equal(error.code,'SETUP_UNKNOWN');assert.match(error.message,/Check your account sessions/);assert.match(error.message,/will not be replayed/);
          for(const value of [home,'agent-retry-2',saved.origin,saved.audience,saved.controllerNetwork,saved.controllerAddress,String(saved.controllerIndex),saved.mode])assert.ok(error.message.includes(shellQuote(value)),`Missing quoted context ${value}`);
          return true;
        });
      }
    }finally{globalThis.fetch=originalFetch;OsSecretStore.prototype.get=originalKeyGet;}
    // Then no prompt, request, profile creation, or durable uncertain-state change occurs.
    assert.equal(requests,0);assert.equal(prompts,0);assert.equal(keyReads,0);
    const after=await MarketplaceProfileStore.open(home);
    try{assert.deepEqual(after.listProfileIds(),[]);assert.equal(after.getSetupState('agent').state,state);assert.equal(after.getSetupState('agent').privatePayload,payload);assert.equal(after.getSetupState('agent-retry-2'),undefined);}finally{after.close();}
  }));
}

test('unknown scoped-credential guidance retains original public grant terms without replay',async t=>{
  // Given a saved uncertain scoped credential with exact public limits and scopes.
  const home=await mkdtemp(join(tmpdir(),'marketplace-unknown-scoped-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const store=await MarketplaceProfileStore.open(home);
  const credential={name:'Task worker',expiresInDays:30,scopes:['tasks:read','tasks:publish'],publishAttoLimit:'123'};
  try{
    store.createSetupState('agent','SCOPED_KEY_UNKNOWN',JSON.stringify({...saved,mode:'scoped-api-key',credential}));
    // When the existing uncertain state is described for recovery.
    const error=unknownSetupOutcome(store,'agent',home);
    // Then the proposed fresh command preserves all public terms and the original state.
    assert.match(error.message,/sessions and credentials/);
    for(const value of ['--credential-name','Task worker','--expires-in-days','30','--scope','tasks:read','tasks:publish','--publish-atto-limit','123'])assert.ok(error.message.includes(shellQuote(value)));
    assert.equal(store.getSetupState('agent').state,'SCOPED_KEY_UNKNOWN');assert.deepEqual(store.listProfileIds(),[]);
  }finally{store.close();}
});

test('finite choice helpers retry ordinary mistakes and propagate cancellation unchanged',async()=>{
  // Given invalid ordinary answers followed by valid answers, plus a terminal cancellation.
  const choices=['typo','2'],yes=['maybe','yes'];const cancelled=Object.assign(new Error('Terminal closed'),{code:'CANCELLED'});
  // When each finite prompt receives the answers or the terminal error.
  assert.equal(await menuChoice(async()=>choices.shift(),'Wallet: ',['1','2'],'1'),'2');
  assert.equal(await yesNo(async()=>yes.shift(),'Continue?',false),true);
  // Then finite choices recover locally and cancellation is never retried.
  let prompts=0;
  await assert.rejects(menuChoice(async()=>{prompts++;throw cancelled;},'Access: ',['1','2'],'1'),error=>error===cancelled);
  assert.equal(prompts,1);
});


test('unknown existing-profile reauthentication guidance keeps the same profile and journal',async t=>{
  // Given an existing controller profile with uncertain reauthentication and a retained payment handoff.
  const home=await mkdtemp(join(tmpdir(),'marketplace-unknown-reauth-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const store=await MarketplaceProfileStore.open(home);
  try{
    store.createProfile({id:'agent',origin:saved.origin,audience:saved.audience,accountId:'11111111-1111-4111-8111-111111111111',
      agentId:'22222222-2222-4222-8222-222222222222',identityId:'33333333-3333-4333-8333-333333333333',controllerNetwork:saved.controllerNetwork,
      controllerAddress:saved.controllerAddress,controllerIndex:saved.controllerIndex,authMode:'controller-session',accessToken:'fixture-access',
      accessExpiresAt:Date.now()-1000,refreshToken:'fixture-refresh',refreshExpiresAt:Date.now()-500});
    const payload=JSON.stringify({...saved,reauthenticate:true});store.createSetupState('agent','LOGIN_UNKNOWN',payload);
    store.putHandoff('agent','d'.repeat(32),'funding','retained-hash','PENDING','retained native candidate',Date.now()+100000);
    // When uncertain reauthentication is inspected for recovery without another request.
    const error=unknownSetupOutcome(store,'agent',home);
    // Then its exact supported command retains the existing profile and payment journal.
    assert.equal(error.code,'REAUTH_REQUIRED');assert.ok(error.message.includes(`--profile ${shellQuote('agent')} --reauthenticate`));
    assert.ok(error.message.includes(`--home ${shellQuote(home)}`));assert.doesNotMatch(error.message,/agent-retry/);
    assert.deepEqual(store.listProfileIds(),['agent']);assert.equal(store.getSetupState('agent').privatePayload,payload);
    assert.equal(store.getHandoff('agent','d'.repeat(32)).privatePayload,'retained native candidate');
  }finally{store.close();}
});

for(const full of [false,true])test(`completed Atto profile with a Nano ${full?'zero-cap receiving grant':'Login-only grant'} reports public access with a locked keyring`,async t=>terminal(async()=>{
  // Given a completed Atto profile and an independently selected shared-recovery Nano wallet.
  const {AttoApplication}=await import('../../atto-cli/dist/application/app.js');
  const {provisionNanoWallet,loadConfiguration}=await import('@attocash/atto-marketplace-nano-adapter');
  const {saveWalletSelection}=await import('../dist/wallet-preferences.js');
  const home=await mkdtemp(join(tmpdir(),'marketplace-public-nano-ready-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const phrase=`${'abandon '.repeat(23)}art`,source=join(home,'wallets','atto'),directory=join(home,'wallets','nano');
  const app=new AttoApplication({directory:source,secrets:{get:async()=>phrase,set:async()=>{}}});
  try{await app.createWallet(phrase);}finally{await app.close();}
  const originalGet=OsSecretStore.prototype.get;
  OsSecretStore.prototype.get=async()=>phrase;
  try{await provisionNanoWallet({dataDir:directory,recoveryWalletDirectory:source,derivationIndex:0,network:'nano:dev',rpcUrl:'http://localhost:17076',origin:saved.origin,
    audience:saved.audience,grants:{externalTransfers:full,controllerPurposes:[]},limits:{maxPaymentAtomic:'0',rolling24hAtomic:'0'},terminalConfirmed:true});}
  finally{OsSecretStore.prototype.get=originalGet;}
  await saveWalletSelection(home,{nanoDirectory:directory});
  const store=await MarketplaceProfileStore.open(home);
  try{store.createProfile({id:'agent',origin:saved.origin,audience:saved.audience,accountId:'11111111-1111-4111-8111-111111111111',agentId:'22222222-2222-4222-8222-222222222222',identityId:'33333333-3333-4333-8333-333333333333',
    controllerNetwork:'ATTO',controllerAddress:'atto://adxseu7ne6h3h5avlrmapalc6qw2dsygbungfscakf6re44prhufjy7syamqo',controllerIndex:0,authMode:'controller-session',accessToken:'fixture-access',refreshToken:'fixture-refresh',accessExpiresAt:Date.now()+120000,refreshExpiresAt:Date.now()+240000});}
  finally{store.close();}
  const before=loadConfiguration(directory),originalFetch=globalThis.fetch,originalWrite=process.stdout.write;let keyReads=0,requests=0,output='';
  OsSecretStore.prototype.get=async()=>{keyReads++;throw new Error('Fixture keyring is locked');};globalThis.fetch=async()=>{requests++;throw new Error('Completed setup must not fetch.');};
  process.stdout.write=(chunk,...rest)=>{if(typeof chunk!=='string')return originalWrite.call(process.stdout,chunk,...rest);output+=chunk;return true;};
  try{
    // When completed setup is repeated to obtain its public access summary.
    await runGuidedSetup(['--home',home,'--profile','agent','--json'],{},async()=>assert.fail('Completed setup must not prompt.'));
    // Then the summary reads no private key and accurately preserves the zero-cap receiving grant.
    assert.equal(keyReads,0);assert.equal(requests,0);
    assert.equal(JSON.parse(output.trim()).access.XNO,full?'Receiving allowed; sending blocked by saved zero limits':'Login only');
    assert.deepEqual(loadConfiguration(directory),before);
  }finally{OsSecretStore.prototype.get=originalGet;globalThis.fetch=originalFetch;process.stdout.write=originalWrite;}
}));
