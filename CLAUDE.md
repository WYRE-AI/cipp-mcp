# cipp-mcp — working notes

## How this codebase treats CIPP

Every request body and query string here is shaped against CIPP's own
`Invoke-*.ps1` handler, read from source, not inferred from the endpoint name or
from general Exchange/Graph knowledge. That is not pedantry — the bugs fixed in
[#67](https://github.com/wyre-technology/cipp-mcp/issues/67),
[#72](https://github.com/wyre-technology/cipp-mcp/issues/72)–[#76](https://github.com/wyre-technology/cipp-mcp/issues/76)
were all cases where a plausible-looking payload matched nothing upstream and
CIPP reported success anyway.

Two habits follow from that, and both are worth keeping:

- **Read the PowerShell before changing a payload.** HTTP triggers live under
  `Modules/CIPPHTTP/Public/Entrypoints/HTTP Functions/` in `KelvinTegelaar/CIPP-API`
  (they moved there from `CIPPCore`). Routing is generic — `/api/Foo` dispatches
  to `Invoke-Foo.ps1`.
- **Never let "CIPP returned 200" mean success.** Several entrypoints hardcode
  200 and report failures as strings in `Results`. `interpretResults` exists for
  exactly this.

## Learnings - 2026-09-07

Adding mailbox and archive size reporting
([#91](https://github.com/WYRE-AI/cipp-mcp/issues/91)).

**`ListMailboxStatistics` does not exist.** It is the endpoint name everyone
assumes for this, including the first three sources you will find. There is no
`Invoke-ListMailboxStatistics.ps1` in the CIPP-API tree. `ListSharedMailboxStatistics`
does exist but carries an upstream comment questioning whether anything calls it,
and it loops one `Get-MailboxStatistics` per mailbox. CIPP's own "Mailbox
Statistics" report page doesn't call a mailbox endpoint at all — it proxies
Graph's `reports/getMailboxUsageDetail` through `ListGraphRequest`.

**Sizes exist only on the cached path.** `Invoke-ListMailboxes`' live Exchange
query selects no size fields whatsoever — its `Select-Object` list stops at
holds and forwarding. `UseReportDB=true` is the *only* tenant-wide source of
sizes. An unsynced cache surfaces as an HTTP 500 whose body is the bare sentence
`No mailbox data found in reporting database. Sync the report data first.`

**Three different units, one feature.** The reporting database stores int64
*bytes*; `ListUserMailboxDetails` returns *gigabyte floats* rounded to two
decimals (so ~10 MB precision); and the raw `Get-Mailbox` object embedded in
that same response carries Exchange *display strings* like
`"1.234 GB (1,325,400,000 bytes)"`. `src/utils/bytes.ts` normalises all three.

Quotas are the subtle one. The top-level `ProhibitSendReceiveQuota` has had its
unit stripped upstream (`[float]($Quota -split ' ')[0]`), so a quota Exchange
prints in TB reads as a handful of GB. The exact byte count survives in the raw
`Mailbox` object's string — prefer it, and treat the stripped figure as a
fallback only.

**The concealment trap — the important one.** `Set-CIPPDBCacheMailboxes` builds
the tenant-wide cache by joining Graph's usage report to the mailbox list *on
the UPN*. When a tenant enables *Reports: conceal user, group, and site names*
in the M365 admin centre, Graph returns 32-character hex hashes instead of UPNs.
The join matches nothing, and every mailbox keeps its cached default of `0`.

Left undetected, the tool returns a clean, confident, well-formatted answer
saying the tenant consumes no storage at all — worse than an error, because
someone could act on it. Both signatures are detected and surfaced as warnings:
an all-zero result set, and UPNs matching `/^[0-9A-F]{32}$/i`. The per-user tool
is immune, because `Invoke-ListUserMailboxDetails` reads
`outlook.office365.com/adminapi` directly rather than the Graph reports.

**Two smaller calls in the same spirit.** An absent archive reports
`enabled: false` with *no* size, rather than a measured `0` that would read as
"archive present but empty". And mailboxes with no usable figure sort last, not
first — an unmeasured mailbox is not the emptiest one in the tenant.

**Endpoint quirks worth remembering.** `ListUserMailboxDetails` keys off the
Entra *object id*; hand it a UPN and it returns an empty shell rather than an
error. It has no all-tenants branch, so `allTenants` is rejected client-side.
`ListMailboxes` with the report DB *does* support `AllTenants`.

## Learnings - 2026-09-11

Adopting a write-verification envelope for the high-risk writes, adapted from
@pdlaskbis's fork (`pdlaskbis/cipp-mcp`).

**The readback field decides the readback path, not the other way round.**
`Invoke-ListUsers` applies its explicit `$select` only on the `UserID` branch.
A `graphFilter` query returns Graph's *default* property set, which contains
neither `accountEnabled` nor `lastPasswordChangeDateTime` — exactly the two
fields that prove a disable or a password reset landed. So a UPN-addressed
readback cannot see what it is looking for, and reports `pending` forever.
Resolve to an object id first; `readUserById` exists for this.

**Verify against the record's own prior value, not against the clock.**
`lastPasswordChangeDateTime` is compared to a baseline captured *before* the
write. Comparing to `Date.now()` would silently depend on three clocks agreeing
(this process, the CIPP function host, Entra). No readable baseline means no
advance can be proved — that stays `pending` rather than guessing.

**Not every write has an honest readback, and faking one is worse than
admitting it.** `signInSessionsValidFromDateTime` is in no property set any CIPP
read returns, and the only MFA read (`ListMFAUsers`) is a tenant-wide
cache-backed report that will answer confidently from stale data. Both
`Remove-CIPPUserMFA` and Graph's `revokeSignInSessions` run inline and throw —
HTTP 500 — on failure, so their own `Results` is the available evidence. It gets
parsed, not assumed, and an empty body stays `pending`.

**A failed READ is not a failed WRITE.** The poll loop swallows readback errors
and keeps going; at the deadline that is `pending` with a recheck instruction.
Reporting `failed` there would invent a failure that never happened.

**The failure regex needs word anchors.** `ExecResetPass` returns CIPP's
generated password inside `Results`. An unanchored `/fail/` calls a *successful*
reset failed the moment a random password happens to contain those four letters.
Where a newer endpoint returns structured `{ resultText, state }`, `state` is
authoritative and the text scan is skipped — `ExecResetPass` on a
directory-synced account succeeds with prose that reads "…will fail if writeback
is not enabled…".

**Per-endpoint body spellings are not interchangeable, even where PowerShell is
forgiving.** `ExecResetMFA` forwards the body's `ID` straight through as
`-UserPrincipalName`, so it wants a UPN and a GUID targets nothing.
`ExecRevokeSessions` reads lowercase `id` and builds its own result string from
`Username` — omit it and a successful revoke reports "Successfully revoked
sessions for " with a blank name, which reads like a failure to a human and to
an agent. `ExecDisableUser` coerces `Enable` with `[Convert]::ToBoolean`, which
turns an absent value into `$false`; send the intent explicitly rather than
betting on upstream never adding a default.

**`New-CIPPGroup` has its own vocabulary.** It derives `securityEnabled`,
`mailEnabled` and `mailNickname` from `groupType` and reads none of them from
the request, so Graph-shaped booleans are discarded in silence. A plain Entra
security group is `Generic`; `Security` means a *mail-enabled* security group.
`groupType` is mandatory because the cmdlet opens with
`$GroupObject.groupType.ToLower()`, which throws on a null and surfaces as an
opaque HTTP 500.

**Testing the poll loop.** `tests/cipp.service.verified-writes.test.ts` drives
the verification poll under Jest fake timers (the `settle` helper), so a
`pending` outcome costs no wall-clock time. The mock routes `ListUsers` on
whether `UserID` is present, which is what separates a resolve from a readback.

**`feat!:` alone does not cut a major in this repo — the footer does.**
`.releaserc.json` runs `@semantic-release/commit-analyzer` with its default
**angular** preset, whose header pattern is `/^(\w*)(?:\((.*)\))?: (.*)$/`. That
pattern does not allow `!`, so `feat!: …` parses with `type: undefined` and the
exclamation mark is invisible to the analyser. What actually produces the major
is the `BREAKING CHANGE:` footer, which the parser extracts independently of the
header. Verified against the installed plugin rather than assumed:

```
$ node -e "… analyzeCommits({}, { commits: [{ hash, message }] })"
RELEASE TYPE: major
```

So on this repo (and any fleet repo on the default preset) a `feat!:` shipped
*without* a `BREAKING CHANGE:` footer yields a **minor** — precisely the silent
break the `!` was meant to prevent. Write both: the `!` for humans reading
`git log`, the footer for the machine. Switching the preset to
`conventionalcommits` would make `!` load-bearing, but that is a release-config
change and should be made deliberately, fleet-wide, not as a side effect.
