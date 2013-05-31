(function(exports) {
     var indexedDB = window.indexedDB || window.mozIndexedDB ||
                     window.webkitIndexedDB || window.msIndexedDB,
         IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange ||
                       window.msIDBKeyRange;

    function Lock() {
        this.counter = 1;
        this.callback = null;
    }
    exports.Lock = Lock;

    Lock.prototype.check = function() {
        if (this.callback && this.counter === 0) {
            this.callback();
            this.callback = null;
        }
    };

    Lock.prototype.setCallback = function(callback) {
        this.callback = callback;
        this.check();
    };

    Lock.prototype.incr = function() {
        this.counter += 1;
    };

    Lock.prototype.decr = function() {
        if (this.counter > 0) {
            this.counter -= 1;
        }

        this.check();
    };

    function Storage(idb) {
        this.idb = idb;
    }

    Storage.prototype.createDocTokens = function(trans, document, callback) {
        var lock, tokenRefs = [], tokenStore, i,
            tokens = SuggestionStore.tokenize(document.text);

        lock = new Lock();

        onRefAdded = function(e) {
            tokenRefs.push(e.target.result);
            lock.decr();
        };

        tokenStore = trans.objectStore("references");

        for (i = 0; i < tokens.length; i += 1) {
            lock.incr();
            tokenStore.add({
                token: tokens[i],
                documentKey: document._key
            }).onsuccess = onRefAdded;
        }

        lock.setCallback(function() {
            callback(tokenRefs);
        });
        lock.decr();
    };

    Storage.prototype.removeDocTokens = function(trans, lock, tokenRefs) {
        var decrLock, tokenStore, i;

        decrLock = function() {
            lock.decr();
        };

        tokenStore = trans.objectStore("references");

        for (i = 0; i < tokenRefs.length; i += 1) {
            lock.incr();
            tokenStore["delete"](tokenRefs[i]).onsuccess = decrLock;
        }
    };

    Storage.prototype.insertDocument = function(document, callback) {
        var key, trans, lock;

        key = SuggestionStore.getDocumentKey(document);
        document._key = key;
        trans = this.idb.transaction(["documents", "references"], "readwrite");

        lock = new Lock();

        lock.incr();
        this.createDocTokens(trans, document, function(tokenRefs) {
            document._tokenRefs = tokenRefs;

            lock.incr();
            trans.objectStore("documents").add(document)
             .onsuccess = function() {
                lock.decr();
            };

            lock.decr();
        });

        lock.setCallback(function() {
            callback(null);
        });

        lock.decr();
    };

    Storage.prototype.updateDocument = function(document, callback) {
        var that = this, trans, key, lock, docStore, putDoc;

        trans = this.idb.transaction(["documents", "references"], "readwrite");
        lock = new Lock();
        key = SuggestionStore.getDocumentKey(document);
        document._key = key;

        docStore = trans.objectStore("documents");

        putDoc = function() {
            lock.incr();
            docStore.put(document).onsuccess =  function() {
                lock.decr();
            };
        };

        lock.incr();
        docStore.get(key).onsuccess = function(e) {
            var storedDocument = e.target.result;
            if (!storedDocument || storedDocument !== document.text) {
                if (storedDocument) {
                    that.removeDocTokens(trans, lock, storedDocument._tokenRefs.slice());
                }
                document._tokenRefs = [];
                lock.incr();
                that.createDocTokens(trans, document, function(tokenRefs) {
                    document._tokenRefs = tokenRefs;
                    putDoc();
                    lock.decr();
                });
            } else {
                putDoc();
            }

            lock.decr();
        };

        lock.setCallback(function() {
            callback(null);
        });

        lock.decr();
    };

    Storage.prototype.deleteDocument = function(key, callback) {
        var that = this, trans, lock, docStore;

        trans = this.idb.transaction(["documents", "references"], "readwrite");
        lock = new Lock();

        docStore = trans.objectStore("documents");

        lock.incr();
        docStore.get(key).onsuccess = function(e) {
            var document = e.target.result;
            that.removeDocTokens(trans, lock, document._tokenRefs.slice());

            lock.incr();
            docStore["delete"](key).onsuccess = function() {
                lock.decr();
            };

            lock.decr();
        };

        lock.setCallback(function() {
            callback(null);
        });

        lock.decr();
    };

    Storage.prototype.getDocs = function(keys, callback) {
        var lock, lookupCb, docStore, i, docs = [];

        lock = new Lock();
        docStore = this.idb.transaction(["documents"])
                    .objectStore("documents");

        lookupCb = function(e) {
            var document = e.target.result;

            // internal
            delete document._key;
            delete document._tokenRefs;

            docs.push(document);
            lock.decr();
        };

        for (i = 0; i < keys.length; i += 1) {
            lock.incr();
            docStore.get(keys[i]).onsuccess = lookupCb;
        }

        lock.setCallback(function() {
            callback(docs);
        });

        lock.decr();
    };

    Storage.prototype.search = function(query, callback) {
        var that = this, tokens, i, lock, tokenIndex, lookupCb, cursor,
            docKeys = [];

        tokens = SuggestionStore.tokenize(query);
        lock = new SuggestionStore.Lock();
        tokenIndex = this.idb.transaction(["references"])
                     .objectStore("references").index("token");

        lookupCb = function(e) {
            var cursor = e.target.result;
            if (cursor) {
                docKeys.push(cursor.value.documentKey);
                cursor["continue"]();
            } else {
                lock.decr();
            }
        };

        for (i = 0; i < tokens.length; i += 1) {
            lock.incr();
            tokenIndex.openCursor(IDBKeyRange.only(tokens[i])).onsuccess = lookupCb;
        }

        lock.setCallback(function() {
            that.getDocs(SuggestionStore.getDocumentSet(docKeys), function(docs) {
                callback(null, docs);
            });
        });

        lock.decr();
    };

    function getStorage(name, version, callback) {
        var openReq = indexedDB.open(name, version);

        openReq.onsuccess = function() {
            callback(null, new Storage(this.result));
        };

        openReq.onerror = function(e) {
            callback(e.target.errorCode, null);
        };

        openReq.onupgradeneeded = function(e) {
            var db = e.currentTarget.result, refStore;
            db.createObjectStore("documents", {keyPath: "_key"});
            refStore = db.createObjectStore("references", {autoIncrement: true});
            refStore.createIndex("token", "token");
        };
    }
    exports.getStorage = getStorage;

}(window.SuggestionStore = window.SuggestionStore || {}));