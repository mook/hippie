hippie
=======

This is an Instantbird/Thunderbird protocol implementation for HipChat.

Licensed under MPL2.

Useful references:
- https://ecosystem.atlassian.net/wiki/display/HCDEV/HipChat+XMPP+Protocol+Documentation
- https://www.hipchat.com/docs/apiv2 (rate limited)

Status:
- [x] Account creation
  - [x] Automatic API token provisioning
  - [x] Custom server support
- [x] User list
- [x] Single user messaging
  - [x] User list fetching
  - [ ] Emoticons
  - File uploads
    - [ ] Display
    - [ ] Upload
- [x] Multi user chat
  - [x] Room list fetching
  - Private rooms
    - [x] Fetch
    - [ ] Create
  - [x] Getting mentioned
  - [ ] Tab-complete other people's mentions
