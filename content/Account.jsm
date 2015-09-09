const EXPORTED_SYMBOLS = ["HipChatAccount"];
const { interfaces: Ci, results: Cr, utils: Cu } = Components;

Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/jsProtoHelper.jsm");
Cu.import("resource:///modules/xmpp.jsm");
//Cu.import("chrome://hippie/content/Buddy.jsm");
//Cu.import("chrome://hippie/content/Channel.jsm");
Cu.import("chrome://hippie/content/Utils.jsm");
//Cu.import("chrome://hippie/content/WebSocket.jsm");

function HipChatAccount(aPrpl, aImAccount) {
    this._init(aPrpl, aImAccount);
    initLogModule(`${this.protocol.id}.${this.name}`, this);
    this.DEBUG(`Created account ${this}`);
}

HipChatAccount.prototype = Utils.extend(XMPPAccountPrototype, {

    chatRoomFields: {
        /* No nick option; always use nick of current user */
        room: {get label() { return _("chatRoomField.room"); }, required: true},
        server: {get label() { return _("chatRoomField.server"); }, required: true},
        password: {get label() { return _("chatRoomField.password"); }, isPassword: true}
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

    get wrappedJSObject() { return this },
    toString: function() { return `<HipChatAccount ${this.name}>`},
});
