import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const worker=fileURLToPath(new URL('../audio/read-document.py',import.meta.url));
function extract(xml){
 const script=`import io,json,subprocess,sys,zipfile
xml=json.loads(sys.stdin.read());out=io.BytesIO()
with zipfile.ZipFile(out,'w') as archive:archive.writestr('word/document.xml',xml.encode('utf-16'))
result=subprocess.run([sys.executable,'-I','-B',sys.argv[1],'office'],input=out.getvalue(),capture_output=True,timeout=4)
sys.stdout.buffer.write(result.stdout)`;
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-I','-B','-c',script,worker],{input:JSON.stringify(xml),encoding:'utf8',timeout:6000,maxBuffer:100000});assert.equal(result.status,0);return JSON.parse(result.stdout);
}
test('shared document reader accepts bounded ordinary UTF-16 Office text',()=>{assert.deepEqual(extract('<?xml version="1.0" encoding="UTF-16"?><doc><t>ordinary text</t></doc>'),{text:'ordinary text',status:'complete'});});
test('shared document reader rejects entity declarations across UTF-16 byte encodings',()=>{assert.deepEqual(extract('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE doc [<!ENTITY private "entity text">]><doc><t>&private;</t></doc>'),{text:'',status:'unsupported'});});
