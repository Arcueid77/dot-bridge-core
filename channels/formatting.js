import MarkdownIt from 'markdown-it';

const markdown=new MarkdownIt({html:false,linkify:false,breaks:true,maxNesting:20});
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const decode=value=>value.replace(/&quot;/g,'"').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
const safeLink=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}};

export function telegramHTML(text) {
  if(typeof text!=='string'||text.length>30000||!text.isWellFormed())throw Error('Invalid bounded Markdown');
  const links=[],lists=[];let result='';
  const render=tokens=>{
    for(const token of tokens){
      if(token.type==='inline'){render(token.children??[]);continue;}
      if(token.type==='text')result+=escape(token.content);
      else if(token.type==='softbreak'||token.type==='hardbreak')result+='\n';
      else if(token.type==='code_inline')result+='<code>'+escape(token.content)+'</code>';
      else if(token.type==='fence'||token.type==='code_block')result+='<pre>'+escape(token.content.replace(/\n$/,''))+'</pre>\n';
      else if(['strong_open','em_open','s_open','heading_open'].includes(token.type))result+={strong_open:'<b>',em_open:'<i>',s_open:'<s>',heading_open:'<b>'}[token.type];
      else if(['strong_close','em_close','s_close','heading_close'].includes(token.type))result+={strong_close:'</b>',em_close:'</i>',s_close:'</s>',heading_close:'</b>\n'}[token.type];
      else if(token.type==='link_open'){const url=safeLink(token.attrGet('href'));links.push(!!url);if(url)result+='<a href="'+escape(url)+'">';}
      else if(token.type==='link_close'){if(links.pop())result+='</a>';}
      else if(token.type==='image')result+='[image: '+escape(token.content)+']';
      else if(token.type==='bullet_list_open'||token.type==='ordered_list_open'){lists.push(token.type==='ordered_list_open'?Number(token.attrGet('start')??1):null);}
      else if(token.type==='bullet_list_close'||token.type==='ordered_list_close'){lists.pop();result+='\n';}
      else if(token.type==='list_item_open'){const index=lists.length-1;result+=lists[index]===null?'• ':String(lists[index]++)+'. ';}
      else if(token.type==='list_item_close'||token.type==='paragraph_close'||token.type==='tr_close')result+='\n';
      else if(token.type==='td_close'||token.type==='th_close')result+=' | ';
      else if(token.type==='blockquote_open')result+='<blockquote>';
      else if(token.type==='blockquote_close')result+='</blockquote>\n';
      else if(token.type==='hr')result+='────\n';
    }
  };
  render(markdown.parse(text,{}));result=result.trim();
  return {html:result,plain:decode(result.replace(/<[^>]*>/g,''))};
}

export function splitTelegramHTML(html,limit=4000) {
  if(!Number.isSafeInteger(limit)||limit<100||limit>4096)throw Error('Invalid Telegram chunk limit');
  const parts=[],stack=[];let output='',length=0;
  const flush=()=>{if(!length)return;parts.push(output+[...stack].reverse().map(tag=>'</'+tag.name+'>').join(''));output=stack.map(tag=>tag.open).join('');length=0;};
  for(const token of html.match(/<[^>]*>|&(?:amp|lt|gt|quot);|[^<&]|[<&]/gu)??[]){
    if(token.startsWith('<')&&token.endsWith('>')){
      const close=/^<\/(\w+)>$/.exec(token),open=/^<(\w+)(?:\s[^>]*)?>$/.exec(token);
      if(close){if(stack.at(-1)?.name!==close[1])throw Error('Unbalanced generated HTML');stack.pop();}else if(open)stack.push({name:open[1],open:token});else throw Error('Unsupported generated HTML');
      output+=token;continue;
    }
    const size=token.startsWith('&')?1:token.length;
    if(length+size>limit)flush();output+=token;length+=size;
    if(length>=Math.floor(limit*0.9)&&/\s/u.test(token))flush();
  }
  if(stack.length)throw Error('Unbalanced generated HTML');flush();return parts;
}

export function clipText(text,limit) {let output='';for(const char of text){if(output.length+char.length>limit)break;output+=char;}return output;}
export function splitMarkdown(text,limit) {
  if(typeof text!=='string'||!text.isWellFormed()||!Number.isSafeInteger(limit)||limit<100)throw Error('Invalid text chunk plan');
  const result=[];let remaining=text,fence=null;
  while(remaining.length){
    const prefix=fence?fence.marker+fence.info+'\n':'';
    const reserve=fence?fence.marker.length+1:12,budget=limit-prefix.length-reserve;
    let end=clipText(remaining,budget).length;
    const boundary=Math.max(remaining.lastIndexOf('\n',end-1),remaining.lastIndexOf(' ',end-1));
    if(end<remaining.length&&boundary>=budget*0.6)end=boundary+1;
    const raw=remaining.slice(0,end);
    for(const match of raw.matchAll(/(?:^|\n)(`{3,10}|~{3,10})([^\n]*)/g)){
      if(fence){if(match[1][0]===fence.marker[0]&&match[1].length>=fence.marker.length&&!match[2].trim())fence=null;}
      else fence={marker:match[1],info:/^[A-Za-z0-9_+-]{0,32}$/.test(match[2].trim())?match[2].trim():''};
    }
    result.push(prefix+raw+(fence?'\n'+fence.marker:''));remaining=remaining.slice(end);
  }
  return result;
}
