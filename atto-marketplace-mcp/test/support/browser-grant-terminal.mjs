// Run in a disposable PTY with the real terminal signer and a local in-memory Marketplace transport.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [, , directory, home] = process.argv;
const load = name => import(pathToFileURL(join(directory,'dist',name + '.js')).href);
const {run} = await load('main');
const {MarketplaceProfileStore} = await load('profile-store');
const {validAttoProof} = await load('atto-proof');
const {offchainVerify} = await import('@attocash/atto-marketplace-nano-adapter/protocol');
const store = await MarketplaceProfileStore.open(home);
const id = 'acceptance', profile = store.getProfile(id);
const api = 'https://api.atto.market/v1/agent/auth/browser-sign-in/grants';
const origin = 'https://atto.market';
const hash = value => createHash('sha256').update(value,'utf8').digest('hex');
let challenge, secret, verified = false, revocations = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(options.method,'POST');
  assert.equal(options.headers.authorization,'Bearer ' + profile.accessToken);
  const body = JSON.parse(options.body);
  if (String(url) === api + '/challenges') {
    const grant = store.browserSignInGrant(id);
    assert.equal(grant.state,'enrolling');
    secret = grant.secret;
    assert.match(secret,/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    assert.deepEqual(body,{browserOrigin:origin, grantHash:hash(secret)});
    const challengeId = randomUUID(), issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now()+120000).toISOString();
    const binding = hash(['marketplace-browser-sign-in-grant-v1',profile.accountId,profile.identityId,origin,body.grantHash].join('\n'));
    const nano = profile.controllerNetwork === 'NANO';
    const message = [nano ? 'Nano Marketplace Agent Controller Proof v1' : 'Marketplace Agent Controller Proof v1',
      'Audience: urn:marketplace:agent-api:live', 'Network: ' + (nano ? 'nano:mainnet' : 'live'),
      'Address: ' + profile.controllerAddress, 'Purpose: browser sign-in grant', 'Request ID: ' + challengeId,
      'Binding Hash: ' + binding, 'Nonce: ' + hash(challengeId), 'Issued At: ' + issuedAt, 'Expiration Time: ' + expiresAt].join('\n');
    challenge = {challengeId,issuedAt,expiresAt,message,accountId:profile.accountId,controllerId:profile.identityId};
    return Response.json(challenge);
  }
  if (String(url) === api) {
    assert.deepEqual(Object.keys(body).sort(),['browserOrigin','challengeId','grantHash','message','signature']);
    assert.equal(body.browserOrigin,origin);
    assert.equal(body.grantHash,hash(secret));
    assert.equal(body.challengeId,challenge.challengeId);
    assert.equal(body.message,challenge.message);
    verified = profile.controllerNetwork === 'ATTO' ? await validAttoProof(profile.controllerAddress,body.message,body.signature)
      : offchainVerify(profile.controllerAddress,body.message,body.signature);
    assert.equal(verified,true);
    return new Response(null,{status:204});
  }
  assert.equal(String(url),api + '/revoke');
  assert.deepEqual(body,{grantSecret:secret});
  assert.equal(store.browserSignInGrant(id).state,'revocation_pending');
  if (++revocations === 1) throw Error('fixture offline');
  return new Response(null,{status:204});
};
const configure = operation => run(['setup','--profile',id,'--home',home,'--browser-sign-in',operation,'--json'],process.env);
try {
  await configure('enable');
  assert.equal(verified,true);
  assert.equal(store.browserSignInGrant(id).state,'enabled');
  await configure('status');
  await assert.rejects(configure('disable'),{code:'BROWSER_REVOCATION_PENDING'});
  await configure('disable');
  assert.equal(store.browserSignInGrant(id),undefined);
} finally {store.close();}
