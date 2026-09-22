/**
 * FTS5 index for task/session search (hermes-agent speed port).
 *
 * `queryTaskList` used to scan with `LOWER(title) LIKE ? OR
 * LOWER(searchable_text) LIKE ?` — seconds of CPU on multi-GB installs.
 * This module keeps an external-content FTS5 table (`tasks_fts`, indexed
 * columns only, no text duplication) in sync via triggers, with a
 * creation-marker-gated rebuild for pre-index rows.
 *
 * Best-effort by design: FTS5 availability differs across runtimes
 * (node:sqlite vs Electron builds), so `ensureTasksFts` probes and
 * returns false instead of throwing, and callers fall back to LIKE.
 * CJK queries also fall back to LIKE: the stock unicode61 tokenizer does
 * not segment CJK, and node:sqlite cannot load Hermes' bigram tokenizer.
 */

import type { DatabaseSync } from "node:sqlite";

/** CJK Unified / Extensions / Compat / Kana / Hangul ranges. */
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿぀-ヿᄀ-ᇿ가-힯ｦ-ﾟ]/u;

const MAX_FTS_TERMS = 10;
const MAX_FTS_QUERY_CHARS = 500;

/**
 * Build an FTS5 MATCH expression for AND-of-quoted-terms semantics, or
 * null when the query must use the LIKE fallback (empty, CJK-bearing, or
 * no indexable terms).
 */
export function buildTasksFtsQuery(search: string): string | null {
  const trimmed = search.trim();
  if (!trimmed || CJK_PATTERN.test(trimmed)) return null;
  const terms: string[] = [];
  for (const raw of trimmed.split(/\s+/)) {
    // Inside double quotes FTS5 treats everything literally except `"`;
    // strip quotes and C0 controls so terms cannot break the MATCH syntax.
    let cleaned = "";
    for (const ch of raw) {
      if (ch !== '"' && (ch.codePointAt(0) ?? 0) >= 0x20) cleaned += ch;
    }
    if (!cleaned) continue;
    // Pure-punctuation terms tokenize to nothing; keep one only if it is
    // the whole query so LIKE fallback (not zero rows) handles it.
    terms.push(`"${cleaned.replace(/"/g, '""')}"`);
    if (terms.length >= MAX_FTS_TERMS) break;
  }
  if (terms.length === 0) return null;
  const query = terms.join(" AND ");
  return query.length > MAX_FTS_QUERY_CHARS ? null : query;
}

const FTS_TRIGGER_NAMES = ["tasks_fts_ai", "tasks_fts_ad", "tasks_fts_au"] as const;

function schemaHas(db: DatabaseSync, type: string, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name) as { ok: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Create/sync the FTS5 index. Idempotent; returns true when the FTS search
 * path may be used. Never throws — failures disable FTS for this process.
 */
export function ensureTasksFts(db: DatabaseSync): boolean {
  try {
    const probe = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as
      | { v: number }
      | undefined;
    if (!probe || probe.v !== 1) return false;
    // NOTE: plain SELECT COUNT(*) on an external-content FTS5 table reads
    // through to the content table, so counts can never detect a stale
    // index. Rebuild exactly when this call creates the table or a missing
    // trigger; otherwise the triggers have kept every write in sync.
    const hadTable = schemaHas(db, "table", "tasks_fts");
    const missingTrigger = FTS_TRIGGER_NAMES.some((name) => !schemaHas(db, "trigger", name));
    db.exec(
      // Plain unicode61: some runtime SQLite builds reject tokenizer
      // options ("parse error in tokenize directive"); the default folds
      // case and strips diacritics, which is all search needs.
      `CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        title, searchable_text,
        content='tasks', content_rowid='rowid',
        tokenize='unicode61'
      )`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, title, searchable_text)
        VALUES (NEW.rowid, NEW.title, NEW.searchable_text);
      END;
      CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, searchable_text)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.searchable_text);
      END;
      CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, searchable_text)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.searchable_text);
        INSERT INTO tasks_fts(rowid, title, searchable_text)
        VALUES (NEW.rowid, NEW.title, NEW.searchable_text);
      END;`,
    );
    if (!hadTable || missingTrigger) {
      db.exec(`INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')`);
    }
    return true;
  } catch {
    return false;
  }
}
