/**
 * Main file for HipChat prpl
 */

debugger;

const EXPORTED_SYMBOLS = ["NSGetFactory"];
const { utils: Cu } = Components;
Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("chrome://hippie/content/Protocol.jsm");
const NSGetFactory = XPCOMUtils.generateNSGetFactory([HipChatPrpl]);
