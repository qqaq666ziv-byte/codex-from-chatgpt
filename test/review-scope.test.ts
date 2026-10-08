import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertReviewableOmissions, assertScopeMatchesInitialSnapshot, parseReviewScope, type ScopeEvidence } from '../src/review-scope.js';
import type { SourceSnapshot } from '../src/snapshot.js';

const sha256=createHash('sha256').update(Buffer.from([0,1,2])).digest('hex');
const binary={path:'public/icon.png',reason:'binary_requires_separate_review',sha256,bytes:3,mode:'100644' as const,git_mode:'100644' as const};
const source:SourceSnapshot={head:'a'.repeat(40),files:{},omitted:[binary]};
const scope:ScopeEvidence={declaration:{mode:'changes',base_commit:'a'.repeat(40),excluded_binary_assets:[{path:binary.path,reason:'Existing unchanged application icon, unrelated to the affected accounting behavior.'}],required_binary_paths:[]},excluded:[{path:binary.path,reason:'Existing unchanged application icon, unrelated to the affected accounting behavior.',sha256,bytes:3,git_mode:'100644',working_mode:'100644'}]};

test('explicit leading change scope accepts exact paths and preserves its immutable baseline',()=>{
  const header=`AutoDev-Review-Scope: ${JSON.stringify(scope.declaration)}\nTask.`;
  assert.deepEqual(parseReviewScope(header),scope.declaration);
  assert.deepEqual(parseReviewScope(`AutoDev-Routing: {}\n${header}`),scope.declaration);
  assert.equal(parseReviewScope(`Task data:\n${header}`),undefined);
  assert.throws(()=>parseReviewScope(`${header.split('\n')[0]}\n${header}`),/Duplicate/);
  assert.throws(()=>parseReviewScope('AutoDev-Review-Scope: nope\nTask'),/Invalid/);
});

test('scope rejects unpinned refs, broad globs, sensitive paths and unknown fields',()=>{
  for(const update of [{base_commit:'main'},...['../icon.png','public/*.png','public/icon?.png','.env'].map(path=>({excluded_binary_assets:[{path,reason:'Unrelated existing icon.'}]})),{allow_all_binaries:true}])
    assert.throws(()=>parseReviewScope(`AutoDev-Review-Scope: ${JSON.stringify({...scope.declaration,...update})}\nTask`),/Invalid/);
});

test('only explicitly scoped unchanged hashed binary evidence is eligible',()=>{
  assert.doesNotThrow(()=>assertReviewableOmissions(source,source,scope));
  for(const missing of [undefined,{declaration:{mode:'full' as const},excluded:[]}])assert.throws(()=>assertReviewableOmissions(source,source,missing),/separate review/);
  for(const omitted of [[],[{...binary,sha256:'b'.repeat(64)}],[{path:binary.path,reason:binary.reason}],[{...binary,reason:'non_utf8_requires_separate_review'}]])
    assert.throws(()=>assertReviewableOmissions(source,{...source,omitted},scope),/changed|evidence/);
});

test('a first followup scope binds only binary hash, size and mode matching the initial snapshot',()=>{
  assert.doesNotThrow(()=>assertScopeMatchesInitialSnapshot(scope,source));
  assert.throws(()=>assertScopeMatchesInitialSnapshot(scope,{...source,omitted:[{...binary,sha256:'b'.repeat(64)}]}),/changed since the initial baseline/);
  assert.throws(()=>assertScopeMatchesInitialSnapshot(scope,{...source,omitted:[{...binary,mode:'100755'}]}),/changed since the initial baseline/);
  assert.throws(()=>assertScopeMatchesInitialSnapshot(scope,{...source,omitted:[{path:binary.path,reason:binary.reason,sha256,bytes:3}]}),/changed since the initial baseline/);
});

test('redaction, UTF8 and required dependencies cannot be turned into binary exceptions',()=>{
  for(const reason of ['non_utf8_requires_separate_review','known_token_patterns_redacted','non_regular_file'])
    assert.throws(()=>assertReviewableOmissions(source,{...source,omitted:[binary,{path:'other.ts',reason}]},scope),/separate review/);
  assert.throws(()=>assertReviewableOmissions(source,source,{...scope,declaration:{...scope.declaration,mode:'changes',base_commit:'a'.repeat(40),excluded_binary_assets:[],required_binary_paths:['missing-relevant.png']}}),/Required binary/);
  assert.doesNotThrow(()=>assertReviewableOmissions({...source,omitted:[{path:'.env',reason:'sensitive_or_private_path'}]},{...source,omitted:[]}));
});
