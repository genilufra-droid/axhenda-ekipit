/* Shared, dependency-free task parsing. Works in the browser and in Node tests. */
(function(root){
  'use strict';
  const fold=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const dateKey=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  function validDate(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;
    const [y,m,d]=value.split('-').map(Number), date=new Date(y,m-1,d,12);
    return dateKey(date)===value;
  }
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  function parse(raw,people=[],now=new Date()){
    const original=String(raw||'').trim(), text=fold(original), spans=[], warnings=[];
    const consume=match=>{if(match)spans.push([match.index,match.index+match[0].length]);};
    // Match complete names, never a substring of another name or word.
    const found=[];
    [...new Set(people.filter(Boolean))].sort((a,b)=>b.length-a.length).forEach(name=>{
      const re=new RegExp(`(^|[^a-z0-9])(${escape(fold(name))})(?=$|[^a-z0-9])`,'g');
      for(const m of text.matchAll(re)){
        const start=m.index+m[1].length,end=start+m[2].length;
        if(spans.some(([a,b])=>start<b&&end>a))continue;
        spans.push([start,end]);found.push({name,start});
      }
    });
    let priority='Mesme';
    const p=text.match(/\b(?:prioritet(?:i)?\s+(?:i\s+)?(?:larte|lart|ulet|mesem|mesme)|jo\s+urgjente?|urgjente?)\b/);
    if(p){priority=/jo\s+urgjent|ulet/.test(p[0])?'Ulet':/lart|urgjent/.test(p[0])?'Lart':'Mesme';consume(p);}
    let due='', match;
    // Prefer an explicit date. Use local calendar dates, not UTC (which shifts dates at midnight).
    const explicit=text.match(/\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
    if(explicit){
      const value=explicit[1]?explicit[0]:`${explicit[6]}-${explicit[5].padStart(2,'0')}-${explicit[4].padStart(2,'0')}`;
      if(validDate(value)){due=value;consume(explicit);}else warnings.push('Data e përmendur nuk është e vlefshme. Zgjidhe manualisht.');
    }else{
      const date=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12);
      if((match=text.match(/\bpasneser\b|\bneser\b|\bsot\b/))){
        date.setDate(date.getDate()+({pasneser:2,neser:1,sot:0}[match[0]]));due=dateKey(date);consume(match);
      }else if((match=text.match(/\bpas\s+(nje|dy|tre|kater|pese|\d{1,3})\s+(dite|jave)\b/))){
        const n=Number(match[1])||({nje:1,dy:2,tre:3,kater:4,pese:5}[match[1]]);
        date.setDate(date.getDate()+n*(match[2]==='jave'?7:1));due=dateKey(date);consume(match);
      }else if((match=text.match(/\b(?:te\s+|e\s+)?(hene|marte|merkure|enjte|premte|shtune|diele)(?:n)?\b/))){
        const day={diele:0,hene:1,marte:2,merkure:3,enjte:4,premte:5,shtune:6}[match[1]];
        date.setDate(date.getDate()+((day-date.getDay()+7)%7||7));due=dateKey(date);consume(match);
      }
    }
    const chars=original.split('');
    for(const [start,end] of spans)for(let i=start;i<end;i++)chars[i]=' ';
    let title=chars.join('').replace(/^\s*(?:caktoja|caktoje|cakto|krijo(?:\s+nje\s+detyre)?)\b/i,'')
      .replace(/\b(?:për|per|deri\s+m[eë]|me\s+afatin?)\s*(?=[,.;:]|$)/gi,'')
      .replace(/\s+/g,' ').replace(/^[\s,.:;–-]+|[\s,.:;–-]+$/g,'').trim();
    if(!title)title=original;
    if(!found.length)warnings.push('Punonjësi nuk u identifikua. Kontrollo fushën “Caktuar për”.');
    if(!due)warnings.push('Afati nuk u identifikua. Mund ta zgjedhësh manualisht.');
    return {original,title:title.charAt(0).toUpperCase()+title.slice(1),assignee:[...new Set(found.sort((a,b)=>a.start-b.start).map(x=>x.name))].join(', '),due,priority,warnings};
  }
  function normalize(data,raw,people=[],now=new Date()){
    const original=typeof data?.transcript==='string'&&data.transcript.trim()?data.transcript.trim():String(raw||'').trim();
    const local=parse(original,people,now), draft=data?.draft;
    if(!draft||typeof draft!=='object')return local;
    const warnings=[...local.warnings];
    let assignee=local.assignee;
    if(typeof draft.assignee==='string'&&draft.assignee.trim()){
      const requested=draft.assignee.split(',').map(x=>x.trim());
      const known=requested.map(name=>people.find(p=>fold(p)===fold(name)));
      if(known.every(Boolean))assignee=[...new Set(known)].join(', ');
      else warnings.push('AI propozoi një emër jashtë kontakteve; u përdor njohja lokale.');
    }
    if(draft.due&&!validDate(draft.due))warnings.push('Afati i propozuar nga AI u refuzua sepse nuk është i vlefshëm.');
    const due=validDate(draft.due)?draft.due:local.due;
    return {...local,title:typeof draft.title==='string'&&draft.title.trim()?draft.title.trim().slice(0,300):local.title,
      assignee,due,priority:['Ulet','Mesme','Lart'].includes(draft.priority)?draft.priority:local.priority,
      warnings:warnings.filter(w=>!(assignee&&w.startsWith('Punonjësi nuk'))&&!(due&&w.startsWith('Afati nuk')))};
  }
  const api={parse,normalize,validDate,dateKey};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.TaskAssistant=api;
})(typeof globalThis!=='undefined'?globalThis:this);
