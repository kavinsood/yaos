# Collaboration

YAOS has no multi-person collaboration. It syncs one person's vaults across that person's devices. This page
replaces the schema-8 "vault collaboration" contract (owner and member people, invitations, ownership transfer,
presence), which was removed with the old server and client; git history keeps it.

## What exists

- **One operator per server.** The person who claims the server signs in to its console with the operator recovery
  key. There are no members, invitations, roles, folder permissions or per-person identities (server
  [DECISIONS](server-rewrite/DECISIONS.md) §1, "Removed (not deferred)").
- **Devices, not people.** Each device is paired with a one-use code and can be revoked on its own. Every paired
  device can read and change its whole vault ([operations.md](operations.md)).
- **Live edits across devices.** Two of your devices editing one note merge character by character, and open
  editors receive each other's edits live. Remote cursors and presence are not shown (DESIGN §d.3, §m.2).
- **Governance lives in the console.** Pairing, the device list, revoke, reset, restore and vault deletion are in the
  operator console, not in Obsidian ([legacy-parity](client-remake/legacy-parity.md) §18).

Sharing a vault with another person today means giving them a paired device of yours: they get full read and write
access, under your vault key, with nothing to tell their edits from yours.

## What collaboration would need

- **Server identity:** people as well as devices (an invitation flow, per-person revoke, an owner who governs), which
  the server rewrite removed on purpose (DECISIONS §1).
- **Shared E2EE:** per-member key wraps, key commitment against a malicious member, and the rest of
  [e2ee-design](client-remake/e2ee-design.md) §2.4. The format keeps that open (key epochs in every header, a
  separate `k` stream, per-device frame windows), but none of it is built.
- **Client:** a person identity and its UI, attribution of edits, and presence (remote cursors are null today).

None of this is planned. The nearest open question is whether device governance should move into the plugin at all:
[BACKLOG](BACKLOG.md) GOVERNANCE.
