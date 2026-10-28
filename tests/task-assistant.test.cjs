const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse,normalize,validDate,dateKey}=require('../task-assistant.js');
const now=new Date(2026,9,28,0,15);
const people=['Arben Kola','Ana','Ana Hoxha','Beni'];
test('recognizes Albanian contacts, priority and tomorrow',()=>{
  const d=parse('Cakto Arben Kola përgatit raportin nesër urgjent',people,now);
  assert.equal(d.title,'Përgatit raportin');assert.equal(d.assignee,'Arben Kola');
  assert.equal(d.due,'2026-10-29');assert.equal(d.priority,'Lart');
});
test('does not match contact names or dates inside words',()=>{
  const d=parse('Analizo panoramën dhe sotëm',people,now);
  assert.equal(d.assignee,'');assert.equal(d.due,'');assert.equal(d.title,'Analizo panoramën dhe sotëm');
});
test('prefers full overlapping names, ignores accents and case',()=>{
  assert.equal(parse('ANA HOXHA dhe Beni për raportin',people,now).assignee,'Ana Hoxha, Beni');
  assert.equal(parse('Arben Kola NESER prioritet i ulet',people,now).priority,'Ulet');
});
test('supports explicit dates and rejects impossible dates',()=>{
  assert.equal(parse('Raporti 31.12.2026',[],now).due,'2026-12-31');
  assert.equal(parse('Raporti 2026-11-04',[],now).due,'2026-11-04');
  assert.equal(parse('Raporti 31/02/2026',[],now).due,'');
  assert.equal(validDate('2026-02-29'),false);assert.equal(validDate('2028-02-29'),true);
  assert.equal(validDate('2026-13-01'),false);assert.equal(validDate('nonsense'),false);
});
test('relative dates use calendar arithmetic across month and year boundaries',()=>{
  assert.equal(parse('Raporti pasnesër',[],new Date(2026,11,31)).due,'2027-01-02');
  assert.equal(parse('Raporti pas dy javë',[],now).due,'2026-11-11');
  assert.equal(parse('Raporti pas 3 ditë',[],now).due,'2026-10-31');
  assert.equal(parse('Raporti të premten',[],now).due,'2026-10-30');
  assert.equal(parse('Raporti të mërkurën',[],now).due,'2026-11-04');
});
test('preserves time and task details rather than silently discarding them',()=>{
  const d=parse('Arben Kola tako klientin nesër në orën 14:30',people,now);
  assert.match(d.title,/14:30/);assert.match(d.original,/nesër/);
});
test('unrecognized fields remain empty with review warnings',()=>{
  const d=parse('Përgatit raportin',people,now);
  assert.equal(d.priority,'Mesme');assert.equal(d.warnings.length,2);
  assert.equal(parse('',people,now).title,'');
});
test('normalizes malformed AI fields and rejects hallucinated people',()=>{
  const d=normalize({draft:{title:34,assignee:'Person imagjinar',due:'2026-02-30',priority:'urgent'}},'Arben Kola raportin nesër',people,now);
  assert.equal(d.assignee,'Arben Kola');assert.equal(d.due,'2026-10-29');assert.equal(d.priority,'Mesme');
  assert.ok(d.warnings.some(w=>w.includes('jashtë')));
  assert.ok(d.warnings.some(w=>w.includes('refuzua')));
});
test('accepts valid AI proposals but keeps original transcript for review',()=>{
  const d=normalize({transcript:'Arben Kola raportin sot',draft:{title:'Përgatit raportin',assignee:'Arben Kola',due:'2026-10-28',priority:'Lart'}},'',people,now);
  assert.equal(d.title,'Përgatit raportin');assert.equal(d.original,'Arben Kola raportin sot');assert.equal(d.warnings.length,0);
});
test('local today is not shifted by UTC conversion',()=>{
  assert.equal(dateKey(now),'2026-10-28');assert.equal(parse('Raporti sot',[],now).due,'2026-10-28');
});
