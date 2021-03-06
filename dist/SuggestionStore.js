(function(exports) {

    function getDocumentKey(document) {
        return document.type + ":" + document.id;
    }
    exports.getDocumentKey = getDocumentKey;

    function groupBy(items, keyFn) {
        var result = {}, i = 0, v, k;

        for (; i < items.length; i += 1) {
            v = items[i];
            k = keyFn(v);

            if (k in result) {
                result[k].push(v);
            } else {
                result[k] = [v];
            }
        }

        return result;
    }
    exports.groupBy = groupBy;

}(window.SuggestionStore = window.SuggestionStore || {}));
;(function(exports) {
     var indexedDB = window.indexedDB || window.mozIndexedDB ||
                     window.webkitIndexedDB || window.msIndexedDB,
         IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange ||
                       window.msIDBKeyRange;

    function Lock() {
        this.counter = 1;
        this.callback = null;
    }
    exports.Lock = Lock;

    /**
     * @private
     */
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

    /**
     * @private
     */
    Storage.prototype.createDocTokens = function(trans, document, callback) {
        var lock, tokenRefs = [], tokenStore, i,
            tokens = SuggestionStore.tokenize(document.text);

        lock = new Lock();

        function onRefAdded(e) {
            tokenRefs.push(e.target.result);
            lock.decr();
        }

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

    /**
     * @private
     */
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

    Storage.prototype.updateDocument =
     function(type, id, getDocumentFn, callback) {
        var that = this, trans, key, lock, docStore, putDoc;

        trans = this.idb.transaction(["documents", "references"], "readwrite");

        lock = new Lock();

        key = SuggestionStore.getDocumentKey({
            type: type,
            id: id
        });

        docStore = trans.objectStore("documents");

        putDoc = function(document) {
            lock.incr();
            docStore.put(document).onsuccess =  function() {
                lock.decr();
            };
        };

        lock.incr();
        docStore.get(key).onsuccess = function(e) {
            var storedDocument, document;

            storedDocument = e.target.result;

            document = getDocumentFn(storedDocument);
            document._key = key;

            if (!storedDocument || storedDocument !== document.text) {
                if (storedDocument) {
                    that.removeDocTokens(trans, lock, storedDocument._tokenRefs.slice());
                }
                document._tokenRefs = [];
                lock.incr();
                that.createDocTokens(trans, document, function(tokenRefs) {
                    document._tokenRefs = tokenRefs;
                    putDoc(document);
                    lock.decr();
                });
            } else {
                putDoc(document);
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

    Storage.prototype.getDocument = function(type, id, callback) {
        var key, req;

        key = SuggestionStore.getDocumentKey({
            type: type,
            id: id
        });

        req = this.idb.transaction(["documents"]).objectStore("documents").get(key);

        req.onsuccess = function(e) {
            var document = e.target.result;

            if (document) {
                // internal
                delete document._key;
                delete document._tokenRefs;
            }

            callback(null, document);
        };

        req.onerror = function(e) {
            callback(e.target.errorCode, null);
        };
    };

    Storage.prototype.getDocs = function(keys, callback) {
        var lock, lookupCb, docStore, i, docs = [];

        lock = new Lock();
        docStore = this.idb.transaction(["documents"])
                    .objectStore("documents");

        lookupCb = function(e) {
            var doc = e.target.result;

            if (doc) {
                // internal
                delete doc._key;
                delete doc._tokenRefs;

                docs.push(doc);
            }
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
        var that = this, tokens, i, lock, tokenIndex, cursor,
            docKeysByToken = {};

        tokens = SuggestionStore.cleanQuery(query);
        lock = new SuggestionStore.Lock();
        tokenIndex = this.idb.transaction(["references"])
                     .objectStore("references").index("token");

        for (i = 0; i < tokens.length; i += 1) {
            docKeysByToken[tokens[i]] = [];
        }

        function createLookupCb(token) {
            return function(e) {
                var cursor = e.target.result;
                if (cursor) {
                    docKeysByToken[token].push(cursor.value.documentKey);

                    cursor["continue"]();
                } else {
                    lock.decr();
                }
            };
        }

        for (i = 0; i < tokens.length; i += 1) {
            lock.incr();

            tokenIndex.openCursor(
                IDBKeyRange.only(tokens[i])
            ).onsuccess = createLookupCb(tokens[i]);
        }

        lock.setCallback(function() {
            var keys = SuggestionStore.getObjectValues(docKeysByToken),
                mapFn = SuggestionStore.getDocumentSet,
                keySets = SuggestionStore.map(keys, mapFn),
                intersection = SuggestionStore.getIntersection(keySets);

            that.getDocs(intersection, function(docs) {
                callback(null, docs);
            });
        });

        lock.decr();
    };

    function DatabaseManager(name, version) {
        /* @protected */
        this.name = name;
        this.version = version;
    }
    exports.DatabaseManager = DatabaseManager;

    DatabaseManager.prototype.get = function(callback) {
        var that = this, req = indexedDB.open(this.name, this.version);

        req.onsuccess = function() {
            callback(null, this.result);
        };

        req.onerror = function(e) {
            callback(e.target.errorCode, null);
        };

        req.onupgradeneeded = function(e) {
            that.handleUpgradeNeeded(e);
        };
    };

    /* @protected */
    DatabaseManager.prototype.initialSetup = function(db) {
        var refStore;
        db.createObjectStore("documents", {keyPath: "_key"});
        refStore = db.createObjectStore("references", {autoIncrement: true});
        refStore.createIndex("token", "token");
    };

    DatabaseManager.prototype.handleUpgradeNeeded = function(e) {
        this.initialSetup(e.currentTarget.result);
    };

    function getStorage(manager, callback) {
        manager.get(function(err, db) {
            if (err) {
                callback(err, null);
            } else {
                callback(null, new Storage(db));
            }
        });
    }
    exports.getStorage = getStorage;

}(window.SuggestionStore = window.SuggestionStore || {}));
;(function(exports) {

    function Trim() {}
    Trim.prototype.wsRE = /\s/;
    Trim.prototype.replaceRE = /^\s\s*/;
    Trim.prototype.apply = function(input) {
        var str = input.replace(this.replaceRE, ''),
            ws = this.wsRE,
            i = str.length;
        while (ws.test(str.charAt(--i)));
        return str.slice(0, i + 1);
    };

    function Replace() {
        this.REs = {};
    }
    exports.Replace = Replace;

    Replace.prototype.setMap = function(map) {
        var key, val, tmp = {};

        this.REs = {};

        for (key in map) {
            if (map.hasOwnProperty(key)) {
                val = map[key];

                if (val in tmp) {
                    tmp[val].push(key);
                } else {
                    tmp[val] = [key];
                }
            }
        }

        for (key in tmp) {
            if (tmp.hasOwnProperty(key)) {
                val = tmp[key];
                this.REs[key] = new RegExp("(" + val.join("|") + ")", "gi");
            }
        }
    };

    Replace.prototype.apply = function(input) {
        var output, key, val;
        output = input;

        for (key in this.REs) {
            if (this.REs.hasOwnProperty(key)) {
                val = this.REs[key];
                output = output.replace(val, key);
            }
        }

        return output;
    };

    var unicodeReplace = new Replace();
    unicodeReplace.setMap({
        "á": "a",  "à": "a",  "â": "a",
        "ã": "a",  "ä": "a",  "é": "e",
        "è": "e",  "ê": "e",  "ë": "e",
        "í": "i",  "ì": "i",  "î": "i",
        "ó": "o",  "ò": "o",  "ô": "o",
        "õ": "o",  "ö": "o",  "ú": "u",
        "ù": "u",  "û": "u",  "ü": "u",
        "ç": "c",  "ñ": "n"
    });
    exports.unicodeReplace = unicodeReplace;

    function Split() {}
    exports.Split = Split;
    Split.prototype.RE = /[^\w\d]+/g;
    Split.prototype.apply = function(input) {
        var i = 0, token, output = [];

        input =  input.split(this.RE);

        for (i = 0; i < input.length; i += 1) {
            token = input[i];
            if (token.length) {
                output.push(token);
            }
        }

        return output;
    };

    function Lower() {}
    exports.Lower = Lower;
    Lower.prototype.apply = function(input) {
        return ("" + input).toLowerCase();
    };

    function createNgrams(input, minLength, maxLength) {
        var output = [];

        minLength = minLength || 1;
        maxLength = Math.min(input.length, maxLength || Number.MAX_VALUE);

        do {
            input = input.slice(0, maxLength);
            output.push(input);
        } while(--maxLength >= minLength);

        return output.reverse();
    }
    exports.createNgrams = createNgrams;

    function addPhraseNgrams(input) {
        var output = [], ngrams = createNgrams(input.join(" "), 1, 30),
            i = 0, len = ngrams.length;

        for (; i < len; i += 1) {
            output.push(ngrams[i]);
        }

        return output;
    }
    exports.addPhraseNgrams = addPhraseNgrams;

   function addTokenNgrams(input) {
        var output = [], i = 0, len = input.length;

        for (; i < len; i += 1) {
            output.push.apply(output, createNgrams(input[i], 1, 20));
        }

        return output;
    }
    exports.addTokenNgrams = addTokenNgrams;

    function getTokenSet(tokens) {
        var swp = {}, i = 0, len = tokens.length, cur, result = [];

        for (; i < len; i += 1) {
            cur = tokens[i];
            if (!(cur in swp)) {
                swp[cur] = 1;
                result.push(cur);
            }
        }

        return result;
    }
    exports.getTokenSet = getTokenSet;


    function Pipeline(steps) {
        this.steps = steps;
    }
    exports.Pipeline = Pipeline;

    Pipeline.prototype.apply = function(input) {
        var i = 0, len, step, output = input;
        for (len = this.steps.length; i < len; i += 1) {
            step = this.steps[i];
            output = step.apply(output);
        }
        return output;
    };

    var defaultPipeline = new Pipeline([
        new Trim(),
        new Lower(),
        unicodeReplace,
        new Split()
    ]);

    function cleanQuery(input) {
        return defaultPipeline.apply(input);
    }
    exports.cleanQuery = cleanQuery;

    function tokenize(input) {
        var output;
        input = defaultPipeline.apply(input);
        output = input.slice();
        output.push.apply(output, addPhraseNgrams(input));
        output.push.apply(output, addTokenNgrams(input));
        return getTokenSet(output);
    }
    exports.tokenize = tokenize;

}(window.SuggestionStore = window.SuggestionStore || {}));
;(function(exports) {
    // Polyfill
    exports.map = function(xs, fn) {
        var xs_l = xs.length, i = 0, results = [];
        for (; i < xs_l; i += 1) {
            results.push(fn(xs[i]));
        }
        return results;
    };

    function getObjectValues(obj) {
        var prop, val, values = [];

        for (prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                val = obj[prop];
                values.push(val);
            }
        }

        return values;
    }
    exports.getObjectValues = getObjectValues;

    /**
     * Returns unique elements of an Array ordered by the numbers of times they
     * appear.
     *
     * @param {array} docRefs - The original array.
     */
    function getDocumentSet(docRefs) {
        var count = {}, i = 0, x, xs = [];

        for (; i < docRefs.length; i += 1) {
            x = docRefs[i];

            if (x in count) {
                count[x] += 1;
            } else {
                count[x] = 1;
                xs.push(x);
            }
        }

        xs.sort(function(a, b) {
            return count[a] > count[b] ? -1 : 1;
        });

        return xs;
    }
    exports.getDocumentSet = getDocumentSet;

    function getIntersection(args) {
        var args_l = args.length, counting = {}, set, str, i = 0, j = 0,
            results = [];

        for (; i < args_l; i += 1) {
            set = args[i];
            for (j = 0; j < set.length; j += 1) {
                str = set[j];

                if (!counting[str]) {
                    counting[str] = 1;
                } else {
                    counting[str] += 1;
                }
            }
        }

        for (str in counting) {
            if (counting[str] === args_l) {
                results.push(str);
            }
        }

        return results;
    }
    exports.getIntersection = getIntersection;

}(window.SuggestionStore = window.SuggestionStore || {}));
