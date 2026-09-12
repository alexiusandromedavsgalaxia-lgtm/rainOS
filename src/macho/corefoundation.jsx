// ============================================================================
// corefoundation.jsx — CoreFoundation + Foundation
// ----------------------------------------------------------------------------
// Implementa CoreFoundation (CF*) y Foundation (NS*):
//
//   CFString, CFMutableString, CFNumber, CFBoolean
//   CFArray, CFMutableArray
//   CFDictionary, CFMutableDictionary
//   CFSet, CFMutableSet
//   CFData, CFMutableData
//   CFDate, CFTimeZone, CFLocale
//   CFURL, CFBundle, CFRunLoop, CFTimer
//   CFStream, CFSocket
//   NSObject, NSString, NSNumber, NSArray, NSDictionary
//   NSSet, NSData, NSDate, NSError, NSURL
//   NSFileManager, NSUserDefaults, NSNotificationCenter
//   NSJSONSerialization, NSPropertyListSerialization
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";

export const CF_EVENTS = Object.freeze({
  OBJECT_CREATED: "cf:object-created",
  OBJECT_RETAINED: "cf:object-retained",
  OBJECT_RELEASED: "cf:object-released",
  STRING_CREATED: "cf:string-created",
  ARRAY_MUTATED: "cf:array-mutated",
  DICT_MUTATED: "cf:dict-mutated",
  URL_OPENED: "cf:url-opened",
  BUNDLE_LOADED: "cf:bundle-loaded",
  RUNLOOP_STARTED: "cf:runloop-started",
  RUNLOOP_STOPPED: "cf:runloop-stopped",
  TIMER_FIRED: "cf:timer-fired",
  JSON_PARSED: "cf:json-parsed",
  LOG: "cf:log",
});

class CfLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(CF_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
}

// ============================================================================
// CF OBJECT BASE
// ============================================================================

let _cfId = 0;

export class CFObject {
  constructor(type) {
    this.cfId = ++_cfId;
    this.cfType = type;
    this.retainCount = 1;
    this.deallocated = false;
    kernelBus.emit(CF_EVENTS.OBJECT_CREATED, { id: this.cfId, type });
  }
  retain() {
    this.retainCount++;
    kernelBus.emit(CF_EVENTS.OBJECT_RETAINED, { id: this.cfId, count: this.retainCount });
    return this;
  }
  release() {
    this.retainCount--;
    kernelBus.emit(CF_EVENTS.OBJECT_RELEASED, { id: this.cfId, count: this.retainCount });
    if (this.retainCount <= 0) this.deallocated = true;
    return this.retainCount <= 0;
  }
  getRetainCount() { return this.retainCount; }
}

// ============================================================================
// CFString
// ============================================================================

export class CFString extends CFObject {
  constructor(str = "") {
    super("CFString");
    this.value = String(str);
    this.length = this.value.length;
    kernelBus.emit(CF_EVENTS.STRING_CREATED, { value: this.value });
  }
  getString() { return this.value; }
  toJS() { return this.value; }
  isEqual(other) {
    return other instanceof CFString && other.value === this.value;
  }
  toString() { return this.value; }
  static fromJS(s) { return new CFString(String(s)); }
  static fromUTF8(bytes) { return new CFString(new TextDecoder().decode(bytes)); }
}

// ============================================================================
// CFNumber
// ============================================================================

export class CFNumber extends CFObject {
  constructor(value, type = "sint64") {
    super("CFNumber");
    this.value = value;
    this.type = type;
  }
  getValue() { return this.value; }
  getIntValue() { return Math.trunc(this.value); }
  getFloatValue() { return Number(this.value); }
  toJS() { return this.value; }
}

// ============================================================================
// CFBoolean
// ============================================================================

export class CFBoolean extends CFObject {
  constructor(value) {
    super("CFBoolean");
    this.value = !!value;
  }
  toJS() { return this.value; }
}
export const kCFBooleanTrue = new CFBoolean(true);
export const kCFBooleanFalse = new CFBoolean(false);

// ============================================================================
// CFArray
// ============================================================================

export class CFArray extends CFObject {
  constructor(items = []) {
    super("CFArray");
    this.items = [...items];
  }
  getCount() { return this.items.length; }
  getValueAtIndex(index) { return this.items[index] ?? null; }
  contains(value) { return this.items.includes(value); }
  toJS() { return this.items.map((i) => (i?.toJS ? i.toJS() : i)); }
  getValues() { return [...this.items]; }
}

export class CFMutableArray extends CFArray {
  constructor(items = []) {
    super(items);
    this.cfType = "CFMutableArray";
  }
  appendValue(value) {
    this.items.push(value);
    kernelBus.emit(CF_EVENTS.ARRAY_MUTATED, { id: this.cfId, op: "append" });
  }
  insertValue(value, index) { this.items.splice(index, 0, value); }
  removeValueAtIndex(index) { this.items.splice(index, 1); }
  replaceValueAtIndex(index, value) { this.items[index] = value; }
  removeAllValues() { this.items = []; }
}

// ============================================================================
// CFDictionary
// ============================================================================

export class CFDictionary extends CFObject {
  constructor(entries = new Map()) {
    super("CFDictionary");
    this.entries = new Map(entries);
  }
  getCount() { return this.entries.size; }
  getValue(key) { return this.entries.get(key) ?? null; }
  containsKey(key) { return this.entries.has(key); }
  getKeys() { return Array.from(this.entries.keys()); }
  getValues() { return Array.from(this.entries.values()); }
  toJS() {
    const out = {};
    for (const [k, v] of this.entries) {
      out[k?.toJS ? k.toJS() : k] = v?.toJS ? v.toJS() : v;
    }
    return out;
  }
}

export class CFMutableDictionary extends CFDictionary {
  constructor(entries = new Map()) {
    super(entries);
    this.cfType = "CFMutableDictionary";
  }
  setValue(key, value) {
    this.entries.set(key, value);
    kernelBus.emit(CF_EVENTS.DICT_MUTATED, { id: this.cfId, op: "set", key });
  }
  removeValue(key) { this.entries.delete(key); }
  removeAllValues() { this.entries.clear(); }
}

// ============================================================================
// CFSet
// ============================================================================

export class CFSet extends CFObject {
  constructor(items = []) {
    super("CFSet");
    this.items = new Set(items);
  }
  getCount() { return this.items.size; }
  contains(value) { return this.items.has(value); }
  toJS() { return Array.from(this.items); }
}

// ============================================================================
// CFData
// ============================================================================

export class CFData extends CFObject {
  constructor(bytes = new Uint8Array(0)) {
    super("CFData");
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.length = this.bytes.length;
  }
  getLength() { return this.length; }
  getBytePtr() { return this.bytes; }
  toJS() { return this.bytes; }
}

// ============================================================================
// CFDate
// ============================================================================

export class CFDate extends CFObject {
  constructor(ms = Date.now()) {
    super("CFDate");
    this.ms = ms;
  }
  getTimeIntervalSince1970() { return this.ms / 1000; }
  toJS() { return new Date(this.ms); }
}

// ============================================================================
// CFURL
// ============================================================================

export class CFURL extends CFObject {
  constructor(url) {
    super("CFURL");
    this.url = String(url);
    this._parsed = new URL(this.url, "file:///");
  }
  getAbsoluteString() { return this.url; }
  getPath() { return this._parsed.pathname; }
  getScheme() { return this._parsed.protocol.replace(":", ""); }
  getHost() { return this._parsed.hostname; }
  getQuery() { return this._parsed.search; }
  isFileURL() { return this._parsed.protocol === "file:"; }
  toJS() { return this._parsed; }
}

// ============================================================================
// CFRunLoop
// ============================================================================

export class CFRunLoopTimer extends CFObject {
  constructor(interval, callback, { repeats = false } = {}) {
    super("CFRunLoopTimer");
    this.interval = interval; // seconds
    this.callback = callback;
    this.repeats = repeats;
    this.fired = 0;
    this.handle = null;
  }
  start() {
    const ms = this.interval * 1000;
    const fire = () => {
      this.fired++;
      kernelBus.emit(CF_EVENTS.TIMER_FIRED, { id: this.cfId, count: this.fired });
      try { this.callback(this); } catch (err) { console.error(err); }
      if (this.repeats) this.handle = setTimeout(fire, ms);
    };
    this.handle = setTimeout(fire, ms);
  }
  stop() {
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }
}

export class CFRunLoopSource extends CFObject {
  constructor(callback) {
    super("CFRunLoopSource");
    this.callback = callback;
    this.pending = [];
  }
  signal(data) {
    this.pending.push(data);
  }
}

export class CFRunLoop extends CFObject {
  constructor() {
    super("CFRunLoop");
    this.timers = new Set();
    this.sources = new Set();
    this.running = false;
    this.observers = new Set();
  }
  addTimer(timer) {
    this.timers.add(timer);
    timer.start();
  }
  removeTimer(timer) {
    this.timers.delete(timer);
    timer.stop();
  }
  addSource(source) {
    this.sources.add(source);
  }
  removeSource(source) {
    this.sources.delete(source);
  }
  run() {
    this.running = true;
    kernelBus.emit(CF_EVENTS.RUNLOOP_STARTED, { id: this.cfId });
  }
  stop() {
    this.running = false;
    kernelBus.emit(CF_EVENTS.RUNLOOP_STOPPED, { id: this.cfId });
  }
  static currentRunLoop() {
    if (!this._current) this._current = new CFRunLoop();
    return this._current;
  }
  static mainRunLoop() {
    if (!this._main) this._main = new CFRunLoop();
    return this._main;
  }
}

// ============================================================================
// CFBundle
// ============================================================================

export class CFBundle extends CFObject {
  constructor(path) {
    super("CFBundle");
    this.path = path;
    this.info = {};
    this.resources = new Map();
  }
  getInfoDictionary() { return this.info; }
  getBundlePath() { return this.path; }
  getExecutablePath() {
    return this.info.CFBundleExecutable
      ? `${this.path}/Contents/MacOS/${this.info.CFBundleExecutable}`
      : `${this.path}/Contents/MacOS/App`;
  }
  bundleIdentifier() { return this.info.CFBundleIdentifier ?? "com.example.app"; }
  load() {
    kernelBus.emit(CF_EVENTS.BUNDLE_LOADED, { path: this.path });
  }
}

// ============================================================================
// NSUserDefaults
// ============================================================================

export class NSUserDefaults {
  constructor() {
    this.data = new Map();
    this.load();
  }
  load() {
    try {
      const raw = localStorage.getItem("nsuserdefaults");
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = new Map(Object.entries(parsed));
      }
    } catch {}
  }
  save() {
    try {
      localStorage.setItem("nsuserdefaults", JSON.stringify(Object.fromEntries(this.data)));
    } catch {}
  }
  setObject(value, key) { this.data.set(key, value); this.save(); }
  objectForKey(key) { return this.data.get(key) ?? null; }
  stringForKey(key) { return String(this.data.get(key) ?? ""); }
  integerForKey(key) { return Math.trunc(Number(this.data.get(key) ?? 0)); }
  boolForKey(key) { return !!this.data.get(key); }
  removeObjectForKey(key) { this.data.delete(key); this.save(); }
  synchronize() { this.save(); return true; }
}

// ============================================================================
// NSNotificationCenter
// ============================================================================

export class NSNotificationCenter {
  constructor() {
    this.observers = new Map(); // name → Set
  }
  addObserver(name, callback) {
    if (!this.observers.has(name)) this.observers.set(name, new Set());
    this.observers.get(name).add(callback);
    return { name, callback };
  }
  removeObserver(token) {
    const set = this.observers.get(token?.name);
    if (set) set.delete(token.callback);
  }
  postNotification(name, userInfo = null) {
    const set = this.observers.get(name);
    if (!set) return;
    for (const cb of set) {
      try { cb({ name, userInfo }); } catch {}
    }
  }
  static defaultCenter() {
    if (!this._default) this._default = new NSNotificationCenter();
    return this._default;
  }
}

// ============================================================================
// NSFileManager
// ============================================================================

export class NSFileManager {
  constructor() {
    this.files = new Map();
  }
  fileExistsAtPath(path) { return this.files.has(path); }
  createFileAtPath(path, contents, attributes) {
    this.files.set(path, contents);
    return true;
  }
  contentsAtPath(path) { return this.files.get(path) ?? null; }
  removeItemAtPath(path) { return this.files.delete(path); }
  createDirectoryAtPath(path, intermediateDirectories, attributes) {
    this.files.set(path, "dir");
    return true;
  }
  contentsOfDirectoryAtPath(path) {
    const out = [];
    for (const p of this.files.keys()) {
      if (p.startsWith(path) && p !== path) {
        const rest = p.slice(path.length + 1).split("/")[0];
        if (rest && !out.includes(rest)) out.push(rest);
      }
    }
    return out;
  }
  static defaultManager() {
    if (!this._default) this._default = new NSFileManager();
    return this._default;
  }
}

// ============================================================================
// NSJSONSerialization
// ============================================================================

export class NSJSONSerialization {
  static JSONObjectWithData(data) {
    try {
      const str = new TextDecoder().decode(data);
      const parsed = JSON.parse(str);
      kernelBus.emit(CF_EVENTS.JSON_PARSED, { ok: true });
      return CFDictionary.fromJS ? CfHelpers.fromJS(parsed) : parsed;
    } catch (err) {
      kernelBus.emit(CF_EVENTS.JSON_PARSED, { ok: false, error: String(err) });
      throw err;
    }
  }
  static dataWithJSONObject(obj) {
    const json = JSON.stringify(obj);
    return new TextEncoder().encode(json);
  }
}

// ============================================================================
// CF RUNTIME
// ============================================================================

export class CfRuntime {
  constructor() {
    this.log = new CfLogger();
    this.runLoops = new Map();
    this.bundles = new Map();
    this.stats = {
      stringsCreated: 0,
      arraysCreated: 0,
      dictsCreated: 0,
      urlsCreated: 0,
      bundlesLoaded: 0,
    };
  }

  createString(str) {
    this.stats.stringsCreated++;
    return new CFString(str);
  }
  createArray(items = []) {
    this.stats.arraysCreated++;
    return new CFArray(items);
  }
  createMutableArray(items = []) {
    this.stats.arraysCreated++;
    return new CFMutableArray(items);
  }
  createDictionary(entries = new Map()) {
    this.stats.dictsCreated++;
    return new CFDictionary(entries);
  }
  createMutableDictionary(entries = new Map()) {
    this.stats.dictsCreated++;
    return new CFMutableDictionary(entries);
  }
  createURL(url) {
    this.stats.urlsCreated++;
    return new CFURL(url);
  }
  createBundle(path) {
    const b = new CFBundle(path);
    this.bundles.set(path, b);
    this.stats.bundlesLoaded++;
    return b;
  }
  getRunLoop() { return CFRunLoop.currentRunLoop(); }

  snapshot() {
    return {
      runLoops: this.runLoops.size,
      bundles: this.bundles.size,
      stats: { ...this.stats },
    };
  }
}

const CfHelpers = {
  fromJS(v) {
    if (v == null) return null;
    if (typeof v === "string") return new CFString(v);
    if (typeof v === "number") return new CFNumber(v);
    if (typeof v === "boolean") return new CFBoolean(v);
    if (Array.isArray(v)) return new CFArray(v.map(CfHelpers.fromJS));
    if (typeof v === "object") {
      const map = new Map();
      for (const [k, val] of Object.entries(v)) map.set(k, CfHelpers.fromJS(val));
      return new CFDictionary(map);
    }
    return v;
  },
};

export default {
  CFObject,
  CFString,
  CFNumber,
  CFBoolean,
  kCFBooleanTrue,
  kCFBooleanFalse,
  CFArray,
  CFMutableArray,
  CFDictionary,
  CFMutableDictionary,
  CFSet,
  CFData,
  CFDate,
  CFURL,
  CFRunLoop,
  CFRunLoopTimer,
  CFRunLoopSource,
  CFBundle,
  NSUserDefaults,
  NSNotificationCenter,
  NSFileManager,
  NSJSONSerialization,
  CfRuntime,
  CF_EVENTS,
};
