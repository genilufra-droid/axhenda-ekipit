/* Shared, dependency-free Albanian task parsing & AI draft normalization.
 * Works identically in the browser and in Node tests.
 * Understands Standard & spoken/Gheg Albanian inflected names, calendar dates,
 * relative deadlines ("pas 3 ditësh", "javën tjetër", "5 nëntor", weekdays), and priorities. */
(function(root){
  'use strict';

  const fold = value => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ë/gi, 'e').replace(/ç/gi, 'c')
    .toLowerCase();

  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const [y, m, d] = value.split('-').map(Number), date = new Date(y, m - 1, d, 12);
    return dateKey(date) === value;
  }

  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* Phonetic folding for Albanian proper names: handles common spoken/ASR confusions
   * (gj/j, q/c, rr/r, ll/l, ia/ja) without blurring short distinct words. */
  function phoneticWord(word) {
    return fold(word)
      .replace(/[^a-z0-9]/g, '')
      .replace(/rr/g, 'r')
      .replace(/ll/g, 'l')
      .replace(/gj/g, 'j')
      .replace(/ia/g, 'ja')
      .replace(/ie/g, 'je');
  }

  /* Builds a regex pattern for one canonical Albanian name token that matches
   * its nominative, accusative, dative, genitive, and ablative forms
   * (e.g. "Kola" -> kola/koles/kolen; "Arben" -> arben/arbeni/arbenit/arbenin;
   * "Ana" -> ana/anes/anen; "Dorjela" -> dorjela/dorjeles/dorjelen; "Jorgo" -> jorgo/jorgos/jorgon),
   * while NEVER matching unrelated words like "Analizo" for "Ana". */
  function nameTokenPattern(rawToken) {
    const base = fold(rawToken).replace(/[^a-z0-9]/g, '');
    if (!base) return '';
    if (base.length <= 2) return escape(base);
    if (base.length === 3) {
      if (base.endsWith('a')) {
        const st = escape(base.slice(0, -1));
        return `(?:${escape(base)}|${st}(?:es|en))`;
      }
      return escape(base);
    }
    if (/[ae]$/.test(base)) {
      const st = escape(base.slice(0, -1));
      return `(?:${escape(base)}(?:s|n|se)?|${st}(?:a|e|es|en|it|in))`;
    }
    if (base.endsWith('i')) {
      const st = escape(base.slice(0, -1));
      return `(?:${escape(base)}(?:t|n|ut|un)?|${st}(?:i|it|in))`;
    }
    if (/[ou]$/.test(base)) {
      return `${escape(base)}(?:s|n|t|se|it|in)?`;
    }
    return `${escape(base)}(?:i|u|it|in|ut|un|a|es|en)?`;
  }

  /* Checks whether a spoken token matches a canonical name token (exact, inflected, or phonetic). */
  function sameAlbanianNameToken(spoken, canonical) {
    const s = fold(spoken).replace(/[^a-z0-9]/g, '');
    const c = fold(canonical).replace(/[^a-z0-9]/g, '');
    if (!s || !c) return false;
    if (s === c) return true;
    const pat = nameTokenPattern(c);
    if (pat && new RegExp('^' + pat + '$').test(s)) return true;
    if (c.length >= 5 && s.length >= 5) {
      const ps = phoneticWord(s), pc = phoneticWord(c);
      const pcStem = /[aei]$/.test(pc) ? pc.slice(0, -1) : pc;
      if (ps === pc || (ps.startsWith(pcStem) && /^(a|e|i|u|s|t|n|it|in|ut|un|es|en|se)?$/.test(ps.slice(pcStem.length)))) {
        return true;
      }
    }
    return false;
  }

  function resolveKnownPerson(rawName, people) {
    const cleanRaw = fold(rawName).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanRaw) return null;
    const exact = people.find(p => fold(p).replace(/\s+/g, ' ').trim() === cleanRaw);
    if (exact) return exact;
    const rWords = cleanRaw.split(' ');
    for (const p of people) {
      const pWords = fold(p).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
      if (pWords.length === rWords.length && pWords.every((pw, idx) => sameAlbanianNameToken(rWords[idx], pw))) {
        return p;
      }
    }
    if (rWords.length === 1 && rWords[0].length >= 4) {
      const firstMatches = people.filter(p => {
        const first = fold(p).replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/)[0];
        return sameAlbanianNameToken(rWords[0], first);
      });
      if (firstMatches.length === 1) return firstMatches[0];
    }
    return null;
  }

  const NUMBER_WORDS = {
    nje: 1, dy: 2, tre: 3, tri: 3, kater: 4, pese: 5,
    gjashte: 6, shtate: 7, tete: 8, nente: 9, dhjete: 10,
  };
  const MONTHS = {
    janar: 1, shkurt: 2, mars: 3, prill: 4, maj: 5, qershor: 6,
    korrik: 7, gusht: 8, shtator: 9, tetor: 10, nentor: 11, dhjetor: 12,
  };

  function parse(raw, people = [], now = new Date()) {
    const original = String(raw || '').trim(), text = fold(original), spans = [], warnings = [];
    const consume = match => { if (match) spans.push([match.index, match.index + match[0].length]); };
    const overlaps = (start, end) => spans.some(([a, b]) => start < b && end > a);

    const uniquePeople = [...new Set(people.filter(Boolean))].sort((a, b) => b.length - a.length);
    const found = [];

    // 1. Match full names (including Albanian case inflections like "Arben Kolës", "Kledis Dogën")
    uniquePeople.forEach(name => {
      const tokens = fold(name).trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return;
      const bodyPat = tokens.map(nameTokenPattern).join('\\s+');
      const re = new RegExp(`(^|[^a-z0-9])(${bodyPat})(?=$|[^a-z0-9])`, 'g');
      for (const m of text.matchAll(re)) {
        const start = m.index + m[1].length, end = start + m[2].length;
        if (overlaps(start, end)) continue;
        spans.push([start, end]);
        found.push({ name, start });
      }
    });

    // 2. Match unambiguous inflected first names (e.g. "Kledisit", "Dorjelës", "Jorgos", "Arbenit")
    // when a multi-word contact was spoken by first name only.
    const firstGroups = new Map();
    uniquePeople.forEach(name => {
      const first = fold(name).trim().split(/\s+/)[0];
      if (!first || first.length < 4) return;
      if (!firstGroups.has(first)) firstGroups.set(first, []);
      firstGroups.get(first).push(name);
    });
    for (const [first, candidates] of firstGroups.entries()) {
      if (candidates.length !== 1) continue;
      const canonical = candidates[0];
      if (found.some(f => f.name === canonical)) continue;
      const pat = nameTokenPattern(first);
      const re = new RegExp(`(^|[^a-z0-9])(${pat})(?=$|[^a-z0-9])`, 'g');
      for (const m of text.matchAll(re)) {
        const start = m.index + m[1].length, end = start + m[2].length;
        if (overlaps(start, end)) continue;
        spans.push([start, end]);
        found.push({ name: canonical, start });
      }
    }

    // 3. Priority expressions (Standard + spoken Albanian)
    let priority = 'Mesme';
    const pLow = text.match(/\b(?:prioritet(?:i)?\s+(?:i\s+)?ulet|jo\s+urgjente?|pa\s+ngut|pa\s+nxitim|kur\s+te\s+(?:kete\s+kohe|mundet))\b/);
    const pHigh = !pLow && text.match(/\b(?:prioritet(?:i)?\s+(?:i\s+)?(?:larte|lart|maksimal)|urgjente?|shume\s+e\s+rendesishme|menjehere|menjiher|sa\s+m[ae]\s+shpejt|pa\s+vonese|kritike)\b/);
    const pMid = !pLow && !pHigh && text.match(/\bprioritet(?:i)?\s+(?:i\s+)?(?:mesem|mesme)\b/);
    if (pLow) { priority = 'Ulet'; consume(pLow); }
    else if (pHigh) { priority = 'Lart'; consume(pHigh); }
    else if (pMid) { priority = 'Mesme'; consume(pMid); }

    // 4. Calendar & relative dates (local calendar arithmetic, never UTC-shifted)
    let due = '', match;
    const explicit = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
    const monthNames = Object.keys(MONTHS).join('|');
    const namedMonth = !explicit && text.match(new RegExp(`\\b(?:me\\s+|deri\\s+me\\s+)?(\\d{1,2})\\s+(${monthNames})(?:i|u|in|un)?(?:\\s+(\\d{4}))?\\b`));
    if (explicit) {
      const value = explicit[1] ? explicit[0] : `${explicit[6]}-${explicit[5].padStart(2, '0')}-${explicit[4].padStart(2, '0')}`;
      if (validDate(value)) { due = value; consume(explicit); }
      else warnings.push('Data e përmendur nuk është e vlefshme. Zgjidhe manualisht.');
    } else if (namedMonth) {
      const dayNum = Number(namedMonth[1]);
      const monNum = MONTHS[namedMonth[2]];
      let yr = namedMonth[3] ? Number(namedMonth[3]) : now.getFullYear();
      if (!namedMonth[3]) {
        const candidate = new Date(yr, monNum - 1, dayNum, 12);
        const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
        if (candidate < todayNoon) yr++;
      }
      const value = `${yr}-${String(monNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      if (validDate(value)) { due = value; consume(namedMonth); }
      else warnings.push('Data e përmendur nuk është e vlefshme. Zgjidhe manualisht.');
    } else {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
      const numPat = Object.keys(NUMBER_WORDS).join('|') + '|\\d{1,3}';
      if ((match = text.match(/\bpasneser\b|\bneser\b|\bsot\b|\bsonte\b|\bbrenda\s+dites\b/))) {
        const key = match[0].startsWith('brenda') || match[0] === 'sonte' ? 'sot' : match[0];
        date.setDate(date.getDate() + ({ pasneser: 2, neser: 1, sot: 0 }[key]));
        due = dateKey(date);
        consume(match);
      } else if ((match = text.match(/\bjaven\s+(?:tjeter|qe\s+vjen)\b|\bjaves\s+tjeter\b/))) {
        date.setDate(date.getDate() + 7);
        due = dateKey(date);
        consume(match);
      } else if ((match = text.match(new RegExp(`\\bpas\\s+(${numPat})\\s+(dite(?:sh|ve)?|jave(?:sh|ve)?|muaj(?:sh|ve)?)\\b`)))) {
        const n = Number(match[1]) || NUMBER_WORDS[match[1]];
        const unit = match[2];
        if (unit.startsWith('muaj')) date.setMonth(date.getMonth() + n);
        else date.setDate(date.getDate() + n * (unit.startsWith('jave') ? 7 : 1));
        due = dateKey(date);
        consume(match);
      } else if ((match = text.match(/\b(?:këtë\s+të\s+|kete\s+te\s+|te\s+|e\s+)?(hene|marte|merkure|enjte|premte|shtune|diele|diel)(?:n)?\b/))) {
        const dayKey = match[1] === 'diel' ? 'diele' : match[1];
        const day = { diele: 0, hene: 1, marte: 2, merkure: 3, enjte: 4, premte: 5, shtune: 6 }[dayKey];
        date.setDate(date.getDate() + ((day - date.getDay() + 7) % 7 || 7));
        due = dateKey(date);
        consume(match);
      }
    }

    const chars = original.split('');
    for (const [start, end] of spans) for (let i = start; i < end; i++) chars[i] = ' ';
    let title = chars.join('')
      .replace(/^\s*(?:caktoja|caktoje|caktoji|cakto|thuaji|thuaj|thuja|jepja|jepi|ngarkoja|ngarko|kujtoja|kujto|krijo(?:\s+nj[eë]\s+detyr[eë])?)\b/i, '')
      .replace(/^\s*(?:dhe|edhe)\b/i, '')
      .replace(/\b(?:për|per|deri\s+m[eë]|me\s+afatin?)\s*(?=[,.;:]|$)/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.:;–-]+|[\s,.:;–-]+$/g, '')
      .trim();
    if (!title) title = original;
    if (!found.length) warnings.push('Punonjësi nuk u identifikua. Kontrollo fushën “Caktuar për”.');
    if (!due) warnings.push('Afati nuk u identifikua. Mund ta zgjedhësh manualisht.');
    return {
      original,
      title: title ? title.charAt(0).toUpperCase() + title.slice(1) : '',
      assignee: [...new Set(found.sort((a, b) => a.start - b.start).map(x => x.name))].join(', '),
      due,
      priority,
      warnings,
    };
  }

  function normalize(data, raw, people = [], now = new Date()) {
    const original = typeof data?.transcript === 'string' && data.transcript.trim() ? data.transcript.trim() : String(raw || '').trim();
    const local = parse(original, people, now), draft = data?.draft;
    if (!draft || typeof draft !== 'object') return local;
    const warnings = [...local.warnings];
    let assignee = local.assignee;
    if (typeof draft.assignee === 'string' && draft.assignee.trim()) {
      const requested = draft.assignee.split(',').map(x => x.trim()).filter(Boolean);
      const known = requested.map(name => resolveKnownPerson(name, people));
      if (known.length && known.every(Boolean)) assignee = [...new Set(known)].join(', ');
      else warnings.push('AI propozoi një emër jashtë kontakteve; u përdor njohja lokale.');
    }
    if (draft.due && !validDate(draft.due)) warnings.push('Afati i propozuar nga AI u refuzua sepse nuk është i vlefshëm.');
    const due = validDate(draft.due) ? draft.due : local.due;
    return {
      ...local,
      title: typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim().slice(0, 300) : local.title,
      assignee,
      due,
      priority: ['Ulet', 'Mesme', 'Lart'].includes(draft.priority) ? draft.priority : local.priority,
      warnings: warnings.filter(w => !(assignee && w.startsWith('Punonjësi nuk')) && !(due && w.startsWith('Afati nuk'))),
    };
  }

  /* Checks whether a task belongs to the logged-in employee (handles full name,
   * Albanian diacritics/inflections, username, and email local-part). */
  function taskMatchesUser(task, identity) {
    if (!task || !task.assignee) return false;
    const info = typeof identity === 'string' ? { userName: identity } : (identity || {});
    const fullName = fold(info.userName || '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const userHandle = fold(info.username || '').replace(/[^a-z0-9._-]/g, '').trim();
    const emailHandle = fold(String(info.email || '').split('@')[0] || '').replace(/[^a-z0-9._-]/g, '').trim();
    if (!fullName && !userHandle && !emailHandle) return false;

    const assignees = String(task.assignee || '')
      .split(/[,;\n]+/)
      .map(s => fold(s).replace(/[^a-z0-9\s._-]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!assignees.length) return false;

    const userWords = fullName ? fullName.split(' ') : [];
    for (const a of assignees) {
      if (fullName && a === fullName) return true;
      if (userHandle && a === userHandle) return true;
      if (emailHandle && a === emailHandle) return true;
      const aWords = a.split(' ').filter(Boolean);
      if (userWords.length && aWords.length === userWords.length &&
          aWords.every((aw, idx) => sameAlbanianNameToken(aw, userWords[idx]) || sameAlbanianNameToken(userWords[idx], aw))) {
        return true;
      }
      if (aWords.length === 1 && userWords.length >= 1 && aWords[0].length >= 4 &&
          sameAlbanianNameToken(aWords[0], userWords[0])) {
        return true;
      }
    }
    return false;
  }

  const EMP_STOPWORDS = new Set([
    'detyra', 'detyren', 'detyres', 'detyrat', 'detyrave', 'puna', 'punen', 'punes',
    'perfundova', 'perfunduam', 'perfundua', 'perfunduar', 'mbarova', 'mbaruam', 'mbaruar',
    'kreva', 'kryem', 'kryer', 'krye', 'bera', 'bona', 'bana', 'bere', 'mbylla', 'mbyllur',
    'mora', 'persiper', 'pranova', 'pranoj', 'pranuar', 'nisa', 'fillova', 'merrem', 'pashe',
    'raportoj', 'raport', 'shenim', 'koment', 'pronarin', 'pronarit', 'ekipit',
    'sot', 'neser', 'tani', 'tashti', 'sapo', 'edhe', 'por', 'sepse', 'qe', 'te', 'me', 'ne', 'per', 'nga', 'tek',
  ]);

  function albanianStem(word) {
    const w = fold(word).replace(/[^a-z0-9]/g, '');
    if (w.length < 5) return w;
    return w.replace(/(?:ave|eve|ive|in|en|at|et|it|es|se|ve|te|ja|ia|ne|a|e|i|u)$/, s => (w.length - s.length >= 4 ? '' : s));
  }

  function contentStems(raw) {
    return fold(raw)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !EMP_STOPWORDS.has(w))
      .map(albanianStem)
      .filter(w => w.length >= 3);
  }

  /* Parses an employee's spoken or typed Albanian update against their own assigned tasks.
   * Actions: 'list' | 'complete' | 'acknowledge' | 'report'. */
  function parseEmployeeAction(raw, myTasks = []) {
    const original = String(raw || '').trim();
    const text = fold(original).replace(/\s+/g, ' ').trim();
    const tasks = Array.isArray(myTasks) ? myTasks.filter(t => t && t.id && t.title) : [];
    const openTasks = tasks.filter(t => !t.done);
    const warnings = [];

    const negated = /\b(?:nuk|s\s*e|s\s*kam|se\s+kam|ende\s+(?:jo|nuk|s)|akoma\s+(?:jo|nuk|s)|pamundur)\b/.test(text);
    const hasComplete = !negated && (
      /\b(?:e\s+)?(?:perfundova|perfunduam|mbarova|mbaruam|kreva|kryem|mbylla|mbyllem)\b/.test(text) ||
      /\b(?:u\s+(?:perfundua|mbarua|krye|mbyll)|ka\s+(?:perfunduar|mbaruar)|eshte\s+(?:perfunduar|kryer|mbaruar)|e\s+kam\s+(?:perfunduar|mbaruar|kryer|bere|bo|ba|mbyllur))\b/.test(text) ||
      /\b(?:e\s+(?:bera|bona|bana)|sheno(?:je)?\s+(?:si\s+)?(?:te\s+)?kryer|beje\s+kryer|detyra\s+u\s+(?:krye|perfundua)|kryer\s+detyr)\b/.test(text) ||
      /\b(?:e\s+)?(?:dergova|cova|dorezova|pergatita|kontrollova|verifikova|rregullova|ndreqa|pagova|nenshkrova|firmosa|pastrova|sistemova)\b/.test(text)
    );
    const hasAck = !negated && !hasComplete && (
      /\b(?:e\s+mora(?:\s+detyren|\s+persiper)?|mora\s+persiper|e\s+pranova|pranoj(?:\s+detyren)?|e\s+kam\s+pranuar|po\s+nis(?:\s+punen)?|nisa\s+punen|fillova\s+(?:punen|me)|po\s+merrem\s+me|e\s+pashe\s+detyren)\b/.test(text)
    );
    const hasReportCue = /\b(?:raportoj|raport|shenim|koment|mungon|problem|vonohet|presim|mbetur)\b/.test(text) || negated;
    const hasListQuery = !hasComplete && !hasAck && !hasReportCue && (
      /\b(?:cilat|cfare|cka|sa)\s+detyr/.test(text) ||
      /\b(?:lexo|me\s+lexo|trego|me\s+trego|shfaq)\s+detyr/.test(text) ||
      /\bdetyrat\s+e\s+mia\b/.test(text) ||
      /\bcfare\s+kam\s+(?:sot|ne\s+pritje|per\s+te\s+bere|per\s+sot)\b/.test(text) ||
      /\bkam\s+ndonje\s+detyre\b/.test(text)
    );

    if (hasListQuery) {
      return { original, action: 'list', taskId: '', taskTitle: '', note: '', warnings: [] };
    }

    const action = hasComplete ? 'complete' : hasAck ? 'acknowledge' : 'report';
    const pool = openTasks.length ? openTasks : tasks;
    let matched = null;

    // 1. Ordinal reference ("detyrën e parë", "të dytën", "të tretën")
    if (/\b(?:detyren\s+e\s+pare|te\s+paren|e\s+para)\b/.test(text) && pool[0]) matched = pool[0];
    else if (/\b(?:detyren\s+e\s+dyte|te\s+dyten|e\s+dyta)\b/.test(text) && pool[1]) matched = pool[1];
    else if (/\b(?:detyren\s+e\s+trete|te\s+treten|e\s+treta)\b/.test(text) && pool[2]) matched = pool[2];

    // 2. Albanian stem & substring similarity against the employee's tasks
    // Words spoken in the main clause (before "sepse / pasi / meqë / por") identify the target task,
    // whereas words after a causal conjunction describe the reason/blocker.
    if (!matched && tasks.length) {
      const clauses = original.split(/\b(?:sepse|pasi|meq[eë]|meqen[eë]se|mir[eë]po|por)\b/i);
      const mainStems = contentStems(clauses[0] || '');
      const reasonStems = contentStems(clauses.slice(1).join(' '));
      let bestScore = 0;
      for (const t of tasks) {
        const tStems = contentStems(`${t.title || ''} ${t.desc || ''} ${t.category || ''}`);
        if (!tStems.length) continue;
        const hitsStem = qs => tStems.some(ts => ts === qs || (qs.length >= 4 && ts.length >= 4 && (ts.startsWith(qs) || qs.startsWith(ts))));
        let overlap = 0;
        mainStems.forEach((qs, idx) => {
          if (hitsStem(qs)) overlap += 3 + 0.25 / (idx + 1);
        });
        reasonStems.forEach(qs => {
          if (hitsStem(qs)) overlap += 1.2;
        });
        if (overlap > 0 && !t.done && (action === 'complete' || action === 'acknowledge')) overlap += 0.5;
        if (overlap > bestScore) {
          bestScore = overlap;
          matched = t;
        }
      }
    }

    // 3. Unambiguous single open task fallback
    if (!matched) {
      if (openTasks.length === 1) matched = openTasks[0];
      else if (tasks.length === 1) matched = tasks[0];
    }

    if (!tasks.length) {
      warnings.push('Aktualisht nuk ke asnjë detyrë të caktuar në emrin tënd.');
    } else if (!matched) {
      warnings.push('Zgjidh detyrën përkatëse nga lista më poshtë para konfirmimit.');
    }

    return {
      original,
      action,
      taskId: matched ? String(matched.id) : '',
      taskTitle: matched ? String(matched.title) : '',
      note: original,
      warnings,
    };
  }

  function normalizeEmployeeAction(data, raw, myTasks = []) {
    const transcript = typeof data?.transcript === 'string' && data.transcript.trim()
      ? data.transcript.trim()
      : String(raw || '').trim();
    const tasks = Array.isArray(myTasks) ? myTasks.filter(t => t && t.id && t.title) : [];
    const local = parseEmployeeAction(transcript, tasks);
    const prop = data?.employeeProposal;
    if (!prop || typeof prop !== 'object') return local;

    const validActions = ['complete', 'acknowledge', 'report', 'list'];
    const negated = /\b(?:nuk|s\s*e|s\s*kam|se\s+kam|ende\s+(?:jo|nuk|s)|akoma\s+(?:jo|nuk|s)|pamundur)\b/.test(fold(transcript));
    let action = validActions.includes(String(prop.action)) ? String(prop.action) : local.action;
    if (negated && action === 'complete') action = 'report';
    if (action === 'list') {
      return { original: transcript, action: 'list', taskId: '', taskTitle: '', note: '', warnings: [] };
    }

    let chosen = null;
    if (prop.taskId) {
      chosen = tasks.find(t => String(t.id) === String(prop.taskId)) || null;
    }
    if (!chosen && local.taskId) {
      chosen = tasks.find(t => String(t.id) === String(local.taskId)) || null;
    }
    const warnings = [];
    if (!tasks.length) warnings.push('Aktualisht nuk ke asnjë detyrë të caktuar në emrin tënd.');
    else if (!chosen) warnings.push('Zgjidh detyrën përkatëse nga lista më poshtë para konfirmimit.');

    const note = typeof prop.note === 'string' && prop.note.trim()
      ? prop.note.trim().slice(0, 1500)
      : local.note;

    return {
      original: transcript,
      action,
      taskId: chosen ? String(chosen.id) : '',
      taskTitle: chosen ? String(chosen.title) : '',
      note,
      warnings,
    };
  }

  const api = { parse, normalize, validDate, dateKey, resolveKnownPerson, taskMatchesUser, parseEmployeeAction, normalizeEmployeeAction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
