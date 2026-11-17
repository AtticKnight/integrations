import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {AttoPrivateKey} from '@attocash/commons-core';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {MarketplaceProfileStore} from '../dist/profile-store.js';
import {runSetup,expiredUnsignedLoginApproval} from '../dist/setup.js';
import {runGuidedSetup} from '../dist/guided-setup.js';
import {approveMarketplaceController} from '../dist/approval-terminal.js';
import {writeApprovalRequest,approvalRequestPath,approvalResponsePath,approvalRequestDigest} from '../dist/approval-files.js';
import {OsSecretStore} from '../../atto-cli/dist/storage/secrets.js';

const signer=await AttoPrivateKey.Companion.parse('01'.repeat(32)).toSigner(),address=signer.address.toString();
const accountId='11111111-1111-4111-8111-111111111111',identityId='33333333-3333-4333-8333-333333333333';
const origin='https://custom.market.example',audience='custom-expiry-audience';
function challenge({expired=false,account=accountId,identity=identityId,network='live'}={}){
  const challengeId=randomUUID(),issuedAt=new Date(Date.now()-(expired?10000:1000)).toISOString(),expiresAt=new Date(Date.now()+(expired?-1000:120000)).toISOString();
  const binding=createHash('sha256').update(['marketplace-login-v1',account,identity].join('\n')).digest('hex');
  return {challengeId,accountId:account,controllerId:identity,issuedAt,expiresAt,
    message:`Marketplace Agent Controller Proof v1\nAudience: ${audience}\nNetwork: ${network}\nAddress: ${address}\nPurpose: login\nRequest ID: ${challengeId}\nBinding Hash: ${binding}\nNonce: ${'a'.repeat(64)}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`};
}
async function fixture(t,{expired=true,mode='controller-session'}={}){
  const home=await mkdtemp(join(tmpdir(),'marketplace-expired-login-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const oldChallenge=challenge({expired}),handoffId='a'.repeat(32);
  const request={version:1,type:'marketplace-controller-approval-request',profileId:'agent',handoffId,marketplaceOrigin:origin,transport:'AGENT_API',proofOrigin:null,audience,
    accountId,identityId,controller:{network:'ATTO',address,index:7},purpose:'login',action:{kind:'login',network:'ATTO',address},
    challenge:{challengeId:oldChallenge.challengeId,message:oldChallenge.message,issuedAt:oldChallenge.issuedAt,expiresAt:oldChallenge.expiresAt}};
  const saved={profileId:'agent',origin,audience,controllerNetwork:'ATTO',controllerAddress:address,controllerIndex:7,mode,challenge:oldChallenge,request,
    ...(mode==='scoped-api-key'?{credential:{name:'Worker',expiresInDays:30,scopes:['tasks:read']}}:{})};
  const payload=JSON.stringify(saved),store=await MarketplaceProfileStore.open(home);
  try{store.createSetupState('agent','LOGIN_APPROVAL',payload);}finally{store.close();}
  await writeApprovalRequest(home,'agent',handoffId,request);
  return {home,saved,request,payload,async state(){const store=await MarketplaceProfileStore.open(home);try{return store.getSetupState('agent');}finally{store.close();}}};
}
async function signedResponse(f,request=f.request){
  const signature=(await signer.signMessage(Int8Array.from(Buffer.from(request.challenge.message,'utf8')))).toString();
  const response={version:1,type:'marketplace-controller-approval-response',profileId:'agent',handoffId:request.handoffId,requestDigest:approvalRequestDigest(request),
    challengeId:request.challenge.challengeId,message:request.challenge.message,signature,controllerAddress:address,controllerIndex:7};
  await writeFile(approvalResponsePath(f.home,'agent',request.handoffId),JSON.stringify(response)+'\n',{mode:0o600});return response;
}
async function capture(action){let output='';const original=process.stdout.write;process.stdout.write=(chunk,...rest)=>{if(typeof chunk!=='string')return original.call(process.stdout,chunk,...rest);output+=chunk;return true;};try{await action();return output;}finally{process.stdout.write=original;}}
async function terminal(action){const saved=[process.stdin,process.stderr].map(stream=>Object.getOwnPropertyDescriptor(stream,'isTTY'));for(const stream of [process.stdin,process.stderr])Object.defineProperty(stream,'isTTY',{configurable:true,value:true});try{return await action();}finally{[process.stdin,process.stderr].forEach((stream,i)=>saved[i]?Object.defineProperty(stream,'isTTY',saved[i]):delete stream.isTTY);}}
async function guarded(action,fetcher){
  const originalFetch=globalThis.fetch,originalGet=OsSecretStore.prototype.get;let keys=0;const calls=[];
  OsSecretStore.prototype.get=async()=>{keys++;throw new Error('Locked fixture keyring');};
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return fetcher?fetcher(url,options):new Response(JSON.stringify(challenge()),{status:200});};
  try{await action(calls);assert.equal(keys,0);}finally{globalThis.fetch=originalFetch;OsSecretStore.prototype.get=originalGet;}
}

test('explicit unsigned expiry refresh preserves pins/spec and requires a new immutable exact approval',async t=>{
  // Given a valid expired unsigned login with a custom binding, nonzero account and scoped specification.
  const f=await fixture(t,{mode:'scoped-api-key'}),oldBytes=await readFile(approvalRequestPath(f.home,'agent',f.request.handoffId));
  await guarded(async calls=>{
    // When explicit completion requests the fresh public challenge.
    const output=JSON.parse((await capture(()=>runSetup(['--profile','agent','--home',f.home,'--complete','--json'],{}))).trim());
    // Then only the fresh challenge was requested, and a fresh immutable handoff preserves original setup intent.
    assert.equal(output.status,'approval_required');assert.notEqual(output.handoffId,f.request.handoffId);assert.equal(calls.length,1);
    assert.equal(calls[0].url,origin+'/v1/agent/auth/challenges');assert.deepEqual(calls[0].body,{network:'ATTO',address});
    const current=await f.state(),saved=JSON.parse(current.privatePayload);assert.equal(current.state,'LOGIN_APPROVAL');
    for(const key of ['profileId','origin','audience','controllerNetwork','controllerAddress','controllerIndex','mode','credential'])assert.deepEqual(saved[key],f.saved[key]);
    assert.equal(saved.request.handoffId,output.handoffId);assert.notEqual(saved.challenge.challengeId,f.saved.challenge.challengeId);
    assert.deepEqual(await readFile(approvalRequestPath(f.home,'agent',f.request.handoffId)),oldBytes);
    assert.ok((await readdir(join(f.home,'approvals','agent'))).includes(output.handoffId+'.request.json'));
  });
});

test('guided refresh decline preserves the exact old row/files with no request, key read or ordinary resume question',async t=>terminal(async()=>{
  // Given the expired unsigned handoff and no response file.
  const f=await fixture(t),oldBytes=await readFile(approvalRequestPath(f.home,'agent',f.request.handoffId));let prompts=0;
  await guarded(async calls=>{
    // When the expiry-specific refresh question is declined.
    await assert.rejects(runGuidedSetup(['--profile','agent','--home',f.home],{},async question=>{prompts++;assert.match(question,/^The login approval expired\. Request a fresh approval for this wallet\?/);return 'no';}),{code:'CANCELLED'});
    // Then the original intent is unchanged and no challenge/session/key operation occurs.
    assert.equal(prompts,1);assert.equal(calls.length,0);assert.deepEqual(await f.state(),{state:'LOGIN_APPROVAL',privatePayload:f.payload});
    assert.deepEqual(await readFile(approvalRequestPath(f.home,'agent',f.request.handoffId)),oldBytes);
  });
}));

for(const failure of ['fetch','account','identity','network'])test(`refresh ${failure} failure leaves the expired intent unchanged`,async t=>{
  // Given a validated unsigned expiry and a failed or differently pinned fresh challenge.
  const f=await fixture(t);
  await guarded(async calls=>{
    // When refresh obtains that result.
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),{code:failure==='fetch'?'SETUP_NETWORK':'PROFILE_CONFLICT'});
    // Then original setup and pins survive with no submission.
    assert.equal(calls.length,1);assert.deepEqual(await f.state(),{state:'LOGIN_APPROVAL',privatePayload:f.payload});
  },async()=>{if(failure==='fetch')throw new Error('offline fixture');return new Response(JSON.stringify(challenge({...(failure==='account'?{account:randomUUID()}:{}),...(failure==='identity'?{identity:randomUUID()}:{}),...(failure==='network'?{network:'dev'}:{})})),{status:200});});
});

test('an old response appearing during challenge fetch blocks refresh installation and is preserved',async t=>{
  // Given an unsigned expired login while another terminal finishes its old immutable response.
  const f=await fixture(t);let response;
  await guarded(async calls=>{
    // When the old response is published while refresh awaits the challenge.
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),{code:'SETUP_BUSY'});
    // Then the old response and exact state are preserved and no session was submitted.
    assert.equal(calls.length,1);assert.deepEqual(await f.state(),{state:'LOGIN_APPROVAL',privatePayload:f.payload});
    assert.deepEqual(JSON.parse(await readFile(approvalResponsePath(f.home,'agent',f.request.handoffId),'utf8')),response);
  },async()=>{response=await signedResponse(f);return new Response(JSON.stringify(challenge()),{status:200});});
});

for(const present of ['response','malformed','symlink'])test(`expired ${present} approval never enters unsigned refresh`,async t=>{
  // Given an expired login with a response artifact that cannot be treated as absent.
  const f=await fixture(t),path=approvalResponsePath(f.home,'agent',f.request.handoffId);
  if(present==='response')await signedResponse(f);
  else if(present==='malformed')await writeFile(path,'invalid response',{mode:0o600});
  else await symlink(join(f.home,'missing-target'),path);
  const old=await f.state();
  await guarded(async calls=>{
    // When completion attempts recovery.
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),error=>{
      assert.equal(error.code,present==='symlink'?'APPROVAL_FILE':'APPROVAL_EXPIRED');if(present!=='symlink'){assert.match(error.message,/saved response/);assert.match(error.message,/agent-retry/);}return true;
    });
    // Then no challenge/session request or replacement occurs and the artifact remains.
    assert.equal(calls.length,0);assert.deepEqual(await f.state(),old);assert.ok((await readdir(join(f.home,'approvals','agent'))).includes(f.request.handoffId+'.response.json'));
  });
});

test('concurrent refreshers install at most one generation through exact old-payload CAS',async t=>{
  // Given two refresh actors blocked on their public challenges for the same expired owner.
  const f=await fixture(t),release=[];let bothEntered;const entered=new Promise(resolve=>{bothEntered=resolve;});
  await guarded(async calls=>{
    const first=capture(()=>runSetup(['--profile','agent','--home',f.home,'--complete','--json'],{}));
    const second=runSetup(['--profile','agent','--home',f.home,'--complete'],{},{quiet:true});
    const secondResult=second.then(()=>null,error=>error);
    await entered;
    // When the first response installs its fresh generation before the second response completes.
    release[0]();await first;const winner=await f.state();release[1]();const loser=await secondResult;
    // Then the loser fails stale and cannot overwrite the first installed generation.
    assert.equal(loser.code,'SETUP_BUSY');assert.equal(calls.length,2);assert.deepEqual(await f.state(),winner);
  },()=>new Promise(resolve=>{release.push(()=>resolve(new Response(JSON.stringify(challenge()),{status:200})));if(release.length===2)bothEntered();}));
});

test('a paused old response completer cannot submit or replace a refreshed same-state owner',async t=>{
  // Given an old still-valid response completer paused just before its submission transition.
  const f=await fixture(t,{expired:false});await signedResponse(f);const original=MarketplaceProfileStore.prototype.transitionSetupState;let replaced;
  MarketplaceProfileStore.prototype.transitionSetupState=function(profile,from,to,payload,expected){
    if(from==='LOGIN_APPROVAL'&&to==='LOGIN_SUBMITTING'&&!replaced){
      const fresh=challenge();
      const next={...f.saved,challenge:fresh,request:{...f.request,handoffId:'b'.repeat(32),challenge:{challengeId:fresh.challengeId,message:fresh.message,issuedAt:fresh.issuedAt,expiresAt:fresh.expiresAt}}};
      // A controlled competing generation models refresh winning after this actor read the old response.
      replaced=JSON.stringify(next);assert.equal(original.call(this,profile,'LOGIN_APPROVAL','LOGIN_APPROVAL',replaced,f.payload),true);
    }
    return original.call(this,profile,from,to,payload,expected);
  };
  try{await guarded(async calls=>{
    // When the stale completer resumes against another LOGIN_APPROVAL payload.
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),{code:'SETUP_BUSY'});
    // Then exact-payload admission rejects it before any old-proof HTTP request, preserving successor state/files.
    assert.equal(calls.length,0);assert.deepEqual(await f.state(),{state:'LOGIN_APPROVAL',privatePayload:replaced});
    assert.ok(await readFile(approvalResponsePath(f.home,'agent',f.request.handoffId)));
  });}finally{MarketplaceProfileStore.prototype.transitionSetupState=original;}
});

test('a paused LOGIN_READY actor cannot prepare approval over a different LOGIN_READY payload',async t=>{
  // Given an actor preparing the first challenge while a competing ready generation wins.
  const f=await fixture(t,{expired:false}),store=await MarketplaceProfileStore.open(f.home),saved={...f.saved};delete saved.request;
  const ready=JSON.stringify(saved);try{assert.equal(store.transitionSetupState('agent','LOGIN_APPROVAL','LOGIN_READY',ready,f.payload),true);}finally{store.close();}
  const original=MarketplaceProfileStore.prototype.transitionSetupState;let successor;
  MarketplaceProfileStore.prototype.transitionSetupState=function(profile,from,to,payload,expected){
    if(from==='LOGIN_READY'&&to==='LOGIN_APPROVAL'&&!successor){successor=JSON.stringify({...saved,challenge:challenge()});assert.equal(original.call(this,profile,'LOGIN_READY','LOGIN_READY',successor,ready),true);}
    return original.call(this,profile,from,to,payload,expected);
  };
  try{await guarded(async calls=>{
    // When the stale actor reaches its preparation CAS.
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),{code:'SETUP_BUSY'});
    // Then its old request cannot replace or publish as the current generation.
    assert.equal(calls.length,0);assert.deepEqual(await f.state(),{state:'LOGIN_READY',privatePayload:successor});
  });}finally{MarketplaceProfileStore.prototype.transitionSetupState=original;}
});

test('standalone approval of the expired old request prints same-profile continuation without opening keys',async t=>terminal(async()=>{
  // Given the exact immutable expired unsigned request.
  const f=await fixture(t);
  await guarded(async calls=>{
    // When that exact old request is approved directly.
    await assert.rejects(approveMarketplaceController(approvalRequestPath(f.home,'agent',f.request.handoffId),{home:f.home,env:{},prompt:()=>assert.fail('No approval preview for expired request')}),error=>error.code==='APPROVAL_EXPIRED'&&error.message.includes('--complete')&&error.message.includes(f.home));
    // Then it is not silently refreshed, signed or submitted.
    assert.equal(calls.length,0);assert.deepEqual(await f.state(),{state:'LOGIN_APPROVAL',privatePayload:f.payload});
  });
}));


test('a late old response remains orphaned after refresh and only the fresh approved proof is submitted',async t=>{
  // Given an expired unsigned handoff and its old response prepared by a late writer.
  const f=await fixture(t),oldResponse=await signedResponse(f);await rm(approvalResponsePath(f.home,'agent',f.request.handoffId));
  const original=MarketplaceProfileStore.prototype.transitionSetupState;let late=false;
  MarketplaceProfileStore.prototype.transitionSetupState=function(profile,from,to,payload,expected){
    if(from==='LOGIN_APPROVAL'&&to==='LOGIN_READY'&&!late){late=true;writeFileSync(approvalResponsePath(f.home,'agent',f.request.handoffId),JSON.stringify(oldResponse)+'\n',{mode:0o600});}
    return original.call(this,profile,from,to,payload,expected);
  };
  try{await guarded(async calls=>{
    // When refresh wins its payload CAS immediately after the old file's final absence check.
    await capture(()=>runSetup(['--profile','agent','--home',f.home,'--complete'],{}));
    const fresh=JSON.parse((await f.state()).privatePayload).request;
    assert.notEqual(fresh.handoffId,f.request.handoffId);
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),{code:'APPROVAL_FILE'});
    assert.equal(calls.length,1,'The old response cannot satisfy the current generation.');
    await signedResponse(f,fresh);
    await capture(()=>runSetup(['--profile','agent','--home',f.home,'--complete'],{}));
    // Then only the new explicitly approved message reaches the session endpoint; both immutable response files survive.
    assert.equal(calls.length,2);assert.equal(calls[1].url,origin+'/v1/agent/auth/sessions');assert.equal(calls[1].body.message,fresh.challenge.message);
    assert.notEqual(calls[1].body.message,oldResponse.message);assert.deepEqual(JSON.parse(await readFile(approvalResponsePath(f.home,'agent',f.request.handoffId),'utf8')),oldResponse);
    const store=await MarketplaceProfileStore.open(f.home);try{assert.deepEqual(store.listProfileIds(),['agent']);assert.equal(store.getSetupState('agent'),undefined);}finally{store.close();}
  },async url=>String(url).endsWith('/challenges')?new Response(JSON.stringify(challenge()),{status:200}):new Response(JSON.stringify({accountId,identityId,agentId:'22222222-2222-4222-8222-222222222222',accessToken:'fixture-session-access',refreshToken:'fixture-session-refresh',accessExpiresAt:new Date(Date.now()+120000).toISOString(),refreshExpiresAt:new Date(Date.now()+240000).toISOString()}),{status:200}));}
  finally{MarketplaceProfileStore.prototype.transitionSetupState=original;}
});

test('a fresh approval expiring during the same guided invocation requires deliberate rerun without another refresh',async t=>{
  // Given one successful refresh generation whose new challenge expires while the person decides.
  const f=await fixture(t),originalNow=Date.now;
  await guarded(async calls=>{
    await capture(()=>runSetup(['--profile','agent','--home',f.home,'--complete'],{}));const current=await f.state();
    Date.now=()=>originalNow()+180000;
    try{
      // When that same guided invocation tries to continue with hidden refresh disabled.
      await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{},{allowLoginRefresh:false}),error=>error.code==='APPROVAL_EXPIRED'&&error.message.includes('--complete'));
      // Then there is one challenge request, no submission, and the current generation remains available for a deliberate rerun.
      assert.equal(calls.length,1);assert.deepEqual(await f.state(),current);
    }finally{Date.now=originalNow;}
  });
});

test('a late session response cannot create a profile or delete a newer submitting owner',async t=>{
  // Given a valid approved login dispatched by its current owner.
  const f=await fixture(t,{expired:false});await signedResponse(f);let successor;
  await guarded(async calls=>{
    // When another generation owns setup before the old session response returns.
    await assert.rejects(runSetup(['--profile','agent','--home',f.home,'--complete'],{}),{code:'SETUP_BUSY'});
    // Then final profile persistence checks the exact dispatch owner and preserves the newer row.
    assert.equal(calls.length,1);assert.deepEqual(await f.state(),{state:'LOGIN_SUBMITTING',privatePayload:successor});
    const store=await MarketplaceProfileStore.open(f.home);try{assert.deepEqual(store.listProfileIds(),[]);}finally{store.close();}
  },async()=>{
    const fresh=challenge();successor=JSON.stringify({...f.saved,challenge:fresh,request:{...f.request,handoffId:'c'.repeat(32),challenge:{challengeId:fresh.challengeId,message:fresh.message,issuedAt:fresh.issuedAt,expiresAt:fresh.expiresAt}}});
    const store=await MarketplaceProfileStore.open(f.home);try{assert.equal(store.transitionSetupState('agent','LOGIN_SUBMITTING','LOGIN_SUBMITTING',successor,f.payload),true);}finally{store.close();}
    return new Response(JSON.stringify({accountId,identityId,agentId:'22222222-2222-4222-8222-222222222222',accessToken:'fixture-late-access',refreshToken:'fixture-late-refresh',accessExpiresAt:new Date(Date.now()+120000).toISOString(),refreshExpiresAt:new Date(Date.now()+240000).toISOString()}),{status:200});
  });
});
