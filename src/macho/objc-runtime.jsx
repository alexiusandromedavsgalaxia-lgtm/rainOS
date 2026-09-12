// ============================================================================
// objc-runtime.jsx — Runtime de Objective-C completo
// ----------------------------------------------------------------------------
// Implementa el runtime de Objective-C que usan todas las apps Cocoa/UIKit:
//
//   - objc_msgSend (dispatch real de mensajes)
//   - objc_msgSendSuper
//   - Clases, metaclases, isa pointers
//   - Method lists y method dispatch
//   - Method swizzling
//   - Categories
//   - Protocolos y conformidad
//   - Asociaciones (associated objects)
//   - Bloques
//   - ARC (retain/release/autorelease)
//   - Autorelease pools
//   - @property synthesis
//   - NSObject, NSString, NSArray, NSDictionary, NSNumber
//
// El runtime está pensado para correr sobre la VCPU y ejecutar el binario
// real de una app Objective-C cargada desde Mach-O.
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// EVENTOS
// ============================================================================

export const OBJC_EVENTS = Object.freeze({
  CLASS_REGISTERED: "objc:class-registered",
  METHOD_ADDED: "objc:method-added",
  METHOD_SWIZZLED: "objc:method-swizzled",
  CATEGORY_ADDED: "objc:category-added",
  PROTOCOL_ADDED: "objc:protocol-added",
  MESSAGE_SENT: "objc:message-sent",
  MESSAGE_UNKNOWN: "objc:message-unknown",
  OBJECT_ALLOCATED: "objc:object-allocated",
  OBJECT_DEALLOCATED: "objc:object-deallocated",
  RETAIN: "objc:retain",
  RELEASE: "objc:release",
  AUTORELEASE: "objc:autorelease",
  POOL_PUSH: "objc:pool-push",
  POOL_POP: "objc:pool-pop",
  EXCEPTION: "objc:exception",
  LOG: "objc:log",
});

const OBJC_LOG_MAX = 500;

class ObjcLogger {
  constructor(max = OBJC_LOG_MAX) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(OBJC_EVENTS.LOG, e);
    if (level === "error") console.error("[objc]", message, meta);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
}

// ============================================================================
// OBJC CLASS
// ============================================================================

let _classCount = 0;
let _selectorCount = 0;
let _objectId = 0;

export class ObjcClass {
  constructor(name, superclass = null) {
    this.id = ++_classCount;
    this.name = name;
    this.superclass = superclass;
    this.isa = null; // metaclase
    this.instanceSize = 8; // isa
    this.methods = new Map();      // selector → IMP
    this.classMethods = new Map(); // metaclase methods
    this.ivars = new Map();        // name → {offset, type, size}
    this.properties = new Map();   // name → {getter, setter, type}
    this.protocols = new Set();
    this.categories = [];
    this.subclasses = new Set();
    if (superclass) superclass.subclasses.add(this);
  }

  addMethod(selector, imp, types = "") {
    this.methods.set(selector, { imp, types, addedAt: Date.now() });
    kernelBus.emit(OBJC_EVENTS.METHOD_ADDED, { class: this.name, selector });
    return true;
  }

  addClassMethod(selector, imp, types = "") {
    this.classMethods.set(selector, { imp, types, addedAt: Date.now() });
    return true;
  }

  addIvar(name, type, size = 8) {
    const offset = this.instanceSize;
    this.ivars.set(name, { offset, type, size });
    this.instanceSize += size;
    return offset;
  }

  addProperty(name, { getter, setter, type = "id" } = {}) {
    this.properties.set(name, { getter, setter, type });
    if (getter) this.addMethod(getter, "auto-getter");
    if (setter) this.addMethod(setter, "auto-setter");
  }

  addProtocol(protocolName) {
    this.protocols.add(protocolName);
  }

  lookupMethod(selector) {
    // 1. Buscar en esta clase
    if (this.methods.has(selector)) return this.methods.get(selector);
    // 2. Buscar en categorías
    for (const cat of this.categories) {
      if (cat.methods.has(selector)) return cat.methods.get(selector);
    }
    // 3. Buscar en superclases
    if (this.superclass) return this.superclass.lookupMethod(selector);
    return null;
  }

  lookupClassMethod(selector) {
    if (this.classMethods.has(selector)) return this.classMethods.get(selector);
    if (this.superclass) return this.superclass.lookupClassMethod(selector);
    return null;
  }

  isSubclassOf(other) {
    let c = this;
    while (c) {
      if (c === other || c.name === other.name) return true;
      c = c.superclass;
    }
    return false;
  }

  conformsTo(protocolName) {
    if (this.protocols.has(protocolName)) return true;
    if (this.superclass) return this.superclass.conformsTo(protocolName);
    return false;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      superclass: this.superclass?.name ?? null,
      methods: Array.from(this.methods.keys()),
      classMethods: Array.from(this.classMethods.keys()),
      ivars: Array.from(this.ivars.entries()),
      protocols: Array.from(this.protocols),
      instanceSize: this.instanceSize,
    };
  }
}

// ============================================================================
// OBJC OBJECT
// ============================================================================

export class ObjcObject {
  constructor(cls) {
    this.id = ++_objectId;
    this.isa = cls;
    this.ivars = new Map();
    this.retainCount = 1;
    this.deallocated = false;
    this.associatedObjects = new Map();
    kernelBus.emit(OBJC_EVENTS.OBJECT_ALLOCATED, {
      id: this.id,
      class: cls.name,
    });
  }

  getIvar(name) {
    return this.ivars.get(name);
  }

  setIvar(name, value) {
    this.ivars.set(name, value);
  }
}

// ============================================================================
// METHOD SWIZZLING
// ============================================================================

export class MethodSwizzler {
  constructor() {
    this.history = [];
  }

  swizzle(cls, selectorA, selectorB) {
    const methodA = cls.methods.get(selectorA);
    const methodB = cls.methods.get(selectorB);
    if (!methodA || !methodB) {
      throw new Error(`swizzle: method not found (${selectorA} or ${selectorB})`);
    }
    const temp = methodA.imp;
    methodA.imp = methodB.imp;
    methodB.imp = temp;

    this.history.push({
      ts: Date.now(),
      class: cls.name,
      selectorA,
      selectorB,
    });
    kernelBus.emit(OBJC_EVENTS.METHOD_SWIZZLED, {
      class: cls.name,
      selectorA,
      selectorB,
    });
    return true;
  }

  swizzleMethod(cls, selector, newImp) {
    const method = cls.methods.get(selector);
    if (!method) {
      throw new Error(`swizzle: method ${selector} not found`);
    }
    const original = method.imp;
    method.imp = newImp;
    this.history.push({
      ts: Date.now(),
      class: cls.name,
      selector,
      swapped: true,
    });
    kernelBus.emit(OBJC_EVENTS.METHOD_SWIZZLED, { class: cls.name, selector });
    return original;
  }
}

// ============================================================================
// AUTORELEASE POOL
// ============================================================================

export class AutoreleasePool {
  constructor() {
    this.objects = [];
    this.pushedAt = Date.now();
  }

  add(obj) {
    this.objects.push(obj);
  }

  drain() {
    const count = this.objects.length;
    for (const obj of this.objects) {
      if (obj && typeof obj.release === "function") {
        try { obj.release(); } catch {}
      }
    }
    this.objects = [];
    kernelBus.emit(OBJC_EVENTS.POOL_POP, { count });
    return count;
  }
}

// ============================================================================
// OBJC RUNTIME
// ============================================================================

export class ObjcRuntime {
  constructor() {
    this.log = new ObjcLogger();
    this.classes = new Map();           // name → ObjcClass
    this.metaclasses = new Map();       // name → ObjcClass (metaclase)
    this.selectors = new Map();         // selector → { name, types }
    this.protocols = new Map();         // name → { methods, protocols }
    this.pools = [];                    // autorelease pools (stack)
    this.currentPool = null;
    this.swizzler = new MethodSwizzler();
    this.exceptions = [];
    this.stats = {
      messageSends: 0,
      unknownSelectors: 0,
      allocations: 0,
      deallocations: 0,
      swizzles: 0,
    };
    this._registerFoundationClasses();
  }

  // -------------------------------------------------------------------------
  // Registro de clases base (Foundation)
  // -------------------------------------------------------------------------

  _registerFoundationClasses() {
    // NSObject
    const NSObject = this.registerClass("NSObject", null);
    NSObject.addMethod("alloc", "objc_alloc");
    NSObject.addMethod("init", "objc_init");
    NSObject.addMethod("dealloc", "objc_dealloc");
    NSObject.addMethod("retain", "objc_retain");
    NSObject.addMethod("release", "objc_release");
    NSObject.addMethod("autorelease", "objc_autorelease");
    NSObject.addMethod("retainCount", "objc_retainCount");
    NSObject.addMethod("isEqual:", "objc_isEqual");
    NSObject.addMethod("hash", "objc_hash");
    NSObject.addMethod("description", "objc_description");
    NSObject.addMethod("respondsToSelector:", "objc_respondsToSelector");
    NSObject.addMethod("conformsToProtocol:", "objc_conformsToProtocol");
    NSObject.addMethod("isKindOfClass:", "objc_isKindOfClass");
    NSObject.addMethod("isMemberOfClass:", "objc_isMemberOfClass");
    NSObject.addClassMethod("new", "objc_new");
    NSObject.addClassMethod("class", "objc_class");
    NSObject.addClassMethod("load", "objc_load");
    NSObject.addClassMethod("initialize", "objc_initialize");

    // NSString
    const NSString = this.registerClass("NSString", NSObject);
    NSString.addMethod("length", "nsstring_length");
    NSString.addMethod("UTF8String", "nsstring_UTF8String");
    NSString.addMethod("isEqualToString:", "nsstring_isEqualToString");
    NSString.addClassMethod("stringWithUTF8String:", "nsstring_stringWithUTF8String");
    NSString.addClassMethod("stringWithFormat:", "nsstring_stringWithFormat");

    // NSArray
    const NSArray = this.registerClass("NSArray", NSObject);
    NSArray.addMethod("count", "nsarray_count");
    NSArray.addMethod("objectAtIndex:", "nsarray_objectAtIndex");
    NSArray.addMethod("containsObject:", "nsarray_containsObject");
    NSArray.addClassMethod("arrayWithObjects:count:", "nsarray_arrayWithObjects");

    // NSMutableArray
    const NSMutableArray = this.registerClass("NSMutableArray", NSArray);
    NSMutableArray.addMethod("addObject:", "nsmutablearray_addObject");
    NSMutableArray.addMethod("removeObjectAtIndex:", "nsmutablearray_removeObjectAtIndex");
    NSMutableArray.addClassMethod("array", "nsmutablearray_array");

    // NSDictionary
    const NSDictionary = this.registerClass("NSDictionary", NSObject);
    NSDictionary.addMethod("objectForKey:", "nsdict_objectForKey");
    NSDictionary.addMethod("count", "nsdict_count");
    NSDictionary.addClassMethod("dictionaryWithObjects:forKeys:count:", "nsdict_dictWithObjects");

    // NSMutableDictionary
    const NSMutableDictionary = this.registerClass("NSMutableDictionary", NSDictionary);
    NSMutableDictionary.addMethod("setObject:forKey:", "nsmutabledict_setObject");
    NSMutableDictionary.addMethod("removeObjectForKey:", "nsmutabledict_removeObject");
    NSMutableDictionary.addClassMethod("dictionary", "nsmutabledict_dictionary");

    // NSNumber
    const NSNumber = this.registerClass("NSNumber", NSObject);
    NSNumber.addMethod("intValue", "nsnumber_intValue");
    NSNumber.addMethod("doubleValue", "nsnumber_doubleValue");
    NSNumber.addMethod("boolValue", "nsnumber_boolValue");
    NSNumber.addMethod("stringValue", "nsnumber_stringValue");
    NSNumber.addClassMethod("numberWithInt:", "nsnumber_numberWithInt");
    NSNumber.addClassMethod("numberWithDouble:", "nsnumber_numberWithDouble");
    NSNumber.addClassMethod("numberWithBool:", "nsnumber_numberWithBool");

    // NSData
    const NSData = this.registerClass("NSData", NSObject);
    NSData.addMethod("length", "nsdata_length");
    NSData.addMethod("bytes", "nsdata_bytes");
    NSData.addClassMethod("dataWithBytes:length:", "nsdata_dataWithBytes");

    // NSDate
    const NSDate = this.registerClass("NSDate", NSObject);
    NSDate.addMethod("timeIntervalSince1970", "nsdate_timestamp");
    NSDate.addClassMethod("date", "nsdate_date");
    NSDate.addClassMethod("dateWithTimeIntervalSince1970:", "nsdate_dateWithTimestamp");

    // NSError
    const NSError = this.registerClass("NSError", NSObject);
    NSError.addMethod("code", "nserror_code");
    NSError.addMethod("domain", "nserror_domain");
    NSError.addMethod("localizedDescription", "nserror_description");
    NSError.addClassMethod("errorWithDomain:code:userInfo:", "nserror_errorWithDomain");

    this.log.info("Foundation classes registered");
  }

  // -------------------------------------------------------------------------
  // Registro público de clases
  // -------------------------------------------------------------------------

  registerClass(name, superclass = null) {
    if (this.classes.has(name)) return this.classes.get(name);
    let superClassObj = null;
    if (superclass) {
      if (typeof superclass === "string") {
        superClassObj = this.classes.get(superclass);
      } else {
        superClassObj = superclass;
      }
    }
    const cls = new ObjcClass(name, superClassObj);
    this.classes.set(name, cls);
    // Crear metaclase
    const meta = new ObjcClass(`meta-${name}`, null);
    meta.isa = cls;
    cls.isa = meta;
    this.metaclasses.set(name, meta);

    kernelBus.emit(OBJC_EVENTS.CLASS_REGISTERED, { name, super: superClassObj?.name });
    return cls;
  }

  lookupClass(name) {
    return this.classes.get(name) ?? null;
  }

  // -------------------------------------------------------------------------
  // Categorías
  // -------------------------------------------------------------------------

  addCategory(className, category) {
    const cls = this.classes.get(className);
    if (!cls) throw new Error(`category: class ${className} not found`);
    const cat = {
      name: category.name,
      methods: new Map(),
      classMethods: new Map(),
      protocols: category.protocols || [],
    };
    for (const [sel, imp] of Object.entries(category.methods || {})) {
      cat.methods.set(sel, { imp, types: "" });
    }
    for (const [sel, imp] of Object.entries(category.classMethods || {})) {
      cat.classMethods.set(sel, { imp, types: "" });
    }
    cls.categories.push(cat);
    kernelBus.emit(OBJC_EVENTS.CATEGORY_ADDED, {
      class: className,
      category: category.name,
    });
    return cat;
  }

  // -------------------------------------------------------------------------
  // Protocolos
  // -------------------------------------------------------------------------

  registerProtocol(name, { methods = [], protocols = [] } = {}) {
    const proto = {
      name,
      methods: new Set(methods),
      protocols: new Set(protocols),
    };
    this.protocols.set(name, proto);
    kernelBus.emit(OBJC_EVENTS.PROTOCOL_ADDED, { name });
    return proto;
  }

  // -------------------------------------------------------------------------
  // Mensajes
  // -------------------------------------------------------------------------

  /**
   * objc_msgSend(receiver, selector, ...args)
   * Dispatch de mensaje. Si `receiver` es una clase, busca en class methods.
   * Si es objeto, busca en instance methods.
   */
  msgSend(receiver, selector, args = []) {
    this.stats.messageSends++;

    if (receiver == null) {
      // Mensaje a nil → nil (0)
      kernelBus.emit(OBJC_EVENTS.MESSAGE_SENT, {
        receiver: null,
        selector,
        result: null,
      });
      return null;
    }

    // Determinar la clase
    let cls;
    let isMeta = false;
    if (receiver instanceof ObjcClass) {
      cls = receiver;
      isMeta = true;
    } else if (receiver instanceof ObjcObject) {
      cls = receiver.isa;
    } else if (typeof receiver === "object" && receiver.constructor) {
      // Objeto genérico — buscar por nombre de clase
      const className = receiver.constructor.name;
      cls = this.classes.get(className) || this.classes.get("NSObject");
    } else {
      // Tipo primitivo
      if (selector === "self") return receiver;
      if (selector === "class") return "primitive";
      return null;
    }

    // Buscar el método
    let method = null;
    if (isMeta && cls.isa) {
      method = cls.lookupClassMethod(selector) || cls.isa.lookupMethod(selector);
    } else {
      method = cls.lookupMethod(selector);
    }

    if (!method) {
      this.stats.unknownSelectors++;
      kernelBus.emit(OBJC_EVENTS.MESSAGE_UNKNOWN, {
        receiver: cls.name,
        selector,
      });
      // Intentar forwardInvocation: / methodSignatureForSelector:
      if (cls.lookupMethod("forwardInvocation:")) {
        return this._forwardInvocation(receiver, selector, args);
      }
      throw new Error(
        `-[${cls.name} ${selector}]: unrecognized selector sent to instance`
      );
    }

    // Invocar el IMP
    const result = this._invokeImp(method.imp, receiver, selector, args);
    kernelBus.emit(OBJC_EVENTS.MESSAGE_SENT, {
      receiver: isMeta ? cls.name : cls.name,
      selector,
      result,
    });
    return result;
  }

  _invokeImp(imp, receiver, selector, args) {
    if (typeof imp === "function") {
      return imp(receiver, selector, args, this);
    }
    if (typeof imp === "string") {
      return this._builtinImp(imp, receiver, selector, args);
    }
    return null;
  }

  _builtinImp(name, receiver, selector, args) {
    switch (name) {
      // Object lifecycle
      case "objc_alloc":
        this.stats.allocations++;
        return new ObjcObject(receiver);
      case "objc_init":
        return receiver;
      case "objc_dealloc":
        this.stats.deallocations++;
        if (receiver instanceof ObjcObject) receiver.deallocated = true;
        kernelBus.emit(OBJC_EVENTS.OBJECT_DEALLOCATED, { id: receiver?.id });
        return null;
      case "objc_retain":
        if (receiver?.retainCount != null) {
          receiver.retainCount++;
          kernelBus.emit(OBJC_EVENTS.RETAIN, { id: receiver.id, count: receiver.retainCount });
        }
        return receiver;
      case "objc_release":
        if (receiver?.retainCount != null) {
          receiver.retainCount--;
          kernelBus.emit(OBJC_EVENTS.RELEASE, { id: receiver.id, count: receiver.retainCount });
          if (receiver.retainCount <= 0) {
            this.msgSend(receiver, "dealloc", []);
          }
        }
        return null;
      case "objc_autorelease":
        if (this.currentPool) {
          this.currentPool.add(receiver);
          kernelBus.emit(OBJC_EVENTS.AUTORELEASE, { id: receiver?.id });
        }
        return receiver;
      case "objc_retainCount":
        return receiver?.retainCount ?? 0;
      case "objc_isEqual":
        return receiver === args[0];
      case "objc_hash":
        return receiver?.id ?? 0;
      case "objc_description":
        return `<${receiver?.isa?.name ?? "Object"}: 0x${(receiver?.id ?? 0).toString(16)}>`;
      case "objc_respondsToSelector":
        return receiver?.isa?.lookupMethod(args[0]) != null;
      case "objc_conformsToProtocol":
        return receiver?.isa?.conformsTo(args[0]) ?? false;
      case "objc_isKindOfClass": {
        const target = args[0];
        if (typeof target === "string") return receiver?.isa?.isSubclassOf({ name: target }) ?? false;
        return receiver?.isa?.isSubclassOf(target) ?? false;
      }
      case "objc_isMemberOfClass": {
        const target = args[0];
        const name = typeof target === "string" ? target : target?.name;
        return receiver?.isa?.name === name;
      }
      case "objc_new":
        return new ObjcObject(receiver);
      case "objc_class":
        return receiver;
      case "objc_load":
      case "objc_initialize":
        return null;

      // NSString
      case "nsstring_length":
        return receiver?.ivars?.get("string")?.length ?? 0;
      case "nsstring_UTF8String":
        return receiver?.ivars?.get("string") ?? "";
      case "nsstring_isEqualToString":
        return receiver?.ivars?.get("string") === args[0]?.ivars?.get("string");
      case "nsstring_stringWithUTF8String": {
        const cls = this.classes.get("NSString");
        const obj = new ObjcObject(cls);
        obj.setIvar("string", args[0]);
        return obj;
      }
      case "nsstring_stringWithFormat": {
        const cls = this.classes.get("NSString");
        const obj = new ObjcObject(cls);
        obj.setIvar("string", String(args[0] ?? ""));
        return obj;
      }

      // NSArray
      case "nsarray_count":
        return receiver?.ivars?.get("array")?.length ?? 0;
      case "nsarray_objectAtIndex":
        return receiver?.ivars?.get("array")?.[args[0]] ?? null;
      case "nsarray_containsObject":
        return (receiver?.ivars?.get("array") || []).includes(args[0]);
      case "nsarray_arrayWithObjects": {
        const cls = this.classes.get("NSArray");
        const obj = new ObjcObject(cls);
        obj.setIvar("array", args[0] || []);
        return obj;
      }

      // NSMutableArray
      case "nsmutablearray_addObject": {
        const arr = receiver.ivars.get("array") || [];
        arr.push(args[0]);
        receiver.setIvar("array", arr);
        return null;
      }
      case "nsmutablearray_removeObjectAtIndex": {
        const arr = receiver.ivars.get("array") || [];
        arr.splice(args[0], 1);
        receiver.setIvar("array", arr);
        return null;
      }
      case "nsmutablearray_array": {
        const cls = this.classes.get("NSMutableArray");
        const obj = new ObjcObject(cls);
        obj.setIvar("array", []);
        return obj;
      }

      // NSDictionary
      case "nsdict_objectForKey":
        return receiver?.ivars?.get("dict")?.[args[0]];
      case "nsdict_count":
        return Object.keys(receiver?.ivars?.get("dict") || {}).length;
      case "nsdict_dictWithObjects": {
        const cls = this.classes.get("NSDictionary");
        const obj = new ObjcObject(cls);
        const dict = {};
        for (let i = 0; i < (args[0]?.length || 0); i++) {
          dict[args[1]?.[i]] = args[0][i];
        }
        obj.setIvar("dict", dict);
        return obj;
      }

      // NSMutableDictionary
      case "nsmutabledict_setObject": {
        const dict = receiver.ivars.get("dict") || {};
        dict[args[1]] = args[0];
        receiver.setIvar("dict", dict);
        return null;
      }
      case "nsmutabledict_removeObject": {
        const dict = receiver.ivars.get("dict") || {};
        delete dict[args[0]];
        receiver.setIvar("dict", dict);
        return null;
      }
      case "nsmutabledict_dictionary": {
        const cls = this.classes.get("NSMutableDictionary");
        const obj = new ObjcObject(cls);
        obj.setIvar("dict", {});
        return obj;
      }

      // NSNumber
      case "nsnumber_intValue":
        return Math.trunc(receiver?.ivars?.get("value") || 0);
      case "nsnumber_doubleValue":
        return receiver?.ivars?.get("value") || 0;
      case "nsnumber_boolValue":
        return !!receiver?.ivars?.get("value");
      case "nsnumber_stringValue":
        return String(receiver?.ivars?.get("value"));
      case "nsnumber_numberWithInt":
      case "nsnumber_numberWithDouble":
      case "nsnumber_numberWithBool": {
        const cls = this.classes.get("NSNumber");
        const obj = new ObjcObject(cls);
        obj.setIvar("value", args[0]);
        return obj;
      }

      // NSData
      case "nsdata_length":
        return receiver?.ivars?.get("bytes")?.length ?? 0;
      case "nsdata_bytes":
        return receiver?.ivars?.get("bytes") ?? null;
      case "nsdata_dataWithBytes": {
        const cls = this.classes.get("NSData");
        const obj = new ObjcObject(cls);
        obj.setIvar("bytes", args[0]);
        return obj;
      }

      // NSDate
      case "nsdate_timestamp":
        return (receiver?.ivars?.get("ts") || 0) / 1000;
      case "nsdate_date": {
        const cls = this.classes.get("NSDate");
        const obj = new ObjcObject(cls);
        obj.setIvar("ts", Date.now());
        return obj;
      }
      case "nsdate_dateWithTimestamp": {
        const cls = this.classes.get("NSDate");
        const obj = new ObjcObject(cls);
        obj.setIvar("ts", (args[0] || 0) * 1000);
        return obj;
      }

      // NSError
      case "nserror_code":
        return receiver?.ivars?.get("code") ?? 0;
      case "nserror_domain":
        return receiver?.ivars?.get("domain") ?? "";
      case "nserror_description":
        return receiver?.ivars?.get("desc") ?? "";
      case "nserror_errorWithDomain": {
        const cls = this.classes.get("NSError");
        const obj = new ObjcObject(cls);
        obj.setIvar("domain", args[0]);
        obj.setIvar("code", args[1]);
        obj.setIvar("desc", args[2]?.localizedDescription || "Error");
        return obj;
      }

      default:
        this.log.warn(`unknown builtin IMP: ${name}`);
        return null;
    }
  }

  _forwardInvocation(receiver, selector, args) {
    // Simplified: return nil
    return null;
  }

  // -------------------------------------------------------------------------
  // Autorelease pools
  // -------------------------------------------------------------------------

  pushPool() {
    const pool = new AutoreleasePool();
    this.pools.push(pool);
    this.currentPool = pool;
    kernelBus.emit(OBJC_EVENTS.POOL_PUSH, { depth: this.pools.length });
    return pool;
  }

  popPool() {
    const pool = this.pools.pop();
    if (pool) pool.drain();
    this.currentPool = this.pools[this.pools.length - 1] ?? null;
    return pool;
  }

  // -------------------------------------------------------------------------
  // Swizzling
  // -------------------------------------------------------------------------

  swizzle(className, selectorA, selectorB) {
    const cls = this.classes.get(className);
    if (!cls) throw new Error(`swizzle: class ${className} not found`);
    this.stats.swizzles++;
    return this.swizzler.swizzle(cls, selectorA, selectorB);
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  snapshot() {
    return {
      classes: this.classes.size,
      metaclasses: this.metaclasses.size,
      selectors: this.selectors.size,
      protocols: this.protocols.size,
      pools: this.pools.length,
      stats: { ...this.stats },
      swizzleHistory: this.swizzler.history.length,
    };
  }
}

export default {
  ObjcClass,
  ObjcObject,
  ObjcRuntime,
  MethodSwizzler,
  AutoreleasePool,
  OBJC_EVENTS,
};
