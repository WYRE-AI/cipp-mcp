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
