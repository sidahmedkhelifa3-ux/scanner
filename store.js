/* ============================================================
   Pyjama Dz Tag Scanner — storage layer
   ------------------------------------------------------------
   One interface, two backends. scanner.js never knows which is
   in use; it just calls these methods and re-renders when the
   change callbacks fire.

     init()                  -> Promise, resolves once loaded
     onCatalog(fn)           fn(catalog)  catalog = {code: product}
     onScans(fn)             fn(scans)    scans   = newest first
     addScan(rec)            -> Promise
     setProduct(code, rec)   -> Promise
     deleteScan(id)          -> Promise
     deleteProduct(code)     -> Promise
     clearScans(ids)         -> Promise
     mode                    "cloud" | "local"

   A scan is stored as its own row rather than as a counter on the
   product. Two phones scanning at the same moment then can never
   overwrite each other's count — the quantities in the UI are
   derived by grouping those rows.
   ============================================================ */

(function(global){
  "use strict";

  var LOG_KEY = "pyjamadz.scanlog.v1";
  var CAT_KEY = "pyjamadz.catalog.v1";

  function lsGet(key, fallback){
    try{
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    }catch(e){ return fallback; }
  }
  function lsSet(key, value){
    try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){}
  }
  function num(v){
    return (v === null || v === undefined || v === "") ? null : Number(v);
  }

  /* ========================================================
     LOCAL — browser storage on this device only
     ======================================================== */
  function LocalStore(cfg){
    this.mode = "local";
    this.label = "this device";
    this.window = (cfg && cfg.scanWindow) || 500;
    this._cat = {};
    this._scans = [];
    this._catFn = null;
    this._scanFn = null;
  }

  LocalStore.prototype.init = function(){
    var self = this;
    this._cat = lsGet(CAT_KEY, {}) || {};
    var s = lsGet(LOG_KEY, []);
    this._scans = Array.isArray(s) ? s : [];

    // another tab of the same page changing the same keys
    global.addEventListener("storage", function(ev){
      if(ev.key === CAT_KEY){
        self._cat = lsGet(CAT_KEY, {}) || {};
        self._emitCat();
      } else if(ev.key === LOG_KEY){
        var v = lsGet(LOG_KEY, []);
        self._scans = Array.isArray(v) ? v : [];
        self._emitScans();
      }
    });
    return Promise.resolve();
  };

  LocalStore.prototype.onCatalog = function(fn){ this._catFn = fn; this._emitCat(); };
  LocalStore.prototype.onScans   = function(fn){ this._scanFn = fn; this._emitScans(); };
  LocalStore.prototype._emitCat   = function(){ if(this._catFn) this._catFn(this._cat); };
  LocalStore.prototype._emitScans = function(){ if(this._scanFn) this._scanFn(this._scans); };

  LocalStore.prototype.addScan = function(rec){
    rec = Object.assign({}, rec);
    rec.id = "l" + Date.now() + Math.random().toString(36).slice(2, 7);
    this._scans.unshift(rec);
    if(this._scans.length > this.window) this._scans.length = this.window;
    lsSet(LOG_KEY, this._scans);
    this._emitScans();
    return Promise.resolve();
  };

  LocalStore.prototype.setProduct = function(code, rec){
    this._cat[code] = rec;
    lsSet(CAT_KEY, this._cat);
    this._emitCat();
    return Promise.resolve();
  };

  LocalStore.prototype.deleteScan = function(id){
    this._scans = this._scans.filter(function(s){ return s.id !== id; });
    lsSet(LOG_KEY, this._scans);
    this._emitScans();
    return Promise.resolve();
  };

  LocalStore.prototype.deleteProduct = function(code){
    delete this._cat[code];
    lsSet(CAT_KEY, this._cat);
    this._emitCat();
    return Promise.resolve();
  };

  LocalStore.prototype.clearScans = function(){
    this._scans = [];
    lsSet(LOG_KEY, this._scans);
    this._emitScans();
    return Promise.resolve();
  };

  /* Everything this device has stored, for the upload prompt. */
  LocalStore.readStash = function(){
    var cat = lsGet(CAT_KEY, {}) || {};
    var log = lsGet(LOG_KEY, []);
    return { catalog: cat, scans: Array.isArray(log) ? log : [] };
  };
  LocalStore.clearStash = function(){
    try{ localStorage.removeItem(CAT_KEY); localStorage.removeItem(LOG_KEY); }catch(e){}
  };

  /* ========================================================
     CLOUD — Supabase, shared by every phone
     ======================================================== */
  function CloudStore(cfg){
    this.mode = "cloud";
    this.label = "supabase";
    this.window = cfg.scanWindow || 500;
    this.sb = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    this._cat = {};
    this._scans = [];
    this._catFn = null;
    this._scanFn = null;
  }

  CloudStore.prototype.init = function(){
    var self = this;
    return Promise.all([this._loadCatalog(), this._loadScans()]).then(function(){
      // Both tables are small, so a change just re-reads the table.
      // Simpler than patching rows in place, and it cannot drift.
      self.sb.channel("pyjamadz-scanner")
        .on("postgres_changes", { event: "*", schema: "public", table: "products" },
            function(){ self._loadCatalog(); })
        .on("postgres_changes", { event: "*", schema: "public", table: "scans" },
            function(){ self._loadScans(); })
        .subscribe();
    });
  };

  CloudStore.prototype.onCatalog = function(fn){ this._catFn = fn; if(this._catFn) this._catFn(this._cat); };
  CloudStore.prototype.onScans   = function(fn){ this._scanFn = fn; if(this._scanFn) this._scanFn(this._scans); };

  CloudStore.prototype._loadCatalog = function(){
    var self = this;
    return this.sb.from("products").select("*").then(function(res){
      if(res.error) throw res.error;
      var map = {};
      (res.data || []).forEach(function(p){
        map[p.code] = {
          brand: p.brand || (p.note && p.note.indexOf("Marque: ") > -1 ? p.note.replace(/^.*Marque:\s*([^\s•]+).*/, "$1") : ""),
          name: p.name, nameAr: p.name_ar, sku: p.sku,
          price: num(p.price), note: p.note
        };
      });
      self._cat = map;
      if(self._catFn) self._catFn(map);
    });
  };

  CloudStore.prototype._loadScans = function(){
    var self = this;
    return this.sb.from("scans")
      .select("*")
      .order("scanned_at", { ascending: false })
      .limit(this.window)
      .then(function(res){
        if(res.error) throw res.error;
        self._scans = (res.data || []).map(function(r){
          return {
            id: r.id, code: r.code, name: r.name, sku: r.sku, brand: r.brand || "",
            source: r.source || "", price: num(r.price), at: r.scanned_at
          };
        });
        if(self._scanFn) self._scanFn(self._scans);
      });
  };

  /* supabase-js RESOLVES with {data, error} — it does not reject — so a
     database error never reaches .catch(). Retrying on rejection was
     therefore dead code. This inspects the error instead, and drops the
     `brand` column only when the schema predates it. */
  /* Which column did the database not recognise? PostgREST says
     "Could not find the 'source' column"; Postgres says
     column "source" of relation ... does not exist. */
  function missingColumnName(err){
    if(!err) return null;
    var text = (err.message || "") + " " + (err.details || "") + " " + (err.hint || "");
    var m = text.match(/'([A-Za-z_][A-Za-z0-9_]*)'\s+column/i) ||
            text.match(/column\s+"([A-Za-z_][A-Za-z0-9_]*)"/i) ||
            text.match(/column\s+([A-Za-z_][A-Za-z0-9_]*)\s+of/i);
    return m ? m[1] : null;
  }

  function omit(row, key){
    var copy = {};
    for(var k in row){ if(k !== key) copy[k] = row[k]; }
    return copy;
  }

  /* run(row) must return a supabase query builder.

     A schema that predates a column should cost the user that ONE
     field, not the whole scan. So when the database rejects a column
     it does not know, drop exactly that column and try again — rather
     than failing the write and losing the record entirely. */
  function sendRow(run, row, depth){
    depth = depth || 0;
    return run(row).then(function(res){
      if(!res || !res.error || depth >= 3) return res;
      var col = missingColumnName(res.error);
      if(col && row[col] !== undefined) return sendRow(run, omit(row, col), depth + 1);
      return res;
    });
  }

  CloudStore.prototype.addScan = function(rec){
    var self = this;
    var row = {
      code: rec.code,
      name: rec.name,
      sku: rec.sku,
      price: rec.price,
      format: rec.format || null,
      scanned_at: rec.at || new Date().toISOString()
    };
    if(rec.brand) row.brand = rec.brand;
    // camera | gun | manual | photo — which input produced this scan
    if(rec.source) row.source = rec.source;
    return sendRow(function(r){
      return self.sb.from("scans").insert(r);
    }, row).then(function(res){
      if(res && res.error) throw res.error;
      return self._loadScans();
    });
  };

  CloudStore.prototype.setProduct = function(code, rec){
    var self = this;
    var noteVal = rec.note || (rec.brand ? "Marque: " + rec.brand : null);
    var row = {
      code: code,
      name: rec.name,
      name_ar: rec.nameAr || null,
      sku: rec.sku || null,
      price: rec.price,
      note: noteVal,
      updated_at: new Date().toISOString()
    };
    if(rec.brand) row.brand = rec.brand;
    return sendRow(function(r){
      return self.sb.from("products").upsert(r, { onConflict: "code" });
    }, row).then(function(res){
      if(res && res.error) throw res.error;
      return self._loadCatalog();
    });
  };

  CloudStore.prototype.deleteScan = function(id){
    var self = this;
    return this.sb.from("scans").delete().eq("id", id).then(function(res){
      if(res.error) throw res.error;
      return self._loadScans();
    });
  };

  CloudStore.prototype.deleteProduct = function(code){
    var self = this;
    return this.sb.from("products").delete().eq("code", code).then(function(res){
      if(res.error) throw res.error;
      return self._loadCatalog();
    });
  };

  CloudStore.prototype.clearScans = function(ids){
    var self = this;
    if(!ids || !ids.length) return Promise.resolve();
    return this.sb.from("scans").delete().in("id", ids).then(function(res){
      if(res.error) throw res.error;
      return self._loadScans();
    });
  };

  /* ========================================================
     Pick a backend. Supabase if configured AND reachable,
     otherwise this device — the scanner still works either way.
     ======================================================== */
  function open(){
    var cfg = global.PYJAMADZ_CONFIG || {};
    var configured = cfg.supabaseUrl && cfg.supabaseAnonKey &&
                     global.supabase && typeof global.supabase.createClient === "function";

    if(!configured){
      var local = new LocalStore(cfg);
      return local.init().then(function(){
        return { store: local, fellBack: false };
      });
    }

    var cloud;
    try{
      cloud = new CloudStore(cfg);
    }catch(e){
      return openLocal(cfg, "The Supabase client could not start.");
    }
    return cloud.init().then(function(){
      return { store: cloud, fellBack: false };
    }, function(err){
      var why = (err && (err.message || err.hint)) || "Supabase did not answer.";
      return openLocal(cfg, why);
    });
  }

  function openLocal(cfg, reason){
    var local = new LocalStore(cfg);
    return local.init().then(function(){
      return { store: local, fellBack: true, reason: reason };
    });
  }

  global.Store = {
    open: open,
    readStash: LocalStore.readStash,
    clearStash: LocalStore.clearStash,
    // exposed so the degradation path can be tested against the real
    // error strings PostgREST and Postgres actually emit
    missingColumnName: missingColumnName
  };

})(window);
