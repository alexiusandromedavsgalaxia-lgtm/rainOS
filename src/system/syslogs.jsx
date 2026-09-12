// ============================================================================
// syslogs.jsx — Sistema de logs unificado (estilo os_log de Apple)
// ----------------------------------------------------------------------------
// Implementa un sistema de logs como el de macOS unified logging:
//
//   - Canales por subsystem + category (ej: com.apple.network, "default")
//   - Niveles: default, info, debug, error, fault
//   - Filtros por nivel, subsystem, category, proceso, tiempo
//   - Búsqueda con texto libre y regex
//   - Ring buffer por canal (1000 entradas por defecto)
//   - Subscribers (stream en vivo)
//   - Persistencia opcional en localStorage
//   - Exportación a JSON / texto / syslog
//   - Histograma por nivel y por subsystem
//   - Rotación automática
//   - Live console (métricas en vivo)
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// NIVELES
// ============================================================================

export const LOG_LEVEL = Object.freeze({
  DEFAULT: "default",
  INFO: "info",
  DEBUG: "debug",
  ERROR: "error",
  FAULT: "fault",
});

export const LOG_LEVEL_NUM = Object.freeze({
  default: 0,
  info: 1,
  debug: 2,
  error: 3,
  fault: 4,
});

export const SYSLOG_EVENTS = Object.freeze({
  LOG_EMITTED: "syslog:emitted",
  CHANNEL_CREATED: "syslog:channel-created",
  CHANNEL_CLEARED: "syslog:channel-cleared",
  ALL_CLEARED: "syslog:all-cleared",
  FILTER_CHANGED: "syslog:filter-changed",
  ERROR: "syslog:error",
});

// ============================================================================
// LOG ENTRY
// ============================================================================

class LogEntry {
  constructor({ level, subsystem, category, message, pid, tid, meta }) {
    this.id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.ts = Date.now();
    this.level = level;
    this.levelNum = LOG_LEVEL_NUM[level] ?? 0;
    this.subsystem = subsystem || "com.rainos.system";
    this.category = category || "default";
    this.message = String(message ?? "");
    this.pid = pid ?? null;
    this.tid = tid ?? null;
    this.meta = meta ?? null;
  }
}

// ============================================================================
// LOG CHANNEL
// ============================================================================

class LogChannel {
  constructor({ subsystem, category, max = 1000 }) {
    this.subsystem = subsystem;
    this.category = category;
    this.max = max;
    this.entries = [];
    this.stats = {
      default: 0, info: 0, debug: 0, error: 0, fault: 0,
      total: 0, bytesApprox: 0,
    };
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    this.stats[entry.level] = (this.stats[entry.level] || 0) + 1;
    this.stats.total++;
    this.stats.bytesApprox += entry.message.length;
  }

  clear() {
    this.entries = [];
    this.stats = {
      default: 0, info: 0, debug: 0, error: 0, fault: 0,
      total: 0, bytesApprox: 0,
    };
  }

  all() {
    return [...this.entries];
  }
}

// ============================================================================
// SYSLOG SYSTEM
// ============================================================================

export class SyslogSystem {
  constructor({ persist = false, storageKey = "rainos.syslogs" } = {}) {
    this.channels = new Map(); // "subsystem:category" → LogChannel
    this.subscribers = new Set();
    this.persist = persist;
    this.storageKey = storageKey;
    this.filters = {
      minLevel: LOG_LEVEL.DEFAULT,
      subsystems: null,        // null = todos
      categories: null,
      pid: null,
      search: "",
      regex: null,
    };
    this.stats = {
      totalEmitted: 0,
      totalDropped: 0,
      perLevel: { default: 0, info: 0, debug: 0, error: 0, fault: 0 },
      perSubsystem: new Map(),
    };
    if (persist) this._load();
  }

  // --------------------------------------------------------------- suscripción
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this.subscribers) {
      try { fn(event, payload); } catch {}
    }
  }

  // --------------------------------------------------------------- canales
  _getChannel(subsystem, category) {
    const key = `${subsystem}:${category}`;
    if (!this.channels.has(key)) {
      this.channels.set(key, new LogChannel({ subsystem, category }));
      kernelBus.emit(SYSLOG_EVENTS.CHANNEL_CREATED, { subsystem, category });
    }
    return this.channels.get(key);
  }

  // --------------------------------------------------------------- emitir
  emit(level, subsystem, category, message, meta = null) {
    const entry = new LogEntry({
      level,
      subsystem,
      category,
      message,
      meta,
      pid: meta?.pid ?? null,
      tid: meta?.tid ?? null,
    });

    const channel = this._getChannel(subsystem, category);
    channel.push(entry);

    this.stats.totalEmitted++;
    this.stats.perLevel[level] = (this.stats.perLevel[level] || 0) + 1;
    this.stats.perSubsystem.set(
      subsystem,
      (this.stats.perSubsystem.get(subsystem) || 0) + 1
    );

    kernelBus.emit(SYSLOG_EVENTS.LOG_EMITTED, entry);
    this._emit("log", entry);

    if (this.persist) this._saveDebounced();
    return entry;
  }

  // Atajos
  default(s, c, m, x) { return this.emit(LOG_LEVEL.DEFAULT, s, c, m, x); }
  info(s, c, m, x) { return this.emit(LOG_LEVEL.INFO, s, c, m, x); }
  debug(s, c, m, x) { return this.emit(LOG_LEVEL.DEBUG, s, c, m, x); }
  error(s, c, m, x) { return this.emit(LOG_LEVEL.ERROR, s, c, m, x); }
  fault(s, c, m, x) { return this.emit(LOG_LEVEL.FAULT, s, c, m, x); }

  // --------------------------------------------------------------- filtros
  setFilter(patch) {
    Object.assign(this.filters, patch);
    if (patch.regex instanceof RegExp) {
      this.filters.regex = patch.regex;
    } else if (typeof patch.search === "string" && patch.search) {
      try { this.filters.regex = new RegExp(patch.search, "i"); }
      catch { this.filters.regex = null; }
    } else if (patch.search === "") {
      this.filters.regex = null;
    }
    kernelBus.emit(SYSLOG_EVENTS.FILTER_CHANGED, { ...this.filters });
    this._emit("filter", this.filters);
  }

  clearFilter() {
    this.filters = {
      minLevel: LOG_LEVEL.DEFAULT,
      subsystems: null,
      categories: null,
      pid: null,
      search: "",
      regex: null,
    };
    kernelBus.emit(SYSLOG_EVENTS.FILTER_CHANGED, { ...this.filters });
    this._emit("filter", this.filters);
  }

  _matches(entry) {
    const f = this.filters;
    if (LOG_LEVEL_NUM[entry.level] < LOG_LEVEL_NUM[f.minLevel]) return false;
    if (f.subsystems && !f.subsystems.includes(entry.subsystem)) return false;
    if (f.categories && !f.categories.includes(entry.category)) return false;
    if (f.pid != null && entry.pid !== f.pid) return false;
    if (f.regex && !f.regex.test(entry.message)) return false;
    return true;
  }

  // --------------------------------------------------------------- queries
  query({ subsystem = null, category = null, limit = 500 } = {}) {
    const out = [];
    if (subsystem && category) {
      const ch = this.channels.get(`${subsystem}:${category}`);
      if (ch) out.push(...ch.entries);
    } else if (subsystem) {
      for (const [key, ch] of this.channels) {
        if (ch.subsystem === subsystem) out.push(...ch.entries);
      }
    } else {
      for (const ch of this.channels.values()) out.push(...ch.entries);
    }
    return out
      .filter((e) => this._matches(e))
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit);
  }

  listChannels() {
    return Array.from(this.channels.values()).map((ch) => ({
      subsystem: ch.subsystem,
      category: ch.category,
      count: ch.entries.length,
      stats: { ...ch.stats },
    }));
  }

  histogramByLevel() {
    const h = { default: 0, info: 0, debug: 0, error: 0, fault: 0 };
    for (const ch of this.channels.values()) {
      for (const lvl of Object.keys(h)) h[lvl] += ch.stats[lvl] || 0;
    }
    return h;
  }

  histogramBySubsystem() {
    const h = {};
    for (const ch of this.channels.values()) {
      h[ch.subsystem] = (h[ch.subsystem] || 0) + ch.entries.length;
    }
    return h;
  }

  // --------------------------------------------------------------- clear
  clearChannel(subsystem, category) {
    const key = `${subsystem}:${category}`;
    const ch = this.channels.get(key);
    if (ch) {
      ch.clear();
      kernelBus.emit(SYSLOG_EVENTS.CHANNEL_CLEARED, { subsystem, category });
    }
  }

  clearAll() {
    for (const ch of this.channels.values()) ch.clear();
    kernelBus.emit(SYSLOG_EVENTS.ALL_CLEARED, {});
  }

  // --------------------------------------------------------------- export
  export({ format = "json", limit = 10000 } = {}) {
    const entries = this.query({ limit });
    if (format === "json") {
      return JSON.stringify(
        entries.map((e) => ({
          ts: e.ts,
          level: e.level,
          subsystem: e.subsystem,
          category: e.category,
          message: e.message,
          pid: e.pid,
          meta: e.meta,
        })),
        null,
        2
      );
    }
    if (format === "text") {
      return entries
        .map((e) =>
          `[${new Date(e.ts).toISOString()}] [${e.level}] ${e.subsystem}:${e.category}: ${e.message}`
        )
        .join("\n");
    }
    if (format === "syslog") {
      const SYSLOG_PRIO = { fault: 0, error: 3, default: 5, info: 6, debug: 7 };
      return entries
        .map((e) => {
          const prio = SYSLOG_PRIO[e.level] ?? 5;
          return `<${prio}>${new Date(e.ts).toISOString()} ${e.subsystem}[${e.pid || 0}]: ${e.message}`;
        })
        .join("\n");
    }
    return "";
  }

  // --------------------------------------------------------------- persist
  _saveDebounced() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 500);
  }

  _save() {
    try {
      const data = {
        ts: Date.now(),
        channels: Array.from(this.channels.values()).map((ch) => ({
          subsystem: ch.subsystem,
          category: ch.category,
          entries: ch.entries.slice(-200).map((e) => ({
            ts: e.ts, level: e.level, message: e.message,
            pid: e.pid, meta: e.meta,
          })),
        })),
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (err) {
      kernelBus.emit(SYSLOG_EVENTS.ERROR, { error: String(err) });
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const ch of data.channels || []) {
        const channel = this._getChannel(ch.subsystem, ch.category);
        for (const e of ch.entries || []) {
          channel.push(new LogEntry({
            ts: e.ts,
            level: e.level,
            subsystem: ch.subsystem,
            category: ch.category,
            message: e.message,
            pid: e.pid,
            meta: e.meta,
          }));
        }
      }
    } catch (err) {
      kernelBus.emit(SYSLOG_EVENTS.ERROR, { error: String(err) });
    }
  }

  snapshot() {
    return {
      channels: this.channels.size,
      totalEmitted: this.stats.totalEmitted,
      totalDropped: this.stats.totalDropped,
      perLevel: { ...this.stats.perLevel },
      perSubsystem: Object.fromEntries(this.stats.perSubsystem),
      filters: { ...this.filters, regex: this.filters.regex ? String(this.filters.regex) : null },
    };
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const SyslogsContext = React.createContext(null);

export function SyslogsProvider({
  children,
  system: external,
  persist = false,
  storageKey = "rainos.syslogs",
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new SyslogSystem({ persist, storageKey });
  }
  const system = ref.current;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsub = system.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, [system]);

  const api = useMemo(
    () => ({
      system,
      emit: (level, s, c, m, x) => system.emit(level, s, c, m, x),
      default: (s, c, m, x) => system.default(s, c, m, x),
      info: (s, c, m, x) => system.info(s, c, m, x),
      debug: (s, c, m, x) => system.debug(s, c, m, x),
      error: (s, c, m, x) => system.error(s, c, m, x),
      fault: (s, c, m, x) => system.fault(s, c, m, x),
      query: (opts) => system.query(opts),
      listChannels: () => system.listChannels(),
      clearChannel: (s, c) => system.clearChannel(s, c),
      clearAll: () => system.clearAll(),
      setFilter: (patch) => system.setFilter(patch),
      clearFilter: () => system.clearFilter(),
      histogramByLevel: () => system.histogramByLevel(),
      histogramBySubsystem: () => system.histogramBySubsystem(),
      export: (opts) => system.export(opts),
      snapshot: () => system.snapshot(),
      subscribe: (fn) => system.subscribe(fn),
      tick,
    }),
    [system, tick]
  );

  return (
    <SyslogsContext.Provider value={api}>{children}</SyslogsContext.Provider>
  );
}

export function useSyslogs() {
  const ctx = React.useContext(SyslogsContext);
  if (!ctx) throw new Error("useSyslogs must be used within SyslogsProvider");
  return ctx;
}

export default {
  SyslogSystem,
  LogChannel,
  LogEntry,
  SyslogsProvider,
  useSyslogs,
  LOG_LEVEL,
  LOG_LEVEL_NUM,
  SYSLOG_EVENTS,
};
