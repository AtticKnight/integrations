import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const packageDirectory=process.env.ATTO_TEST_MARKETPLACE_MCP_PACKAGE_DIR??join(import.meta.dirname,'..');
const {terminalText,terminalFields,takeJsonFlag,writeTerminalResult}=await import(pathToFileURL(join(packageDirectory,'dist/terminal-output.js')).href);

test('terminal results default to readable fields and preserve the explicit JSON contract',t=>{
  // Given a public ready result with nested client launch configuration.
  const result={status:'ready',profileId:'main',origin:'https://marketplace.example',mcpServers:{marketplace:{command:'node',args:['/private/main.js','--profile','main']}}};
  let output='';const originalWrite=process.stdout.write;t.mock.method(process.stdout,'write',(chunk,...rest)=>{if(typeof chunk!=='string')return originalWrite.call(process.stdout,chunk,...rest);output+=chunk;return true;});
  // When a terminal result is presented normally.
  writeTerminalResult(result);
  // Then it has one ready summary and useful readable launch fields.
  assert.match(output,/^Marketplace MCP is ready\.\nProfile: main\nMarketplace: https:\/\/marketplace.example/);
  assert.match(output,/Command: node/);assert.match(output,/- \/private\/main.js/);assert.doesNotMatch(output,/"status"|^\{/);
  // When JSON is explicitly selected, the complete original object is retained.
  output='';writeTerminalResult(result,true);
  // Then scripts receive exactly the public data contract.
  assert.deepEqual(JSON.parse(output),result);
});

test('terminal terms retain exact values and visibly escape terminal control characters',()=>{
  // Given signed terms containing hostile display controls and significant amounts.
  const terms={origin:'https://marketplace.example',audience:'agent\u001b[2J\u009b31m\u202e',action:{scopes:['payments:read','payments:write'],amountAtomic:'100000000000000000000000000001',recipient:'recipient\nforged approval'}};
  // When readable approval fields are rendered.
  const preview=terminalFields(terms);
  // Then every exact public term is visible without executable controls or a forged line.
  assert.equal(terminalText('\u001b\r\u0007\u2066\u2028\u2029'),'\\u001b\\u000d\\u0007\\u2066\\u2028\\u2029');
  assert.match(preview,/Audience: agent\\u001b\[2J\\u009b31m\\u202e/);
  assert.ok(preview.includes('100000000000000000000000000001'));
  assert.ok(preview.includes('payments:read'));assert.ok(preview.includes('payments:write'));
  assert.ok(preview.includes('recipient\\u000aforged approval'));
  assert.doesNotMatch(preview,/[\u001b\u009b\u202e]/);
});

test('JSON selection is local and preserves command arguments in either flag position',()=>{
  // Given equivalent explicit JSON flags before and after a command.
  for(const argv of [['--json','setup','--status'],['setup','--status','--json']]){
    // When terminal flags are separated from command arguments.
    const selected=takeJsonFlag(argv);
    // Then only this invocation selects JSON and the actual command remains intact.
    assert.deepEqual(selected,{argv:['setup','--status'],json:true});
    assert.deepEqual(takeJsonFlag(['setup']),{argv:['setup'],json:false});
  }
});
