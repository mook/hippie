/**
 * Extension of XMPPSession to support HipChat-style auth
 */

const EXPORTED_SYMBOLS = ["HipChatSession"];

const { interfaces: Ci, results: Cr, utils: Cu, classes: Cc } = Components;

Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/xmpp-authmechs.jsm");
Cu.import("resource:///modules/xmpp-session.jsm");
Cu.import("chrome://hippie/content/Utils.jsm");
Cu.import("chrome://hippie/content/XML.jsm");

Cu.importGlobalProperties(["URL"]);

XPCOMUtils.defineLazyGetter(this, "_", () =>
  l10nHelper("chrome://chat/locale/xmpp.properties")
);

function HipChatAuth(aSession) {
    let data = `\0${aSession._login}\0${aSession._password}\0${aSession._resource}`;
    // btoa for Unicode, see https://developer.mozilla.org/en-US/docs/DOM/window.btoa
    this._base64Data = btoa(unescape(encodeURIComponent(data)));
}
HipChatAuth.prototype = {
    next: function(aStanza) {
        let result = { done: true };
        let node = Stanza.node("auth", Stanza.NS.hipchat,
                               {ver: "0",
                                node: "http://hippie.mook.github.io",
                                oauth2_token: true},
                               "(base64 login and password not logged)");
        result.log = node.getXML();
        node.children.pop();
        node.addText(this._base64Data);
        result.send = node;
        return result;
    }
};

function HipChatSession(aHost, aLogin, aPassword, aAccount, aResource=null) {
    this._host = aHost;
    this._login = aLogin;
    this._port = 5222;
    this._connectionSecurity = "require_tls";
    this._security = ["starttls"];
    this._password = aPassword;
    this._account = aAccount;
    this._domain = aHost;

    // Whether to do HipChat-specific auth. Used for fallback.
    this._allowHipChatAuth = true;

    this._resource = aResource || XMPPDefaultResource;
    this._handlers = new Map();
    this._account.reportConnecting();

    initLogModule(`${this._account.protocol.id}.${this.name}`, this);
    this.DEBUG(`Attempting to connect to ${this._host}:${this._port} with ${this._security}`);

    try {
        this.connect(this._host, this._port, this._security);
    } catch (e) {
        Cu.reportError(e);
        // We can't use _networkError because this._account._connection
        // isn't set until we return from the XMPPSession constructor.
        this._account.reportDisconnecting(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                                          _("connection.error.failedToCreateASocket"));
        this._account.reportDisconnected();
    }
}
HipChatSession.prototype = Utils.extend(XMPPSession.prototype, {

    _xmppStanzaListeners: XMPPSession.prototype.stanzaListeners,

    stanzaListeners: Utils.extend(XMPPSession.prototype.stanzaListeners, {
        // override stanzaListeners.startAuth to do HipChat-specific auth
        startAuth(aStanza) {
            this._allowHipChatAuth = true;
            // At this point, we already have a TLS connection.
            this.DEBUG(`Starting auth with ${aStanza.getXML()}`);

            if (aStanza.localName != "features") {
                this.ERROR(`Unexpected stanza ${aStanza.localName}, expected 'features'`);
                this._networkError(_("connection.error.incorrectResponse"));
                return;
            }

            if (!aStanza.getElementsNS([[Stanza.NS.hipchat, "auth"]])) {
                this.LOG("HipChat-specific auth mechanism missing, falling back to plain XMPP");
                this._doFallbackAuth(aStanza);
                return;
            }

            this._startAuthStanza = aStanza;
            let authMech = new HipChatAuth(this);
            this._password = null; // We don't need this anymore
            this._account.reportConnecting(_("connection.authenticating"));
            this.onXmppStanza = this.stanzaListeners.authDialog.bind(this, authMech);
            this.onXmppStanza(null); // the first auth step doesn't read anything
        },

        authResult(aStanza) {
            this.DEBUG(`Got auth result; doing ${this._allowHipChatAuth ? "HipChat" : "fallback"} auth`);

            let startAuthStanza = this._startAuthStanza;
            delete this._startAuthStanza;

            if (!this._allowHipChatAuth || aStanza.localName != "success") {
                return this._xmppStanzaListeners.authResult.call(this, aStanza);
            }

            this._account.reportConnecting(_("connection.gettingResource"));
            this._jid = this._account._parseJID(aStanza.attributes["jid"]);
            if (!this._jid) {
                this._networkError(_("connection.error.failedToGetAResource"));
                this._doFallbackAuth(startAuthStanza);
                return;
            }
            if (!this._jid.resource) {
                this._jid.resource = this._resource;
            }
            this._account._jid = this._jid;
            this._api_host = aStanza.attributes["api_host"];
            this._chat_host = aStanza.attributes["chat_host"];
            this._muc_host = aStanza.attributes["muc_host"];
            this._web_host = aStanza.attributes["web_host"];
            this._token = aStanza.attributes["oauth2_token"];
            this._domain = this._chat_host;

            // The HipChat internal protocol skips the XMPP spec here, and
            // directly assumes the session has started.
            this.stanzaListeners.sessionStarted.call(this, null);
        },

    }),

    /**
     * This method is called if we are unable to use the HipChat-specific auth
     * mechanism.  Fall back to scraping the web site for XMPP info and using
     * that to connect.
     */
    _doFallbackAuth(aStanza) {
        this._allowHipChatAuth = false;

        this._api_host = this._host;
        if (this._api_host.endsWith(".hipchat.com")) {
            // Hosted hipchat uses the main server
            this._api_host = "www.hipchat.com"
        }

        this.DEBUG(`Connecting to ${this._api_host} as ${this._login}`);
        this._account.reportConnecting("Locating web login");

        new Promise((resolve, reject) => { return resolve()})
        // Fetch the sign in page
        .then(() => {
            const url = `https://${this._api_host}/sign_in`;
            this.DEBUG(`Fetching login form ${url}`);
            return Utils.fetch(url, {});
        })
        // Fill out the sign in form
        .then((doc) => {
            let url = new URL(doc.documentURI);
            if (url.pathname == "/home") {
                // already signed in
                return doc;
            }
            let form = doc.querySelector("form[name='signin']");
            let data = new FormData(form);
            data.set("email", this._login);
            data.set("password", this._password);
            this.DEBUG(`Submitting login form to ${form.action}`);
            return Utils.fetch(form.action, {method: form.method, body: data});
        })
        // Confirm sign in, look for account info
        .then((doc) => {
            let url = new URL(doc.documentURI);
            if (url.pathname == "/sign_in") {
                let message = "Error signing in";
                let box = doc.querySelector(".aui-message-error");
                if (box) {
                    message = box.textContent.trim();
                }
                throw message;
            }
            this._api_host = url.host;
            url.pathname = "/account/api";
            return Utils.fetch(url);
        })
        // Get the API token
        .then((doc) => {
            this._account.reportConnecting("Locating connection information");
            this._lookupAPIToken(doc);
        })
        // Get current user xmpp id
        .then(() => {
            return Utils.fetch(`https://${this._api_host}/account/xmpp`);
        })
        .then((doc) => {
            let content = doc.querySelector(".aui-page-panel-content table.aui");
            this._user_info = {
                jid: content.querySelector("#jabberid").textContent.trim(),
                name: content.querySelector("#nickname").textContent.trim(),
                host: content.querySelector("#connecthost").textContent.trim(),
            };
        })
        .then(() => {
            this._jid = this._account._parseJID(this._user_info.jid);

            // For the resource, if the user has edited the option to a non
            // empty value, use that.
            if (this._account.prefs.prefHasUserValue("resource")) {
                let resource = this._account.getString("resource");
                if (resource) {
                    this._jid.resource = resource;
                }
            }
            // Otherwise, if the username doesn't contain a resource, use the
            // value of the resource option (it will be the default value).
            // If we set an empty resource, XMPPSession will fallback to
            // XMPPDefaultResource (set to brandShortName).
            if (!this._jid.resource) {
                this._jid.resource = this._account.getString("resource");
            }

            //FIXME if we have changed this._jid.resource, then this._jid.jid
            // needs to be updated. This value is however never used because
            // while connected it's the jid of the session that's interesting.
            this._account._jid = this._jid;
        })
        .then(() => {
            this.DEBUG("Account information received, going back to auth");
            this._xmppStanzaListeners.startAuth.call(this, aStanza);
        })
        .catch((ex) => {
            this.ERROR(ex);
            this._networkError(`Failed fallback authorization: ${ex}`);
        });
    },

    get _TOKEN_LABEL() { return "Mozilla Hippie Token"; },

    /**
     * Look up the API token to use
     * This is part of the _doFallbackAuth() flow.
     * @param doc {Document} The document from loading /account/api
     * @return promise to be resolved
     * @resolve nothing; but this._token will be the API token.
     */
    _lookupAPIToken: function(doc, allowConfirmPassword = true) {
        return new Promise((resolve, reject) => {
            let url = new URL(doc.documentURI);
            if (url.pathname == "/account/confirm_password") {
                if (!allowConfirmPassword) {
                    // We're in a confirm password loop
                    reject(`Password confirmation failure`);
                    return;
                }
                // Need to confirm the password
                let form = doc.querySelector("form[name='confirm_password']");
                if (!form) {
                    reject(`Failed to find password confirmation form`);
                }
                let data = new FormData(form);
                data.set("password", this._password);
                this.DEBUG(`Submitting password confirmation to ${form.action}`);
                Utils.fetch(form.action, {method: form.method, body: data})
                    .then((doc) => resolve(this._lookupAPIToken(doc, false)))
                    .catch(reject);
                return;
            }

            // Check for existing OAuth scoped token
            for (let label of doc.querySelectorAll("#tokens tr.data td.label")) {
                if (label.textContent.trim() == this._TOKEN_LABEL) {
                    let node = label.parentNode.querySelector(".token");
                    this._token = node.textContent.trim();
                    this.DEBUG(`Found existing token ${this._token}`);
                    resolve();
                    return;
                }
            }

            // Request new token
            this.DEBUG(`Will need to request new token`);
            let form = doc.querySelector(".aui-page-panel-content > form[action$='/account/api']");
            let data = new FormData(form);
            data.set("label", this._TOKEN_LABEL);
            data.delete("scopes[]");
            for (let scope of ["send_message", "send_notification", "view_group", "view_messages", "view_room"]) {
                data.append("scopes[]", scope);
            }
            // There's a <input name="action"> which breaks form.action
            Utils.fetch(form.getAttribute("action"), {method: form.method, body: data})
                .then((doc) => resolve(this._lookupAPIToken(doc, false)))
                .catch(reject);
        });
    },

    /**
     * Make an API request
     * @param path {String} The API endpoint, e.g. /v2/user/foo
     * @param options {Object} See Utils.fetch
     * @returns {Promise} The API JSON
     */
    APIRequest: function(path, options={}) {
        let headers = {};
        headers["Authorization"] = `Bearer ${this._token}`;
        let opts = {};
        for (let k of Object.keys(options)) {
            opts[k] = options[k];
        }
        opts.responseType = "json";
        opts.headers = headers;
        let url = new URL(path, `https://${this._api_server}/`);
        return Utils.fetch(url, opts);
    },

    // HipChat times out at 90s, and recommends ping at 60s.
    kTimeBeforePing: 60000,
});
