const EXPORTED_SYMBOLS = ["HipChatAccount"];
const { interfaces: Ci, results: Cr, utils: Cu, classes: Cc } = Components;

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/jsProtoHelper.jsm");
Cu.import("resource:///modules/xmpp.jsm");
Cu.import("resource:///modules/xmpp-session.jsm");
Cu.import("resource:///modules/xmpp-xml.jsm");
Cu.import("chrome://hippie/content/Utils.jsm");
Cu.importGlobalProperties(["URL"]);

XPCOMUtils.defineLazyGetter(this, "_", () =>
  l10nHelper("chrome://chat/locale/xmpp.properties")
);

const kRoomInfoRefreshInterval =  12 * 60 * 60 * 1000; // 12 hours.

function ChatRoomFieldValues(mapping={}) {
    this._data = new Map();
    for (let key of Object.keys(mapping)) {
        this.setValue(key, mapping[key]);
    }
}
ChatRoomFieldValues.prototype = {
    getValue(aIdentifier) {
        return this._data.get(aIdentifier);
    },
    setValue(aIdentifier, aValue) {
        this._data.set(aIdentifier, aValue);
    },
};

function HipChatAccount(aPrpl, aImAccount) {
    this._init(aPrpl, aImAccount);
    initLogModule(`${this.protocol.id}.${this.name}`, this);

    this._roomInfoCallbacks = new Set();
    this._photoFetchURLs = new Map();
    this.DEBUG(`Created account ${this}`);
}

HipChatAccount.prototype = Utils.extend(XMPPAccountPrototype, {
    chatRoomFields: {
        /* No nick option; always use nick of current user */
        room: {get label() { return _("chatRoomField.room"); }, required: true},
        server: {get label() { return _("chatRoomField.server"); }, required: true},
        password: {get label() { return _("chatRoomField.password"); }, isPassword: true}
    },

    get _TOKEN_LABEL() { return "Mozilla Hippie Token"; },

    /**
     * Override XMPPAccountPrototype.connect() to determine the JID automatically
     */
    connect: function() {
        var [, login, server] = /(.*)@(.*?)$/.exec(this.name);
        if (server.endsWith(".hipchat.com")) {
            // Hosted HipChat uses the same login server
            server = "www.hipchat.com";
        }
        this._api_server = server;

        this.DEBUG(`Connecting to ${server} as ${login}`);
        this.reportConnecting("Locating web login");

        new Promise((resolve, reject) => { return resolve()})
        // Fetch the sign in page
        .then(() => {
            const url = `https://${server}/sign_in`;
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
            data.set("email", login);
            data.set("password", this.imAccount.password);
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
            this._api_server = url.host;
            url.pathname = "/account/api";
            return Utils.fetch(url);
        })
        // Get the API token
        .then((doc) => {
            this.reportConnecting("Locating connection information");
            this._lookupAPIToken(doc);
        })
        // Get current user xmpp id
        .then(() => {
            return Utils.fetch(`https://${this._api_server}/account/xmpp`);
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
            this._jid = this._parseJID(this._user_info.jid);

            // For the resource, if the user has edited the option to a non
            // empty value, use that.
            if (this.prefs.prefHasUserValue("resource")) {
                let resource = this.getString("resource");
                if (resource) {
                    this._jid.resource = resource;
                }
            }
            // Otherwise, if the username doesn't contain a resource, use the
            // value of the resource option (it will be the default value).
            // If we set an empty resource, XMPPSession will fallback to
            // XMPPDefaultResource (set to brandShortName).
            if (!this._jid.resource) {
                this._jid.resource = this.getString("resource");
            }

            //FIXME if we have changed this._jid.resource, then this._jid.jid
            // needs to be updated. This value is however never used because
            // while connected it's the jid of the session that's interesting.

            this._connection =
              new XMPPSession(this._user_info.host,
                              5222,
                              "require_tls",
                              this._jid,
                              this.imAccount.password,
                              this);

            // HipChat times out at 90s, ping at 60s.
            this._connection.kTimeBeforePing = 60000;

            return this._connection;
        })
        .catch((ex) => {
            Cu.reportError(ex);
            this.DEBUG(`Error connecting to HipChat: ${ex}`);
        })
    },

    /**
     * Look up the API token to use
     * This is part of the connect() flow.
     * @param doc {Document} The document from loading /account/api
     * @return promise to be resolved
     * @resolve nothing; but this._token will be the API token.
     */
    _lookupAPIToken: function(doc) {
        return new Promise((resolve, reject) => {
            let url = new URL(doc.documentURI);
            if (url.pathname == "/account/confirm_password") {
                // Need to confirm the password
                let form = doc.querySelector("form[name='confirm_password']");
                if (!form) {
                    reject(`Failed to find password confirmation form`);
                }
                let data = new FormData(form);
                data.set("password", this.imAccount.password);
                this.DEBUG(`Submitting password confirmation to ${form.action}`);
                Utils.fetch(form.action, {method: form.method, body: data})
                    .then((doc) => resolve(this._lookupAPIToken(doc)))
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
                .then((doc) => resolve(this._lookupAPIToken(doc)))
                .catch(reject);
        });
    },

    /**
     * Make an API request
     * @param path {String} The API endpoint, e.g. /v2/user/foo
     * @param options {Object} See Utils.fetch
     * @returns {Promise} The API JSON
     */
    _APIRequest: function(path, options={}) {
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

    // Override default XMPP joinChat() to provide the nick automatically
    joinChat: function(aComponents) {
        let jid =
            `${aComponents.getValue("room")}@${aComponents.getValue("server")}`;
        let nick = "XXX missing nick"

        let muc = this._mucs.get(jid);
        if (muc) {
            if (!muc.left)
                return muc; // We are already in this conversation.
            else if (!muc.chatRoomFields) {
                // We are rejoining a room that was parted by the user.
                muc._rejoined = true;
            }
        }
        else {
            muc = new this._MUCConversationConstructor(this, jid, nick);
            this._mucs.set(jid, muc);
        }

        // Store the prplIChatRoomFieldValues to enable later reconnections.
        muc.chatRoomFields = aComponents;
        muc.joining = true;
        muc.removeAllParticipants();

        let password = aComponents.getValue("password");
        let x = Stanza.node("x", Stanza.NS.muc, null,
                            password ? Stanza.node("password", null, null, password) : null);
        let logString;
        if (password) {
            logString = "<presence .../> (Stanza containing password to join MUC " +
                jid + "/" + nick + " not logged)";
        }
        this.sendStanza(Stanza.presence({to: jid + "/" + nick}, x),
                        undefined, undefined, logString);
        return muc;
    },

    _roomInfoCallbacks: new Set(),
    _roomInfoRequestTime: 0,
    _roomInfoCache: [],

    requestRoomInfo: function(callback, requestStartTime=0) {
        this.DEBUG(`Requesting room info (time=${requestStartTime})`);

        if (!this._mucService) {
            this.DEBUG(`requestRoomInfo failed, no muc service`);
            callback.onRoomInfoAvailable([], this, true, 0);
            return;
        }

        if (this._roomInfoCallbacks.has(callback)) {
            return;  // a room info request is pending, don't duplicate work
        }

        if (Date.now() - this._roomInfoRequestTime < kRoomInfoRefreshInterval) {
            // We have a valid cache; use it.
            this.DEBUG(`Using cache of ${this._roomInfoCache.length} items`);
            callback.onRoomInfoAvailable(this._roomInfoCache, this, true, this._roomInfoCache.length);
            return;
        }

        if (this._roomInfoCallbacks.size > 0) {
            // There's a request pending, wait for that to come back instead
            this.DEBUG(`Adding callback to existing request (${this._roomInfoCallbacks.size} callbacks)`);
            this._roomInfoCallbacks.add(callback);
            return;
        }

        this._roomInfoCallbacks.add(callback);
        this._roomInfoRequestTime = 0;

        if (requestStartTime == 0) {
            requestStartTime = Date.now();
            // Fresh request, clear the cache; otherwise, the cache contains the
            // previous items from this set
            this._roomInfoCache = [];
        }

        let iq = Stanza.iq("get", null, this._mucService,
                           Stanza.node("query", Stanza.NS.disco_items));
        let lastRoom = this._roomInfoCache.slice(-1)[0];
        if (lastRoom) {
            let set = Stanza.node("set",
                                  "http://jabber.org/protocol/rsm",
                                  null,
                                  Stanza.node("after",
                                              null,
                                              null,
                                              lastRoom.name));
            iq.getChildren()[0].addChild(set);
        }
        this.DEBUG(`Requesting rooms: ${iq.getXML()}`);

        this.sendStanza(iq, (receivedStanza) => {
            let newItems = [];
            let query = receivedStanza.getElement(["query"]);
            for (let item of query.getElements(["item"])) {
                let jid = this._parseJID(item.attributes["jid"]);
                newItems.push({
                    accountId: this.imAccount.id,
                    name: item.attributes["name"],
                    topic: item.getElement(["x", "topic"]).innerText.trim(),
                    participantCount: +item.getElement(["x", "num_participants"]).innerText.trim(),
                    chatRoomFieldValues: new ChatRoomFieldValues({
                        room: jid.node,
                        server: jid.domain,
                    })
                });
            }
            let set = query.getElement(["set"]);
            if (set) {
                // The results are incomplete; fetch more
                this.DEBUG(`Set found, fetching more items`);
                this.requestRoomInfo(callback, requestStartTime);
            }
            [].push.call(this._roomInfoCache, newItems);
            for (let callback of this._roomInfoCallbacks) {
                callback.onRoomInfoAvailable(newItems, this, !set, newItems.length);
            }
            if (!set) {
                // No more items
                this._roomInfoRequestTime = requestStartTime;
                this._roomInfoCallbacks.clear();
            }
            return true;
        });
    },

    joinChat: function(aComponents) {
        aComponents.setValue("nick", this._user_info.name);
        return XMPPAccountPrototype.joinChat.call(this, aComponents);
    },

    _photoFetchURLs: new Map(),
    _onRosterItem: function(aItem, aNotifyOfUpdates) {
        // Stub out _requestVCard here, the server falls over if we request too
        // many at once - about 1000 or so.
        let _requestVCard = Object.getOwnPropertyDescriptor(this, "_requestVCard");
        this._requestVCard = (jid) => {
            this.DEBUG(`Skipping request of vCard for ${jid}`);
        };
        try {
            var jid = XMPPAccountPrototype._onRosterItem.call(this, aItem, aNotifyOfUpdates);
        } finally {
            if (_requestVCard) {
                Object.setOwnPropertyDescriptor(this, "_requestVCard", _requestVCard);
            } else {
                delete this._requestVCard;
            }
        }

        // There may be extra fields we can fill in from the roster item
        if (!jid || !this._buddies.has(jid)) {
            this.DEBUG(`No buddy found for ${jid}, not setting photo`);
            return jid;
        }
        let buddy = this._buddies.get(jid);
        if (aItem.attributes["name"]) {
            buddy.vCardFormattedName = aItem.attributes["name"];
        }
        if (aItem.attributes["photo_url"] && !buddy.buddyIconFilename) {
            let url = aItem.attributes["photo_url"];
            if (this._photoFetchURLs.has(url)) {
                this._photoFetchURLs.get(url).push(buddy);
                return;
            }
            let hasher = Cc["@mozilla.org/security/hash;1"]
                           .createInstance(Ci.nsICryptoHash);
            hasher.init(Ci.nsICryptoHash.SHA1);
            hasher.update(url.split("").map((c) => c.charCodeAt(0)), url.length);
            let leaf = `${hasher.finish(true)}.jpg`.replace(/\//g, "-");
            let file = FileUtils.getFile("ProfD", ["icons",
                                                   this.protocol.normalizedName,
                                                   this.normalizedName,
                                                   "photos",
                                                   leaf]);
            let filespec = Services.io.newFileURI(file).spec;
            if (!file.exists()) {
                this._photoFetchURLs.set(url, []);
                this._photoFetchURLs.get(url).push(buddy);
                let uri = NetUtil.newURI(url);
                let principal = Services.scriptSecurityManager.createCodebasePrincipal(uri, {});
                let channel = NetUtil.newChannel({
                    uri: uri,
                    loadingPrincipal: principal,
                    contentPolicyType: Ci.nsIContentPolicy.TYPE_IMAGE
                });
                NetUtil.asyncFetch(channel, (inputStream, status, request) => {
                    if (!Components.isSuccessCode(status)) {
                        this.DEBUG(`Failed to fetch photo for ${buddy}: ${status.toString(16)}`);
                        this._photoFetchURLs.delete(url);
                        return;
                    }
                    let outputStream = FileUtils.openSafeFileOutputStream(file);
                    NetUtil.asyncCopy(inputStream, outputStream, (status) => {
                        if (Components.isSuccessCode(status)) {
                            for (let buddy of this._photoFetchURLs.get(url)) {
                                buddy.buddyIconFilename = filespec;
                            }
                        } else {
                            this.DEBUG(`Failed to copy photo for ${buddy}: ${status.toString(16)}`);
                        }
                        this._photoFetchURLs.delete(url);
                    });
                });
            } else {
                // File already exists, don't download again
                buddy.buddyIconFilename = filespec;
            }
        }
        return jid;
    },

    get wrappedJSObject() { return this },
    toString: function() { return `<HipChatAccount ${this.name}>`},
});
