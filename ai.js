// ai.js — parsing + insight engine.
// Tier 1 (always on): local rule-based parsing & correlation, runs on-device, no key.
// Tier 2 (if a Claude API key is set): richer read-backs, weekly reflection & pattern insights
//         via a direct browser call to the Claude API. Only the text you analyze is sent.
import { db } from './db.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-3-5-haiku-latest';

// ---------- trigger / symptom vocabulary (local engine) ----------
const FOOD_TAGS = {
  dairy: ['milk', 'cheese', 'latte', 'yogurt', 'yoghurt', 'ice cream', 'butter', 'cream', 'dairy'],
  sugar: ['sugar', 'candy', 'dessert', 'cake', 'cookie', 'chocolate', 'soda', 'sweet', 'pastry', 'donut'],
  caffeine: ['coffee', 'latte', 'espresso', 'caffeine', 'energy drink', 'matcha'],
  gluten: ['bread', 'pasta', 'wheat', 'bagel', 'croissant', 'gluten', 'cereal'],
  alcohol: ['wine', 'beer', 'alcohol', 'cocktail', 'whiskey', 'vodka', 'tequila'],
  greasy: ['fried', 'greasy', 'fast food', 'burger', 'pizza', 'fries', 'chips'],
  spicy: ['spicy', 'hot sauce', 'chili', 'jalapeno'],
};
const SYMPTOM_GROUPS = {
  Breakouts: ['breakout', 'break out', 'pimple', 'acne', 'zit', 'skin flare', 'spot on'],
  Headache: ['headache', 'migraine', 'head hurts'],
  'Stomach trouble': ['stomach', 'bloat', 'nausea', 'nauseous', 'cramp', 'gut', 'indigestion', 'queasy', 'diarrhea'],
  Pain: ['pain', 'ache', 'sore', 'hurts', 'stiff'],
};
const TYPE_KEYWORDS = {
  food: ['ate', 'eat', 'eating', 'drank', 'drink', 'had a', 'had some', 'breakfast', 'lunch', 'dinner', 'snack', 'coffee', 'latte', 'salad', 'meal'],
  sleep: ['slept', 'sleep', 'woke', 'insomnia', 'nap', 'bed', 'rest', 'awake'],
  energy: ['energy', 'motivation', 'foggy', 'sluggish', 'exhausted', 'wired', 'alert', 'groggy', 'drained', 'focus'],
  activity: ['workout', 'work out', 'run', 'ran', 'gym', 'walk', 'walked', 'yoga', 'lift', 'exercise', 'sat', 'sitting', 'stood', 'standing', 'stretch', 'cycled', 'swim'],
  symptom: ['pain', 'ache', 'sore', 'rash', 'breakout', 'pimple', 'acne', 'headache', 'migraine', 'nausea', 'bloat', 'stomach', 'cramp', 'itch', 'dizzy', 'hurts', 'stiff'],
};

function has(text, arr) { return arr.some(w => text.includes(w)); }
function tagsIn(text, dict) { return Object.keys(dict).filter(k => has(text, dict[k])); }

// ---------- local parse ----------
export function parseLocal(text) {
  const t = (text || '').toLowerCase().trim();
  let type = 'note';
  // priority: symptom > food > sleep > energy > activity
  if (has(t, TYPE_KEYWORDS.symptom)) type = 'symptom';
  else if (has(t, TYPE_KEYWORDS.food)) type = 'food';
  else if (has(t, TYPE_KEYWORDS.sleep)) type = 'sleep';
  else if (has(t, TYPE_KEYWORDS.energy)) type = 'energy';
  else if (has(t, TYPE_KEYWORDS.activity)) type = 'activity';

  // intensity
  let intensity = null;
  const m = t.match(/(\d{1,2})\s*(?:out of|\/)\s*10/);
  if (m) intensity = Math.min(10, parseInt(m[1], 10));
  else if (has(t, ['slight', 'mild', 'little', 'minor', 'bit of', 'faint'])) intensity = 3;
  else if (has(t, ['moderate', 'medium', 'noticeable'])) intensity = 5;
  else if (has(t, ['bad', 'severe', 'really', 'very', 'strong', 'intense', 'terrible', 'awful', 'killing'])) intensity = 8;

  // status
  let status = 'event';
  if (/\b(didn't|did not|skipped|couldn't|couldn’t|no |forgot to|missed)\b/.test(t)) status = 'absence';
  else if (has(t, ['still', 'ongoing', 'again', 'persist', 'lingering', 'same'])) status = 'ongoing';
  else if (type === 'energy' || type === 'sleep') status = 'rating';

  // subtag (dairy, sugar, breakout group…)
  const foodTags = tagsIn(t, FOOD_TAGS);
  let subtag = foodTags[0] || null;
  if (!subtag) {
    if (type === 'symptom') { const g = symptomGroupOf(t); subtag = g ? g.toLowerCase() : status; }
    else if (type === 'activity') subtag = status === 'absence' ? 'skipped' : 'movement';
    else if (type === 'energy') subtag = intensity && intensity <= 4 ? 'low' : 'energy';
    else if (type === 'sleep') subtag = has(t, ['bad', 'woke', 'insomnia', 'poorly', "couldn't", 'awake']) ? 'poor' : 'sleep';
  }

  const subject = smartSubject(text);
  const followup =
    type === 'symptom' ? 'Is this new, or the same thing from earlier?' :
    type === 'food' ? 'Anything else along with it?' :
    type === 'sleep' ? 'Roughly how many hours?' : null;

  return { type, subject, intensity, status, subtag, tags: foodTags, followup, source: 'local' };
}

function symptomGroupOf(t) {
  for (const g of Object.keys(SYMPTOM_GROUPS)) if (has(t, SYMPTOM_GROUPS[g])) return g;
  return null;
}
function smartSubject(text) {
  let s = (text || '').trim().replace(/\s+/g, ' ');
  if (s.length > 52) s = s.slice(0, 50).replace(/\s\S*$/, '') + '…';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Claude call ----------
async function callClaude(system, user, maxTokens = 1024) {
  const key = await db.getSetting('apiKey');
  if (!key) throw new Error('no-key');
  const model = (await db.getSetting('model')) || DEFAULT_MODEL;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('api-' + res.status + ' ' + txt.slice(0, 140));
  }
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}
function extractJSON(str) {
  if (!str) throw new Error('empty');
  let s = str.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

export async function hasKey() { return !!(await db.getSetting('apiKey')); }

// ---------- parse (LLM if available) ----------
export async function parseClue(text) {
  if (await hasKey()) {
    try {
      const sys = `You turn a person's spoken health note into ONE structured "clue" for a self-tracking app called CLUE. Reply with ONLY minified JSON, no prose.
Schema: {"type": one of "food"|"symptom"|"activity"|"energy"|"sleep"|"note", "subject": short human label (<=6 words), "intensity": integer 0-10 or null, "status": "event"|"ongoing"|"absence"|"rating", "subtag": short tag like "dairy","breakout","low","skipped", "followup": a brief friendly clarifying question or null}.`;
      const out = await callClaude(sys, `Note: "${text}"\nReturn the JSON clue.`, 400);
      const j = extractJSON(out);
      j.tags = Array.isArray(j.tags) ? j.tags : [];
      j.source = 'ai';
      if (!j.type) j.type = 'note';
      return j;
    } catch (e) { /* fall through to local */ }
  }
  return parseLocal(text);
}

// ---------- correlation ----------
export async function generateInsights(clues, sensitivity = 1) {
  // Try LLM for the narrative + patterns; always have local as the floor.
  const local = correlateLocal(clues, sensitivity);
  if (await hasKey() && clues.length >= 4) {
    try {
      const recent = clues.slice(0, 80).map(c => ({
        when: c.createdAt, type: c.type, text: c.text, intensity: c.intensity, status: c.status, subtag: c.subtag,
      }));
      const sensWord = ['cautious', 'balanced', 'eager'][sensitivity] || 'balanced';
      const sys = `You are CLUE, a gentle, careful body-pattern companion. You analyze a person's self-logged "clues" (food, symptoms, activity, energy, sleep) and surface possible cause→effect patterns over time.
Rules: never claim causation; speak in graded confidence; be honest about exceptions and small samples; this is not medical advice. Sensitivity is "${sensWord}" — cautious = only surface well-supported patterns; eager = include early hunches.
Reply with ONLY minified JSON:
{"summary": 2-3 warm sentences about the week, "stats": {"logged": n, "watched": n, "actionable": n}, "patterns": [{"input": short label, "symptom": short label, "confidence": 0..1, "label": "Likely"|"Worth watching"|"Early hunch", "windowText": e.g. "within ~1 day", "desc": one honest sentence, "matched": n, "recommendation": one gentle suggestion, "evidence": [{"date":"Aug 12","lagHours": number, "matched": true/false}]}], "experiment": one small testable suggestion or null}
Order patterns strongest first. Max 4 patterns. Use the person's own dates.`;
      const out = await callClaude(sys, `Today is ${new Date().toDateString()}. Clues (newest first):\n${JSON.stringify(recent)}`, 1600);
      const j = extractJSON(out);
      if (j && Array.isArray(j.patterns)) { j.source = 'ai'; return normalizeInsights(j); }
    } catch (e) { /* fall through */ }
  }
  return local;
}

function normalizeInsights(j) {
  j.patterns = (j.patterns || []).map((p, i) => {
    const conf = typeof p.confidence === 'number' ? p.confidence : 0.5;
    return {
      id: 'p' + i,
      input: p.input || '—', symptom: p.symptom || '—',
      confidence: conf,
      label: p.label || (conf >= 0.7 ? 'Likely' : conf >= 0.45 ? 'Worth watching' : 'Early hunch'),
      level: Math.max(1, Math.min(5, Math.round(conf * 5))),
      windowText: p.windowText || 'over time',
      desc: p.desc || '',
      matched: p.matched || (p.evidence ? p.evidence.length : 0),
      recommendation: p.recommendation || '',
      evidence: (p.evidence || []).slice(0, 6),
    };
  });
  return j;
}

// ---------- local correlation engine ----------
function correlateLocal(clues, sensitivity) {
  const asc = [...clues].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const foods = asc.filter(c => c.type === 'food');
  const activities = asc.filter(c => c.type === 'activity');
  const WIN_MIN = 2, WIN_MAX = 36; // hours

  const patterns = [];
  // food-tag → symptom-group
  for (const grp of Object.keys(SYMPTOM_GROUPS)) {
    const instances = asc.filter(c => c.type === 'symptom' && (has((c.text || '').toLowerCase(), SYMPTOM_GROUPS[grp])));
    if (instances.length < 2) continue;
    for (const tag of Object.keys(FOOD_TAGS)) {
      let matched = 0; const evidence = [];
      for (const sym of instances.slice(-6)) {
        const symT = new Date(sym.createdAt).getTime();
        // nearest preceding food with this tag in window
        let hit = null;
        for (const f of foods) {
          const ft = new Date(f.createdAt).getTime();
          const lag = (symT - ft) / 3600000;
          if (lag >= WIN_MIN && lag <= WIN_MAX && tagsIn((f.text || '').toLowerCase(), FOOD_TAGS).includes(tag)) {
            if (!hit || ft > new Date(hit.createdAt).getTime()) hit = f;
          }
        }
        if (hit) {
          matched++;
          const lagH = (symT - new Date(hit.createdAt).getTime()) / 3600000;
          evidence.push({ date: fmtDay(sym.createdAt), lagHours: Math.round(lagH), matched: true });
        } else {
          evidence.push({ date: fmtDay(sym.createdAt), lagHours: null, matched: false });
        }
      }
      const denom = Math.min(instances.length, 6);
      const rate = matched / denom;
      if (matched >= 2) {
        patterns.push(buildPattern(cap(tag), grp, rate, matched, denom, 'within ~1 day', evidence, sensitivity));
      }
    }
  }
  // skipped workout → low energy / low motivation
  const lowEnergy = asc.filter(c => c.type === 'energy' && (c.intensity == null || c.intensity <= 4 || /low|foggy|sluggish|drained|groggy|motivat/.test((c.text || '').toLowerCase())));
  if (lowEnergy.length >= 2) {
    const poorSleep = asc.filter(c => c.type === 'sleep' && /bad|woke|poor|insomnia|awake|couldn|short|little/.test((c.text || '').toLowerCase()));
    let matched = 0; const evidence = [];
    for (const e of lowEnergy.slice(-6)) {
      const et = new Date(e.createdAt).getTime();
      const hit = poorSleep.find(s => { const lag = (et - new Date(s.createdAt).getTime()) / 3600000; return lag >= 0 && lag <= 16; });
      if (hit) { matched++; evidence.push({ date: fmtDay(e.createdAt), lagHours: Math.round((et - new Date(hit.createdAt).getTime()) / 3600000), matched: true }); }
      else evidence.push({ date: fmtDay(e.createdAt), lagHours: null, matched: false });
    }
    const denom = Math.min(lowEnergy.length, 6);
    if (matched >= 2) patterns.push(buildPattern('Short sleep', 'Low energy', matched / denom, matched, denom, 'the next morning', evidence, sensitivity));
  }

  patterns.sort((a, b) => b.confidence - a.confidence);
  const top = patterns.slice(0, 4);
  const summary = composeSummary(clues, top);
  return {
    source: 'local',
    summary,
    stats: { logged: clues.length, watched: top.length, actionable: top.filter(p => p.confidence >= 0.7).length },
    patterns: top,
    experiment: top[0] ? `Try ${top[0].confidence >= 0.6 ? '3' : 'a few'} ${String(top[0].input).toLowerCase()}-free days and keep logging as usual — I'll watch whether your ${String(top[0].symptom).toLowerCase()} settles.` : null,
  };
}

function buildPattern(input, symptom, rate, matched, denom, windowText, evidence, sensitivity) {
  // sensitivity shifts thresholds: 0 cautious, 1 balanced, 2 eager
  const bump = [0.1, 0, -0.1][sensitivity] ?? 0;
  let label = 'Early hunch';
  if (rate >= 0.75 + bump && matched >= 3) label = 'Likely';
  else if (rate >= 0.5 + bump) label = 'Worth watching';
  const confidence = Math.max(0.2, Math.min(0.95, rate * (matched >= 3 ? 1 : 0.85)));
  return {
    id: (input + symptom).replace(/\s/g, ''),
    input, symptom, confidence, label,
    level: Math.max(1, Math.min(5, Math.round(confidence * 5))),
    windowText, matched,
    desc: `${matched} of your last ${denom} ${symptom.toLowerCase()} ${matched === 1 ? 'followed' : 'followed'} ${input.toLowerCase()} ${windowText}.` + (label === 'Early hunch' ? ' Early signal — I need more clues to trust it.' : ''),
    recommendation: `Consider easing off ${input.toLowerCase()} for a few days and see if your ${symptom.toLowerCase()} settles. I'll keep matching the clues either way.`,
    evidence,
  };
}

function composeSummary(clues, patterns) {
  if (!clues.length) return 'Start logging clues and I’ll begin looking for patterns in how your body responds.';
  if (!patterns.length) return `You've logged ${clues.length} clue${clues.length === 1 ? '' : 's'}. No clear patterns yet — keep going and I'll surface connections as they emerge.`;
  const p = patterns[0];
  return `You've logged ${clues.length} clues. The clearest thread: your ${p.symptom.toLowerCase()} keep landing ${p.windowText} after ${p.input.toLowerCase()}. Here's what I'm watching.`;
}

// ---------- proactive trigger check on capture ----------
export function checkTrigger(newClue, insights) {
  if (!newClue || newClue.type !== 'food' || !insights || !insights.patterns) return null;
  const text = (newClue.text || '').toLowerCase();
  for (const p of insights.patterns) {
    const key = String(p.input).toLowerCase();
    const tagWords = FOOD_TAGS[key] || [key];
    if (tagWords.some(w => text.includes(w)) && p.confidence >= 0.5) {
      return `Heads up — ${key} has come before your ${String(p.symptom).toLowerCase()} before. I'll keep watch over the next day.`;
    }
  }
  return null;
}

function fmtDay(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
