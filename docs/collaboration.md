# Vault collaboration

Schema 7 makes a YAOS vault a human collaboration boundary rather than a set of
unrelated device memberships.

## Product contract

Every active vault has exactly one owner. Every other active person is a member.
Owner and member have identical authority over ordinary vault content:

- enumerate and read the complete vault;
- create, edit, rename, move, delete, and revive files;
- read and mutate attachments;
- participate in live updates and cursors;
- synchronize their own settings environments across their own devices.

Only the owner governs the vault. Owner-only actions include inviting and
removing people, revoking another person's device, recovery, security audit,
vault-wide diagnostics, shared vault policy, vault rename, ownership transfer,
and requesting destruction.

YAOS does not provide viewer, delegated administrator, custom-role, folder ACL,
or per-person permission-toggle modes. Anyone invited receives complete
plaintext read/write access. Revocation prevents future access but cannot erase
plaintext already downloaded by a member.

## People and devices

A principal is one stable vault-scoped person identity. A device is one
credential-bearing installation owned by that principal. **Invite person**
creates a member principal and first device; **Add my device** adds a separately
revocable credential to the current principal. These bearer-code flows are
purpose-bound and cannot be substituted for each other.

Every active membership has at least one active device. Removing a member's last
device removes the membership; self-removal is leave. Losing every owner device
requires the deployment operator's audited recovery ceremony.

## Authority

Every admitted request, socket, and durable operation names:

```text
vault generation
principal ID and membership revision
device ID and credential revision
owner/member role and policy version
```

The control plane authenticates this actor and the vault runtime verifies it
against a generation-scoped principal/device mirror. Fixed capabilities are
classified deny-by-default at every route and socket boundary. Clients receive
capability facts for UX only; the server remains authoritative.

Revocation and ownership transfer first stop new admission, then install a
durable idempotent fence in the vault runtime. Fence installation and durable
mutations share one serialized order. A mutation committed first remains
committed under its old authority; a fence installed first rejects the mutation
as `authority_superseded`.

An exact outcome lookup can recover the bounded receipt for an already-committed
operation after a lost response. It never performs a new mutation or grants
continued vault access. Candidate outcomes retain the same bounded 30-day
recovery window and global capacity limit as candidate receipts, including
successful candidates whose update was already present and created no new
document generation.

## Ownership transfer

The owner offers transfer to one active member. The target explicitly accepts.
The control plane then advances both memberships and the vault runtime atomically
installs the new owner and former-owner-as-member authorities. The vault can
never expose zero or two active owners.

Both clients should settle visible queued work before acceptance. Unknown
offline work remains local and is preserved under the stale-authority contract.

## Settings and recovery

Settings environments are keyed by vault, principal, and configuration-folder
key. A principal can access only their own settings; ownership transfer neither
reveals another person's settings nor takes away the former owner's settings.
Device-local settings remain local. Shared vault policy is a separate explicit
owner-managed resource, never an arbitrary plugin settings blob.

Recovery restores content only. It cannot restore principals, memberships,
devices, invitations, revocations, authority changes, or security audit state.

## Presence and attribution

Schema 7 keeps YAOS's existing live cursors. Awareness remains distinct for each
device/socket instance, while the server replaces client identity fields with
the current principal display name and principal color. The UI may group several
device cursors under one person without merging their awareness state.

Durable work records the admitted principal and device at mutation boundaries.
This establishes who committed an operation without claiming character-level
authorship.

## Compatibility

Collaboration is an exact breaking boundary:

| Boundary | Version |
|---|---:|
| Document schema | 7 |
| Socket protocol | 3 |
| Control-plane identity format | 3 |

Older clients fail before partial synchronization. Historical schema-6 work is
`legacy_unattributed`; migration never invents person attribution for it.
