import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_MEDIA_BYTES,MAX_MEDIA_BASE64,MEDIA_RPC_LIMIT,decodeMedia,validateMedia,attachmentResult} from '../channels/media.js';
import {TUNNEL_ENVELOPE_BYTES,TUNNEL_METADATA_RESERVE_BYTES} from '../channels/tunnel-budget.js';
import {metadata,rpcResult,toolResult} from '../router/common.js';
import {createChannelAdapter} from '../channels/contract.js';

// Actual official client envelope shapes from openai/tunnel-client commit
// 01d67bb4da0d8359b808b4761f8db171ab682cd7, docs/protocol.md and
// pkg/controlplane/wiretypes/wire.go. resp_json/jsonrpc are json.RawMessage.
// encoding/json escapes HTML and U+2028/U+2029 even inside those RawMessages.
const goJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const size = value => Buffer.byteLength(goJson(value));
const requestEnvelope = rpc => ({commands:[{request_id:'r'.repeat(256),shard_token:'s'.repeat(256),command_type:'jsonrpc',channel:'main',created_at:'2026-10-31T00:00:00Z',headers:{'Mcp-Protocol-Version':['2026-07-28'],'X-Trace-Context':['x'.repeat(8192)]},response_timeout:'120s',jsonrpc:rpc}]});
const responseEnvelope = rpc => ({request_id:'r'.repeat(256),channel:'main',resp_json:rpc,resp_headers:{'Content-Type':['application/json'],'X-Trace-Context':['x'.repeat(8192)]},resp_code:200,resp_type:'jsonrpc_response'});

test('maximum media fits actual request/response tunnel envelopes with worst escaped duplicate metadata',()=>{
 const data=Buffer.alloc(MAX_MEDIA_BYTES,65),encoded=data.toString('base64');
 assert.equal(MAX_MEDIA_BYTES,5*1024*1024);assert.equal(encoded.length,MAX_MEDIA_BASE64);
 const request={jsonrpc:'2.0',id:'q'.repeat(256),method:'tools/call',params:{name:'reply_fixture_media',arguments:{message_id:'m'.repeat(256),type:'file',data:encoded,name:'文'.repeat(255),mime_type:'application/octet-stream',text:'\u2028'.repeat(20000),idempotency_key:'k'.repeat(128)},_meta:metadata()}};
 const value={message_id:'m'.repeat(256),attachment_index:9,kind:'file',name:'文'.repeat(255),mime_type:'application/octet-stream',size:data.length,extraction_status:'complete',extracted_text:'\u0000'.repeat(30000)};
 const response=rpcResult('q'.repeat(256),toolResult(attachmentResult(value,data)));
 for(const [rpc,envelope] of [[request,requestEnvelope(request)],[response,responseEnvelope(response)]]){
  assert.ok(Buffer.byteLength(JSON.stringify(rpc))<MEDIA_RPC_LIMIT);
  assert.ok(size(envelope)+TUNNEL_METADATA_RESERVE_BYTES<TUNNEL_ENVELOPE_BYTES);
  // This is deliberately stronger than the official raw JSON envelope: it
  // covers a transport wrapper encoding the whole MCP body a second time.
  const conservative={...envelope,mcp_body_base64:Buffer.from(goJson(rpc)).toString('base64')};
  if(conservative.commands)conservative.commands[0]={...conservative.commands[0],jsonrpc:undefined};
  else delete conservative.resp_json;
  assert.ok(size(conservative)+TUNNEL_METADATA_RESERVE_BYTES<TUNNEL_ENVELOPE_BYTES);
 }
});

test('the byte after the maximum is refused even when Base64 encoded lengths match',()=>{
 const valid=Buffer.alloc(MAX_MEDIA_BYTES,1),oversize=Buffer.alloc(MAX_MEDIA_BYTES+1,1);
 assert.equal(valid.toString('base64').length,oversize.toString('base64').length);
 assert.equal(decodeMedia(valid.toString('base64')).length,MAX_MEDIA_BYTES);
 assert.throws(()=>decodeMedia(oversize.toString('base64')),e=>e.status===413&&e.data.reason==='media_limit_exceeded'&&e.data.max_bytes===MAX_MEDIA_BYTES);
 assert.throws(()=>validateMedia({type:'file',data:oversize,mimeType:'application/octet-stream',name:'file.bin'}),e=>e.data.reason==='media_limit_exceeded');
 const adapter=createChannelAdapter({id:'fixture',name:'Fixture',envPrefix:'FIXTURE',defaultPort:8799,media:{read:['file'],reply:['file']}});
 assert.throws(()=>adapter.validateToolArguments('reply_fixture_media',{message_id:'m',type:'file',data:oversize.toString('base64'),mime_type:'application/octet-stream',name:'file.bin',idempotency_key:'once'},true),e=>e.status===413);
});

test('legacy eight MiB rich responses exceed the official envelope without any extra body encoding',()=>{
 const data=Buffer.alloc(8*1024*1024),value={message_id:'m',attachment_index:0,kind:'file',name:'file.bin',mime_type:'application/octet-stream',size:data.length,extraction_status:'not_requested'};
 assert.ok(size(responseEnvelope(rpcResult('q',toolResult(attachmentResult(value,data)))))>TUNNEL_ENVELOPE_BYTES);
});
