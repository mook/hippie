const EXPORTED_SYMBOLS = ["HipChatPrpl"];

const { interfaces: Ci, utils: Cu } = Components;
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/jsProtoHelper.jsm");
Cu.import("resource:///modules/xmpp.jsm");
Cu.import("resource:///modules/xmpp-session.jsm");
Cu.import("chrome://hippie/content/Account.jsm");
Cu.import("chrome://hippie/content/Utils.jsm");

function HipChatPrpl() {
    initLogModule(`${this.id}.prpl`, this);
    Cu.import("resource:///modules/xmpp-commands.jsm", this);
    this.registerCommands();
    this.DEBUG("Prpl created");
}

HipChatPrpl.prototype = Utils.extend(GenericProtocolPrototype, {
    get normalizedName() { return "hipchat"; },
    get name() { return "HipChat"; },
    get iconBaseURI() { return "chrome://hippie/content/"; },

    get imagesInIM() { return false; },

    getAccount(aImAccount) {
        return new HipChatAccount(this, aImAccount);
    },
    get usernameSplits() {
        return [
            {
                label: 'HipChat server',
                separator: '@',
                reverse: true,
                defaultValue: 'www.hipchat.com',
            },
        ];
    },
    get options() {
        return {
            resource: {
                get label() { return _("options.resource"); },
                get default() { return XMPPDefaultResource; },
            },
            server: {
                get label() { return _("options.connectServer"); },
                default: "chat.hipchat.com",
            },
        };
    },

    _getOptionDefault(aName) {
        this.DEBUG(`getOptionDefault(${aName})`);
        switch (aName) {
            case "port": return 5222;
            case "connection_security": return "require_tls";
        }
        if (this.options && this.options.hasOwnProperty(aName)) {
            return this.options[aName].default;
        }
        let msg = `${aName} has no default value in ${this.id}.`;
        this.ERROR(msg);
        throw msg;
    },

    get classID() {
        return Components.ID("{addb6c02-116a-48f1-950d-c8672980e3af}");
    },
    get _xpcom_factory() {
        return XPCOMUtils.generateSingletonFactory(HipChatPrpl);
    },

    get wrappedJSObject() { return this; },
    toString() { return `<${this.name}Prpl>`; },
});
