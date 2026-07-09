import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PRIORITY_MAP: Record<number, string> = {
  0: 'CRIT',
  1: 'HIGH',
  2: 'MED',
  3: 'LOW',
  4: 'BKLOG',
};

function priorityStr(p: number): string {
  return PRIORITY_MAP[p] ?? `P${p}`;
}

function statusMark(s: string): string {
  switch (s) {
    case 'closed':
      return '✓';
    case 'in_progress':
    case 'in-progress':
      return '◐';
    case 'blocked':
      return '⛔';
    default:
      return ' ';
  }
}

function statusBox(s: string): string {
  switch (s) {
    case 'closed':
      return '[✓]';
    case 'in_progress':
    case 'in-progress':
      return '[→]';
    case 'blocked':
      return '[⛔]';
    default:
      return '[ ]';
  }
}

interface BeadRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  labels: string[];
  estimate_hours: number;
  dependencies: string[];
  assignee?: string;
  notes: string;
  started_at?: string;
  closed_at?: string;
}

const rawInput = process.argv.slice(2).join(' ');
const trimmed = rawInput.trim().toLowerCase();

function detectMode(): string {
  if (/active\s+work/.test(trimmed)) return 'active';
  if (/^dependency/.test(trimmed) || /^dependencies/.test(trimmed) || /show\s+dependencies/.test(trimmed)) return 'dep';
  if (/^metadata\b/.test(trimmed) || /^show\s+metadata\b/.test(trimmed)) return 'meta';
  if (/^focus\s+on\b/.test(trimmed)) return 'focus';
  return 'full';
}

function runBdJson(args: string[]): [number, string, string | null] {
  const result = spawnSync(process.env.BD ?? 'bd', ['show', '--json', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return [result.status ?? 1, result.stdout || result.stderr || '', result.stderr || null];
  }
  return [0, result.stdout, null];
}

function extractBeadsFromBdShow(issueId: string): BeadRow[] {
  const rc = runBdJson([issueId, '--children', '--include-dependents']);
  if (rc[0] !== 0 || !rc[1].trim()) return [];
  try {
    const arr = JSON.parse(rc[1]);
    if (!Array.isArray(arr)) return [];
    return arr.map((item: Record<string, unknown>) => {
      const labels = Array.isArray(item.labels) ? item.labels.map(String) : [];
      const estimate = typeof item.estimate_hours === 'number'
        ? item.estimate_hours
        : typeof item.estimate === 'number'
          ? item.estimate
          : 0;
      const dependencies = Array.isArray((item as Record<string, unknown>).dependencies)
        ? ((item as Record<string, unknown>).dependencies as unknown[]).map((d) => {
            if (typeof d === 'string') return d;
            if (typeof d === 'object' && d !== null) {
              const dd = d as Record<string, unknown>;
              return typeof dd.depends_on_id === 'string' ? (dd.depends_on_id as string) : '';
            }
            return '';
          }).filter((v: string) => v.length > 0)
        : [];
      return {
        id: String(item.id ?? item.issue_id ?? ''),
        title: String(item.title ?? ''),
        status: String(item.status ?? 'open'),
        priority: typeof item.priority === 'number' ? item.priority : 4,
        labels,
        estimate_hours: estimate,
        dependencies,
        assignee: typeof item.assignee === 'string' ? (item.assignee as string) : undefined,
        notes: String((item as Record<string, unknown>).notes ?? (item as Record<string, unknown>).description ?? ''),
        started_at: typeof item.started_at === 'string' ? (item.started_at as string) : undefined,
        closed_at: typeof item.closed_at === 'string' ? (item.closed_at as string) : undefined,
      };
    });
  } catch {
    return [];
  }
}

function extractBeadsFromJsonl(seedId: string): BeadRow[] {
  const out: BeadRow[] = [];
  const seen = new Set<string>();
  const jsonl = '.beads/issues.jsonl';
  if (!existsSync(jsonl)) return out;
  const raw = readFileSync(jsonl, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec._type !== 'issue') continue;
      const rawId = String(rec.id ?? '');
      if (!rawId) continue;
      if (rawId === seedId || rawId.startsWith(`${seedId}.`) || rawId.startsWith(`${seedId}-`)) {
        if (seen.has(rawId)) continue;
        seen.add(rawId);
        const labels: string[] = Array.isArray(rec.labels) ? rec.labels.map(String) : [];
        const estRaw = rec.estimate;
        const est = typeof estRaw === 'number' ? estRaw : 0;
        const deps: string[] = Array.isArray(rec.dependencies)
          ? rec.dependencies.map((d: Record<string, unknown>) => d.depends_on_id ? String(d.depends_on_id) : '').filter(Boolean)
          : [];
        out.push({
          id: rawId,
          title: String(rec.title ?? ''),
          status: String(rec.status ?? 'open'),
          priority: typeof rec.priority === 'number' ? rec.priority : 4,
          labels,
          estimate_hours: est,
          dependencies: deps,
          assignee: typeof rec.assignee === 'string' ? rec.assignee : undefined,
          notes: String(rec.notes ?? rec.description ?? ''),
          started_at: typeof rec.started_at === 'string' ? rec.started_at : undefined,
          closed_at: typeof rec.closed_at === 'string' ? rec.closed_at : undefined,
        });
      }
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) => {
    if (a.id === seedId) return -1;
    if (b.id === seedId) return 1;
    return a.status.localeCompare(b.status);
  });
}

function getBeads(issueId: string): BeadRow[] {
  return extractBeadsFromBdShow(issueId).length > 0
    ? extractBeadsFromBdShow(issueId)
    : extractBeadsFromJsonl(issueId);
}

function inlineMeta(bead: BeadRow, fullTags = false): string {
  const pStr = priorityStr(bead.priority);
  const estStr = bead.estimate_hours > 0 ? `e:${bead.estimate_hours}h` : '';
  const labels = bead.labels;
  let labelStr = '';
  if (labels.length > 0) {
    const shown = fullTags
      ? labels.join(',')
      : labels.length > 2
        ? `${labels.slice(0, 2).join(',')} (+${labels.length - 2})`
        : labels.join(',');
    labelStr = `t:${shown}`;
  }
  const parts = [pStr, estStr, labelStr].filter(Boolean);
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

// ----- Full Graph -----
function renderFullGraph(beads: BeadRow[], issueId: string): void {
  const beadMap = new Map(beads.map((b) => [b.id, b]));
  const seed = beadMap.get(issueId);
  if (!seed) {
    console.log(`No beads found for: ${issueId}`);
    return;
  }

  const childMap = new Map<string, BeadRow[]>();
  for (const b of beads) {
    if (b.id === issueId) continue;
    if (b.dependencies.length === 0) continue;
    const depId = b.dependencies[0];
    if (depId === b.id) continue;
    const arr = childMap.get(depId) ?? [];
    arr.push(b);
    childMap.set(depId, arr);
  }

  function walk(bead: BeadRow, depth: number, isLast: boolean, visited = new Set<string>()): void {
    if (visited.has(bead.id) && bead.id !== issueId) return;
    visited.add(bead.id);
    const indent = '│   '.repeat(depth);
    const prefix = depth === 0 ? 'Feature: ' : isLast ? '└── ' : '├── ';
    const title = bead.title.length > 55 ? bead.title.slice(0, 52) + '...' : bead.title;
    if (depth === 0) {
      console.log(`${prefix}${title}`);
    } else {
      const meta = inlineMeta(bead);
      console.log(`${indent}${prefix}${statusBox(bead.status)} ${title}${meta}`);
    }
    const children = (childMap.get(bead.id) ?? [])
      .filter((c) => c.id !== bead.id)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.title.localeCompare(b.title);
      });
    for (let i = 0; i < children.length; i++) {
      walk(children[i], depth + 1, i === children.length - 1, visited);
    }
  }
  walk(seed, 0, true);
  console.log('');
  console.log(`Total beads shown: ${beads.length}`);
}

// ----- Focus -----
function renderFocus(beads: BeadRow[], issueId: string): void {
  const beadMap = new Map(beads.map((b) => [b.id, b]));
  const seed = beadMap.get(issueId);
  if (!seed) {
    console.log('No beads found matching focus criteria.');
    return;
  }
  const related = beads
    .filter((b) => b.id !== issueId && (b.dependencies.includes(seed.id) || seed.dependencies.includes(b.id)))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.status.localeCompare(b.status);
    });
  console.log(`Focus: ${seed.title}`);
  console.log(`Seed: ${statusBox(seed.status)} ${seed.id}${inlineMeta(seed)}`);
  console.log(`Dependencies: ${seed.dependencies.length > 0 ? seed.dependencies.join(', ') : '(none)'}`);
  console.log('');
  if (related.length === 0) {
    console.log('(no related beads)');
    return;
  }
  const statusOrder = ['in_progress', 'in-progress', 'open', 'blocked', 'closed', 'deferred'];
  const groups = new Map<string, BeadRow[]>();
  for (const b of related) {
    if (!groups.has(b.status)) groups.set(b.status, []);
    groups.get(b.status)!.push(b);
  }
  for (const s of statusOrder) {
    const arr = groups.get(s);
    if (!arr || arr.length === 0) continue;
    console.log(`\n[${s.toUpperCase().replace('_', ' ')}]`);
    for (const b of arr) {
      const rel = b.dependencies.includes(seed.id) ? '← dependent' : '→ dependency';
      console.log(` ${statusBox(b.status)} ${b.title} (${rel})${inlineMeta(b)}`);
      console.log(`   ID: ${b.id}`);
    }
  }
}

// ----- Active Work -----
function renderActive(beads: BeadRow[]): void {
  const order: Record<string, number> = { in_progress: 0, 'in-progress': 0, blocked: 1, open: 2, deferred: 3 };
  const incomplete = beads
    .filter((b) => b.status !== 'closed')
    .sort((a, b) => {
      const ao = order[a.status] ?? 4;
      const bo = order[b.status] ?? 4;
      if (ao !== bo) return ao - bo;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.title.localeCompare(b.title);
    });
  if (incomplete.length === 0) {
    console.log('No active/ready work found.');
    return;
  }
  for (const b of incomplete) {
    const mark = statusMark(b.status);
    console.log(`${statusBox(b.status)} ${b.title}${inlineMeta(b)}`);
    console.log(`   ID: ${b.id}`);
    console.log(`   Status: ${b.status}`);
    console.log(`   Dependencies: ${b.dependencies.length > 0 ? b.dependencies.join(', ') : '(none)'}`);
    if (b.status === 'open' && b.dependencies.length > 0) console.log('   → next recommended (all deps closed)');
    if (b.notes) {
      const note = b.notes.length > 120 ? b.notes.slice(0, 117) + '...' : b.notes;
      console.log(`   Notes: ${note.replace(/\n/g, ' ')}`);
    }
    console.log('');
  }
  console.log(`Total shown: ${incomplete.length}`);
}

// ----- Dependency View -----
function renderDep(beads: BeadRow[]): void {
  const beadsById = new Map(beads.map((b) => [b.id, b]));
  const incomplete = beads.filter((b) => b.status !== 'closed');
  console.log(`Incomplete: ${incomplete.length} of ${beads.length} beads\n`);
  for (const bead of incomplete) {
    console.log(`${statusMark(bead.status)} ${bead.title.length > 50 ? bead.title.slice(0,47)+'...' : bead.title}${inlineMeta(bead)}`);
    console.log(`  ID: ${bead.id}`);
    if (bead.dependencies.length === 0) {
      console.log('  Status: unblocked (no dependencies)');
    } else {
      for (const depId of bead.dependencies) {
        const dep = beadsById.get(depId);
        const blocked = dep && dep.status !== 'closed';
        const arrow = blocked ? '⛔ blocked by' : '→ depends on';
        const depTitle = dep ? dep.title.length > 50 ? dep.title.slice(0,47)+'...' : dep.title : '(unknown)';
        console.log(`  ${arrow}: ${depId} ${depTitle}`);
      }
    }
    console.log('');
  }
}

// ----- Metadata View -----
function renderMeta(beads: BeadRow[], targetId?: string): void {
  let rows = beads;
  if (targetId) {
    const exact = beads.find((b) => {
      if (b.id === targetId) return true;
      if (targetId.length < b.id.length && (b.id.startsWith(`${targetId}.`) || b.id.startsWith(`${targetId}-`))) return true;
      return false;
    });
    if (exact) {
      rows = [exact];
    } else {
      const startsWith = beads.filter((b) => b.id.toLowerCase().includes(targetId.toLowerCase()) || b.title.toLowerCase().includes(targetId.toLowerCase()));
      rows = startsWith;
      if (rows.length === 0) {
        console.log(`No beads matching: ${targetId}`);
        return;
      }
    }
  }
  for (const bead of rows) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`Bead: ${bead.id} — ${bead.title}`);
    console.log(`  Title:       ${bead.title}`);
    console.log(`  Status:      ${bead.status}`);
    console.log(`  Priority:    ${priorityStr(bead.priority).toLowerCase()}`);
    console.log(`  Tags:        [${bead.labels.map((l) => `"${l}"`).join(', ')}]`);
    if (bead.estimate_hours > 0) console.log(`  Estimate:    ${bead.estimate_hours} hours`);
    console.log(`  Template:    false`);
    console.log(`  Inherits:    []`);
    console.log(`  Dependencies: [${bead.dependencies.map((d) => `"${d}"`).join(', ')}]`);
    if (bead.assignee) console.log(`  Assignee:    ${bead.assignee}`);
    if (bead.notes) {
      const note = bead.notes.length > 200 ? bead.notes.slice(0, 197) + '...' : bead.notes;
      console.log(`  Notes:       ${note.replace(/\n/g, ' ')}`);
    }
  }
  console.log(`${'─'.repeat(60)}`);
}

// ----- main -----
function main(): void {
  // resolve target bead ID
  const tokens = rawInput.split(/\s+/);
  let targetBeadId = 'contextio-mol-os7';
  const explicitId = tokens.find((t) => /^[a-z0-9]+-[a-z0-9]+(\.[0-9]+)*$/i.test(t));
  if (explicitId) targetBeadId = explicitId;

  const mode = detectMode();

  // focus target
  let focusTarget: string | null = null;
  if (mode === 'focus') {
    const m = rawInput.match(/focus on\s+(.+)/i);
    if (m) focusTarget = m[1].trim();
  }

  // metadata target
  let metaTarget: string | undefined;
  const metaForMatch = rawInput.match(/metadata\s+for\s+(.+)/i);
  if (metaForMatch) {
    metaTarget = metaForMatch[1].trim();
  } else if (mode === 'meta') {
    metaTarget = rawInput
      .replace(/^(show\s+)?metadata\s*/i, '')
      .trim()
      .replace(/^for\s*/i, '')
      .trim() || undefined;
  }

  let beads = getBeads(targetBeadId);
  let issueIdForRender = targetBeadId;
  if (mode === 'focus' && focusTarget) {
    const matched = beads.find(
      (b) => b.title.toLowerCase().includes(focusTarget.toLowerCase()) || b.id.toLowerCase().includes(focusTarget.toLowerCase()),
    );
    if (matched) issueIdForRender = matched.id;
  }
  if (mode === 'meta' && metaTarget) {
    const exact = beads.find((b) => b.id === metaTarget || b.id.startsWith(`${metaTarget}.`) || b.id.startsWith(`${metaTarget}-`));
    if (!exact && metaTarget !== targetBeadId) {
      beads = getBeads(metaTarget);
    }
    issueIdForRender = metaTarget;
  }

  const modeLabel =
    mode === 'full' ? 'Full Graph'
    : mode === 'focus' ? 'Focus Mode'
    : mode === 'active' ? 'Active Work'
    : mode === 'dep' ? 'Dependency View'
    : 'Metadata View';

  const headerSeed = issueIdForRender !== targetBeadId ? ` — ${issueIdForRender}` : '';
  console.log(`🫧 bd-show${headerSeed}`);
  console.log(`Mode: ${modeLabel}`);
  console.log('');

  switch (mode) {
    case 'full':
      console.log(`Hierarchy — ${beads.length} beads:`);
      console.log('');
      renderFullGraph(beads, issueIdForRender);
      break;
    case 'focus':
      renderFocus(beads, issueIdForRender);
      console.log('');
      console.log(`Related beads shown: ${beads.length}`);
      break;
    case 'active':
      renderActive(beads);
      break;
    case 'dep':
      renderDep(beads);
      break;
    case 'meta':
      renderMeta(beads, metaTarget ?? undefined);
      break;
  }
}

main();
