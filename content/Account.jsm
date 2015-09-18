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
Cu.import("chrome://hippie/content/Utils.jsm");
Cu.importGlobalProperties(["fetch", "XMLHttpRequest", "URL"]);

function HipChatAccount(aPrpl, aImAccount) {
    this._init(aPrpl, aImAccount);
    initLogModule(`${this.protocol.id}.${this.name}`, this);
    this.DEBUG(`Created account ${this}`);
}

XPCOMUtils.defineLazyGetter(this, "_", () =>
  l10nHelper("chrome://chat/locale/xmpp.properties")
);

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

    requestRoomInfo: function(callback, offset=0) {
        this.DEBUG(`Requesting room info`);
        this._APIRequest(`/v2/room?start-index=${offset}`)
            .then((json) => {
                return Promise.all(json.items.map((item) => {
                    return this._APIRequest(`/v2/room/${item.id}`)
                    .then((room) => {
                        let jid = this._parseJID(room.xmpp_jid);
                        return ({
                            accountId: this.imAccount.id,
                            name: room.name,
                            topic:room.topic,
                            participantCount: 0,
                            chatRoomFieldValues: ChatRoomFieldValues({
                                room: jid.node,
                                server: jid.domain,
                                nick: this._user_info.name,
                            })
                        });
                    });
                }))
            })
            .then((rooms) => {
                callback(rooms, this, !json.links.next, rooms.length);
                if (json.links.next) {
                    this.requestRoomInfo(callback, json.startIndex + json.items.length);
                }
            })
            .catch((error) => {
                this.ERROR(error);
            })
    },

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
            let url = NetUtil.newURI(aItem.attributes["photo_url"]);
            let principal = Services.scriptSecurityManager.createCodebasePrincipal(url, {});
            let channel = NetUtil.newChannel({
                uri: url,
                loadingPrincipal: principal,
                contentPolicyType: Ci.nsIContentPolicy.TYPE_IMAGE
            });
            NetUtil.asyncFetch(channel, (inputStream, status, request) => {
                if (!Components.isSuccessCode(status)) {
                    this.DEBUG(`Failed to fetch photo for ${buddy}: ${status.toString(16)}`);
                    return;
                }
                let file = FileUtils.getFile("ProfD", ["icons",
                                                       this.protocol.normalizedName,
                                                       this.normalizedName,
                                                       `${buddy.normalizedName}.jpg`]);
                let outputStream = FileUtils.openSafeFileOutputStream(file);
                NetUtil.asyncCopy(inputStream, outputStream, (status) => {
                    if (Components.isSuccessCode(status)) {
                        buddy.buddyIconFilename = Services.io.newFileURI(file).spec;
                    } else {
                        this.DEBUG(`Failed to copy photo for ${buddy}: ${status.toString(16)}`);
                    }
                });
            });
        }
        return jid;
    },

    get wrappedJSObject() { return this },
    toString: function() { return `<HipChatAccount ${this.name}>`},
});
