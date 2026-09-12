// ============================================================================
// sysfiltered.jsx — Motor de filtros y búsqueda para logs y syscalls
// ----------------------------------------------------------------------------
// Proporciona un motor de filtrado y búsqueda reutilizable que se apoya en
// syslogs y syscalls. Pensado para alimentar una UI tipo Console.app.
//
// FUNCIONALIDADES
//
//   - Filtros por:
//       * nivel mínimo
//       * subsystem, category
//       * pid, tid
//       * rango temporal (desde/hasta)
//       * texto libre (substring, case-insensitive)
//       * regex (con flags i, m, s)
//       * categoría (process/file/memory/security/…)
//   - Búsqueda fuzzy
//   - Guardado de filtros como "presets" persistentes
//   - Parseo de "predicados" estilo Console.app:
//       level:error subsystem:com.apple.network pid:1234 "texto libre"
//   - Agrupación de resultados por subsystem/category/level/pid
//   - Estadísticas sobre los resultados filtrados
//   - Paginación (offset, limit)
//   - Diff entre dos conjuntos filtrados
// ============================================================================

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

const SYSFILTERED_STORAGE_KEY = "rainos.sysfiltered.presets";

// ============================================================================
// FUZZY MATCH
// ============================================================================

export function fuzzyMatch(query, target) {
  if (!query) return { matched: true, score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = (target || "").toLowerCase();
  if (!t) return { matched: false, score: 0, ranges: [] };

  // Exact substring → máxima puntuación
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return {
      matched: true,
      score: 1000 + q.length * 10 - idx,
      ranges: [[idx, idx + q.length]],
    };
  }

  // Subsequence match
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  const ranges = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10;
      if (lastMatch === ti - 1) score += 5;
      lastMatch = ti;
      ranges.push([ti, ti + 1]);
      qi++;
    }
  }
  if (qi < q.length) return { matched: false, score: 0, ranges: [] };
  return { matched: true, score, ranges };
}

// ============================================================================
// PREDICADO PARSER (estilo Console.app)
// ----------------------------------------------------------------------------
// Sintaxis:
//   level:error              → nivel igual
//   level>=info              → nivel >=
//   subsystem:com.apple.*    → wildcard permitido
//   category:network
//   pid:1234
//   tid:5678
//   since:"2026-01-01"
//   before:"2026-12-31"
//   "texto libre"            → búsqueda de substring
//   /regex/flags             → regex
//   category:file|network    → OR
// ============================================================================

function tokenizePredicate(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }

    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let s = "";
      while (i < input.length && input[i] !== quote) {
        s += input[i];
        i++;
      }
      i++;
      tokens.push({ type: "free", value: s });
      continue;
    }

    if (c === "/") {
      i++;
      let s = "";
      while (i < input.length && input[i] !== "/") {
        s += input[i];
        i++;
      }
      i++;
      let flags = "";
      while (i < input.length && /[gimsuy]/.test(input[i])) {
        flags += input[i];
        i++;
      }
      tokens.push({ type: "regex", value: s, flags: flags || "i" });
      continue;
    }

    // key(:|>=|<=|>|<)value  ó  free text
    let j = i;
    while (j < input.length && !/\s/.test(input[j])) j++;
    const word = input.slice(i, j);
    i = j;

    const m = word.match(/^([a-zA-Z_]+)(>=|<=|>|<|:|=)(.*)$/);
    if (m) {
      tokens.push({ type: "kv", key: m[1].toLowerCase(), op: m[2], value: m[3] });
    } else {
      tokens.push({ type: "free", value: word });
    }
  }
  return tokens;
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withWildcards}$`, "i");
}

function matchWildcard(pattern, value) {
  if (!pattern) return true;
  if (pattern === "*") return true;
  const alternates = pattern.split("|");
  for (const alt of alternates) {
    const rx = wildcardToRegex(alt);
    if (rx.test(value ?? "")) return true;
  }
  return false;
}

// ============================================================================
// FILTER ENGINE
// ============================================================================

export class FilterEngine {
  constructor() {
    this.presets = new Map();
    this._loadPresets();
  }

  // -------------------------------------------------------------- presets
  savePreset(name, filter) {
    this.presets.set(name, filter);
    this._savePresets();
    return true;
  }

  loadPreset(name) {
    return this.presets.get(name) ?? null;
  }

  deletePreset(name) {
    this.presets.delete(name);
    this._savePresets();
  }

  listPresets() {
    return Array.from(this.presets.entries()).map(([name, filter]) => ({ name, filter }));
  }

  _savePresets() {
    try {
      const data = Array.from(this.presets.entries());
      localStorage.setItem(SYSFILTERED_STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }

  _loadPresets() {
    try {
      const raw = localStorage.getItem(SYSFILTERED_STORAGE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const [name, filter] of arr) this.presets.set(name, filter);
      }
    } catch {}
  }

  // -------------------------------------------------------------- parse predicate
  parsePredicate(input) {
    const tokens = tokenizePredicate(input ?? "");
    const filter = {
      text: "",
      regex: null,
      regexFlags: "i",
      level: null,
      minLevel: null,
      subsystem: null,
      category: null,
      pid: null,
      tid: null,
      since: null,
      until: null,
      tag: null,
    };

    const levelOrder = { default: 0, info: 1, debug: 2, error: 3, fault: 4 };

    for (const tok of tokens) {
      if (tok.type === "free") {
        filter.text = (filter.text ? filter.text + " " : "") + tok.value;
        continue;
      }
      if (tok.type === "regex") {
        filter.regex = tok.value;
        filter.regexFlags = tok.flags;
        continue;
      }
      if (tok.type === "kv") {
        const { key, op, value } = tok;
        switch (key) {
          case "level":
            if (op === ":") filter.level = value.toLowerCase();
            else if (op === ">=") filter.minLevel = value.toLowerCase();
            else if (op === ">") {
              const idx = levelOrder[value.toLowerCase()] ?? 0;
              filter.minLevel = Object.keys(levelOrder).find((k) => levelOrder[k] === idx + 1) ?? "fault";
            }
            break;
          case "subsystem":
          case "sub":
            filter.subsystem = value;
            break;
          case "category":
          case "cat":
            filter.category = value;
            break;
          case "pid":
            filter.pid = Number(value);
            break;
          case "tid":
            filter.tid = Number(value);
            break;
          case "since":
            filter.since = Date.parse(value) || null;
            break;
          case "before":
          case "until":
            filter.until = Date.parse(value) || null;
            break;
          case "tag":
            filter.tag = value;
            break;
          default:
            break;
        }
      }
    }
    return filter;
  }

  // -------------------------------------------------------------- matches
  matches(entry, filter) {
    if (!filter) return true;
    const levelOrder = { default: 0, info: 1, debug: 2, error: 3, fault: 4 };

    if (filter.level) {
      if ((entry.level || "default").toLowerCase() !== filter.level) return false;
    }
    if (filter.minLevel) {
      const min = levelOrder[filter.minLevel] ?? 0;
      const cur = levelOrder[(entry.level || "default").toLowerCase()] ?? 0;
      if (cur < min) return false;
    }
    if (filter.subsystem) {
      if (!matchWildcard(filter.subsystem, entry.subsystem)) return false;
    }
    if (filter.category) {
      if (!matchWildcard(filter.category, entry.category)) return false;
    }
    if (filter.pid != null && entry.pid !== filter.pid) return false;
    if (filter.tid != null && entry.tid !== filter.tid) return false;
    if (filter.since != null && entry.ts < filter.since) return false;
    if (filter.until != null && entry.ts > filter.until) return false;
    if (filter.tag && entry.meta?.tag !== filter.tag) return false;

    if (filter.text) {
      const f = fuzzyMatch(filter.text, entry.message);
      if (!f.matched) return false;
    }
    if (filter.regex) {
      try {
        const rx = new RegExp(filter.regex, filter.regexFlags || "i");
        if (!rx.test(entry.message)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------- apply
  apply(entries, filter, { limit = 500, offset = 0, sort = "asc" } = {}) {
    let out = entries.filter((e) => this.matches(e, filter));
    out.sort((a, b) => (sort === "desc" ? b.ts - a.ts : a.ts - b.ts));
    const total = out.length;
    out = out.slice(offset, offset + limit);
    return { items: out, total, offset, limit };
  }

  // -------------------------------------------------------------- stats
  stats(entries, filter) {
    const filtered = entries.filter((e) => this.matches(e, filter));
    const byLevel = { default: 0, info: 0, debug: 0, error: 0, fault: 0 };
    const bySubsystem = {};
    const byCategory = {};
    let totalBytes = 0;
    let first = null;
    let last = null;

    for (const e of filtered) {
      byLevel[e.level ?? "default"] = (byLevel[e.level ?? "default"] || 0) + 1;
      bySubsystem[e.subsystem] = (bySubsystem[e.subsystem] || 0) + 1;
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      totalBytes += (e.message ?? "").length;
      if (first == null || e.ts < first) first = e.ts;
      if (last == null || e.ts > last) last = e.ts;
    }

    return {
      count: filtered.length,
      totalBytes,
      firstTs: first,
      lastTs: last,
      durationMs: first != null && last != null ? last - first : 0,
      byLevel,
      bySubsystem,
      byCategory,
    };
  }

  // -------------------------------------------------------------- group
  group(entries, filter, by = "subsystem") {
    const filtered = entries.filter((e) => this.matches(e, filter));
    const groups = new Map();
    for (const e of filtered) {
      const key = e[by] ?? "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    return Array.from(groups.entries())
      .map(([key, items]) => ({ key, items, count: items.length }))
      .sort((a, b) => b.count - a.count);
  }

  // -------------------------------------------------------------- diff
  diff(entries, filterA, filterB, { limit = 200 } = {}) {
    const setA = new Set(
      entries.filter((e) => this.matches(e, filterA)).map((e) => e.id)
    );
    const setB = new Set(
      entries.filter((e) => this.matches(e, filterB)).map((e) => e.id)
    );
    const onlyA = [];
    const onlyB = [];
    const both = [];
    for (const e of entries) {
      const inA = setA.has(e.id);
      const inB = setB.has(e.id);
      if (inA && inB) both.push(e);
      else if (inA) onlyA.push(e);
      else if (inB) onlyB.push(e);
    }
    return {
      onlyA: onlyA.slice(-limit),
      onlyB: onlyB.slice(-limit),
      both: both.slice(-limit),
      counts: { onlyA: onlyA.length, onlyB: onlyB.length, both: both.length },
    };
  }
}

// ============================================================================
// PRESETS POR DEFECTO
// ============================================================================

export const DEFAULT_PRESETS = Object.freeze({
  "Solo errores": { minLevel: "error" },
  "Solo faults": { level: "fault" },
  "Red": { subsystem: "com.apple.network|com.rainos.network" },
  "Seguridad": { subsystem: "com.apple.security|com.rainos.security" },
  "Últimos 5 min": { since: Date.now() - 5 * 60 * 1000 },
  "Batería": { subsystem: "com.rainos.battery|com.apple.powerd" },
});

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const SysfilteredContext = React.createContext(null);

export function SysfilteredProvider({ children, engine: external }) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new FilterEngine();
  }
  const engine = ref.current;

  const [filter, setFilter] = useState(() => ({
    text: "",
    regex: null,
    regexFlags: "i",
    level: null,
    minLevel: null,
    subsystem: null,
    category: null,
    pid: null,
    tid: null,
    since: null,
    until: null,
    tag: null,
  }));
  const [predicate, setPredicate] = useState("");
  const [presets, setPresets] = useState(() => engine.listPresets());

  const applyPredicate = useCallback(
    (text) => {
      setPredicate(text);
      const parsed = engine.parsePredicate(text);
      setFilter(parsed);
      return parsed;
    },
    [engine]
  );

  const setFilterPatch = useCallback(
    (patch) => {
      setFilter((f) => ({ ...f, ...patch }));
    },
    []
  );

  const clearFilter = useCallback(() => {
    setFilter({
      text: "",
      regex: null,
      regexFlags: "i",
      level: null,
      minLevel: null,
      subsystem: null,
      category: null,
      pid: null,
      tid: null,
      since: null,
      until: null,
      tag: null,
    });
    setPredicate("");
  }, []);

  const refreshPresets = useCallback(() => {
    setPresets(engine.listPresets());
  }, [engine]);

  const api = useMemo(
    () => ({
      engine,
      filter,
      predicate,
      presets,
      defaultPresets: DEFAULT_PRESETS,
      setFilter: setFilterPatch,
      applyPredicate,
      clearFilter,
      parsePredicate: (text) => engine.parsePredicate(text),
      matches: (entry, f) => engine.matches(entry, f ?? filter),
      apply: (entries, opts) => engine.apply(entries, filter, opts),
      stats: (entries) => engine.stats(entries, filter),
      group: (entries, by) => engine.group(entries, filter, by),
      diff: (entries, a, b, opts) => engine.diff(entries, a, b, opts),
      savePreset: (name, f) => {
        engine.savePreset(name, f ?? filter);
        refreshPresets();
      },
      loadPreset: (name) => {
        const f = engine.loadPreset(name);
        if (f) setFilter(f);
        return f;
      },
      deletePreset: (name) => {
        engine.deletePreset(name);
        refreshPresets();
      },
    }),
    [engine, filter, predicate, presets, setFilterPatch, applyPredicate, clearFilter, refreshPresets]
  );

  return (
    <SysfilteredContext.Provider value={api}>
      {children}
    </SysfilteredContext.Provider>
  );
}

export function useSysfiltered() {
  const ctx = React.useContext(SysfilteredContext);
  if (!ctx) throw new Error("useSysfiltered must be used within SysfilteredProvider");
  return ctx;
}

export default {
  FilterEngine,
  SysfilteredProvider,
  useSysfiltered,
  fuzzyMatch,
  DEFAULT_PRESETS,
};
