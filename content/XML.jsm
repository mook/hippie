/**
 * Extensions to xmpp-xml.jsm
 */

const EXPORTED_SYMBOLS = ["Stanza", "XMPPParser"];

const { interfaces: Ci, results: Cr, utils: Cu, classes: Cc } = Components;
var { XMLNode } = Cu.import("resource:///modules/xmpp-xml.jsm");

/**
 * Get the first element anywhere inside the node (including child nodes) that
 * matches the query.  A query consists of an array of elements; each element
 * may be a two-tuple of (namespace, localName), or just the localName by
 * itself.
 */
XMLNode.prototype.getElementNS = function(aQuery) {
    if (aQuery.length == 0) {
        return this;
    }

    let nq = aQuery.slice(1);
    let q = aQuery[0];
    let [ns, localName] = (q + "" == q) ? [null, q] : q;
    for (let child of this.children) {
        if (child.type == "text" || (ns && child.uri != ns) || child.localName != localName) {
            continue;
        }
        let n = child.getElementNS(nq);
        if (n) {
            return n;
        }
    }

    return null;
};

/**
 * Get all elements of the node (including child nodes) that match the query.
 * A query consists of an array of elements; each element may be a two-tuple of
 * (namespace, localName), or just the localName by itself.
 */
XMLNode.prototype.getElementsNS = function(aQuery) {
    if (aQuery.length == 0) {
        return [this];
    }

    let q = aQuery[0];
    let [ns, localName] = (q + "" == q) ? [null, q] : q;
    let c = this.children.filter((c) => (c.type != "text" && (!ns || c.uri == ns) && c.localName == localName));
    let nq = aQuery.slice(1);
    let res = [];
    for (let child of c) {
        [].push.apply(res, child.getElements(nq));
    }

    return res;
};