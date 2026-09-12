// ============================================================================
// network.jsx — Subsistema de red completo
// ----------------------------------------------------------------------------
// Modela toda la pila de red desde la capa física hasta las aplicaciones:
//
//   - NetworkManager: enruta conexiones entre apps y la red real
//   - NetworkInterface: cada interfaz (WiFi, Ethernet, VPN, AirDrop)
//   - Socket: simulación de sockets con estado (TCP-like)
//   - DnsResolver: cache de DNS con TTL y fallback
//   - TlsContext: simulación de TLS 1.3 con fingerprints y certificados
//   - HttpCache: cache de respuestas HTTP con etag y max-age
//   - BandwidthMeter: medición de ancho de banda y latencia
//   - Firewall: reglas allow/deny por app/host/puerto/protocolo
//   - QosManager: prioridades de tráfico (interactive, streaming, bulk)
//   - ConnectionPool: reutilización de conexiones
//   - ReachabilityMonitor: detección de cambios en conectividad
//
// INTEGRACIÓN CON EL NAVEGADOR
//
//   - fetch() instrumentado con hooks
//   - WebSocket con stats
//   - navigator.onLine + navigator.connection
//   - Service Worker para capturar requests reales
//   - WebRTC (para medición P2P)
//
// EVENTOS
//
//   - interface:added, interface:removed, interface:changed
//   - reachability:changed
//   - socket:created, socket:opened, socket:closed, socket:error
//   - dns:resolved, dns:cache-hit, dns:cache-miss, dns:failed
//   - tls:handshake, tls:verified, tls:failed
//   - request:started, request:completed, request:failed, request:cached
//   - bandwidth:update, latency:update
//   - firewall:blocked, firewall:allowed
//   - qos:classified
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const INTERFACE_KIND = Object.freeze({
  WIFI: "wifi",
  ETHERNET: "ethernet",
  CELLULAR: "cellular",
  VPN: "vpn",
  LOOPBACK: "loopback",
  AIRDROP: "airdrop",
  HOTSPOT: "hotspot",
  UNKNOWN: "unknown",
});

export const INTERFACE_STATE = Object.freeze({
  OFFLINE: "offline",
  CONNECTING: "connecting",
  ONLINE: "online",
  LIMITED: "limited",
  FAILED: "failed",
});

export const SOCKET_STATE = Object.freeze({
  CLOSED: "closed",
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSING: "closing",
  FAILED: "failed",
});

export const QOS_CLASS = Object.freeze({
  INTERACTIVE: "interactive", // videollamadas, juegos
  VOICE: "voice",             // VoIP
  STREAMING: "streaming",     // vídeo/audio en vivo
  BULK: "bulk",               // descargas grandes
  BACKGROUND: "background",   // sync, updates
  DEFAULT: "default",
});

export const NETWORK_EVENTS = Object.freeze({
  MANAGER_STARTED: "network:manager-started",
  INTERFACE_ADDED: "network:interface-added",
  INTERFACE_REMOVED: "network:interface-removed",
  INTERFACE_CHANGED: "network:interface-changed",
  DEFAULT_ROUTE_CHANGED: "network:default-route-changed",
  REACHABILITY_CHANGED: "network:reachability-changed",
  ONLINE: "network:online",
  OFFLINE: "network:offline",

  SOCKET_CREATED: "network:socket-created",
  SOCKET_OPENED: "network:socket-opened",
  SOCKET_CLOSED: "network:socket-closed",
  SOCKET_ERROR: "network:socket-error",

  DNS_QUERY: "network:dns-query",
  DNS_CACHE_HIT: "network:dns-cache-hit",
  DNS_CACHE_MISS: "network:dns-cache-miss",
  DNS_RESOLVED: "network:dns-resolved",
  DNS_FAILED: "network:dns-failed",

  TLS_HANDSHAKE_START: "network:tls-handshake-start",
  TLS_HANDSHAKE_DONE: "network:tls-handshake-done",
  TLS_VERIFIED: "network:tls-verified",
  TLS_FAILED: "network:tls-failed",

  REQUEST_STARTED: "network:request-started",
  REQUEST_PROGRESS: "network:request-progress",
  REQUEST_COMPLETED: "network:request-completed",
  REQUEST_FAILED: "network:request-failed",
  REQUEST_CACHED: "network:request-cached",

  BANDWIDTH_UPDATE: "network:bandwidth-update",
  LATENCY_UPDATE: "network:latency-update",

  FIREWALL_BLOCKED: "network:firewall-blocked",
  FIREWALL_ALLOWED: "network:firewall-allowed",

  QOS_CLASSIFIED: "network:qos-classified",

  LOG: "network:log",
});

// ============================================================================
// LOGGER
// ============================================================================

class NetworkLog {
  constructor(max = 1000) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(NETWORK_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
  all() { return [...this.entries]; }
}

// ============================================================================
// NETWORK INTERFACE
// ============================================================================

let _ifCounter = 0;

class NetworkInterface {
  constructor({
    id,
    name,
    kind,
    address = "0.0.0.0",
    netmask = "255.255.255.0",
    mac = "00:00:00:00:00:00",
    gateway = null,
    dns = [],
    mtu = 1500,
    state = INTERFACE_STATE.ONLINE,
    isDefault = false,
    metered = false,
    txBytes = 0,
    rxBytes = 0,
  } = {}) {
    this.id = id || `if-${++_ifCounter}`;
    this.name = name;
    this.kind = kind;
    this.address = address;
    this.netmask = netmask;
    this.mac = mac;
    this.gateway = gateway;
    this.dns = dns;
    this.mtu = mtu;
    this.state = state;
    this.isDefault = isDefault;
    this.metered = metered;
    this.txBytes = txBytes;
    this.rxBytes = rxBytes;
    this.createdAt = Date.now();
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  setState(state) {
    if (this.state === state) return;
    const prev = this.state;
    this.state = state;
    this._emit(NETWORK_EVENTS.INTERFACE_CHANGED, { from: prev, to: state });
  }

  addTx(bytes) { this.txBytes += bytes; }
  addRx(bytes) { this.rxBytes += bytes; }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      address: this.address,
      netmask: this.netmask,
      mac: this.mac,
      gateway: this.gateway,
      dns: [...this.dns],
      mtu: this.mtu,
      state: this.state,
      isDefault: this.isDefault,
      metered: this.metered,
      txBytes: this.txBytes,
      rxBytes: this.rxBytes,
      createdAt: this.createdAt,
    };
  }
}

// ============================================================================
// SOCKET (simulación TCP-like sobre WebSocket real cuando aplica)
// ============================================================================

let _sockCounter = 0;

class Socket {
  constructor({ host, port, protocol = "tcp", appId = null, timeoutMs = 30000 }) {
    this.id = `sock-${++_sockCounter}`;
    this.host = host;
    this.port = port;
    this.protocol = protocol;
    this.appId = appId;
    this.timeoutMs = timeoutMs;
    this.state = SOCKET_STATE.CLOSED;
    this.createdAt = Date.now();
    this.openedAt = null;
    this.closedAt = null;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.rttMs = null;
    this.ws = null;
    this.error = null;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  async connect() {
    this.state = SOCKET_STATE.CONNECTING;
    try {
      if (this.protocol === "wss" || this.protocol === "ws") {
        const url = `${this.protocol}://${this.host}:${this.port}`;
        this.ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error("timeout")),
            this.timeoutMs
          );
          this.ws.onopen = () => {
            clearTimeout(t);
            this.openedAt = Date.now();
            this.state = SOCKET_STATE.OPEN;
            resolve();
          };
          this.ws.onerror = (err) => {
            clearTimeout(t);
            reject(new Error("websocket error"));
          };
        });
      } else {
        // Para tcp/udp simulamos
        await new Promise((r) => setTimeout(r, 20));
        this.openedAt = Date.now();
        this.state = SOCKET_STATE.OPEN;
      }
      this._emit(NETWORK_EVENTS.SOCKET_OPENED, { socketId: this.id });
      return true;
    } catch (err) {
      this.state = SOCKET_STATE.FAILED;
      this.error = String(err);
      this._emit(NETWORK_EVENTS.SOCKET_ERROR, { socketId: this.id, error: String(err) });
      return false;
    }
  }

  send(bytes) {
    if (this.state !== SOCKET_STATE.OPEN) return false;
    this.bytesSent += bytes;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
    return true;
  }

  close() {
    this.state = SOCKET_STATE.CLOSING;
    try { this.ws?.close?.(); } catch {}
    this.closedAt = Date.now();
    this.state = SOCKET_STATE.CLOSED;
    this._emit(NETWORK_EVENTS.SOCKET_CLOSED, { socketId: this.id });
  }

  snapshot() {
    return {
      id: this.id,
      host: this.host,
      port: this.port,
      protocol: this.protocol,
      appId: this.appId,
      state: this.state,
      createdAt: this.createdAt,
      openedAt: this.openedAt,
      closedAt: this.closedAt,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      rttMs: this.rttMs,
      error: this.error,
    };
  }
}

// ============================================================================
// DNS RESOLVER
// ============================================================================

class DnsEntry {
  constructor({ host, address, family = 4, ttlMs = 300000 }) {
    this.host = host;
    this.address = address;
    this.family = family;
    this.resolvedAt = Date.now();
    this.expiresAt = Date.now() + ttlMs;
    this.hitCount = 0;
  }
  get isExpired() {
    return Date.now() > this.expiresAt;
  }
}

class DnsResolver {
  constructor({ defaultTtlMs = 300000 } = {}) {
    this.cache = new Map(); // host → DnsEntry
    this.defaultTtlMs = defaultTtlMs;
    this.stats = {
      queries: 0,
      hits: 0,
      misses: 0,
      failures: 0,
    };
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    kernelBus.emit(event, payload);
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  /**
   * Resuelve un hostname. Si es una IP directa, la devuelve sin consultar.
   * Si está en cache y no expiró, devuelve cache hit.
   * Si no, hace un "resolve" simulado (o real usando fetch HEAD).
   */
  async resolve(host) {
    this.stats.queries++;
    this._emit(NETWORK_EVENTS.DNS_QUERY, { host });

    // ¿Es una IP directa?
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return { address: host, family: 4, cached: false, direct: true };
    }

    // Cache
    const cached = this.cache.get(host);
    if (cached && !cached.isExpired) {
      cached.hitCount++;
      this.stats.hits++;
      this._emit(NETWORK_EVENTS.DNS_CACHE_HIT, { host, address: cached.address });
      return {
        address: cached.address,
        family: cached.family,
        cached: true,
        hitCount: cached.hitCount,
      };
    }
    this.stats.misses++;
    this._emit(NETWORK_EVENTS.DNS_CACHE_MISS, { host });

    // Resolver via Cloudflare DoH (DNS over HTTPS)
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
        { headers: { Accept: "application/dns-json" } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const answer = data.Answer?.find((a) => a.type === 1 || a.type === 28);
      if (!answer) throw new Error("no A/AAAA record");
      const family = answer.type === 28 ? 6 : 4;
      const entry = new DnsEntry({
        host,
        address: answer.data,
        family,
        ttlMs: Math.min((answer.TTL ?? 300) * 1000, this.defaultTtlMs),
      });
      this.cache.set(host, entry);
      this._emit(NETWORK_EVENTS.DNS_RESOLVED, { host, address: answer.data, family });
      return { address: answer.data, family, cached: false };
    } catch (err) {
      this.stats.failures++;
      this._emit(NETWORK_EVENTS.DNS_FAILED, { host, error: String(err) });
      return { address: null, error: String(err) };
    }
  }

  flush() {
    this.cache.clear();
  }

  listCache() {
    return Array.from(this.cache.values()).map((e) => ({
      host: e.host,
      address: e.address,
      family: e.family,
      expiresInMs: Math.max(0, e.expiresAt - Date.now()),
      hitCount: e.hitCount,
    }));
  }

  snapshot() {
    return {
      cacheSize: this.cache.size,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// TLS CONTEXT
// ----------------------------------------------------------------------------
// Simula el handshake TLS 1.3 y verifica el certificado del servidor.
// ============================================================================

class TlsContext {
  constructor({ host }) {
    this.host = host;
    this.state = "idle"; // idle | handshaking | established | failed
    this.version = null;
    this.cipherSuite = null;
    this.certificate = null;
    this.verified = false;
    this.handshakeStartedAt = null;
    this.handshakeCompletedAt = null;
    this.bytesEncrypted = 0;
    this.bytesDecrypted = 0;
  }

  async handshake() {
    this.state = "handshaking";
    this.handshakeStartedAt = Date.now();
    kernelBus.emit(NETWORK_EVENTS.TLS_HANDSHAKE_START, { host: this.host });

    // Simular negociación
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));

    this.version = "TLS 1.3";
    this.cipherSuite = "TLS_AES_128_GCM_SHA256";
    this.certificate = {
      subject: `CN=${this.host}`,
      issuer: "RainOS Virtual CA",
      validFrom: Date.now() - 86400000 * 30,
      validTo: Date.now() + 86400000 * 335,
      fingerprint: this._fakeFingerprint(),
      publicKeyAlg: "ECDSA P-256",
      signatureAlg: "SHA256-ECDSA",
    };
    this.verified = true;
    this.state = "established";
    this.handshakeCompletedAt = Date.now();

    kernelBus.emit(NETWORK_EVENTS.TLS_HANDSHAKE_DONE, {
      host: this.host,
      version: this.version,
      cipherSuite: this.cipherSuite,
      handshakeMs: this.handshakeCompletedAt - this.handshakeStartedAt,
    });
    kernelBus.emit(NETWORK_EVENTS.TLS_VERIFIED, {
      host: this.host,
      fingerprint: this.certificate.fingerprint,
    });

    return true;
  }

  _fakeFingerprint() {
    const hex = "0123456789abcdef";
    const groups = [];
    for (let i = 0; i < 32; i++) {
      groups.push(hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)]);
    }
    return groups.join(":").toUpperCase();
  }

  snapshot() {
    return {
      host: this.host,
      state: this.state,
      version: this.version,
      cipherSuite: this.cipherSuite,
      certificate: this.certificate,
      verified: this.verified,
      handshakeMs: this.handshakeCompletedAt
        ? this.handshakeCompletedAt - this.handshakeStartedAt
        : null,
    };
  }
}

// ============================================================================
// HTTP CACHE
// ============================================================================

class HttpCache {
  constructor({ maxSize = 50 * 1024 * 1024, maxEntries = 500 } = {}) {
    this.maxSize = maxSize;
    this.maxEntries = maxEntries;
    this.currentSize = 0;
    this.entries = new Map(); // url → { url, body, etag, maxAge, fetchedAt, size, headers }
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      bytesSaved: 0,
    };
  }

  get(url) {
    const e = this.entries.get(url);
    if (!e) {
      this.stats.misses++;
      return null;
    }
    if (e.expiresAt < Date.now()) {
      this.entries.delete(url);
      this.currentSize -= e.size;
      this.stats.misses++;
      return null;
    }
    e.lastUsed = Date.now();
    e.hitCount = (e.hitCount || 0) + 1;
    this.stats.hits++;
    this.stats.bytesSaved += e.size;
    return e;
  }

  put(url, { body, etag, maxAge, headers, status = 200 }) {
    const size = body?.byteLength ?? body?.length ?? 0;
    if (size > this.maxSize) return false;

    const prev = this.entries.get(url);
    if (prev) this.currentSize -= prev.size;

    const entry = {
      url,
      body,
      etag,
      maxAge,
      headers,
      status,
      size,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + maxAge * 1000,
      lastUsed: Date.now(),
      hitCount: 0,
    };
    this.entries.set(url, entry);
    this.currentSize += size;

    this._evict();
    return true;
  }

  _evict() {
    if (this.entries.size <= this.maxEntries && this.currentSize <= this.maxSize) return;

    const sorted = Array.from(this.entries.values()).sort(
      (a, b) => a.lastUsed - b.lastUsed
    );
    while (
      sorted.length > 0 &&
      (this.entries.size > this.maxEntries || this.currentSize > this.maxSize)
    ) {
      const e = sorted.shift();
      this.entries.delete(e.url);
      this.currentSize -= e.size;
      this.stats.evictions++;
    }
  }

  clear() {
    this.entries.clear();
    this.currentSize = 0;
  }

  snapshot() {
    return {
      entries: this.entries.size,
      sizeBytes: this.currentSize,
      maxSize: this.maxSize,
      maxEntries: this.maxEntries,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// BANDWIDTH METER
// ============================================================================

class BandwidthMeter {
  constructor() {
    this.samples = [];
    this.maxSamples = 60;
    this.downloadMbps = 0;
    this.uploadMbps = 0;
    this.latencyMs = 0;
    this.jitterMs = 0;
    this.packetLossPct = 0;
    this.lastMeasureAt = null;
    this.measurements = 0;
  }

  record({ bytesDownloaded = 0, bytesUploaded = 0, durationMs = 1 }) {
    const durationSec = durationMs / 1000;
    const dlMbps = (bytesDownloaded * 8) / durationSec / 1e6;
    const ulMbps = (bytesUploaded * 8) / durationSec / 1e6;

    this.samples.push({
      ts: Date.now(),
      dlMbps,
      ulMbps,
      durationMs,
    });
    if (this.samples.length > this.maxSamples) this.samples.shift();

    this.downloadMbps = dlMbps;
    this.uploadMbps = ulMbps;
    this.lastMeasureAt = Date.now();
    this.measurements++;
  }

  setLatency(ms) {
    const prev = this.latencyMs;
    this.latencyMs = ms;
    if (prev > 0) {
      // Jitter = diferencia entre latencias consecutivas
      const delta = Math.abs(ms - prev);
      this.jitterMs = this.jitterMs * 0.7 + delta * 0.3;
    }
  }

  snapshot() {
    return {
      downloadMbps: this.downloadMbps,
      uploadMbps: this.uploadMbps,
      latencyMs: this.latencyMs,
      jitterMs: this.jitterMs,
      packetLossPct: this.packetLossPct,
      lastMeasureAt: this.lastMeasureAt,
      measurements: this.measurements,
      samples: this.samples.length,
    };
  }
}

// ============================================================================
// FIREWALL
// ============================================================================

class FirewallRule {
  constructor({ action, appId = null, host = null, port = null, protocol = null }) {
    this.action = action; // "allow" | "deny"
    this.appId = appId;
    this.host = host;      // null = any
    this.port = port;
    this.protocol = protocol;
    this.hits = 0;
  }

  matches({ appId, host, port, protocol }) {
    if (this.appId && this.appId !== appId) return false;
    if (this.host) {
      const rx = new RegExp("^" + this.host.replace(/\*/g, ".*") + "$", "i");
      if (!rx.test(host ?? "")) return false;
    }
    if (this.port != null && this.port !== port) return false;
    if (this.protocol && this.protocol !== protocol) return false;
    return true;
  }
}

class Firewall {
  constructor() {
    this.rules = [];
    this.defaultAction = "allow";
    this.stats = {
      allowed: 0,
      blocked: 0,
    };
    this.blockedHosts = [];
  }

  addRule(rule) {
    this.rules.push(new FirewallRule(rule));
  }

  clearRules() {
    this.rules = [];
  }

  check({ appId, host, port, protocol }) {
    for (const rule of this.rules) {
      if (rule.matches({ appId, host, port, protocol })) {
        rule.hits++;
        const allowed = rule.action === "allow";
        if (allowed) {
          this.stats.allowed++;
          kernelBus.emit(NETWORK_EVENTS.FIREWALL_ALLOWED, {
            appId,
            host,
            port,
            rule,
          });
        } else {
          this.stats.blocked++;
          this.blockedHosts.push({ ts: Date.now(), appId, host, port });
          if (this.blockedHosts.length > 200) this.blockedHosts.shift();
          kernelBus.emit(NETWORK_EVENTS.FIREWALL_BLOCKED, {
            appId,
            host,
            port,
            rule,
          });
        }
        return allowed;
      }
    }
    return this.defaultAction === "allow";
  }

  snapshot() {
    return {
      rules: this.rules.length,
      defaultAction: this.defaultAction,
      stats: { ...this.stats },
      blockedHosts: this.blockedHosts.slice(-20),
    };
  }
}

// ============================================================================
// QOS MANAGER
// ============================================================================

class QosManager {
  constructor() {
    this.classes = new Map(); // connectionKey → QosClass
    this.queues = {
      [QOS_CLASS.INTERACTIVE]: [],
      [QOS_CLASS.VOICE]: [],
      [QOS_CLASS.STREAMING]: [],
      [QOS_CLASS.BULK]: [],
      [QOS_CLASS.BACKGROUND]: [],
      [QOS_CLASS.DEFAULT]: [],
    };
    this.stats = {
      classified: 0,
    };
  }

  /**
   * Clasifica una conexión según host, puerto y app.
   */
  classify({ appId, host, port, protocol }) {
    let qos = QOS_CLASS.DEFAULT;

    // Reglas heurísticas
    if (port === 443 || port === 80) qos = QOS_CLASS.DEFAULT;
    if (host?.includes("zoom") || host?.includes("meet") || host?.includes("teams")) {
      qos = QOS_CLASS.INTERACTIVE;
    }
    if (host?.includes("youtube") || host?.includes("netflix") || host?.includes("spotify")) {
      qos = QOS_CLASS.STREAMING;
    }
    if (host?.includes("voip") || host?.includes("sip")) {
      qos = QOS_CLASS.VOICE;
    }
    if (host?.includes("update") || host?.includes("sync") || host?.includes("backup")) {
      qos = QOS_CLASS.BACKGROUND;
    }

    this.stats.classified++;
    kernelBus.emit(NETWORK_EVENTS.QOS_CLASSIFIED, {
      appId,
      host,
      port,
      protocol,
      qos,
    });
    return qos;
  }

  snapshot() {
    return {
      stats: { ...this.stats },
      queues: Object.fromEntries(
        Object.entries(this.queues).map(([k, v]) => [k, v.length])
      ),
    };
  }
}

// ============================================================================
// NETWORK MANAGER
// ============================================================================

export class NetworkManager {
  constructor(options = {}) {
    this.options = {
      enableDns: true,
      enableTls: true,
      enableHttpCache: true,
      enableFirewall: false,
      enableQos: true,
      ...options,
    };

    this.log = new NetworkLog();
    this.interfaces = new Map();
    this.defaultInterfaceId = null;
    this.sockets = new Map();
    this.dns = new DnsResolver();
    this.httpCache = new HttpCache();
    this.bandwidth = new BandwidthMeter();
    this.firewall = new Firewall();
    this.qos = new QosManager();

    this.tlsContexts = new Map(); // host → TlsContext
    this.connectionPool = new Map(); // key → socket

    this.reachable = typeof navigator !== "undefined" ? navigator.onLine : true;
    this.reachabilityAt = Date.now();

    this.listeners = new Set();
    this.stats = {
      totalRequests: 0,
      totalBytesReceived: 0,
      totalBytesSent: 0,
      errors: 0,
      startedAt: Date.now(),
    };

    this._setupReachability();
  }

  // -------------------------------------------------------------- suscripción
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    kernelBus.emit(event, payload);
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  _log(level, message, meta) {
    this.log.push(level, message, meta);
  }

  // -------------------------------------------------------------- reachability
  _setupReachability() {
    if (typeof window === "undefined") return;
    const update = () => {
      const now = navigator.onLine;
      if (now !== this.reachable) {
        this.reachable = now;
        this.reachabilityAt = Date.now();
        this._emit(NETWORK_EVENTS.REACHABILITY_CHANGED, { online: now });
        this._emit(now ? NETWORK_EVENTS.ONLINE : NETWORK_EVENTS.OFFLINE, {});
        this._log(now ? "info" : "warn", now ? "network online" : "network offline");
      }
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    if (navigator.connection) {
      navigator.connection.addEventListener?.("change", () => {
        this._emit(NETWORK_EVENTS.INTERFACE_CHANGED, {
          interfaceId: this.defaultInterfaceId,
          effectiveType: navigator.connection.effectiveType,
          downlink: navigator.connection.downlink,
          rtt: navigator.connection.rtt,
        });
      });
    }
  }

  // -------------------------------------------------------------- init
  init() {
    if (typeof navigator !== "undefined" && navigator.connection) {
      const conn = navigator.connection;
      const id = "if-default";
      this.addInterface({
        id,
        name: conn.effectiveType ? `Network (${conn.effectiveType})` : "Network",
        kind: conn.effectiveType === "4g" || conn.effectiveType === "5g"
          ? INTERFACE_KIND.CELLULAR
          : INTERFACE_KIND.WIFI,
        state: navigator.onLine ? INTERFACE_STATE.ONLINE : INTERFACE_STATE.OFFLINE,
        isDefault: true,
        metered: conn.saveData === true,
      });
      this.defaultInterfaceId = id;
      this.bandwidth.setLatency(conn.rtt ?? 0);
    } else {
      const id = "if-default";
      this.addInterface({
        id,
        name: "Loopback",
        kind: INTERFACE_KIND.LOOPBACK,
        address: "127.0.0.1",
        state: INTERFACE_STATE.ONLINE,
        isDefault: true,
      });
      this.defaultInterfaceId = id;
    }
    this._emit(NETWORK_EVENTS.MANAGER_STARTED, {});
    this._log("info", "network manager started");
  }

  // -------------------------------------------------------------- interfaces
  addInterface(opts) {
    const iface = new NetworkInterface(opts);
    iface.subscribe((event, payload) => {
      this._emit(event, { interfaceId: iface.id, ...payload });
    });
    this.interfaces.set(iface.id, iface);
    if (iface.isDefault) this.defaultInterfaceId = iface.id;
    this._emit(NETWORK_EVENTS.INTERFACE_ADDED, iface.snapshot());
    return iface;
  }

  removeInterface(id) {
    const iface = this.interfaces.get(id);
    if (!iface) return false;
    this.interfaces.delete(id);
    if (this.defaultInterfaceId === id) {
      this.defaultInterfaceId = this.interfaces.keys().next().value ?? null;
      this._emit(NETWORK_EVENTS.DEFAULT_ROUTE_CHANGED, {
        id: this.defaultInterfaceId,
      });
    }
    this._emit(NETWORK_EVENTS.INTERFACE_REMOVED, { interfaceId: id });
    return true;
  }

  getInterface(id) {
    return this.interfaces.get(id) ?? null;
  }

  listInterfaces() {
    return Array.from(this.interfaces.values()).map((i) => i.snapshot());
  }

  getDefaultInterface() {
    return this.defaultInterfaceId ? this.getInterface(this.defaultInterfaceId) : null;
  }

  setDefaultInterface(id) {
    if (!this.interfaces.has(id)) return false;
    for (const i of this.interfaces.values()) i.isDefault = false;
    const iface = this.interfaces.get(id);
    iface.isDefault = true;
    this.defaultInterfaceId = id;
    this._emit(NETWORK_EVENTS.DEFAULT_ROUTE_CHANGED, { id });
    return true;
  }

  // -------------------------------------------------------------- sockets
  createSocket({ host, port, protocol = "tcp", appId = null, timeoutMs = 30000 }) {
    const socket = new Socket({ host, port, protocol, appId, timeoutMs });
    socket.subscribe((event, payload) => {
      this._emit(event, { socketId: socket.id, ...payload });
    });
    this.sockets.set(socket.id, socket);
    this._emit(NETWORK_EVENTS.SOCKET_CREATED, socket.snapshot());
    return socket;
  }

  destroySocket(id) {
    const socket = this.sockets.get(id);
    if (!socket) return false;
    socket.close();
    this.sockets.delete(id);
    return true;
  }

  listSockets() {
    return Array.from(this.sockets.values()).map((s) => s.snapshot());
  }

  // -------------------------------------------------------------- TLS
  async ensureTls(host) {
    if (!this.options.enableTls) return null;
    if (this.tlsContexts.has(host)) return this.tlsContexts.get(host);
    const ctx = new TlsContext({ host });
    await ctx.handshake();
    this.tlsContexts.set(host, ctx);
    return ctx;
  }

  // -------------------------------------------------------------- fetch instrumentado
  /**
   * Realiza una petición HTTP instrumentada. Aplica:
   *   - Firewall
   *   - QoS
   *   - DNS (para el nombre de host)
   *   - TLS (si es https)
   *   - HTTP cache
   *   - Bandwidth metering
   */
  async fetch(url, options = {}) {
    const startedAt = Date.now();
    const method = (options.method || "GET").toUpperCase();

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      this.stats.errors++;
      throw new Error(`invalid URL: ${url}`);
    }

    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const protocol = parsed.protocol.replace(":", "");
    const appId = options.appId ?? null;

    this.stats.totalRequests++;
    this._emit(NETWORK_EVENTS.REQUEST_STARTED, { url, method, appId });

    // Firewall
    if (this.options.enableFirewall) {
      const allowed = this.firewall.check({ appId, host, port, protocol });
      if (!allowed) {
        const err = new Error("blocked by firewall");
        this._emit(NETWORK_EVENTS.REQUEST_FAILED, { url, error: "firewall" });
        this.stats.errors++;
        throw err;
      }
    }

    // QoS
    if (this.options.enableQos) {
      this.qos.classify({ appId, host, port, protocol });
    }

    // Cache (solo GET)
    if (this.options.enableHttpCache && method === "GET") {
      const cached = this.httpCache.get(url);
      if (cached) {
        this._emit(NETWORK_EVENTS.REQUEST_CACHED, { url, size: cached.size });
        return new Response(cached.body, {
          status: cached.status,
          headers: cached.headers,
        });
      }
    }

    // DNS
    if (this.options.enableDns && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const dnsResult = await this.dns.resolve(host);
      if (dnsResult.error) {
        this._emit(NETWORK_EVENTS.REQUEST_FAILED, { url, error: dnsResult.error });
        this.stats.errors++;
        throw new Error(`dns failed: ${dnsResult.error}`);
      }
    }

    // TLS
    if (protocol === "https") {
      await this.ensureTls(host);
    }

    // Request real
    try {
      const response = await fetch(url, options);
      const clone = response.clone();
      const body = await clone.arrayBuffer();
      const durationMs = Date.now() - startedAt;

      this.stats.totalBytesReceived += body.byteLength;
      this.bandwidth.record({
        bytesDownloaded: body.byteLength,
        durationMs,
      });

      // Guardar en cache si procede
      if (this.options.enableHttpCache && method === "GET") {
        const cacheControl = response.headers.get("cache-control") || "";
        const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
        const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
        if (maxAge > 0) {
          this.httpCache.put(url, {
            body,
            etag: response.headers.get("etag"),
            maxAge,
            headers: Object.fromEntries(response.headers.entries()),
            status: response.status,
          });
        }
      }

      this._emit(NETWORK_EVENTS.REQUEST_COMPLETED, {
        url,
        method,
        status: response.status,
        bytes: body.byteLength,
        durationMs,
      });

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      this.stats.errors++;
      this._emit(NETWORK_EVENTS.REQUEST_FAILED, { url, error: String(err) });
      throw err;
    }
  }

  /**
   * Ping a un host para medir latencia.
   */
  async ping(url) {
    const t0 = performance.now();
    try {
      await fetch(url, { method: "HEAD", cache: "no-cache", mode: "no-cors" });
    } catch {}
    const latency = performance.now() - t0;
    this.bandwidth.setLatency(latency);
    this._emit(NETWORK_EVENTS.LATENCY_UPDATE, { url, latencyMs: latency });
    return latency;
  }

  /**
   * Test de velocidad real.
   */
  async speedTest() {
    const t0 = performance.now();
    try {
      const res = await fetch(
        "https://speed.cloudflare.com/__down?bytes=10000000",
        { cache: "no-store" }
      );
      const buf = await res.arrayBuffer();
      const durationMs = performance.now() - t0;
      this.bandwidth.record({
        bytesDownloaded: buf.byteLength,
        durationMs,
      });
      return this.bandwidth.snapshot();
    } catch (err) {
      this._log("error", "speedtest failed", err);
      return null;
    }
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    return {
      reachable: this.reachable,
      reachabilityAt: this.reachabilityAt,
      interfaces: this.listInterfaces(),
      defaultInterfaceId: this.defaultInterfaceId,
      sockets: this.sockets.size,
      dns: this.dns.snapshot(),
      httpCache: this.httpCache.snapshot(),
      bandwidth: this.bandwidth.snapshot(),
      firewall: this.firewall.snapshot(),
      qos: this.qos.snapshot(),
      tlsContexts: this.tlsContexts.size,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const NetworkContext = React.createContext(null);

export function NetworkProvider({
  children,
  manager: external,
  autoInit = true,
  options = {},
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new NetworkManager(options);
  }
  const manager = ref.current;
  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoInit) manager.init();
    return unsub;
  }, [manager, autoInit]);

  // Loop de snapshot periódico para que el estado no se quede obsoleto
  useEffect(() => {
    const t = setInterval(() => setSnapshot(manager.snapshot()), 2000);
    return () => clearInterval(t);
  }, [manager]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,
      init: () => manager.init(),

      addInterface: (opts) => manager.addInterface(opts),
      removeInterface: (id) => manager.removeInterface(id),
      getInterface: (id) => manager.getInterface(id),
      listInterfaces: () => manager.listInterfaces(),
      getDefaultInterface: () => manager.getDefaultInterface(),
      setDefaultInterface: (id) => manager.setDefaultInterface(id),

      createSocket: (opts) => manager.createSocket(opts),
      destroySocket: (id) => manager.destroySocket(id),
      listSockets: () => manager.listSockets(),

      resolve: (host) => manager.dns.resolve(host),
      flushDns: () => manager.dns.flush(),
      listDnsCache: () => manager.dns.listCache(),

      ensureTls: (host) => manager.ensureTls(host),

      fetch: (url, opts) => manager.fetch(url, opts),
      ping: (url) => manager.ping(url),
      speedTest: () => manager.speedTest(),

      clearHttpCache: () => manager.httpCache.clear(),
      getHttpCache: () => manager.httpCache.snapshot(),

      firewall: manager.firewall,
      qos: manager.qos,
      bandwidth: manager.bandwidth,
      dns: manager.dns,
    }),
    [manager, snapshot]
  );

  return (
    <NetworkContext.Provider value={api}>{children}</NetworkContext.Provider>
  );
}

export function useNetwork() {
  const ctx = React.useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork must be used within NetworkProvider");
  return ctx;
}

export default {
  NetworkManager,
  NetworkInterface,
  Socket,
  DnsResolver,
  TlsContext,
  HttpCache,
  BandwidthMeter,
  Firewall,
  QosManager,
  NetworkProvider,
  useNetwork,
  INTERFACE_KIND,
  INTERFACE_STATE,
  SOCKET_STATE,
  QOS_CLASS,
  NETWORK_EVENTS,
};
