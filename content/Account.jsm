const EXPORTED_SYMBOLS = ["HipChatAccount"];
const { interfaces: Ci, results: Cr, utils: Cu, classes: Cc } = Components;

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/jsProtoHelper.jsm");
Cu.import("resource:///modules/xmpp.jsm");
Cu.import("resource:///modules/xmpp-xml.jsm");
Cu.import("chrome://hippie/content/Utils.jsm");
Cu.import("chrome://hippie/content/Session.jsm");
Cu.import("chrome://hippie/content/Conversation.jsm");
Cu.import("chrome://hippie/content/XML.jsm");

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

    /**
     * Override XMPPAccountPrototype.connect() to determine the JID automatically
     */
    connect: function() {
        var [, login, server] = /(.*)@(.*?)$/.exec(this.name);

        if (server.endsWith(".hipchat.com")) {
            // For hosted HipChat, they use a central chat server
            server = "chat.hipchat.com";
        }

        let resource = null;
        // For the resource, if the user has edited the option to a non
        // empty value, use that.
        if (this.prefs.prefHasUserValue("resource")) {
            resource = this.getString("resource");
        }
        // Otherwise, if the username doesn't contain a resource, use the
        // value of the resource option (it will be the default value).
        // If we set an empty resource, XMPPSession will fallback to
        // XMPPDefaultResource (set to brandShortName).
        if (!resource) {
            resource = this.getString("resource");
        }

        this._connection = new HipChatSession(server,
                                              login,
                                              this.imAccount.password,
                                              this,
                                              resource);
    },

    /**
     * Called when the XMPP session is started; overridden to use the HipChat
     * startup call
     */
    onConnection() {
        // We still need to get the roster and do service discovery
        XMPPAccountPrototype.onConnection.call(this);

        this.reportConnecting(_("connection.downloadingRoster"));
        let iq = Stanza.iq("get", null, null,
                           Stanza.node("query", Stanza.NS.hipchat_startup));
        this.sendStanza(iq, (stanza) => {
            let query = stanza.getElementNS([[Stanza.NS.hipchat_startup, "query"]]);
            if (!query) {
                this.DEBUG(`Failed to do HipChat startup: ${query}`);
                return;
            }
            const kInfoMap = {
                name:       "name",
                mention:    "mention_name",
                user_id:    "user_id",
                group_id:   "group_id",
                group_host: "group_uri_domain",
            }
            this._userInfo = this._userInfo || {};
            for (let key in kInfoMap) {
                let elem = query.getElementNS([[Stanza.NS.hipchat_startup, kInfoMap[key]]]);
                if (elem) {
                    this._userInfo[key] = elem.innerText;
                } else {
                    this.DEBUG(`Failed to find ${kInfoMap[key]}`);
                }
            }

            let regexpQuote = (str) => str.replace(/[[\]{}()*+?.\\^$|]/g, "\\$&");
            this._pingRegexp = new RegExp("(?:^|\\W)(?:" +
                                          regexpQuote(this._userInfo.name) +
                                          "|@" +
                                          regexpQuote(this._userInfo.mention) +
                                          ")(?:\\W|$)", "i");

            for (let item of query.getElements(["preferences", "autoJoin", "item"])) {
                this.DEBUG(`auto join: \n${item.convertToString("  ")}`);
                let roomInfo = this._cacheRoomInfo(item);
                if (roomInfo) {
                    this.joinChat(roomInfo.chatRoomFieldValues);
                } else {
                    // One-on-one IM conversation
                    this.createConversation(item.attributes["jid"]);
                }
            }
        }, this);
    },

    // _pingRegexp is overwritten once we have the name / mention
    // The default value will never match
    _pingRegexp: /$.^/,

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
    _roomInfoCache: new Map(), // jid -> entries

    requestRoomInfo: function(callback, requestStartTime=0, lastRoomName=null) {
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
            this.DEBUG(`Using cache of ${this._roomInfoCache.size} items`);
            callback.onRoomInfoAvailable(this._roomInfoCache.values(), this, true, this._roomInfoCache.size);
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
        }

        let iq = Stanza.iq("get", null, this._mucService,
                           Stanza.node("query", Stanza.NS.disco_items));
        if (lastRoomName) {
            let set = Stanza.node("set",
                                  "http://jabber.org/protocol/rsm",
                                  null,
                                  Stanza.node("after",
                                              null,
                                              null,
                                              lastRoomName));
            iq.getChildren()[0].addChild(set);
        }
        this.DEBUG(`Requesting rooms: ${iq.getXML()}`);

        this.sendStanza(iq, (receivedStanza) => {
            let newItems = [];
            let query = receivedStanza.getElement(["query"]);
            for (let item of query.getElements(["item"])) {
                newItems.push(this._cacheRoomInfo(item));
            }
            let set = query.getElement(["set"]);
            if (set) {
                // The results are incomplete; fetch more
                this.DEBUG(`Set found, fetching more items`);
                this.requestRoomInfo(callback, requestStartTime, newItems.slice(-1)[0].name);
            }
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

    _cacheRoomInfo(aStanza) {
        let query = aStanza.getElementNS([[Stanza.NS.disco_info, "query"]]) || aStanza;

        let x = query.getElementNS([[Stanza.NS.hipchat_room, "x"]]);
        if (!x) {
            this.DEBUG(`Can't cache room info, not a room:\n${aStanza.convertToString("  ")}`);
            return null;
        }

        let prop = (localName) => {
            let elem = x.getElementNS([[Stanza.NS.hipchat_room, localName]]);
            return elem ? elem.innerText.trim() : null;
        };

        let roomInfo = {
            name: aStanza.attributes["name"],
            accountId: this.imAccount.id,
            topic: prop("topic"),
            participantCount: parseInt(prop("num_participants"), 10),
            hipchat_id: prop("id"),
            version: prop("version"),
        };

        if (!roomInfo.name) {
            let id = query.getElementNS([[Stanza.NS.disco_info, "identity"]]);
            if (id) {
                roomInfo.name = id.attributes["name"];
            }
        }
        if (!roomInfo.name) {
            this.DEBUG(`No name found in room info:\n${aStanza.convertToString("  ")}`);
            return null;
        }

        let jid = aStanza.attributes["jid"];
        if (!jid) {
            jid = aStanza.attributes["from"];
        }
        if (!jid) {
            this.DEBUG(`No JID found in room info:\n${aStanza.convertToString("  ")}`);
            return null;
        }
        roomInfo.jid = this._parseJID(jid);
        roomInfo.chatRoomFieldValues = new ChatRoomFieldValues({
            room: roomInfo.jid.node,
            server: roomInfo.jid.domain,
        });

        this._roomInfoCache.set(jid, roomInfo);
        return roomInfo;
    },

    _getRoomName(aJID) {
        if (aJID.node && aJID.domain) {
            aJID = `${aJID.node}@${aJID.domain}`;
        }
        return new Promise((resolve, reject) => {
            if (this._roomInfoCache.has(aJID)) {
                resolve(this._roomInfoCache.get(aJID).name);
                return;
            }
            let iq = Stanza.iq("get", null, aJID,
                               Stanza.node("query", Stanza.NS.disco_info));
            this.sendStanza(iq, (receivedStanza) => {
                resolve(this._cacheRoomInfo(receivedStanza)).name;
            });
        });
    },

    joinChat: function(aComponents) {
        aComponents.setValue("nick", this._userInfo.name);
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

    _MUCConversationConstructor: HipChatConversation,
    
    get wrappedJSObject() { return this },
    toString: function() { return `<HipChatAccount ${this.name}>`},
});
