/**
 * Helpers
 * This shouldn't exist, need to find existing equivalents
 */

const EXPORTED_SYMBOLS = [ "Utils", "FormData" ];

const { utils: Cu } = Components;
Cu.importGlobalProperties(["XMLHttpRequest"]);

const Utils = {
    assign: function(aTarget, ...aSources) {
        for (let source of aSources) {
            let props = {};
            for (let prop of Object.getOwnPropertyNames(source)) {
                props[prop] = Object.getOwnPropertyDescriptor(source, prop);
            }
            Object.definedProperties(aTarget, props);
        }
    },
    extend: function(aBase, ...aExtensions) {
        var props = {};
        for (let extension of aExtensions) {
            for (let prop of Object.getOwnPropertyNames(extension)) {
                props[prop] = Object.getOwnPropertyDescriptor(extension, prop);
            }
        }
        return Object.create(aBase, props);
    },
    /**
     * The GlobalFetch.fetch API doesn't support FormData
     * This is a work-mostly-alike
     */
    fetch: function(url, options={}) {
        let method = (options.method || "get").toUpperCase();
        return new Promise((resolve, reject) => {
            dump(`${method}ing ${url}\n`);
            let xhr = new XMLHttpRequest();
            xhr.responseType = options.responseType || "document";
            xhr.addEventListener("load", (e) => {
                resolve(xhr.response);
            });
            xhr.addEventListener("error", reject);
            xhr.open(method, url, true);
            // Workaround until bug 1108181 is fixed
            for (let k of Object.keys(options.headers || {})) {
                xhr.setRequestHeader(k, options.headers[k]);
            }
            xhr.send(options.body);
        });
    }
};

/**
 * There seems to be no way to get a FormData
 * This is a wrapper around the XPCOM version
 */
function FormData(form) {
    var data = Components.classes["@mozilla.org/files/formdata;1"].createInstance();
    if (form && form.elements) {
        for (let element of form.elements) {
            if (typeof(element.name) === "undefined") {
                continue;
            }
            data.append(element.name, element.value);
        }
    }
    return data;
}
