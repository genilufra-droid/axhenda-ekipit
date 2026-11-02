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

  const api = { parse, normalize, validDate, dateKey, resolveKnownPerson };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
