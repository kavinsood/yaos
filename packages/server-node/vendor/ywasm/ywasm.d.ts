/* tslint:disable */
/* eslint-disable */

export class Awareness {
    free(): void;
    [Symbol.dispose](): void;
    destroy(): void;
    getLocalState(): any;
    getStates(): Map<any, any>;
    constructor(doc: YDoc);
    off(event: string, callback: Function): boolean;
    on(event: string, callback: Function): void;
    setLocalState(state: any): void;
    setLocalStateField(key: string, value: any): void;
    readonly doc: YDoc;
    readonly meta: Map<any, any>;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current YArray reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    /**
     * Deletes a range of items of given `length` from current `YArray` instance,
     * starting from given `index`.
     */
    delete(index: number, length: number | null | undefined, txn: YTransaction | undefined): void;
    /**
     * Returns an element stored under given `index`.
     */
    get(index: number, txn: YTransaction | undefined): any;
    /**
     * Inserts a given range of `items` into this `YArray` instance, starting at given `index`.
     */
    insert(index: number, items: any[], txn: YTransaction | undefined): void;
    /**
     * Returns a number of elements stored within this instance of `YArray`.
     */
    length(txn: YTransaction | undefined): number;
    /**
     * Creates a new preliminary instance of a `YArray` shared data type, with its state
     * initialized to provided parameter.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    constructor(items?: any[] | null);
    /**
     * Subscribes to all operations happening over this instance of `YArray`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    /**
     * Appends a range of `items` at the end of this `YArray` instance.
     */
    push(items: any[], txn: YTransaction | undefined): void;
    quote(lower: number | null | undefined, upper: number | null | undefined, lower_open: boolean | null | undefined, upper_open: boolean | null | undefined, txn: YTransaction | undefined): YWeakLink;
    /**
     * Converts an underlying contents of this `YArray` instance into their JSON representation.
     */
    toJson(txn: YTransaction | undefined): any;
    unobserve(callback: Function): boolean;
    unobserveDeep(callback: Function): boolean;
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
     */
    values(txn: YTransaction | undefined): any;
    readonly doc: YDoc | undefined;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YArray`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

/**
 * Event generated by `YArray.observe` method. Emitted during transaction commit phase.
 */
export class YArrayEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     */
    path(): any;
    /**
     * Returns a list of text changes made over corresponding `YArray` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { insert: any[] }
     * - { delete: number }
     * - { retain: number }
     */
    readonly delta: any;
    readonly origin: any;
    /**
     * Returns a current shared type instance, that current event changes refer to.
     */
    readonly target: any;
}

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
    free(): void;
    [Symbol.dispose](): void;
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
     */
    beginTransaction(origin: any): YTransaction;
    /**
     * Emit `onDestroy` event and unregister all event handlers.
     */
    destroy(parent_txn: YTransaction | undefined): void;
    /**
     * Returns a stable census of integrated CRDT structs. This intentionally
     * does not expose Yrs block-store internals to JavaScript.
     */
    documentStats(): any;
    /**
     * Returns a `YArray` shared data type, that's accessible for subsequent accesses using given
     * `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YArray` instance.
     */
    getArray(name: string): YArray;
    /**
     * Returns a `YMap` shared data type, that's accessible for subsequent accesses using given
     * `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YMap` instance.
     */
    getMap(name: string): YMap;
    /**
     * Returns a list of unique identifiers of the sub-documents existings within the scope of
     * this document.
     */
    getSubdocGuids(txn: YTransaction | undefined): Set<any>;
    /**
     * Returns a list of sub-documents existings within the scope of this document.
     */
    getSubdocs(txn: YTransaction | undefined): Array<any>;
    /**
     * Returns a `YText` shared data type, that's accessible for subsequent accesses using given
     * `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YText` instance.
     */
    getText(name: string): YText;
    /**
     * Returns a `YXmlFragment` shared data type, that's accessible for subsequent accesses using
     * given `name`.
     *
     * If there was no instance with this name before, it will be created and then returned.
     *
     * If there was an instance with this name, but it was of different type, it will be projected
     * onto `YXmlFragment` instance.
     */
    getXmlFragment(name: string): YXmlFragment;
    /**
     * Notify the parent document that you request to load data into this subdocument
     * (if it is a subdocument).
     */
    load(parent_txn: YTransaction | undefined): void;
    /**
     * Creates a new ywasm document. If `id` parameter was passed it will be used as this document
     * globally unique identifier (it's up to caller to ensure that requirement). Otherwise it will
     * be assigned a randomly generated number.
     */
    constructor(options: any);
    off(event: string, callback: Function): boolean;
    on(event: string, callback: Function): void;
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
     */
    roots(txn: YTransaction | undefined): Array<any>;
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
     */
    selectAll(json_path: string): Array<any>;
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
     */
    selectOne(json_path: string): any;
    readonly autoLoad: boolean;
    /**
     * Gets globally unique identifier of this `YDoc` instance.
     */
    readonly guid: string;
    /**
     * Gets unique peer identifier of this `YDoc` instance.
     */
    readonly id: number;
    /**
     * Returns a parent document of this document or null if current document is not sub-document.
     */
    readonly parentDoc: YDoc | undefined;
    /**
     * Checks if a document is a preliminary type. It returns false, if current document
     * is already a sub-document of another document.
     */
    readonly prelim: boolean;
    readonly shouldLoad: boolean;
    readonly type: number;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current YMap reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    /**
     * Removes an entry identified by a given `key` from this instance of `YMap`, if such exists.
     */
    delete(key: string, txn: YTransaction | undefined): void;
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
     */
    entries(txn: YTransaction | undefined): any;
    /**
     * Returns value of an entry stored under given `key` within this instance of `YMap`,
     * or `undefined` if no such entry existed.
     */
    get(key: string, txn: YTransaction | undefined): any;
    /**
     * Returns a number of entries stored within this instance of `YMap`.
     */
    length(txn: YTransaction | undefined): number;
    link(key: string, txn: YTransaction | undefined): any;
    /**
     * Creates a new preliminary instance of a `YMap` shared data type, with its state
     * initialized to provided parameter.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    constructor(init?: object | null);
    /**
     * Subscribes to all operations happening over this instance of `YMap`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    /**
     * Sets a given `key`-`value` entry within this instance of `YMap`. If another entry was
     * already stored under given `key`, it will be overridden with new `value`.
     */
    set(key: string, value: any, txn: YTransaction | undefined): void;
    /**
     * Converts contents of this `YMap` instance into a JSON representation.
     */
    toJson(txn: YTransaction | undefined): any;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserve(callback: Function): boolean;
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     */
    unobserveDeep(callback: Function): boolean;
    readonly doc: YDoc | undefined;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YMap`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

/**
 * Event generated by `YMap.observe` method. Emitted during transaction commit phase.
 */
export class YMapEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     */
    path(): any;
    /**
     * Returns a list of key-value changes made over corresponding `YMap` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { action: 'add'|'update'|'delete', oldValue: any|undefined, newValue: any|undefined }
     */
    readonly keys: any;
    readonly origin: any;
    /**
     * Returns a current shared type instance, that current event changes refer to.
     */
    readonly target: any;
}

export class YSubdocsEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly added: Array<any>;
    readonly loaded: Array<any>;
    readonly removed: Array<any>;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current YArray reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    applyDelta(delta: Array<any>, txn: YTransaction | undefined): void;
    /**
     * Deletes a specified range of characters, starting at a given `index`.
     * Both `index` and `length` are counted in terms of a number of UTF-8 character bytes.
     */
    delete(index: number, length: number, txn: YTransaction | undefined): void;
    /**
     * Wraps an existing piece of text within a range described by `index`-`length` parameters with
     * formatting blocks containing provided `attributes` metadata. This method only works for
     * `YText` instances that already have been integrated into document store.
     */
    format(index: number, length: number, attributes: any, txn: YTransaction | undefined): void;
    /**
     * Inserts a given `chunk` of text into this `YText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.`attributes` are only supported for a `YText` instance which
     * already has been integrated into document store.
     */
    insert(index: number, chunk: string, attributes: any, txn: YTransaction | undefined): void;
    /**
     * Inserts a given `embed` object into this `YText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided `embed`
     * with a formatting blocks.`attributes` are only supported for a `YText` instance which
     * already has been integrated into document store.
     */
    insertEmbed(index: number, embed: any, attributes: any, txn: YTransaction | undefined): void;
    /**
     * Returns length of an underlying string stored in this `YText` instance,
     * understood as a number of UTF-8 encoded bytes.
     */
    length(txn: YTransaction | undefined): number;
    /**
     * Creates a new preliminary instance of a `YText` shared data type, with its state initialized
     * to provided parameter.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    constructor(init?: string | null);
    /**
     * Subscribes to all operations happening over this instance of `YText`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    /**
     * Appends a given `chunk` of text at the end of current `YText` instance.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.`attributes` are only supported for a `YText` instance which
     * already has been integrated into document store.
     */
    push(chunk: string, attributes: any, txn: YTransaction | undefined): void;
    quote(lower: number | null | undefined, upper: number | null | undefined, lower_open: boolean | null | undefined, upper_open: boolean | null | undefined, txn: YTransaction | undefined): YWeakLink;
    /**
     * Returns the Delta representation of this YText type.
     */
    toDelta(snapshot: any, prev_snapshot: any, compute_ychange: Function | null | undefined, txn: YTransaction | undefined): Array<any>;
    /**
     * Returns an underlying shared string stored in this data type.
     */
    toJson(txn: YTransaction | undefined): any;
    /**
     * Returns an underlying shared string stored in this data type.
     */
    toString(txn: YTransaction | undefined): string;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserve(callback: Function): boolean;
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     */
    unobserveDeep(callback: Function): boolean;
    readonly doc: YDoc | undefined;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YArray`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

/**
 * Event generated by `YYText.observe` method. Emitted during transaction commit phase.
 */
export class YTextEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     */
    path(): any;
    /**
     * Returns a list of text changes made over corresponding `YText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { insert: string, attributes: any|undefined }
     * - { delete: number }
     * - { retain: number, attributes: any|undefined }
     */
    readonly delta: any;
    readonly origin: any;
    /**
     * Returns a current shared type instance, that current event changes refer to.
     */
    readonly target: any;
}

export class YTransaction {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
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
     */
    applyV1(diff: Uint8Array): void;
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
     */
    applyV2(diff: Uint8Array): void;
    /**
     * Triggers a post-update series of operations without `free`ing the transaction. This includes
     * compaction and optimization of internal representation of updates, triggering events etc.
     * ywasm transactions are auto-committed when they are `free`d.
     */
    commit(): void;
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
     */
    diffV1(vector?: Uint8Array | null): Uint8Array;
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
     */
    diffV2(vector?: Uint8Array | null): Uint8Array;
    encodeUpdate(): Uint8Array;
    encodeUpdateV2(): Uint8Array;
    /**
     * Force garbage collection of the deleted elements, regardless of a parent doc was created
     * with `gc` option turned on or off.
     */
    gc(): void;
    /**
     * Given a logical identifier of the collection (obtained via `YText.id`, `YArray.id` etc.),
     * attempts to return an instance of that collection in the scope of current document.
     *
     * Returns `undefined` if an instance was not defined locally, haven't been integrated or
     * has been deleted.
     */
    get(id: any): any;
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
     */
    selectAll(json_path: string): Array<any>;
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
     */
    selectOne(json_path: string): any;
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
     */
    stateVectorV1(): Uint8Array;
    /**
     * Returns state vector describing the current state of
     * the document.
     */
    readonly afterState: Map<any, any>;
    /**
     * Returns state vector describing the state of the document
     * at the moment when the transaction began.
     */
    readonly beforeState: Map<any, any>;
    /**
     * Returns a delete set containing information about
     * all blocks removed as part of a current transaction.
     */
    readonly deleteSet: Map<any, any>;
    readonly origin: any;
    /**
     * Returns a unapplied delete set, that was received in one of the previous remote updates.
     * This DeleteSet is waiting for a missing updates to arrive in order to be applied.
     */
    readonly pendingDeleteSet: Map<any, any> | undefined;
    readonly pendingStructs: any;
}

export class YUndoEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly kind: any;
    meta: any;
    readonly origin: any;
}

export class YUndoManager {
    free(): void;
    [Symbol.dispose](): void;
    addToScope(ytypes: Array<any>): void;
    addTrackedOrigin(origin: any): void;
    clear(clear_undo_stack?: boolean | null, clear_redo_stack?: boolean | null): void;
    constructor(options: any);
    off(event: string, callback: Function): boolean;
    on(event: string, callback: Function): void;
    redo(): void;
    removeTrackedOrigin(origin: any): void;
    stopCapturing(): void;
    undo(): void;
    readonly canRedo: boolean;
    readonly canUndo: boolean;
}

export class YWeakLink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current YWeakLink reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    deref(txn: YTransaction | undefined): any;
    /**
     * Subscribes to all operations happening over this instance of `YMap`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    toString(txn: YTransaction | undefined): string;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserve(callback: Function): boolean;
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     */
    unobserveDeep(callback: Function): boolean;
    unquote(txn: YTransaction | undefined): Array<any>;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YWeakLink`.
     *
     * Preliminary instances can be nested into other shared data types such as `YArray` and `YMap`.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

/**
 * Event generated by `YXmlElement.observe` method. Emitted during transaction commit phase.
 */
export class YWeakLinkEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     */
    path(): any;
    readonly origin: any;
    /**
     * Returns a current shared type instance, that current event changes refer to.
     */
    readonly target: any;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current shared type reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    /**
     * Returns an iterator that enables to traverse over all attributes of this XML node in
     * unspecified order. This method returns attribute values as their original JS values,
     * not just as strings.
     */
    attributes(txn: YTransaction | undefined): any;
    delete(index: number, length: number | null | undefined, txn: YTransaction | undefined): void;
    /**
     * Returns a first child of this XML node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node has not children.
     */
    firstChild(txn: YTransaction | undefined): any;
    /**
     * Returns a value of an attribute given its `name` as any JS value. If no attribute with such name existed,
     * `undefined` will be returned.
     */
    getAttribute(name: string, txn: YTransaction | undefined): any;
    insert(index: number, xml_node: any, txn: YTransaction | undefined): void;
    /**
     * Returns a number of child XML nodes stored within this `YXMlElement` instance.
     */
    length(txn: YTransaction | undefined): number;
    /**
     * Returns a tag name of this XML node.
     */
    name(txn: YTransaction | undefined): string;
    constructor(name: string, attributes: any, children: any);
    /**
     * Returns a next XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a last child of
     * parent XML node.
     */
    nextSibling(txn: YTransaction | undefined): any;
    /**
     * Subscribes to all operations happening over this instance of `YXmlElement`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    /**
     * Returns a parent `YXmlElement` node or `undefined` if current node has no parent assigned.
     */
    parent(txn: YTransaction | undefined): any;
    /**
     * Returns a previous XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a first child
     * of parent XML node.
     */
    prevSibling(txn: YTransaction | undefined): any;
    push(xml_node: any, txn: YTransaction | undefined): void;
    /**
     * Removes an attribute from this XML node, given its `name`.
     */
    removeAttribute(name: string, txn: YTransaction | undefined): void;
    /**
     * Sets a `name` and `value` as new attribute for this XML node. If an attribute with the same
     * `name` already existed on that node, its value with be overridden with a provided one.
     * This method accepts any JavaScript value, not just strings.
     */
    setAttribute(name: string, value: any, txn: YTransaction | undefined): void;
    /**
     * Returns a string representation of this XML node.
     */
    toString(txn: YTransaction | undefined): string;
    /**
     * Returns an iterator that enables a deep traversal of this XML node - starting from first
     * child over this XML node successors using depth-first strategy.
     */
    treeWalker(txn: YTransaction | undefined): Array<any>;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserve(callback: Function): boolean;
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     */
    unobserveDeep(callback: Function): boolean;
    readonly doc: YDoc | undefined;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YXmlElement`.
     *
     * Preliminary instances can be nested into other shared data types.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

/**
 * Event generated by `YXmlElement.observe` method. Emitted during transaction commit phase.
 */
export class YXmlEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     */
    path(): any;
    /**
     * Returns a list of XML child node changes made over corresponding `YXmlElement` collection
     * within bounds of current transaction. These changes follow a format:
     *
     * - { insert: (YXmlText|YXmlElement)[] }
     * - { delete: number }
     * - { retain: number }
     */
    readonly delta: any;
    /**
     * Returns a list of attribute changes made over corresponding `YXmlText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { action: 'add'|'update'|'delete', oldValue: string|undefined, newValue: string|undefined }
     */
    readonly keys: any;
    readonly origin: any;
    /**
     * Returns a current shared type instance, that current event changes refer to.
     */
    readonly target: any;
}

/**
 * Represents a list of `YXmlElement` and `YXmlText` types.
 * A `YXmlFragment` is similar to a `YXmlElement`, but it does not have a
 * nodeName and it does not have attributes. Though it can be bound to a DOM
 * element - in this case the attributes and the nodeName are not shared
 */
export class YXmlFragment {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current shared type reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    delete(index: number, length: number | null | undefined, txn: YTransaction | undefined): void;
    /**
     * Returns a first child of this XML node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node has not children.
     */
    firstChild(txn: YTransaction | undefined): any;
    insert(index: number, xml_node: any, txn: YTransaction | undefined): void;
    /**
     * Returns a number of child XML nodes stored within this `YXMlElement` instance.
     */
    length(txn: YTransaction | undefined): number;
    constructor(children: any[]);
    /**
     * Subscribes to all operations happening over this instance of `YXmlFragment`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    push(xml_node: any, txn: YTransaction | undefined): void;
    /**
     * Returns a string representation of this XML node.
     */
    toString(txn: YTransaction | undefined): string;
    /**
     * Returns an iterator that enables a deep traversal of this XML node - starting from first
     * child over this XML node successors using depth-first strategy.
     */
    treeWalker(txn: YTransaction | undefined): Array<any>;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserve(callback: Function): boolean;
    /**
     * Unsubscribes a callback previously subscribed with `observeDeep` method.
     */
    unobserveDeep(callback: Function): boolean;
    readonly doc: YDoc | undefined;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YXmlFragment`.
     *
     * Preliminary instances can be nested into other shared data types.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

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
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if current shared type reference is alive and has not been deleted by its parent collection.
     * This method only works on already integrated shared types and will return false is current
     * type is preliminary (has not been integrated into document).
     */
    alive(txn: YTransaction): boolean;
    applyDelta(delta: Array<any>, txn: YTransaction | undefined): void;
    /**
     * Returns an iterator that enables to traverse over all attributes of this XML node in
     * unspecified order. This method returns attribute values as their original JS values,
     * not just as strings.
     */
    attributes(txn: YTransaction | undefined): any;
    /**
     * Deletes a specified range of characters, starting at a given `index`.
     * Both `index` and `length` are counted in terms of a number of UTF-8 character bytes.
     */
    delete(index: number, length: number, txn: YTransaction | undefined): void;
    /**
     * Formats text within bounds specified by `index` and `len` with a given formatting
     * attributes.
     */
    format(index: number, length: number, attributes: any, txn: YTransaction | undefined): void;
    /**
     * Returns a value of an attribute given its `name` as any JS value. If no attribute with such name existed,
     * `undefined` will be returned.
     */
    getAttribute(name: string, txn: YTransaction | undefined): any;
    /**
     * Inserts a given `chunk` of text into this `YXmlText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.
     */
    insert(index: number, chunk: string, attributes: any, txn: YTransaction | undefined): void;
    /**
     * Inserts a given `embed` object into this `YXmlText` instance, starting at a given `index`.
     *
     * Optional object with defined `attributes` will be used to wrap provided `embed`
     * with a formatting blocks.`attributes` are only supported for a `YXmlText` instance which
     * already has been integrated into document store.
     */
    insertEmbed(index: number, embed: any, attributes: any, txn: YTransaction | undefined): void;
    /**
     * Returns length of an underlying string stored in this `YXmlText` instance,
     * understood as a number of UTF-8 encoded bytes.
     */
    length(txn: YTransaction | undefined): number;
    constructor(text: string | null | undefined, attributes: any);
    /**
     * Returns a next XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a last child of
     * parent XML node.
     */
    nextSibling(txn: YTransaction | undefined): any;
    /**
     * Subscribes to all operations happening over this instance of `YXmlText`. All changes are
     * batched and eventually triggered during transaction commit phase.
     */
    observe(callback: Function): void;
    /**
     * Subscribes to all operations happening over this Y shared type, as well as events in
     * shared types stored within this one. All changes are batched and eventually triggered
     * during transaction commit phase.
     */
    observeDeep(callback: Function): void;
    /**
     * Returns a parent `YXmlElement` node or `undefined` if current node has no parent assigned.
     */
    parent(txn: YTransaction | undefined): any;
    /**
     * Returns a previous XML sibling node of this XMl node.
     * It can be either `YXmlElement`, `YXmlText` or `undefined` if current node is a first child
     * of parent XML node.
     */
    prevSibling(txn: YTransaction | undefined): any;
    /**
     * Appends a given `chunk` of text at the end of `YXmlText` instance.
     *
     * Optional object with defined `attributes` will be used to wrap provided text `chunk`
     * with a formatting blocks.
     */
    push(chunk: string, attributes: any, txn: YTransaction | undefined): void;
    quote(lower: number | null | undefined, upper: number | null | undefined, lower_open: boolean | null | undefined, upper_open: boolean | null | undefined, txn: YTransaction | undefined): YWeakLink;
    /**
     * Removes an attribute from this XML node, given its `name`.
     */
    removeAttribute(name: string, txn: YTransaction | undefined): void;
    /**
     * Sets a `name` and `value` as new attribute for this XML node. If an attribute with the same
     * `name` already existed on that node, its value with be overridden with a provided one.
     * This method accepts any JavaScript value, not just strings.
     */
    setAttribute(name: string, value: any, txn: YTransaction | undefined): void;
    /**
     * Returns the Delta representation of this YXmlText type.
     */
    toDelta(snapshot: any, prev_snapshot: any, compute_ychange: Function | null | undefined, txn: YTransaction | undefined): Array<any>;
    /**
     * Returns an underlying string stored in this `YXmlText` instance.
     */
    toString(txn: YTransaction | undefined): string;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserve(callback: Function): boolean;
    /**
     * Unsubscribes a callback previously subscribed with `observe` method.
     */
    unobserveDeep(callback: Function): boolean;
    readonly doc: YDoc | undefined;
    /**
     * Gets unique logical identifier of this type, shared across peers collaborating on the same
     * document.
     */
    readonly id: any;
    /**
     * Returns true if this is a preliminary instance of `YXmlText`.
     *
     * Preliminary instances can be nested into other shared data types.
     * Once a preliminary instance has been inserted this way, it becomes integrated into ywasm
     * document store and cannot be nested again: attempt to do so will result in an exception.
     */
    readonly prelim: boolean;
    readonly type: number;
}

/**
 * Event generated by `YXmlText.observe` method. Emitted during transaction commit phase.
 */
export class YXmlTextEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns an array of keys and indexes creating a path from root type down to current instance
     * of shared type (accessible via `target` getter).
     */
    path(): any;
    /**
     * Returns a list of text changes made over corresponding `YText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { insert: string, attributes: any|undefined }
     * - { delete: number }
     * - { retain: number, attributes: any|undefined }
     */
    readonly delta: any;
    /**
     * Returns a list of attribute changes made over corresponding `YXmlText` collection within
     * bounds of current transaction. These changes follow a format:
     *
     * - { action: 'add'|'update'|'delete', oldValue: string|undefined, newValue: string|undefined }
     */
    readonly keys: any;
    readonly origin: any;
    /**
     * Returns a current shared type instance, that current event changes refer to.
     */
    readonly target: any;
}

export function applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, _origin: any): void;

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
 */
export function applyUpdate(doc: YDoc, update: Uint8Array, origin: any): void;

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
 */
export function applyUpdateV2(doc: YDoc, update: Uint8Array, origin: any): void;

/**
 * Similar to `mergeUpdatesV1` but instead of just merging the updates, it creates a temporary
 * document, applies them and then performs garbage collection (if requested). Good for
 * constructing document's state snapshot.
 */
export function applyUpdatesV1(gc: boolean, updates: Uint8Array[]): Uint8Array;

/**
 * Similar to `mergeUpdatesV2` but instead of just merging the updates, it creates a temporary
 * document, applies them and then performs garbage collection (if requested). Good for
 * constructing document's state snapshot.
 */
export function applyUpdatesV2(gc: boolean, updates: Uint8Array[]): Uint8Array;

export function compareRelativePositions(a: any, b: any): boolean;

/**
 * Converts a sticky index (see: `createStickyIndexFromType`) into an object
 * containing human-readable index.
 */
export function createAbsolutePositionFromRelativePosition(rpos: any, doc: YDoc): any;

/**
 * Retrieves a sticky index corresponding to a given human-readable `index` pointing into
 * the shared `ytype`. Unlike standard indexes sticky indexes enables to track
 * the location inside of a shared y-types, even in the face of concurrent updates.
 *
 * If association is >= 0, the resulting position will point to location **after** the referenced index.
 * If association is < 0, the resulting position will point to location **before** the referenced index.
 */
export function createRelativePositionFromTypeIndex(ytype: any, index: number, assoc: number, txn: YTransaction | undefined): any;

/**
 * Returns a string dump representation of a given `update` encoded using lib0 v1 encoding.
 */
export function debugUpdateV1(update: Uint8Array): string;

/**
 * Returns a string dump representation of a given `update` encoded using lib0 v2 encoding.
 */
export function debugUpdateV2(update: Uint8Array): string;

/**
 * Deserializes sticky index serialized previously by `encodeStickyIndex`.
 */
export function decodeRelativePosition(bin: Uint8Array): any;

export function decodeSnapshotV1(snapshot: Uint8Array): any;

export function decodeSnapshotV2(snapshot: Uint8Array): any;

export function encodeAwarenessUpdate(awareness: Awareness, clients: any): Uint8Array;

/**
 * Serializes sticky index created by `createStickyIndexFromType` into a binary
 * payload.
 */
export function encodeRelativePosition(rpos: any): Uint8Array;

export function encodeSnapshotV1(snapshot: any): Uint8Array;

export function encodeSnapshotV2(snapshot: any): Uint8Array;

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
 */
export function encodeStateAsUpdate(doc: YDoc, vector?: Uint8Array | null): Uint8Array;

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
 */
export function encodeStateAsUpdateV2(doc: YDoc, vector?: Uint8Array | null): Uint8Array;

export function encodeStateFromSnapshotV1(doc: YDoc, snapshot: any): Uint8Array;

export function encodeStateFromSnapshotV2(doc: YDoc, snapshot: any): Uint8Array;

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
 */
export function encodeStateVector(doc: YDoc): Uint8Array;

export function equalSnapshots(snap1: any, snap2: any): boolean;

/**
 * Merges a sequence of updates (encoded using lib0 v1 encoding) together, producing another
 * update (also lib0 v1 encoded) in the result. Returned binary is a combination of all input
 * `updates`, compressed.
 *
 * Returns an error whenever any of the input updates couldn't be decoded.
 */
export function mergeUpdatesV1(updates: Array<any>): Uint8Array;

/**
 * Merges a sequence of updates (encoded using lib0 v2 encoding) together, producing another
 * update (also lib0 v2 encoded) in the result. Returned binary is a combination of all input
 * `updates`, compressed.
 *
 * Returns an error whenever any of the input updates couldn't be decoded.
 */
export function mergeUpdatesV2(updates: Array<any>): Uint8Array;

export function modifyAwarenessUpdate(update: Uint8Array, modify: Function): Uint8Array;

export function removeAwarenessStates(awareness: Awareness, clients: BigUint64Array): void;

/**
 * When called will call console log errors whenever internal panic is called from within
 * WebAssembly module.
 */
export function setPanicHook(): void;

export function snapshot(doc: YDoc): any;
