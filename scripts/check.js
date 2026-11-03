import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const files=['audio','channels','router','scripts','test','packages'].flatMap(root=>fs.readdirSync(root,{recursive:true}).filter(f=>f.endsWith('.js')||f.endsWith('.mjs')).map(f=>path.join(root,f)));
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}}
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
if(pkg.devDependencies||Object.keys(pkg.dependencies??{}).sort().join(',')!=='markdown-it'||pkg.dependencies['markdown-it']!=='15.0.3')throw Error('Core permits only its pinned provider-independent Markdown parser, never provider SDKs');
for(const file of fs.readdirSync('router'))if(/from\s+['"][^'"]*(?:dot-(?:qq|lark)-bridge|lark-contract)/.test(fs.readFileSync(path.join('router',file),'utf8')))throw Error('Provider repository coupled into core router');
process.stdout.write(`Syntax checked ${files.length} public JavaScript files; core has no provider dependencies.\n`);
