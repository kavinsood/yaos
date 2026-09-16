import wasmModule from "./ywasm_bg.wasm";

/* @ts-self-types="./ywasm.d.ts" */

export class Awareness {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AwarenessFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_awareness_free(ptr, 0);
    }
    destroy() {
        wasm.awareness_destroy(this.__wbg_ptr);
    }
    /**
     * @returns {YDoc}
     */
    get doc() {
        const ret = wasm.awareness_doc(this.__wbg_ptr);
        return YDoc.__wrap(ret);
    }
    /**
     * @returns {any}
     */
    getLocalState() {
        const ret = wasm.awareness_getLocalState(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {Map<any, any>}
     */
    getStates() {
        const ret = wasm.awareness_getStates(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {Map<any, any>}
     */
    get meta() {
        const ret = wasm.awareness_meta(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {YDoc} doc
     */
    constructor(doc) {
        _assertClass(doc, YDoc);
        var ptr0 = doc.__destroy_into_raw();
        const ret = wasm.awareness_new(ptr0);
        this.__wbg_ptr = ret;
        AwarenessFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} event
     * @param {Function} callback
     * @returns {boolean}
     */
    off(event, callback) {
        const ptr0 = passStringToWasm0(event, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.awareness_off(this.__wbg_ptr, ptr0, len0, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
        const ptr0 = passStringToWasm0(event, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.awareness_on(this.__wbg_ptr, ptr0, len0, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {any} state
     */
    setLocalState(state) {
        const ret = wasm.awareness_setLocalState(this.__wbg_ptr, state);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} key
     * @param {any} value
     */
    setLocalStateField(key, value) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.awareness_setLocalStateField(this.__wbg_ptr, ptr0, len0, value);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) Awareness.prototype[Symbol.dispose] = Awareness.prototype.free;

/**
 * A collection used to store data in an indexed sequence structure. This type is internally
 * implemented as a double linked list, which may squash values inserted directly one after another
 * into single list node upon transaction commit.
 *
 * Reading a root-level type as an YArray means treating its sequence components as a list, where
 * every countable element becomes an individual entity:
 *
 * - JSON-like primitives (booleans, numbers, strings, JSON maps, arrays etc.) are counted
 *   individually.
 * - Text chunks inserted by [Text] data structure: each character becomes an element of an
 *   array.
 * - Embedded and binary values: they count as a single element even though they correspond of
 *   multiple bytes.
 *
 * Like all Yrs shared data types, YArray is resistant to the problem of interleaving (situation
 * when elements inserted one after another may interleave with other peers concurrent inserts
 * after merging all updates together). In case of Yrs conflict resolution is solved by using
 * unique document id to determine correct and consistent ordering.
 */
export class YArray {
    static __wrap(ptr) {
        const obj = Object.create(YArray.prototype);
        obj.__wbg_ptr = ptr;
        YArrayFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YArrayFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yarray_free(ptr, 0);
    }
    /**
     * Checks if current YArray reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.yarray_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Deletes a range of items of given `length` from current `YArray` instance,
     * starting from given `index`.
     * @param {number} index
     * @param {number | null | undefined} length
     * @param {YTransaction | undefined} txn
     */
    delete(index, length, txn) {
        const ret = wasm.yarray_delete(this.__wbg_ptr, index, isLikeNone(length) ? Number.MAX_SAFE_INTEGER : (length) >>> 0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {YDoc | undefined}
     */
    get doc() {
        const ret = wasm.yarray_doc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Returns an element stored under given `index`.
     * @param {number} index
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    get(index, txn) {
        const ret = wasm.yarray_get(this.__wbg_ptr, index, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.yarray_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Inserts a given range of `items` into this `YArray` instance, starting at given `index`.
     * @param {number} index
     * @param {any[]} items
     * @param {YTransaction | undefined} txn
     */
    insert(index, items, txn) {
        const ptr0 = passArrayJsValueToWasm0(items, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yarray_insert(this.__wbg_ptr, index, ptr0, len0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a number of elements stored within this instance of `YArray`.
     * @param {YTransaction | undefined} txn
     * @returns {number}
     */
    length(txn) {
        const ret = wasm.yarray_length(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Creates a new preliminary instance of a `YArray` shared data type, with its state
     * initialized to provided parameter.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @param {any[] | null} [items]
     */
    constructor(items) {
        var ptr0 = isLikeNone(items) ? 0 : passArrayJsValueToWasm0(items, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.yarray_new(ptr0, len0);
        this.__wbg_ptr = ret;
        YArrayFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Subscribes to all operations happening over this instance of `YArray`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.yarray_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.yarray_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns true if this is a preliminary instance of `YArray`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.yarray_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Appends a range of `items` at the end of this `YArray` instance.
     * @param {any[]} items
     * @param {YTransaction | undefined} txn
     */
    push(items, txn) {
        const ptr0 = passArrayJsValueToWasm0(items, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yarray_push(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number | null | undefined} lower
     * @param {number | null | undefined} upper
     * @param {boolean | null | undefined} lower_open
     * @param {boolean | null | undefined} upper_open
     * @param {YTransaction | undefined} txn
     * @returns {YWeakLink}
     */
    quote(lower, upper, lower_open, upper_open, txn) {
        const ret = wasm.yarray_quote(this.__wbg_ptr, isLikeNone(lower) ? Number.MAX_SAFE_INTEGER : (lower) >>> 0, isLikeNone(upper) ? Number.MAX_SAFE_INTEGER : (upper) >>> 0, isLikeNone(lower_open) ? 0xFFFFFF : lower_open ? 1 : 0, isLikeNone(upper_open) ? 0xFFFFFF : upper_open ? 1 : 0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return YWeakLink.__wrap(ret[0]);
    }
    /**
     * Converts an underlying contents of this `YArray` instance into their JSON representation.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    toJson(txn) {
        const ret = wasm.yarray_toJson(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.yarray_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.yarray_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.yarray_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Returns an iterator that can be used to traverse over the values stored withing this
     * instance of `YArray`.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const doc = new YDoc()
     * const array = doc.getArray('name')
     * const txn = doc.beginTransaction()
     * try {
     *     array.push(txn, ['hello', 'world'])
     *     for (let item of array.values(txn)) {
     *         console.log(item)
     *     }
     * } finally {
     *     txn.free()
     * }
     * ```
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    values(txn) {
        const ret = wasm.yarray_values(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) YArray.prototype[Symbol.dispose] = YArray.prototype.free;

/**
 * Event generated by `YArray.observe` method. Emitted during transaction commit phase.
 */
export class YArrayEvent {
    static __wrap(ptr) {
        const obj = Object.create(YArrayEvent.prototype);
        obj.__wbg_ptr = ptr;
        YArrayEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YArrayEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yarrayevent_free(ptr, 0);
    }
    /**
     * Returns a list of text changes made over corresponding `YArray` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { insert: any[] }
     * - { delete: number }
     * - { retain: number }
     * @returns {any}
     */
    get delta() {
        const ret = wasm.yarrayevent_delta(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.yarrayevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     * @returns {any}
     */
    path() {
        const ret = wasm.yarrayevent_path(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a current shared type instance, that current event changes refer to.
     * @returns {any}
     */
    get target() {
        const ret = wasm.yarrayevent_target(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YArrayEvent.prototype[Symbol.dispose] = YArrayEvent.prototype.free;

/**
 * A ywasm document type. Documents are most important units of collaborative resources management.
 * All shared collections live within a scope of their corresponding documents. All updates are
 * generated on per-document basis (rather than individual shared type). All operations on shared
 * collections happen via [YTransaction], which lifetime is also bound to a document.
 *
 * Document manages so-called root types, which are top-level shared types definitions (as opposed
 * to recursively nested types).
 *
 * A basic workflow sample:
 *
 * ```javascript
 * import YDoc from 'ywasm'
 *
 * const doc = new YDoc()
 * const txn = doc.beginTransaction()
 * try {
 *     const text = txn.getText('name')
 *     text.push(txn, 'hello world')
 *     const output = text.toString(txn)
 *     console.log(output)
 * } finally {
 *     txn.free()
 * }
 * ```
 */
export class YDoc {
    static __wrap(ptr) {
        const obj = Object.create(YDoc.prototype);
        obj.__wbg_ptr = ptr;
        YDocFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    static __unwrap(jsValue) {
        if (!(jsValue instanceof YDoc)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YDocFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ydoc_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    get autoLoad() {
        const ret = wasm.ydoc_autoLoad(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns a new transaction for this document. Ywasm shared data types execute their
     * operations in a context of a given transaction. Each document can have only one active
     * transaction at the time - subsequent attempts will cause exception to be thrown.
     *
     * Transactions started with `doc.beginTransaction` can be released using `transaction.free`
     * method.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * // helper function used to simplify transaction
     * // create/release cycle
     * YDoc.prototype.transact = callback => {
     *     const txn = this.transaction()
     *     try {
     *         return callback(txn)
     *     } finally {
     *         txn.free()
     *     }
     * }
     *
     * const doc = new YDoc()
     * const text = doc.getText('name')
     * doc.transact(txn => text.insert(txn, 0, 'hello world'))
     * ```
     * @param {any} origin
     * @returns {YTransaction}
     */
    beginTransaction(origin) {
        const ret = wasm.ydoc_beginTransaction(this.__wbg_ptr, origin);
        return YTransaction.__wrap(ret);
    }
    /**
     * Emit `onDestroy` event and unregister all event handlers.
     * @param {YTransaction | undefined} parent_txn
     */
    destroy(parent_txn) {
        const ret = wasm.ydoc_destroy(this.__wbg_ptr, parent_txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a stable census of integrated CRDT structs. This intentionally
     * does not expose Yrs block-store internals to JavaScript.
     * @returns {any}
     */
    documentStats() {
        const ret = wasm.ydoc_documentStats(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a `YArray` shared data type, that's accessible for subsequent accesses using given
     * `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YArray` instance.
     * @param {string} name
     * @returns {YArray}
     */
    getArray(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_getArray(this.__wbg_ptr, ptr0, len0);
        return YArray.__wrap(ret);
    }
    /**
     * Returns a `YMap` shared data type, that's accessible for subsequent accesses using given
     * `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YMap` instance.
     * @param {string} name
     * @returns {YMap}
     */
    getMap(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_getMap(this.__wbg_ptr, ptr0, len0);
        return YMap.__wrap(ret);
    }
    /**
     * Returns a list of unique identifiers of the sub-documents existings within the scope of
     * this document.
     * @param {YTransaction | undefined} txn
     * @returns {Set<any>}
     */
    getSubdocGuids(txn) {
        const ret = wasm.ydoc_getSubdocGuids(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a list of sub-documents existings within the scope of this document.
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    getSubdocs(txn) {
        const ret = wasm.ydoc_getSubdocs(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a `YText` shared data type, that's accessible for subsequent accesses using given
     * `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YText` instance.
     * @param {string} name
     * @returns {YText}
     */
    getText(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_getText(this.__wbg_ptr, ptr0, len0);
        return YText.__wrap(ret);
    }
    /**
     * Returns a `YXmlFragment` shared data type, that's accessible for subsequent accesses using
     * given `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YXmlFragment` instance.
     * @param {string} name
     * @returns {YXmlFragment}
     */
    getXmlFragment(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_getXmlFragment(this.__wbg_ptr, ptr0, len0);
        return YXmlFragment.__wrap(ret);
    }
    /**
     * Gets globally unique identifier of this `YDoc` instance.
     * @returns {string}
     */
    get guid() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.ydoc_guid(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Gets unique peer identifier of this `YDoc` instance.
     * @returns {number}
     */
    get id() {
        const ret = wasm.ydoc_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * Notify the parent document that you request to load data into this subdocument
     * (if it is a subdocument).
     * @param {YTransaction | undefined} parent_txn
     */
    load(parent_txn) {
        const ret = wasm.ydoc_load(this.__wbg_ptr, parent_txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Creates a new ywasm document. If `id` parameter was passed it will be used as this document
     * globally unique identifier (it's up to caller to ensure that requirement). Otherwise it will
     * be assigned a randomly generated number.
     * @param {any} options
     */
    constructor(options) {
        const ret = wasm.ydoc_new(options);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        YDocFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} event
     * @param {Function} callback
     * @returns {boolean}
     */
    off(event, callback) {
        const ptr0 = passStringToWasm0(event, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_off(this.__wbg_ptr, ptr0, len0, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
        const ptr0 = passStringToWasm0(event, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_on(this.__wbg_ptr, ptr0, len0, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a parent document of this document or null if current document is not sub-document.
     * @returns {YDoc | undefined}
     */
    get parentDoc() {
        const ret = wasm.ydoc_parentDoc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Checks if a document is a preliminary type. It returns false, if current document
     * is already a sub-document of another document.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.ydoc_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns a list of all root-level replicated collections, together with their types.
     * These collections can then be accessed via `getMap`/`getText` etc. methods.
     *
     * Example:
     * ```js
     * import * as Y from 'ywasm'
     *
     * const doc = new Y.YDoc()
     * const ymap = doc.getMap('a')
     * const yarray = doc.getArray('b')
     * const ytext = doc.getText('c')
     * const yxml = doc.getXmlFragment('d')
     *
     * const roots = doc.roots() // [['a',ymap], ['b',yarray], ['c',ytext], ['d',yxml]]
     * ```
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    roots(txn) {
        const ret = wasm.ydoc_roots(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Evaluates a JSON path expression (see: https://en.wikipedia.org/wiki/JSONPath) on
     * the document and returns an array of values matching that query.
     *
     * Currently, this method supports the following syntax:
     * - `$` - root object
     * - `@` - current object
     * - `.field` or `['field']` - member accessor
     * - `[1]` - array index (also supports negative indices)
     * - `.*` or `[*]` - wildcard (matches all members of an object or array)
     * - `..` - recursive descent (matches all descendants not only direct children)
     * - `[start:end:step]` - array slice operator (requires positive integer arguments)
     * - `['a', 'b', 'c']` - union operator (returns an array of values for each query)
     * - `[1, -1, 3]` - multiple indices operator (returns an array of values for each index)
     *
     * At the moment, JSON Path does not support filter predicates.
     * @param {string} json_path
     * @returns {Array<any>}
     */
    selectAll(json_path) {
        const ptr0 = passStringToWasm0(json_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_selectAll(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Evaluates a JSON path expression (see: https://en.wikipedia.org/wiki/JSONPath) on
     * the document and returns first value matching that query.
     *
     * Currently, this method supports the following syntax:
     * - `$` - root object
     * - `@` - current object
     * - `.field` or `['field']` - member accessor
     * - `[1]` - array index (also supports negative indices)
     * - `.*` or `[*]` - wildcard (matches all members of an object or array)
     * - `..` - recursive descent (matches all descendants not only direct children)
     * - `[start:end:step]` - array slice operator (requires positive integer arguments)
     * - `['a', 'b', 'c']` - union operator (returns an array of values for each query)
     * - `[1, -1, 3]` - multiple indices operator (returns an array of values for each index)
     *
     * At the moment, JSON Path does not support filter predicates.
     * @param {string} json_path
     * @returns {any}
     */
    selectOne(json_path) {
        const ptr0 = passStringToWasm0(json_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ydoc_selectOne(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    get shouldLoad() {
        const ret = wasm.ydoc_shouldLoad(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.ydoc_type(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YDoc.prototype[Symbol.dispose] = YDoc.prototype.free;

/**
 * Collection used to store key-value entries in an unordered manner. Keys are always represented
 * as UTF-8 strings. Values can be any value type supported by Yrs: JSON-like primitives as well as
 * shared data types.
 *
 * In terms of conflict resolution, [Map] uses logical last-write-wins principle, meaning the past
 * updates are automatically overridden and discarded by newer ones, while concurrent updates made
 * by different peers are resolved into a single value using document id seniority to establish
 * order.
 */
export class YMap {
    static __wrap(ptr) {
        const obj = Object.create(YMap.prototype);
        obj.__wbg_ptr = ptr;
        YMapFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YMapFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ymap_free(ptr, 0);
    }
    /**
     * Checks if current YMap reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.ymap_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Removes an entry identified by a given `key` from this instance of `YMap`, if such exists.
     * @param {string} key
     * @param {YTransaction | undefined} txn
     */
    delete(key, txn) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ymap_delete(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {YDoc | undefined}
     */
    get doc() {
        const ret = wasm.ymap_doc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Returns an iterator that can be used to traverse over all entries stored within this
     * instance of `YMap`. Order of entry is not specified.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const doc = new YDoc()
     * const map = doc.getMap('name')
     * const txn = doc.beginTransaction()
     * try {
     *     map.set(txn, 'key1', 'value1')
     *     map.set(txn, 'key2', true)
     *
     *     for (let [key, value] of map.entries(txn)) {
     *         console.log(key, value)
     *     }
     * } finally {
     *     txn.free()
     * }
     * ```
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    entries(txn) {
        const ret = wasm.ymap_entries(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns value of an entry stored under given `key` within this instance of `YMap`,
     * or `undefined` if no such entry existed.
     * @param {string} key
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    get(key, txn) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ymap_get(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.ymap_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a number of entries stored within this instance of `YMap`.
     * @param {YTransaction | undefined} txn
     * @returns {number}
     */
    length(txn) {
        const ret = wasm.ymap_length(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {string} key
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    link(key, txn) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ymap_link(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Creates a new preliminary instance of a `YMap` shared data type, with its state
     * initialized to provided parameter.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @param {object | null} [init]
     */
    constructor(init) {
        const ret = wasm.ymap_new(isLikeNone(init) ? 0 : addToExternrefTable0(init));
        this.__wbg_ptr = ret;
        YMapFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Subscribes to all operations happening over this instance of `YMap`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.ymap_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.ymap_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns true if this is a preliminary instance of `YMap`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.ymap_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Sets a given `key`-`value` entry within this instance of `YMap`. If another entry was
     * already stored under given `key`, it will be overridden with new `value`.
     * @param {string} key
     * @param {any} value
     * @param {YTransaction | undefined} txn
     */
    set(key, value, txn) {
        const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ymap_set(this.__wbg_ptr, ptr0, len0, value, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Converts contents of this `YMap` instance into a JSON representation.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    toJson(txn) {
        const ret = wasm.ymap_toJson(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.ymap_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.ymap_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.ymap_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) YMap.prototype[Symbol.dispose] = YMap.prototype.free;

/**
 * Event generated by `YMap.observe` method. Emitted during transaction commit phase.
 */
export class YMapEvent {
    static __wrap(ptr) {
        const obj = Object.create(YMapEvent.prototype);
        obj.__wbg_ptr = ptr;
        YMapEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YMapEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ymapevent_free(ptr, 0);
    }
    /**
     * Returns a list of key-value changes made over corresponding `YMap` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { action: 'add'|'update'|'delete', oldValue: any|undefined, newValue: any|undefined }
     * @returns {any}
     */
    get keys() {
        const ret = wasm.ymapevent_keys(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.ymapevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     * @returns {any}
     */
    path() {
        const ret = wasm.ymapevent_path(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a current shared type instance, that current event changes refer to.
     * @returns {any}
     */
    get target() {
        const ret = wasm.ymapevent_target(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YMapEvent.prototype[Symbol.dispose] = YMapEvent.prototype.free;

export class YSubdocsEvent {
    static __wrap(ptr) {
        const obj = Object.create(YSubdocsEvent.prototype);
        obj.__wbg_ptr = ptr;
        YSubdocsEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YSubdocsEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ysubdocsevent_free(ptr, 0);
    }
    /**
     * @returns {Array<any>}
     */
    get added() {
        const ret = wasm.ysubdocsevent_added(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Array<any>}
     */
    get loaded() {
        const ret = wasm.ysubdocsevent_loaded(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Array<any>}
     */
    get removed() {
        const ret = wasm.ysubdocsevent_removed(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YSubdocsEvent.prototype[Symbol.dispose] = YSubdocsEvent.prototype.free;

/**
 * A shared data type used for collaborative text editing. It enables multiple users to add and
 * remove chunks of text in efficient manner. This type is internally represented as a mutable
 * double-linked list of text chunks - an optimization occurs during `YTransaction.commit`, which
 * allows to squash multiple consecutively inserted characters together as a single chunk of text
 * even between transaction boundaries in order to preserve more efficient memory model.
 *
 * `YText` structure internally uses UTF-8 encoding and its length is described in a number of
 * bytes rather than individual characters (a single UTF-8 code point can consist of many bytes).
 *
 * Like all Yrs shared data types, `YText` is resistant to the problem of interleaving (situation
 * when characters inserted one after another may interleave with other peers concurrent inserts
 * after merging all updates together). In case of Yrs conflict resolution is solved by using
 * unique document id to determine correct and consistent ordering.
 */
export class YText {
    static __wrap(ptr) {
        const obj = Object.create(YText.prototype);
        obj.__wbg_ptr = ptr;
        YTextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YTextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ytext_free(ptr, 0);
    }
    /**
     * Checks if current YArray reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.ytext_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {Array<any>} delta
     * @param {YTransaction | undefined} txn
     */
    applyDelta(delta, txn) {
        const ret = wasm.ytext_applyDelta(this.__wbg_ptr, delta, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Deletes a specified range of characters, starting at a given `index`.
     * Both `index` and `length` are counted in terms of a number of UTF-8 character bytes.
     * @param {number} index
     * @param {number} length
     * @param {YTransaction | undefined} txn
     */
    delete(index, length, txn) {
        const ret = wasm.ytext_delete(this.__wbg_ptr, index, length, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {YDoc | undefined}
     */
    get doc() {
        const ret = wasm.ytext_doc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Wraps an existing piece of text within a range described by `index`-`length` parameters with
     * formatting blocks containing provided `attributes` metadata. This method only works for
     * `YText` instances that already have been integrated into document store.
     * @param {number} index
     * @param {number} length
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    format(index, length, attributes, txn) {
        const ret = wasm.ytext_format(this.__wbg_ptr, index, length, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.ytext_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Inserts a given `chunk` of text into this `YText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.`attributes` are only supported for a `YText` instance which
     * already has been integrated into document store.
     * @param {number} index
     * @param {string} chunk
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    insert(index, chunk, attributes, txn) {
        const ptr0 = passStringToWasm0(chunk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ytext_insert(this.__wbg_ptr, index, ptr0, len0, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Inserts a given `embed` object into this `YText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided `embed`
     * with a formatting blocks.`attributes` are only supported for a `YText` instance which
     * already has been integrated into document store.
     * @param {number} index
     * @param {any} embed
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    insertEmbed(index, embed, attributes, txn) {
        const ret = wasm.ytext_insertEmbed(this.__wbg_ptr, index, embed, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns length of an underlying string stored in this `YText` instance,
     * understood as a number of UTF-8 encoded bytes.
     * @param {YTransaction | undefined} txn
     * @returns {number}
     */
    length(txn) {
        const ret = wasm.ytext_length(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Creates a new preliminary instance of a `YText` shared data type, with its state initialized
     * to provided parameter.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @param {string | null} [init]
     */
    constructor(init) {
        var ptr0 = isLikeNone(init) ? 0 : passStringToWasm0(init, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.ytext_new(ptr0, len0);
        this.__wbg_ptr = ret;
        YTextFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Subscribes to all operations happening over this instance of `YText`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.ytext_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.ytext_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns true if this is a preliminary instance of `YArray`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.ytext_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Appends a given `chunk` of text at the end of current `YText` instance.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.`attributes` are only supported for a `YText` instance which
     * already has been integrated into document store.
     * @param {string} chunk
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    push(chunk, attributes, txn) {
        const ptr0 = passStringToWasm0(chunk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ytext_push(this.__wbg_ptr, ptr0, len0, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number | null | undefined} lower
     * @param {number | null | undefined} upper
     * @param {boolean | null | undefined} lower_open
     * @param {boolean | null | undefined} upper_open
     * @param {YTransaction | undefined} txn
     * @returns {YWeakLink}
     */
    quote(lower, upper, lower_open, upper_open, txn) {
        const ret = wasm.ytext_quote(this.__wbg_ptr, isLikeNone(lower) ? Number.MAX_SAFE_INTEGER : (lower) >>> 0, isLikeNone(upper) ? Number.MAX_SAFE_INTEGER : (upper) >>> 0, isLikeNone(lower_open) ? 0xFFFFFF : lower_open ? 1 : 0, isLikeNone(upper_open) ? 0xFFFFFF : upper_open ? 1 : 0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return YWeakLink.__wrap(ret[0]);
    }
    /**
     * Returns the Delta representation of this YText type.
     * @param {any} snapshot
     * @param {any} prev_snapshot
     * @param {Function | null | undefined} compute_ychange
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    toDelta(snapshot, prev_snapshot, compute_ychange, txn) {
        const ret = wasm.ytext_toDelta(this.__wbg_ptr, snapshot, prev_snapshot, isLikeNone(compute_ychange) ? 0 : addToExternrefTable0(compute_ychange), txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns an underlying shared string stored in this data type.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    toJson(txn) {
        const ret = wasm.ytext_toJson(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns an underlying shared string stored in this data type.
     * @param {YTransaction | undefined} txn
     * @returns {string}
     */
    toString(txn) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.ytext_toString(this.__wbg_ptr, txn);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.ytext_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.ytext_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.ytext_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) YText.prototype[Symbol.dispose] = YText.prototype.free;

/**
 * Event generated by `YYText.observe` method. Emitted during transaction commit phase.
 */
export class YTextEvent {
    static __wrap(ptr) {
        const obj = Object.create(YTextEvent.prototype);
        obj.__wbg_ptr = ptr;
        YTextEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YTextEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ytextevent_free(ptr, 0);
    }
    /**
     * Returns a list of text changes made over corresponding `YText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { insert: string, attributes: any|undefined }
     * - { delete: number }
     * - { retain: number, attributes: any|undefined }
     * @returns {any}
     */
    get delta() {
        const ret = wasm.ytextevent_delta(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.ytextevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     * @returns {any}
     */
    path() {
        const ret = wasm.ytextevent_path(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a current shared type instance, that current event changes refer to.
     * @returns {any}
     */
    get target() {
        const ret = wasm.ytextevent_target(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YTextEvent.prototype[Symbol.dispose] = YTextEvent.prototype.free;

export class YTransaction {
    static __wrap(ptr) {
        const obj = Object.create(YTransaction.prototype);
        obj.__wbg_ptr = ptr;
        YTransactionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YTransactionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ytransaction_free(ptr, 0);
    }
    /**
     * Returns state vector describing the current state of
     * the document.
     * @returns {Map<any, any>}
     */
    get afterState() {
        const ret = wasm.ytransaction_afterState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Applies delta update generated by the remote document replica to a current transaction's
     * document. This method assumes that a payload maintains lib0 v1 encoding format.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const localDoc = new YDoc()
     * const localTxn = localDoc.beginTransaction()
     *
     * // document on machine B
     * const remoteDoc = new YDoc()
     * const remoteTxn = localDoc.beginTransaction()
     *
     * try {
     *     const localSV = localTxn.stateVectorV1()
     *     const remoteDelta = remoteTxn.diffV1(localSv)
     *     localTxn.applyV1(remoteDelta)
     * } finally {
     *     localTxn.free()
     *     remoteTxn.free()
     * }
     * ```
     * @param {Uint8Array} diff
     */
    applyV1(diff) {
        const ret = wasm.ytransaction_applyV1(this.__wbg_ptr, diff);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Applies delta update generated by the remote document replica to a current transaction's
     * document. This method assumes that a payload maintains lib0 v2 encoding format.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const localDoc = new YDoc()
     * const localTxn = localDoc.beginTransaction()
     *
     * // document on machine B
     * const remoteDoc = new YDoc()
     * const remoteTxn = localDoc.beginTransaction()
     *
     * try {
     *     const localSV = localTxn.stateVectorV1()
     *     const remoteDelta = remoteTxn.diffV2(localSv)
     *     localTxn.applyV2(remoteDelta)
     * } finally {
     *     localTxn.free()
     *     remoteTxn.free()
     * }
     * ```
     * @param {Uint8Array} diff
     */
    applyV2(diff) {
        const ret = wasm.ytransaction_applyV2(this.__wbg_ptr, diff);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns state vector describing the state of the document
     * at the moment when the transaction began.
     * @returns {Map<any, any>}
     */
    get beforeState() {
        const ret = wasm.ytransaction_beforeState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Triggers a post-update series of operations without `free`ing the transaction. This includes
     * compaction and optimization of internal representation of updates, triggering events etc.
     * ywasm transactions are auto-committed when they are `free`d.
     */
    commit() {
        const ret = wasm.ytransaction_commit(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a delete set containing information about
     * all blocks removed as part of a current transaction.
     * @returns {Map<any, any>}
     */
    get deleteSet() {
        const ret = wasm.ytransaction_deleteSet(this.__wbg_ptr);
        return ret;
    }
    /**
     * Encodes all updates that have happened since a given version `vector` into a compact delta
     * representation using lib0 v1 encoding. If `vector` parameter has not been provided, generated
     * delta payload will contain all changes of a current ywasm document, working effectively as
     * its state snapshot.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const localDoc = new YDoc()
     * const localTxn = localDoc.beginTransaction()
     *
     * // document on machine B
     * const remoteDoc = new YDoc()
     * const remoteTxn = localDoc.beginTransaction()
     *
     * try {
     *     const localSV = localTxn.stateVectorV1()
     *     const remoteDelta = remoteTxn.diffV1(localSv)
     *     localTxn.applyV1(remoteDelta)
     * } finally {
     *     localTxn.free()
     *     remoteTxn.free()
     * }
     * ```
     * @param {Uint8Array | null} [vector]
     * @returns {Uint8Array}
     */
    diffV1(vector) {
        const ret = wasm.ytransaction_diffV1(this.__wbg_ptr, isLikeNone(vector) ? 0 : addToExternrefTable0(vector));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Encodes all updates that have happened since a given version `vector` into a compact delta
     * representation using lib0 v1 encoding. If `vector` parameter has not been provided, generated
     * delta payload will contain all changes of a current ywasm document, working effectively as
     * its state snapshot.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const localDoc = new YDoc()
     * const localTxn = localDoc.beginTransaction()
     *
     * // document on machine B
     * const remoteDoc = new YDoc()
     * const remoteTxn = localDoc.beginTransaction()
     *
     * try {
     *     const localSV = localTxn.stateVectorV1()
     *     const remoteDelta = remoteTxn.diffV2(localSv)
     *     localTxn.applyV2(remoteDelta)
     * } finally {
     *     localTxn.free()
     *     remoteTxn.free()
     * }
     * ```
     * @param {Uint8Array | null} [vector]
     * @returns {Uint8Array}
     */
    diffV2(vector) {
        const ret = wasm.ytransaction_diffV2(this.__wbg_ptr, isLikeNone(vector) ? 0 : addToExternrefTable0(vector));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {Uint8Array}
     */
    encodeUpdate() {
        const ret = wasm.ytransaction_encodeUpdate(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {Uint8Array}
     */
    encodeUpdateV2() {
        const ret = wasm.ytransaction_encodeUpdateV2(this.__wbg_ptr);
        return ret;
    }
    /**
     * Force garbage collection of the deleted elements, regardless of a parent doc was created
     * with `gc` option turned on or off.
     */
    gc() {
        const ret = wasm.ytransaction_gc(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Given a logical identifier of the collection (obtained via `YText.id`, `YArray.id` etc.),
     * attempts to return an instance of that collection in the scope of current document.
     *
     * Returns `undefined` if an instance was not defined locally, haven't been integrated or
     * has been deleted.
     * @param {any} id
     * @returns {any}
     */
    get(id) {
        const ret = wasm.ytransaction_get(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.ytransaction_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a unapplied delete set, that was received in one of the previous remote updates.
     * This DeleteSet is waiting for a missing updates to arrive in order to be applied.
     * @returns {Map<any, any> | undefined}
     */
    get pendingDeleteSet() {
        const ret = wasm.ytransaction_pendingDeleteSet(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {any}
     */
    get pendingStructs() {
        const ret = wasm.ytransaction_pendingStructs(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Evaluates a JSON path expression (see: https://en.wikipedia.org/wiki/JSONPath) on
     * the document and returns an array of values matching that query.
     *
     * Currently, this method supports the following syntax:
     * - `$` - root object
     * - `@` - current object
     * - `.field` or `['field']` - member accessor
     * - `[1]` - array index (also supports negative indices)
     * - `.*` or `[*]` - wildcard (matches all members of an object or array)
     * - `..` - recursive descent (matches all descendants not only direct children)
     * - `[start:end:step]` - array slice operator (requires positive integer arguments)
     * - `['a', 'b', 'c']` - union operator (returns an array of values for each query)
     * - `[1, -1, 3]` - multiple indices operator (returns an array of values for each index)
     *
     * At the moment, JSON Path does not support filter predicates.
     * @param {string} json_path
     * @returns {Array<any>}
     */
    selectAll(json_path) {
        const ptr0 = passStringToWasm0(json_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ytransaction_selectAll(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Evaluates a JSON path expression (see: https://en.wikipedia.org/wiki/JSONPath) on
     * the document and returns first value matching that query.
     *
     * Currently, this method supports the following syntax:
     * - `$` - root object
     * - `@` - current object
     * - `.field` or `['field']` - member accessor
     * - `[1]` - array index (also supports negative indices)
     * - `.*` or `[*]` - wildcard (matches all members of an object or array)
     * - `..` - recursive descent (matches all descendants not only direct children)
     * - `[start:end:step]` - array slice operator (requires positive integer arguments)
     * - `['a', 'b', 'c']` - union operator (returns an array of values for each query)
     * - `[1, -1, 3]` - multiple indices operator (returns an array of values for each index)
     *
     * At the moment, JSON Path does not support filter predicates.
     * @param {string} json_path
     * @returns {any}
     */
    selectOne(json_path) {
        const ptr0 = passStringToWasm0(json_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ytransaction_selectOne(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Encodes a state vector of a given transaction document into its binary representation using
     * lib0 v1 encoding. State vector is a compact representation of updates performed on a given
     * document and can be used by `encode_state_as_update` on remote peer to generate a delta
     * update payload to synchronize changes between peers.
     *
     * Example:
     *
     * ```javascript
     * import YDoc from 'ywasm'
     *
     * /// document on machine A
     * const localDoc = new YDoc()
     * const localTxn = localDoc.beginTransaction()
     *
     * // document on machine B
     * const remoteDoc = new YDoc()
     * const remoteTxn = localDoc.beginTransaction()
     *
     * try {
     *     const localSV = localTxn.stateVectorV1()
     *     const remoteDelta = remoteTxn.diffV1(localSv)
     *     localTxn.applyV1(remoteDelta)
     * } finally {
     *     localTxn.free()
     *     remoteTxn.free()
     * }
     * ```
     * @returns {Uint8Array}
     */
    stateVectorV1() {
        const ret = wasm.ytransaction_stateVectorV1(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YTransaction.prototype[Symbol.dispose] = YTransaction.prototype.free;

export class YUndoEvent {
    static __wrap(ptr) {
        const obj = Object.create(YUndoEvent.prototype);
        obj.__wbg_ptr = ptr;
        YUndoEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YUndoEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yundoevent_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    get kind() {
        const ret = wasm.yundoevent_kind(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {any}
     */
    get meta() {
        const ret = wasm.yundoevent_meta(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.yundoevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {any} value
     */
    set meta(value) {
        wasm.yundoevent_set_meta(this.__wbg_ptr, value);
    }
}
if (Symbol.dispose) YUndoEvent.prototype[Symbol.dispose] = YUndoEvent.prototype.free;

export class YUndoManager {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YUndoManagerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yundomanager_free(ptr, 0);
    }
    /**
     * @param {Array<any>} ytypes
     */
    addToScope(ytypes) {
        const ret = wasm.yundomanager_addToScope(this.__wbg_ptr, ytypes);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {any} origin
     */
    addTrackedOrigin(origin) {
        wasm.yundomanager_addTrackedOrigin(this.__wbg_ptr, origin);
    }
    /**
     * @returns {boolean}
     */
    get canRedo() {
        const ret = wasm.yundomanager_canRedo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get canUndo() {
        const ret = wasm.yundomanager_canUndo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {boolean | null} [clear_undo_stack]
     * @param {boolean | null} [clear_redo_stack]
     */
    clear(clear_undo_stack, clear_redo_stack) {
        wasm.yundomanager_clear(this.__wbg_ptr, isLikeNone(clear_undo_stack) ? 0xFFFFFF : clear_undo_stack ? 1 : 0, isLikeNone(clear_redo_stack) ? 0xFFFFFF : clear_redo_stack ? 1 : 0);
    }
    /**
     * @param {any} options
     */
    constructor(options) {
        const ret = wasm.yundomanager_new(options);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        YUndoManagerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {string} event
     * @param {Function} callback
     * @returns {boolean}
     */
    off(event, callback) {
        const ptr0 = passStringToWasm0(event, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yundomanager_off(this.__wbg_ptr, ptr0, len0, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
        const ptr0 = passStringToWasm0(event, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yundomanager_on(this.__wbg_ptr, ptr0, len0, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    redo() {
        wasm.yundomanager_redo(this.__wbg_ptr);
    }
    /**
     * @param {any} origin
     */
    removeTrackedOrigin(origin) {
        wasm.yundomanager_removeTrackedOrigin(this.__wbg_ptr, origin);
    }
    stopCapturing() {
        wasm.yundomanager_stopCapturing(this.__wbg_ptr);
    }
    undo() {
        wasm.yundomanager_undo(this.__wbg_ptr);
    }
}
if (Symbol.dispose) YUndoManager.prototype[Symbol.dispose] = YUndoManager.prototype.free;

export class YWeakLink {
    static __wrap(ptr) {
        const obj = Object.create(YWeakLink.prototype);
        obj.__wbg_ptr = ptr;
        YWeakLinkFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YWeakLinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yweaklink_free(ptr, 0);
    }
    /**
     * Checks if current YWeakLink reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.yweaklink_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    deref(txn) {
        const ret = wasm.yweaklink_deref(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.yweaklink_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Subscribes to all operations happening over this instance of `YMap`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.yweaklink_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.yweaklink_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns true if this is a preliminary instance of `YWeakLink`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.yweaklink_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {YTransaction | undefined} txn
     * @returns {string}
     */
    toString(txn) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yweaklink_toString(this.__wbg_ptr, txn);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.yweaklink_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.yweaklink_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.yweaklink_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    unquote(txn) {
        const ret = wasm.yweaklink_unquote(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) YWeakLink.prototype[Symbol.dispose] = YWeakLink.prototype.free;

/**
 * Event generated by `YXmlElement.observe` method. Emitted during transaction commit phase.
 */
export class YWeakLinkEvent {
    static __wrap(ptr) {
        const obj = Object.create(YWeakLinkEvent.prototype);
        obj.__wbg_ptr = ptr;
        YWeakLinkEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YWeakLinkEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yweaklinkevent_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.yweaklinkevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     * @returns {any}
     */
    path() {
        const ret = wasm.yweaklinkevent_path(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a current shared type instance, that current event changes refer to.
     * @returns {any}
     */
    get target() {
        const ret = wasm.yweaklinkevent_target(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YWeakLinkEvent.prototype[Symbol.dispose] = YWeakLinkEvent.prototype.free;

/**
 * XML element data type. It represents an XML node, which can contain key-value attributes
 * (interpreted as strings) as well as other nested XML elements or rich text (represented by
 * `YXmlText` type).
 *
 * In terms of conflict resolution, `YXmlElement` uses following rules:
 *
 * - Attribute updates use logical last-write-wins principle, meaning the past updates are
 *   automatically overridden and discarded by newer ones, while concurrent updates made by
 *   different peers are resolved into a single value using document id seniority to establish
 *   an order.
 * - Child node insertion uses sequencing rules from other Yrs collections - elements are inserted
 *   using interleave-resistant algorithm, where order of concurrent inserts at the same index
 *   is established using peer's document id seniority.
 */
export class YXmlElement {
    static __wrap(ptr) {
        const obj = Object.create(YXmlElement.prototype);
        obj.__wbg_ptr = ptr;
        YXmlElementFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YXmlElementFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yxmlelement_free(ptr, 0);
    }
    /**
     * Checks if current shared type reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.yxmlelement_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns an iterator that enables to traverse over all attributes of this XML node in
     * unspecified order. This method returns attribute values as their original JS values,
     * not just as strings.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    attributes(txn) {
        const ret = wasm.yxmlelement_attributes(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} index
     * @param {number | null | undefined} length
     * @param {YTransaction | undefined} txn
     */
    delete(index, length, txn) {
        const ret = wasm.yxmlelement_delete(this.__wbg_ptr, index, isLikeNone(length) ? Number.MAX_SAFE_INTEGER : (length) >>> 0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {YDoc | undefined}
     */
    get doc() {
        const ret = wasm.yxmlelement_doc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Returns a first child of this XML node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node has not children.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    firstChild(txn) {
        const ret = wasm.yxmlelement_firstChild(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a value of an attribute given its `name` as any JS value. If no attribute with such name existed,
     * `undefined` will be returned.
     * @param {string} name
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    getAttribute(name, txn) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmlelement_getAttribute(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.yxmlelement_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} index
     * @param {any} xml_node
     * @param {YTransaction | undefined} txn
     */
    insert(index, xml_node, txn) {
        const ret = wasm.yxmlelement_insert(this.__wbg_ptr, index, xml_node, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a number of child XML nodes stored within this `YXMlElement` instance.
     * @param {YTransaction | undefined} txn
     * @returns {number}
     */
    length(txn) {
        const ret = wasm.yxmlelement_length(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Returns a tag name of this XML node.
     * @param {YTransaction | undefined} txn
     * @returns {string}
     */
    name(txn) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yxmlelement_name(this.__wbg_ptr, txn);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} name
     * @param {any} attributes
     * @param {any} children
     */
    constructor(name, attributes, children) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmlelement_new(ptr0, len0, attributes, children);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        YXmlElementFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Returns a next XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a last child of
     * parent XML node.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    nextSibling(txn) {
        const ret = wasm.yxmlelement_nextSibling(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Subscribes to all operations happening over this instance of `YXmlElement`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.yxmlelement_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.yxmlelement_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a parent `YXmlElement` node or `undefined` if current node has no parent assigned.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    parent(txn) {
        const ret = wasm.yxmlelement_parent(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns true if this is a preliminary instance of `YXmlElement`.
     *
     * Preliminary instances can be nested into other shared data types.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.yxmlelement_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns a previous XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a first child
     * of parent XML node.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    prevSibling(txn) {
        const ret = wasm.yxmlelement_prevSibling(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} xml_node
     * @param {YTransaction | undefined} txn
     */
    push(xml_node, txn) {
        const ret = wasm.yxmlelement_push(this.__wbg_ptr, xml_node, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Removes an attribute from this XML node, given its `name`.
     * @param {string} name
     * @param {YTransaction | undefined} txn
     */
    removeAttribute(name, txn) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmlelement_removeAttribute(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Sets a `name` and `value` as new attribute for this XML node. If an attribute with the same
     * `name` already existed on that node, its value with be overridden with a provided one.
     * This method accepts any JavaScript value, not just strings.
     * @param {string} name
     * @param {any} value
     * @param {YTransaction | undefined} txn
     */
    setAttribute(name, value, txn) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmlelement_setAttribute(this.__wbg_ptr, ptr0, len0, value, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a string representation of this XML node.
     * @param {YTransaction | undefined} txn
     * @returns {string}
     */
    toString(txn) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yxmlelement_toString(this.__wbg_ptr, txn);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns an iterator that enables a deep traversal of this XML node - starting from first
     * child over this XML node successors using depth-first strategy.
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    treeWalker(txn) {
        const ret = wasm.yxmlelement_treeWalker(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.yxmlelement_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.yxmlelement_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.yxmlelement_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) YXmlElement.prototype[Symbol.dispose] = YXmlElement.prototype.free;

/**
 * Event generated by `YXmlElement.observe` method. Emitted during transaction commit phase.
 */
export class YXmlEvent {
    static __wrap(ptr) {
        const obj = Object.create(YXmlEvent.prototype);
        obj.__wbg_ptr = ptr;
        YXmlEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YXmlEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yxmlevent_free(ptr, 0);
    }
    /**
     * Returns a list of XML child node changes made over corresponding `YXmlElement` collection
     * within bounds of current transaction. These changes follow a format:
     *
     * - { insert: (YXmlText|YXmlElement)[] }
     * - { delete: number }
     * - { retain: number }
     * @returns {any}
     */
    get delta() {
        const ret = wasm.yxmlevent_delta(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a list of attribute changes made over corresponding `YXmlText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { action: 'add'|'update'|'delete', oldValue: string|undefined, newValue: string|undefined }
     * @returns {any}
     */
    get keys() {
        const ret = wasm.yxmlevent_keys(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.yxmlevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     * @returns {any}
     */
    path() {
        const ret = wasm.yxmlevent_path(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a current shared type instance, that current event changes refer to.
     * @returns {any}
     */
    get target() {
        const ret = wasm.yxmlevent_target(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YXmlEvent.prototype[Symbol.dispose] = YXmlEvent.prototype.free;

/**
 * Represents a list of `YXmlElement` and `YXmlText` types.
 * A `YXmlFragment` is similar to a `YXmlElement`, but it does not have a
 * nodeName and it does not have attributes. Though it can be bound to a DOM
 * element - in this case the attributes and the nodeName are not shared
 */
export class YXmlFragment {
    static __wrap(ptr) {
        const obj = Object.create(YXmlFragment.prototype);
        obj.__wbg_ptr = ptr;
        YXmlFragmentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YXmlFragmentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yxmlfragment_free(ptr, 0);
    }
    /**
     * Checks if current shared type reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.yxmlfragment_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} index
     * @param {number | null | undefined} length
     * @param {YTransaction | undefined} txn
     */
    delete(index, length, txn) {
        const ret = wasm.yxmlfragment_delete(this.__wbg_ptr, index, isLikeNone(length) ? Number.MAX_SAFE_INTEGER : (length) >>> 0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {YDoc | undefined}
     */
    get doc() {
        const ret = wasm.yxmlfragment_doc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Returns a first child of this XML node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node has not children.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    firstChild(txn) {
        const ret = wasm.yxmlfragment_firstChild(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.yxmlfragment_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} index
     * @param {any} xml_node
     * @param {YTransaction | undefined} txn
     */
    insert(index, xml_node, txn) {
        const ret = wasm.yxmlfragment_insert(this.__wbg_ptr, index, xml_node, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a number of child XML nodes stored within this `YXMlElement` instance.
     * @param {YTransaction | undefined} txn
     * @returns {number}
     */
    length(txn) {
        const ret = wasm.yxmlfragment_length(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {any[]} children
     */
    constructor(children) {
        const ptr0 = passArrayJsValueToWasm0(children, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmlfragment_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        YXmlFragmentFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Subscribes to all operations happening over this instance of `YXmlFragment`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.yxmlfragment_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.yxmlfragment_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns true if this is a preliminary instance of `YXmlFragment`.
     *
     * Preliminary instances can be nested into other shared data types.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.yxmlfragment_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {any} xml_node
     * @param {YTransaction | undefined} txn
     */
    push(xml_node, txn) {
        const ret = wasm.yxmlfragment_push(this.__wbg_ptr, xml_node, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a string representation of this XML node.
     * @param {YTransaction | undefined} txn
     * @returns {string}
     */
    toString(txn) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yxmlfragment_toString(this.__wbg_ptr, txn);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns an iterator that enables a deep traversal of this XML node - starting from first
     * child over this XML node successors using depth-first strategy.
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    treeWalker(txn) {
        const ret = wasm.yxmlfragment_treeWalker(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.yxmlfragment_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.yxmlfragment_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.yxmlfragment_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) YXmlFragment.prototype[Symbol.dispose] = YXmlFragment.prototype.free;

/**
 * A shared data type used for collaborative text editing, that can be used in a context of
 * `YXmlElement` nodee. It enables multiple users to add and remove chunks of text in efficient
 * manner. This type is internally represented as a mutable double-linked list of text chunks
 * - an optimization occurs during `YTransaction.commit`, which allows to squash multiple
 * consecutively inserted characters together as a single chunk of text even between transaction
 * boundaries in order to preserve more efficient memory model.
 *
 * Just like `YXmlElement`, `YXmlText` can be marked with extra metadata in form of attributes.
 *
 * `YXmlText` structure internally uses UTF-8 encoding and its length is described in a number of
 * bytes rather than individual characters (a single UTF-8 code point can consist of many bytes).
 *
 * Like all Yrs shared data types, `YXmlText` is resistant to the problem of interleaving (situation
 * when characters inserted one after another may interleave with other peers concurrent inserts
 * after merging all updates together). In case of Yrs conflict resolution is solved by using
 * unique document id to determine correct and consistent ordering.
 */
export class YXmlText {
    static __wrap(ptr) {
        const obj = Object.create(YXmlText.prototype);
        obj.__wbg_ptr = ptr;
        YXmlTextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YXmlTextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yxmltext_free(ptr, 0);
    }
    /**
     * Checks if current shared type reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     * @param {YTransaction} txn
     * @returns {boolean}
     */
    alive(txn) {
        _assertClass(txn, YTransaction);
        const ret = wasm.yxmltext_alive(this.__wbg_ptr, txn.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {Array<any>} delta
     * @param {YTransaction | undefined} txn
     */
    applyDelta(delta, txn) {
        const ret = wasm.yxmltext_applyDelta(this.__wbg_ptr, delta, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns an iterator that enables to traverse over all attributes of this XML node in
     * unspecified order. This method returns attribute values as their original JS values,
     * not just as strings.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    attributes(txn) {
        const ret = wasm.yxmltext_attributes(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Deletes a specified range of characters, starting at a given `index`.
     * Both `index` and `length` are counted in terms of a number of UTF-8 character bytes.
     * @param {number} index
     * @param {number} length
     * @param {YTransaction | undefined} txn
     */
    delete(index, length, txn) {
        const ret = wasm.yxmltext_delete(this.__wbg_ptr, index, length, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {YDoc | undefined}
     */
    get doc() {
        const ret = wasm.yxmltext_doc(this.__wbg_ptr);
        return ret === 0 ? undefined : YDoc.__wrap(ret);
    }
    /**
     * Formats text within bounds specified by `index` and `len` with a given formatting
     * attributes.
     * @param {number} index
     * @param {number} length
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    format(index, length, attributes, txn) {
        const ret = wasm.yxmltext_format(this.__wbg_ptr, index, length, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a value of an attribute given its `name` as any JS value. If no attribute with such name existed,
     * `undefined` will be returned.
     * @param {string} name
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    getAttribute(name, txn) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmltext_getAttribute(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     * @returns {any}
     */
    get id() {
        const ret = wasm.yxmltext_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Inserts a given `chunk` of text into this `YXmlText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.
     * @param {number} index
     * @param {string} chunk
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    insert(index, chunk, attributes, txn) {
        const ptr0 = passStringToWasm0(chunk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmltext_insert(this.__wbg_ptr, index, ptr0, len0, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Inserts a given `embed` object into this `YXmlText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided `embed`
     * with a formatting blocks.`attributes` are only supported for a `YXmlText` instance which
     * already has been integrated into document store.
     * @param {number} index
     * @param {any} embed
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    insertEmbed(index, embed, attributes, txn) {
        const ret = wasm.yxmltext_insertEmbed(this.__wbg_ptr, index, embed, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns length of an underlying string stored in this `YXmlText` instance,
     * understood as a number of UTF-8 encoded bytes.
     * @param {YTransaction | undefined} txn
     * @returns {number}
     */
    length(txn) {
        const ret = wasm.yxmltext_length(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {string | null | undefined} text
     * @param {any} attributes
     */
    constructor(text, attributes) {
        var ptr0 = isLikeNone(text) ? 0 : passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmltext_new(ptr0, len0, attributes);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        YXmlTextFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Returns a next XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a last child of
     * parent XML node.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    nextSibling(txn) {
        const ret = wasm.yxmltext_nextSibling(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Subscribes to all operations happening over this instance of `YXmlText`. All changes are
     * batched and eventually triggered during transaction commit phase.
     * @param {Function} callback
     */
    observe(callback) {
        const ret = wasm.yxmltext_observe(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     * @param {Function} callback
     */
    observeDeep(callback) {
        const ret = wasm.yxmltext_observeDeep(this.__wbg_ptr, callback);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns a parent `YXmlElement` node or `undefined` if current node has no parent assigned.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    parent(txn) {
        const ret = wasm.yxmltext_parent(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns true if this is a preliminary instance of `YXmlText`.
     *
     * Preliminary instances can be nested into other shared data types.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     * @returns {boolean}
     */
    get prelim() {
        const ret = wasm.yxmltext_prelim(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Returns a previous XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a first child
     * of parent XML node.
     * @param {YTransaction | undefined} txn
     * @returns {any}
     */
    prevSibling(txn) {
        const ret = wasm.yxmltext_prevSibling(this.__wbg_ptr, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Appends a given `chunk` of text at the end of `YXmlText` instance.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.
     * @param {string} chunk
     * @param {any} attributes
     * @param {YTransaction | undefined} txn
     */
    push(chunk, attributes, txn) {
        const ptr0 = passStringToWasm0(chunk, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmltext_push(this.__wbg_ptr, ptr0, len0, attributes, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number | null | undefined} lower
     * @param {number | null | undefined} upper
     * @param {boolean | null | undefined} lower_open
     * @param {boolean | null | undefined} upper_open
     * @param {YTransaction | undefined} txn
     * @returns {YWeakLink}
     */
    quote(lower, upper, lower_open, upper_open, txn) {
        const ret = wasm.yxmltext_quote(this.__wbg_ptr, isLikeNone(lower) ? Number.MAX_SAFE_INTEGER : (lower) >>> 0, isLikeNone(upper) ? Number.MAX_SAFE_INTEGER : (upper) >>> 0, isLikeNone(lower_open) ? 0xFFFFFF : lower_open ? 1 : 0, isLikeNone(upper_open) ? 0xFFFFFF : upper_open ? 1 : 0, txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return YWeakLink.__wrap(ret[0]);
    }
    /**
     * Removes an attribute from this XML node, given its `name`.
     * @param {string} name
     * @param {YTransaction | undefined} txn
     */
    removeAttribute(name, txn) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmltext_removeAttribute(this.__wbg_ptr, ptr0, len0, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Sets a `name` and `value` as new attribute for this XML node. If an attribute with the same
     * `name` already existed on that node, its value with be overridden with a provided one.
     * This method accepts any JavaScript value, not just strings.
     * @param {string} name
     * @param {any} value
     * @param {YTransaction | undefined} txn
     */
    setAttribute(name, value, txn) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yxmltext_setAttribute(this.__wbg_ptr, ptr0, len0, value, txn);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns the Delta representation of this YXmlText type.
     * @param {any} snapshot
     * @param {any} prev_snapshot
     * @param {Function | null | undefined} compute_ychange
     * @param {YTransaction | undefined} txn
     * @returns {Array<any>}
     */
    toDelta(snapshot, prev_snapshot, compute_ychange, txn) {
        const ret = wasm.yxmltext_toDelta(this.__wbg_ptr, snapshot, prev_snapshot, isLikeNone(compute_ychange) ? 0 : addToExternrefTable0(compute_ychange), txn);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns an underlying string stored in this `YXmlText` instance.
     * @param {YTransaction | undefined} txn
     * @returns {string}
     */
    toString(txn) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yxmltext_toString(this.__wbg_ptr, txn);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get type() {
        const ret = wasm.yxmltext_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserve(callback) {
        const ret = wasm.yxmltext_unobserve(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     * @param {Function} callback
     * @returns {boolean}
     */
    unobserveDeep(callback) {
        const ret = wasm.yxmltext_unobserveDeep(this.__wbg_ptr, callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) YXmlText.prototype[Symbol.dispose] = YXmlText.prototype.free;

/**
 * Event generated by `YXmlText.observe` method. Emitted during transaction commit phase.
 */
export class YXmlTextEvent {
    static __wrap(ptr) {
        const obj = Object.create(YXmlTextEvent.prototype);
        obj.__wbg_ptr = ptr;
        YXmlTextEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YXmlTextEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yxmltextevent_free(ptr, 0);
    }
    /**
     * Returns a list of text changes made over corresponding `YText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { insert: string, attributes: any|undefined }
     * - { delete: number }
     * - { retain: number, attributes: any|undefined }
     * @returns {any}
     */
    get delta() {
        const ret = wasm.yxmltextevent_delta(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Returns a list of attribute changes made over corresponding `YXmlText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { action: 'add'|'update'|'delete', oldValue: string|undefined, newValue: string|undefined }
     * @returns {any}
     */
    get keys() {
        const ret = wasm.yxmltextevent_keys(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    get origin() {
        const ret = wasm.yxmltextevent_origin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     * @returns {any}
     */
    path() {
        const ret = wasm.yxmltextevent_path(this.__wbg_ptr);
        return ret;
    }
    /**
     * Returns a current shared type instance, that current event changes refer to.
     * @returns {any}
     */
    get target() {
        const ret = wasm.yxmltextevent_target(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) YXmlTextEvent.prototype[Symbol.dispose] = YXmlTextEvent.prototype.free;

/**
 * @param {Awareness} awareness
 * @param {Uint8Array} update
 * @param {any} _origin
 */
export function applyAwarenessUpdate(awareness, update, _origin) {
    _assertClass(awareness, Awareness);
    const ret = wasm.applyAwarenessUpdate(awareness.__wbg_ptr, update, _origin);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Applies delta update generated by the remote document replica to a current document. This
 * method assumes that a payload maintains lib0 v1 encoding format.
 *
 * Example:
 *
 * ```javascript
 * import {YDoc, encodeStateVector, encodeStateAsUpdate, applyUpdate} from 'ywasm'
 *
 * /// document on machine A
 * const localDoc = new YDoc()
 * const localSV = encodeStateVector(localDoc)
 *
 * // document on machine B
 * const remoteDoc = new YDoc()
 * const remoteDelta = encodeStateAsUpdate(remoteDoc, localSV)
 *
 * applyUpdateV2(localDoc, remoteDelta)
 * ```
 * @param {YDoc} doc
 * @param {Uint8Array} update
 * @param {any} origin
 */
export function applyUpdate(doc, update, origin) {
    _assertClass(doc, YDoc);
    const ret = wasm.applyUpdate(doc.__wbg_ptr, update, origin);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Applies delta update generated by the remote document replica to a current document. This
 * method assumes that a payload maintains lib0 v2 encoding format.
 *
 * Example:
 *
 * ```javascript
 * import {YDoc, encodeStateVector, encodeStateAsUpdate, applyUpdate} from 'ywasm'
 *
 * /// document on machine A
 * const localDoc = new YDoc()
 * const localSV = encodeStateVector(localDoc)
 *
 * // document on machine B
 * const remoteDoc = new YDoc()
 * const remoteDelta = encodeStateAsUpdateV2(remoteDoc, localSV)
 *
 * applyUpdateV2(localDoc, remoteDelta)
 * ```
 * @param {YDoc} doc
 * @param {Uint8Array} update
 * @param {any} origin
 */
export function applyUpdateV2(doc, update, origin) {
    _assertClass(doc, YDoc);
    const ret = wasm.applyUpdateV2(doc.__wbg_ptr, update, origin);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Similar to `mergeUpdatesV1` but instead of just merging the updates, it creates a temporary
 * document, applies them and then performs garbage collection (if requested). Good for
 * constructing document's state snapshot.
 * @param {boolean} gc
 * @param {Uint8Array[]} updates
 * @returns {Uint8Array}
 */
export function applyUpdatesV1(gc, updates) {
    const ptr0 = passArrayJsValueToWasm0(updates, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.applyUpdatesV1(gc, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Similar to `mergeUpdatesV2` but instead of just merging the updates, it creates a temporary
 * document, applies them and then performs garbage collection (if requested). Good for
 * constructing document's state snapshot.
 * @param {boolean} gc
 * @param {Uint8Array[]} updates
 * @returns {Uint8Array}
 */
export function applyUpdatesV2(gc, updates) {
    const ptr0 = passArrayJsValueToWasm0(updates, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.applyUpdatesV2(gc, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function compareRelativePositions(a, b) {
    const ret = wasm.compareRelativePositions(a, b);
    return ret !== 0;
}

/**
 * Converts a sticky index (see: `createStickyIndexFromType`) into an object
 * containing human-readable index.
 * @param {any} rpos
 * @param {YDoc} doc
 * @returns {any}
 */
export function createAbsolutePositionFromRelativePosition(rpos, doc) {
    _assertClass(doc, YDoc);
    const ret = wasm.createAbsolutePositionFromRelativePosition(rpos, doc.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Retrieves a sticky index corresponding to a given human-readable `index` pointing into
 * the shared `ytype`. Unlike standard indexes sticky indexes enables to track
 * the location inside of a shared y-types, even in the face of concurrent updates.
 *
 * If association is >= 0, the resulting position will point to location **after** the referenced index.
 * If association is < 0, the resulting position will point to location **before** the referenced index.
 * @param {any} ytype
 * @param {number} index
 * @param {number} assoc
 * @param {YTransaction | undefined} txn
 * @returns {any}
 */
export function createRelativePositionFromTypeIndex(ytype, index, assoc, txn) {
    const ret = wasm.createRelativePositionFromTypeIndex(ytype, index, assoc, txn);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Returns a string dump representation of a given `update` encoded using lib0 v1 encoding.
 * @param {Uint8Array} update
 * @returns {string}
 */
export function debugUpdateV1(update) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.debugUpdateV1(update);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Returns a string dump representation of a given `update` encoded using lib0 v2 encoding.
 * @param {Uint8Array} update
 * @returns {string}
 */
export function debugUpdateV2(update) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.debugUpdateV2(update);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Deserializes sticky index serialized previously by `encodeStickyIndex`.
 * @param {Uint8Array} bin
 * @returns {any}
 */
export function decodeRelativePosition(bin) {
    const ret = wasm.decodeRelativePosition(bin);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array} snapshot
 * @returns {any}
 */
export function decodeSnapshotV1(snapshot) {
    const ptr0 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decodeSnapshotV1(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array} snapshot
 * @returns {any}
 */
export function decodeSnapshotV2(snapshot) {
    const ptr0 = passArray8ToWasm0(snapshot, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decodeSnapshotV2(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Awareness} awareness
 * @param {any} clients
 * @returns {Uint8Array}
 */
export function encodeAwarenessUpdate(awareness, clients) {
    _assertClass(awareness, Awareness);
    const ret = wasm.encodeAwarenessUpdate(awareness.__wbg_ptr, clients);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Serializes sticky index created by `createStickyIndexFromType` into a binary
 * payload.
 * @param {any} rpos
 * @returns {Uint8Array}
 */
export function encodeRelativePosition(rpos) {
    const ret = wasm.encodeRelativePosition(rpos);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} snapshot
 * @returns {Uint8Array}
 */
export function encodeSnapshotV1(snapshot) {
    const ret = wasm.encodeSnapshotV1(snapshot);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {any} snapshot
 * @returns {Uint8Array}
 */
export function encodeSnapshotV2(snapshot) {
    const ret = wasm.encodeSnapshotV2(snapshot);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Encodes all updates that have happened since a given version `vector` into a compact delta
 * representation using lib0 v1 encoding. If `vector` parameter has not been provided, generated
 * delta payload will contain all changes of a current ywasm document, working effectivelly as its
 * state snapshot.
 *
 * Example:
 *
 * ```javascript
 * import {YDoc, encodeStateVector, encodeStateAsUpdate, applyUpdate} from 'ywasm'
 *
 * /// document on machine A
 * const localDoc = new YDoc()
 * const localSV = encodeStateVector(localDoc)
 *
 * // document on machine B
 * const remoteDoc = new YDoc()
 * const remoteDelta = encodeStateAsUpdate(remoteDoc, localSV)
 *
 * applyUpdate(localDoc, remoteDelta)
 * ```
 * @param {YDoc} doc
 * @param {Uint8Array | null} [vector]
 * @returns {Uint8Array}
 */
export function encodeStateAsUpdate(doc, vector) {
    _assertClass(doc, YDoc);
    const ret = wasm.encodeStateAsUpdate(doc.__wbg_ptr, isLikeNone(vector) ? 0 : addToExternrefTable0(vector));
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Encodes all updates that have happened since a given version `vector` into a compact delta
 * representation using lib0 v2 encoding. If `vector` parameter has not been provided, generated
 * delta payload will contain all changes of a current ywasm document, working effectivelly as its
 * state snapshot.
 *
 * Example:
 *
 * ```javascript
 * import {YDoc, encodeStateVector, encodeStateAsUpdate, applyUpdate} from 'ywasm'
 *
 * /// document on machine A
 * const localDoc = new YDoc()
 * const localSV = encodeStateVector(localDoc)
 *
 * // document on machine B
 * const remoteDoc = new YDoc()
 * const remoteDelta = encodeStateAsUpdateV2(remoteDoc, localSV)
 *
 * applyUpdate(localDoc, remoteDelta)
 * ```
 * @param {YDoc} doc
 * @param {Uint8Array | null} [vector]
 * @returns {Uint8Array}
 */
export function encodeStateAsUpdateV2(doc, vector) {
    _assertClass(doc, YDoc);
    const ret = wasm.encodeStateAsUpdateV2(doc.__wbg_ptr, isLikeNone(vector) ? 0 : addToExternrefTable0(vector));
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {YDoc} doc
 * @param {any} snapshot
 * @returns {Uint8Array}
 */
export function encodeStateFromSnapshotV1(doc, snapshot) {
    _assertClass(doc, YDoc);
    const ret = wasm.encodeStateFromSnapshotV1(doc.__wbg_ptr, snapshot);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * @param {YDoc} doc
 * @param {any} snapshot
 * @returns {Uint8Array}
 */
export function encodeStateFromSnapshotV2(doc, snapshot) {
    _assertClass(doc, YDoc);
    const ret = wasm.encodeStateFromSnapshotV2(doc.__wbg_ptr, snapshot);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Encodes a state vector of a given ywasm document into its binary representation using lib0 v1
 * encoding. State vector is a compact representation of updates performed on a given document and
 * can be used by `encode_state_as_update` on remote peer to generate a delta update payload to
 * synchronize changes between peers.
 *
 * Example:
 *
 * ```javascript
 * import {YDoc, encodeStateVector, encodeStateAsUpdate, applyUpdate} from 'ywasm'
 *
 * /// document on machine A
 * const localDoc = new YDoc()
 * const localSV = encodeStateVector(localDoc)
 *
 * // document on machine B
 * const remoteDoc = new YDoc()
 * const remoteDelta = encodeStateAsUpdate(remoteDoc, localSV)
 *
 * applyUpdate(localDoc, remoteDelta)
 * ```
 * @param {YDoc} doc
 * @returns {Uint8Array}
 */
export function encodeStateVector(doc) {
    _assertClass(doc, YDoc);
    const ret = wasm.encodeStateVector(doc.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} snap1
 * @param {any} snap2
 * @returns {boolean}
 */
export function equalSnapshots(snap1, snap2) {
    const ret = wasm.equalSnapshots(snap1, snap2);
    return ret !== 0;
}

/**
 * Merges a sequence of updates (encoded using lib0 v1 encoding) together, producing another
 * update (also lib0 v1 encoded) in the result. Returned binary is a combination of all input
 * `updates`, compressed.
 *
 * Returns an error whenever any of the input updates couldn't be decoded.
 * @param {Array<any>} updates
 * @returns {Uint8Array}
 */
export function mergeUpdatesV1(updates) {
    const ret = wasm.mergeUpdatesV1(updates);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Merges a sequence of updates (encoded using lib0 v2 encoding) together, producing another
 * update (also lib0 v2 encoded) in the result. Returned binary is a combination of all input
 * `updates`, compressed.
 *
 * Returns an error whenever any of the input updates couldn't be decoded.
 * @param {Array<any>} updates
 * @returns {Uint8Array}
 */
export function mergeUpdatesV2(updates) {
    const ret = wasm.mergeUpdatesV2(updates);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array} update
 * @param {Function} modify
 * @returns {Uint8Array}
 */
export function modifyAwarenessUpdate(update, modify) {
    const ret = wasm.modifyAwarenessUpdate(update, modify);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Awareness} awareness
 * @param {BigUint64Array} clients
 */
export function removeAwarenessStates(awareness, clients) {
    _assertClass(awareness, Awareness);
    const ptr0 = passArray64ToWasm0(clients, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.removeAwarenessStates(awareness.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * When called will call console log errors whenever internal panic is called from within
 * WebAssembly module.
 */
export function setPanicHook() {
    wasm.setPanicHook();
}

/**
 * @param {YDoc} doc
 * @returns {any}
 */
export function snapshot(doc) {
    _assertClass(doc, YDoc);
    const ret = wasm.snapshot(doc.__wbg_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_9a4e0ecb0fa16705: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_d968e41184ae354f: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_c25d447a39f5578f: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_aca499c5de7ff5e5: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_2f76dc55065b4273: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_ea9085d691f535d3: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_e659fcf7b0e32763: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_e3b662382210db98: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_done_89b2b13e91a60321: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_015dc610cd81ede0: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_from_13e323c65fc8f464: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_getRandomValues_3f44b700395062e5: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_get_507a50627bffa49b: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_c7eb1f358a7654df: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_6e0ad6d2a41b06f6: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_0677c962b281d01a: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_04f36e4056f1b851: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_6f722e4a93058b71: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_370319915dc99107: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_7796ffc7ed656783: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_e64f7b1e88921146: function(arg0) {
            const ret = new Set(arg0);
            return ret;
        },
        __wbg_new_from_slice_77cdfb7977362f3c: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_next_6dbf2c0ac8cde20f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_71f2aa1cb3d1e37e: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_parse_1c0d8a8656d7e016: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_d2ae3af0c1217ae6: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_575dd786d51585f8: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_slice_2b88ff0ac64039d6: function(arg0, arg1) {
            const ret = arg1.slice();
            const ptr1 = passArrayJsValueToWasm0(ret, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_stringify_b54333f60f1e4dad: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_value_a5d5488a9589444a: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_yarray_new: function(arg0) {
            const ret = YArray.__wrap(arg0);
            return ret;
        },
        __wbg_yarrayevent_new: function(arg0) {
            const ret = YArrayEvent.__wrap(arg0);
            return ret;
        },
        __wbg_ydoc_new: function(arg0) {
            const ret = YDoc.__wrap(arg0);
            return ret;
        },
        __wbg_ydoc_unwrap: function(arg0) {
            const ret = YDoc.__unwrap(arg0);
            return ret;
        },
        __wbg_ymap_new: function(arg0) {
            const ret = YMap.__wrap(arg0);
            return ret;
        },
        __wbg_ymapevent_new: function(arg0) {
            const ret = YMapEvent.__wrap(arg0);
            return ret;
        },
        __wbg_ysubdocsevent_new: function(arg0) {
            const ret = YSubdocsEvent.__wrap(arg0);
            return ret;
        },
        __wbg_ytext_new: function(arg0) {
            const ret = YText.__wrap(arg0);
            return ret;
        },
        __wbg_ytextevent_new: function(arg0) {
            const ret = YTextEvent.__wrap(arg0);
            return ret;
        },
        __wbg_ytransaction_new: function(arg0) {
            const ret = YTransaction.__wrap(arg0);
            return ret;
        },
        __wbg_yundoevent_new: function(arg0) {
            const ret = YUndoEvent.__wrap(arg0);
            return ret;
        },
        __wbg_yweaklink_new: function(arg0) {
            const ret = YWeakLink.__wrap(arg0);
            return ret;
        },
        __wbg_yweaklinkevent_new: function(arg0) {
            const ret = YWeakLinkEvent.__wrap(arg0);
            return ret;
        },
        __wbg_yxmlelement_new: function(arg0) {
            const ret = YXmlElement.__wrap(arg0);
            return ret;
        },
        __wbg_yxmlevent_new: function(arg0) {
            const ret = YXmlEvent.__wrap(arg0);
            return ret;
        },
        __wbg_yxmlfragment_new: function(arg0) {
            const ret = YXmlFragment.__wrap(arg0);
            return ret;
        },
        __wbg_yxmltext_new: function(arg0) {
            const ret = YXmlText.__wrap(arg0);
            return ret;
        },
        __wbg_yxmltextevent_new: function(arg0) {
            const ret = YXmlTextEvent.__wrap(arg0);
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./ywasm_bg.js": import0,
    };
}

const AwarenessFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_awareness_free(ptr, 1));
const YArrayFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yarray_free(ptr, 1));
const YArrayEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yarrayevent_free(ptr, 1));
const YDocFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ydoc_free(ptr, 1));
const YMapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ymap_free(ptr, 1));
const YMapEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ymapevent_free(ptr, 1));
const YSubdocsEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ysubdocsevent_free(ptr, 1));
const YTextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ytext_free(ptr, 1));
const YTextEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ytextevent_free(ptr, 1));
const YTransactionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ytransaction_free(ptr, 1));
const YUndoEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yundoevent_free(ptr, 1));
const YUndoManagerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yundomanager_free(ptr, 1));
const YWeakLinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yweaklink_free(ptr, 1));
const YWeakLinkEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yweaklinkevent_free(ptr, 1));
const YXmlElementFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yxmlelement_free(ptr, 1));
const YXmlEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yxmlevent_free(ptr, 1));
const YXmlFragmentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yxmlfragment_free(ptr, 1));
const YXmlTextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yxmltext_free(ptr, 1));
const YXmlTextEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yxmltextevent_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();

/** Current high-water size of the shared Wasm linear memory. */
export function wasmMemoryByteLength() {
    return wasm.memory.buffer.byteLength;
}
