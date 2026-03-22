/* ═══════════════════════════════════════════════════════════════════════════
   eventbus.js  —  HEXADO CHASING v2.0
   Layer   : Foundation (load order: 1st after Three.js)
   Exports : window.HexEngine.EventBus
   Deps    : none
   ═══════════════════════════════════════════════════════════════════════════ */

var HE = window.HexEngine = window.HexEngine || {};

HE.EventBus = class {

  constructor() {
    this._listeners = new Map();
    this._emitDepth = 0;
  }

  /* Subscribe fn to event. Duplicates ignored. Returns this for chaining. */
  on(event, fn) {
    if (typeof event !== 'string' || typeof fn !== 'function') {
      console.warn('[EventBus] on() — invalid args:', event, fn);
      return this;
    }
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);
    return this;
  }

  /* Unsubscribe a specific handler. Silent no-op if not found. */
  off(event, fn) {
    if (!this._listeners.has(event)) return this;
    this._listeners.get(event).delete(fn);
    if (this._listeners.get(event).size === 0) {
      this._listeners.delete(event);
    }
    return this;
  }

  /* Broadcast data to all subscribers. Snapshots Set before iterating so
     handlers that call off() mid-loop don't cause skipped callbacks.       */
  emit(event, data) {
    if (this._emitDepth >= 10) {
      console.error('[EventBus] recursion limit hit for:', event);
      return this;
    }
    if (!this._listeners.has(event)) return this;

    var handlers = Array.from(this._listeners.get(event));
    this._emitDepth++;
    for (var i = 0; i < handlers.length; i++) {
      try {
        handlers[i](data);
      } catch (err) {
        console.error('[EventBus] handler error on "' + event + '":', err);
      }
    }
    this._emitDepth--;
    return this;
  }

  /* Subscribe fn for exactly one emit, then auto-unsubscribe. */
  once(event, fn) {
    var self = this;
    var wrapper = function(data) {
      self.off(event, wrapper);
      fn(data);
    };
    return this.on(event, wrapper);
  }

  /* Remove all handlers for event, or all events if omitted. */
  clear(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
    return this;
  }

  /* DevTools helper — call HE.bus.debug() to inspect live subscriptions. */
  debug() {
    console.group('[EventBus] Active subscriptions');
    this._listeners.forEach(function(set, ev) {
      console.log(ev + ' — ' + set.size + ' handler(s)');
    });
    console.groupEnd();
  }

};
