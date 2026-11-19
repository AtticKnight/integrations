import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {join} from 'node:path';
import {tmpdir} from '../../test/support/temporary-directory.mjs';
import {browserDestination,browserSignIn,pairBrowser} from '../dist/browser-sign-in.js';
import {MarketplaceProfileStore} from '../dist/profile-store.js';
import {runSetup} from '../dist/setup.js';

const origin = 'https://atto.market';
const accessToken = 'private-fixture-controller-token';
const handoffId = randomUUID(), verifierHash = 'a'.repeat(64);

test('destination validation preserves ordinary Marketplace links and protects the connect routes', () => {
  assert.equal(browserDestination(), '/workspace');
  for (const path of ['/','/workspace/tasks?q=hello%20there#details','/Résumé','/shop/%C3%A9','/workspace/connected','/?q=https://other.example']) {
    assert.equal(browserDestination(path),path);
  }
  for (const path of ['workspace','//other.test','https://atto.market','/dir//page','/x/../finish','/a/./b','/x/%2e%2E/finish',
    '/workspace/connect','/Workspace/%63onnect/finish','/workspace/connect/?q=x','/a%2fb','/%255c','/a%5cb','/a\\b',
    '/a%x1','/a?q=%','/a%00b','/\tfoo','/a%ff','/' + 'a'.repeat(2048)]) {
    assert.throws(() => browserDestination(path),{code:'INVALID_BROWSER_PATH'});
  }
});

async function fixture(t, changes = {}) {
  const home = await mkdtemp(join(tmpdir(),'marketplace-browser-sign-in-'));
  const store = await MarketplaceProfileStore.open(home);
  t.after(async () => {store.close(); await rm(home,{recursive:true,force:true});});
  store.createProfile({id:'main',origin:'https://api.atto.market',audience:'urn:marketplace:agent-api:live',
    accountId:randomUUID(),agentId:randomUUID(),identityId:randomUUID(),controllerNetwork:'ATTO',
    controllerAddress:'atto://' + 'a'.repeat(61),authMode:'controller-session',accessToken,accessExpiresAt:Date.now()+120_000,...changes});
  return store;
}

function exchange(port, path, method, headers = {}, body) {
  return new Promise((resolve,reject) => {
    const req = httpRequest({hostname:'127.0.0.1',port,path,method,headers}, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()});
      } catch (error) {reject(error);}
    });
    req.once('error',reject);
    req.end(body);
  });
}

test('disabled profiles, scoped credentials and custom authorities return ordinary links without launching',async t => {
  const signal = new AbortController().signal;
  for (const extra of [{},{authMode:'scoped-api-key',apiKey:'secret'}, {origin:'https://other.example'}, {audience:'test'}]) {
    const store = await fixture(t,extra);
    if (Object.keys(extra).length) {
      const secret = randomBytes(32).toString('base64url');
      store.startBrowserSignInGrant('main',secret); store.activateBrowserSignInGrant('main',secret);
    }
    let calls = 0;
    const answer = await browserSignIn(store,'main','/shop?tab=1#list',signal,async () => {calls++;});
    assert.equal(calls,0);
    assert.equal(answer.status,'manual_sign_in');
    assert.equal(answer.url,origin+'/shop?tab=1#list');
    assert.equal(JSON.stringify(answer).includes('secret'),false);
  }
});

test('enabling and disabling require a terminal, and enrollment stays disabled until acknowledgement',async t => {
  const store = await fixture(t);
  for (const operation of ['enable','disable']) {
    await assert.rejects(runSetup(['--profile','main','--browser-sign-in',operation,'--home',store.home],{}),{code:'TERMINAL_REQUIRED'});
  }
  const secret = randomBytes(32).toString('base64url');
  store.startBrowserSignInGrant('main',secret);
  assert.equal(store.disableBrowserSignInGrant('main'),secret);
  assert.throws(() => store.activateBrowserSignInGrant('main',secret),{code:'BROWSER_GRANT_CHANGED'});
  store.forgetBrowserSignInGrant('main',secret,'revocation_pending');
  const next = randomBytes(32).toString('base64url');
  store.startBrowserSignInGrant('main',next);
  store.forgetBrowserSignInGrant('main',secret,'enrolling');
  assert.equal(store.browserSignInGrant('main').secret,next);
});

test('loopback accepts one same-origin proof and posts only the pinned Marketplace handoff',async t => {
  const store = await fixture(t), secret = randomBytes(32).toString('base64url');
  store.startBrowserSignInGrant('main',secret); store.activateBrowserSignInGrant('main',secret);
  const posts = [];
  t.mock.method(globalThis,'fetch',async (url, options) => {
    posts.push({url:String(url), auth:options.headers.authorization, redirect:options.redirect, body:JSON.parse(options.body)});
    return new Response(null,{status:204});
  });
  let callback, steps;
  const path = '/workspace/history?q=search#activity';
  const result = await browserSignIn(store,'main',path,new AbortController().signal, url => {
    steps = (async () => {
      const start = new URL(url), launch = new URLSearchParams(start.hash.slice(1));
      assert.equal(start.origin + start.pathname, origin+'/workspace/connect');
      assert.deepEqual([...launch.keys()].sort(),['nonce','port']);
      const nonce = launch.get('nonce');
      assert.match(nonce,/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      const port = Number(launch.get('port'));
      callback = port;
      const headers = {Origin:'http://127.0.0.1:' + port, 'Content-Type':'application/json'};
      const body = JSON.stringify({nonce,handoffId,verifierHash});
      const page = await exchange(port,'/','GET');
      assert.equal(page.status,200);
      assert.equal(page.headers['cache-control'],'no-store');
      assert.equal(page.headers['referrer-policy'],'no-referrer');
      assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
      assert.match(page.text,/history\.replaceState/);
      assert.ok(page.text.includes(origin+'/workspace/connect/finish'));
      assert.equal(page.text.includes(nonce),false);
      for (const [route,method,additional,payload] of [
        ['/','GET',{Host:'localhost'},undefined],
        ['/pair','OPTIONS',{},undefined], ['/pair','GET',{},undefined],
        ['/pair','POST',{Origin:origin},body], ['/pair','POST',{'Content-Type':'text/plain'},body],
        ['/pair?bad=1','POST',{},body], ['/pair','POST',{}, JSON.stringify({nonce:nonce + 'x',handoffId,verifierHash})],
        ['/pair','POST',{},JSON.stringify({nonce,handoffId:handoffId.toUpperCase(),verifierHash})],
        ['/pair','POST',{},JSON.stringify({nonce,handoffId,verifierHash:'large'.repeat(256)})],
        ['/pair','POST',{},JSON.stringify({nonce,handoffId,verifierHash,secret:'extra'})],
      ]) {
        assert.ok((await exchange(port,route,method,{...headers,...additional},payload)).status >= 400);
      }
      const paired = await exchange(port,'/pair','POST',headers,body);
      assert.equal(paired.status,204);
      assert.equal(paired.text,'');
    })();
    return steps;
  });
  await steps;
  assert.deepEqual(result,{status:'paired'});
  assert.deepEqual(posts,[{url:'https://api.atto.market/v1/agent/auth/browser-sign-in/handoffs/'+handoffId,
    auth:'Bearer '+accessToken,redirect:'error',body:{browserOrigin:origin,grantSecret:secret,verifierHash,path}}]);
  await assert.rejects(exchange(callback,'/','GET'));
});

test('launcher failure, cancellation, and a grant disabled while the browser is open end pairing',async t => {
  let port;
  const launch = async url => {port = Number(new URLSearchParams(new URL(url).hash.slice(1)).get('port')); throw Error('no browser');};
  assert.equal(await pairBrowser(launch,new AbortController().signal,() => assert.fail()),false);
  assert.ok(port > 0);
  await assert.rejects(exchange(port,'/','GET'));
  const stop = new AbortController();
  assert.equal(await pairBrowser(async () => stop.abort(),stop.signal,() => assert.fail()),false);
  const store = await fixture(t), secret = randomBytes(32).toString('base64url');
  store.startBrowserSignInGrant('main',secret); store.activateBrowserSignInGrant('main',secret);
  let completed;
  const result = await browserSignIn(store,'main',undefined,new AbortController().signal,url => {
    const fragment = new URLSearchParams(new URL(url).hash.slice(1));
    const port = Number(fragment.get('port'));
    store.disableBrowserSignInGrant('main');
    const headers = {origin:'http://127.0.0.1:'+port,'content-type':'application/json'};
    completed = exchange(port,'/pair','POST',headers,JSON.stringify({nonce:fragment.get('nonce'),handoffId,verifierHash}));
    return completed;
  });
  assert.equal((await completed).status,403);
  assert.equal(result.status,'manual_sign_in');
  assert.equal(result.url,origin+'/workspace');
});

test('disabling the grant during controller token refresh prevents the handoff POST',async t => {
  const store = await fixture(t,{accessExpiresAt:Date.now()-1000,refreshToken:'fixture-refresh-token',refreshExpiresAt:Date.now()+120_000});
  const secret = randomBytes(32).toString('base64url');
  store.startBrowserSignInGrant('main',secret); store.activateBrowserSignInGrant('main',secret);
  const requests = [];
  t.mock.method(globalThis,'fetch',async url => {
    requests.push(String(url));
    store.disableBrowserSignInGrant('main');
    return Response.json({accessToken:'fixture-rotated-access-token',accessExpiresAt:new Date(Date.now()+90_000).toISOString(),
      refreshToken:'fixture-rotated-refresh-token',refreshExpiresAt:new Date(Date.now()+120_000).toISOString()});
  });
  const result = await browserSignIn(store,'main',undefined,new AbortController().signal,async url => {
    const fragment = new URLSearchParams(new URL(url).hash.slice(1));
    const port = Number(fragment.get('port'));
    await exchange(port,'/pair','POST',{origin:'http://127.0.0.1:'+port,'content-type':'application/json'},
      JSON.stringify({nonce:fragment.get('nonce'),handoffId,verifierHash}));
  });
  assert.equal(result.status,'manual_sign_in');
  assert.deepEqual(requests,['https://api.atto.market/v1/agent/auth/sessions/refresh']);
  assert.equal(store.getProfile('main').accessToken,'fixture-rotated-access-token');
  assert.equal(store.browserSignInGrant('main').state,'revocation_pending');
});
