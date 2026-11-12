## [2.9.3] - 2026-11-12

### Fixed
- Addressed stack overflow risks when processing `$ref` chains of any length.
- Implemented stricter prototype key checks to prevent pollution.
- Improved schema node budget counting for inlining and mapper value calculations.
- Resolved schema handling to avoid circular references causing application crashes.

## [2.9.2] - 2026-11-12

### Fixed
- Restored v2.9.1's allOf nesting limit.
- Charged every conversion visit against maxSchemaNodes.
- Budgeted only emitted work, using cheaper cycle analysis.
- Bounded generateTools work on schemas that reuse a $ref.

## [2.9.1] - 2026-10-20

### Security
- Resolved security alerts related to `@istanbuljs/load-nyc-config/js-yaml`.

## [2.9.0] - 2026-10-20

### Changed
- Improved hostname normalization for $ref resolution.
- Updated internal IP blocking for IPv6 flows.

### Fixed
- Fixed SSRF vulnerability by adjusting IPv6 prefix blocking.
- Ensured spec credentials retain original origin during redirects.

### Security
- Enhanced SSRF protection in hostname handling.
- Adjusted SSRF prevention mechanisms to handle spec credentials more securely.

## [2.5.0] - 2026-06-21

### Security (SSRF hardening — GHSA-65h7-9wrw-629c)

Closes the remaining SSRF bypasses left after 2.4.0, where the guard checked the
hostname **string** rather than the **resolved IP**:

- **DNS resolution** — spec URLs and external `$ref` targets are now resolved
  (Node `node:dns`) and rejected if **any** resolved address is internal. This
  closes the `http://127.0.0.1.nip.io/` (and any DNS-name-to-internal) bypass.
- **`fromURL` is now guarded** — the initial spec fetch was previously
  unprotected (no host check, blind redirect-following). It now runs through the
  same SSRF guard.
- **Redirect re-validation** — every HTTP redirect hop is re-validated against
  the guard before being followed (manual redirect handling) instead of trusting
  the client to stop at a blocked `Location`.
- **External `$ref` fetch hardening** — refs are fetched via the SSRF-safe
  client (DNS-validated, redirects refused) and the spec-load credentials
  (`headers`) are **no longer forwarded** to third-party `$ref` hosts.
- IPv4 range checks now also cover CGNAT (`100.64.0.0/10`), benchmarking
  (`198.18.0.0/15`), and `192.0.0.0/24`; IPv6 covers loopback, ULA, link-local,
  and multicast.

`RefResolutionOptions` (`allowedHosts` / `blockedHosts` / `allowInternalIPs`)
now governs the spec-URL fetch too. New `SsrfError` and the `ssrf` helpers
(`assertUrlSafe`, `safeFetch`, `isBlockedAddress`, …) are exported.

Residual: resolve-then-fetch is not connection-pinned, so a sub-second
DNS-rebinding race is not fully eliminated — combine with `allowedHosts` and
network egress controls for fully-untrusted input.

## [2.4.0] - 2026-06-18
