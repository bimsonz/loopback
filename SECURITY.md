# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[report a vulnerability](https://github.com/bimsonz/loopback/security/advisories/new), or
**Report a vulnerability** on the repository's **Security** tab. Do not open a public issue, pull
request or discussion about it.

Include what an attacker can do, the steps to reproduce it, and the version or commit you tested.
You'll hear back on the report, and once a fix is released the advisory is published with credit to
you, unless you'd rather not be named.

## Supported versions

Fixes go into the latest release on `main`. Deployments are self-hosted, so upgrading means
deploying the release that carries the fix.

## What Loopback protects

These are the boundaries a report is most useful against:

- **The token.** A deployment's `LOOPBACK_TOKEN` is the one credential for its inbox and its MCP
  endpoint. Loopback accepts it only in the `Authorization` header and compares it in constant time.
  The inbox's event socket opens with a single-use ticket that lapses within a minute, never the
  token.
- **Props from an invoker.** Behind a dispatcher, access comes from `props.loopback`, which only code
  deployed on the same Cloudflare account can set. See [`docs/hosting.md`](docs/hosting.md).
- **Image uploads.** An upload URL is a single-use capability, valid for fifteen minutes, for one
  image type and a fixed size limit. A review can show only images its own space holds.
- **The inbox.** Its files are served with a content security policy that allows scripts only from
  the deployment itself, and it is never framed by another site.
