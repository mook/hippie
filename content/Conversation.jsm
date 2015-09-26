/**
 * HipChat overrides for Conversations
 */

const EXPORTED_SYMBOLS = ["HipChatConversation"];
const { interfaces: Ci, results: Cr, utils: Cu, classes: Cc } = Components;

Cu.import("resource:///modules/jsProtoHelper.jsm");
Cu.import("resource:///modules/xmpp.jsm");
Cu.import("chrome://hippie/content/Utils.jsm");

function HipChatConversation(...args) {
    this._init.apply(this, args);
    this._title = null;
    this._account._getRoomName(this.name).then((title) => {
        this._title = title;
        this.notifyObservers(null, "update-conv-title");
    });
}
HipChatConversation.prototype = Utils.extend(XMPPMUCConversationPrototype, {
    get title() {
        return this._title || this.name;
    },

    writeMessage(aWho, aText, aProperties) {
        aProperties.containsNick =
            aProperties.incoming && this._account._pingRegexp.test(aText);
        GenericConversationPrototype.writeMessage.apply(this, arguments);
    },
});
